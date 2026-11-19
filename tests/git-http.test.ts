import test from 'node:test';
import assert from 'node:assert';
import { Store } from '../store.ts';
import { handleGitRequest, parseRepoPath } from '../git-http.ts';
import { GitClient } from '/home/dy6z/.hermes/cache/scratch/github-core-current-kit-20261119/github-core-clone-01-kit/sdk/conformance/git-client.ts';

test('parseRepoPath helper', () => {
  const parsed1 = parseRepoPath('/owner/repo.git/info/refs?service=git-upload-pack');
  assert.deepStrictEqual(parsed1, { owner: 'owner', repo: 'repo', suffix: '/info/refs' });

  const parsed2 = parseRepoPath('/alice/my-project.git/git-upload-pack');
  assert.deepStrictEqual(parsed2, { owner: 'alice', repo: 'my-project', suffix: '/git-upload-pack' });

  const parsed3 = parseRepoPath('/invalid/path');
  assert.strictEqual(parsed3, null);
});

test('Git HTTP - info/refs 404 for missing repo', async () => {
  const store = new Store();
  const res = await handleGitRequest(store, 'GET', '/owner/missing.git/info/refs?service=git-upload-pack', {});
  assert.strictEqual(res.status, 404);
});

test('Git HTTP - info/refs upload-pack v0 and v2 advertisements', async () => {
  const store = new Store();
  store.createRepo('owner', 'repo');

  // v0 advertisement
  const resV0 = await handleGitRequest(store, 'GET', '/owner/repo.git/info/refs?service=git-upload-pack', {});
  assert.strictEqual(resV0.status, 200);
  assert.ok(resV0.headers['content-type'].includes('application/x-git-upload-pack-advertisement'));

  // v2 advertisement
  const resV2 = await handleGitRequest(store, 'GET', '/owner/repo.git/info/refs?service=git-upload-pack', {
    'git-protocol': 'version=2',
  });
  assert.strictEqual(resV2.status, 200);
  assert.ok(resV2.headers['content-type'].includes('application/x-git-upload-pack-advertisement'));
});

test('Git HTTP - push and clone via GitClient integration test', async () => {
  const store = new Store();
  store.createRepo('owner', 'testrepo');

  const mockFetch = async (url: string, init: any) => {
    const res = await handleGitRequest(
      store,
      init.method,
      url,
      init.headers,
      init.body ? Buffer.from(init.body) : undefined,
    );
    return {
      status: res.status,
      headers: {
        get(name: string) {
          return res.headers[name.toLowerCase()] || null;
        },
      },
      body: {
        async *[Symbol.asyncIterator]() {
          yield res.body;
        },
      },
      async arrayBuffer() {
        return res.body.buffer.slice(res.body.byteOffset, res.body.byteOffset + res.body.byteLength);
      },
      async text() {
        return res.body.toString('utf8');
      },
    };
  };

  const client = new GitClient({
    baseUrl: 'http://localhost',
    fetchImpl: mockFetch as any,
  });

  const adv = await client.advertisement('owner', 'testrepo', 'git-upload-pack');
  assert.strictEqual(adv.protocol, 2);

  const blobSha = store.storeObject('blob', Buffer.from('hello git smart http', 'utf8'));
  const treeContent = Buffer.concat([Buffer.from('100644 README.md\0', 'utf8'), Buffer.from(blobSha, 'hex')]);
  const treeSha = store.storeObject('tree', treeContent);

  const commitContent = Buffer.from(
    `tree ${treeSha}\nauthor Test <test@forge.local> 1700000000 +0000\ncommitter Test <test@forge.local> 1700000000 +0000\n\nInitial commit\n`,
    'utf8',
  );
  const commitSha = store.storeObject('commit', commitContent);
  store.setRef('owner', 'testrepo', 'refs/heads/main', commitSha);

  const cloneResult = await client.clone('owner', 'testrepo');
  assert.strictEqual(cloneResult.objects.size > 0, true);
  assert.ok(cloneResult.objects.has(commitSha));
});
