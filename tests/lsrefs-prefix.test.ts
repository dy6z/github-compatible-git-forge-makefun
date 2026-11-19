import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../store.ts';
import { handleGitRequest } from '../git-http.ts';
import { encodePktLines, decodePktLines } from '../packet.ts';

async function lsRefs(store: Store, prefix: string): Promise<string[]> {
  const body = encodePktLines([
    'command=ls-refs\n',
    'agent=test\n',
    'object-format=sha1\n',
    'delim',
    'peel\n',
    'symrefs\n',
    'unborn\n',
    `ref-prefix ${prefix}\n`,
    'flush',
  ]);
  const response = await handleGitRequest(store, 'POST', '/owner/repo.git/git-upload-pack', { 'git-protocol': 'version=2' }, body);
  return decodePktLines(response.body).flatMap((packet) => packet.kind === 'data' ? [packet.payload.toString('utf8').trim()] : []);
}

test('v2 ls-refs honors heads, tags, and unmatched prefixes exactly', async () => {
  const store = new Store();
  store.createRepo('owner', 'repo');
  const blob = store.storeObject('blob', Buffer.from('x'));
  const tree = store.storeObject('tree', Buffer.concat([Buffer.from('100644 x\0'), Buffer.from(blob, 'hex')]));
  const commit = store.storeObject('commit', Buffer.from(`tree ${tree}\nauthor A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\n\nx`));
  const tag = store.storeObject('tag', Buffer.from(`object ${commit}\ntype commit\ntag v1\ntagger A <a@b> 1 +0000\n\nv1`));
  store.setRef('owner', 'repo', 'refs/heads/main', commit);
  store.setRef('owner', 'repo', 'refs/tags/v1', tag);

  const heads = await lsRefs(store, 'refs/heads/');
  const tags = await lsRefs(store, 'refs/tags/');
  const none = await lsRefs(store, 'refs/does-not-exist/');
  assert.deepEqual(heads.map((line) => line.split(' ')[1]), ['refs/heads/main']);
  assert.deepEqual(tags.map((line) => line.split(' ')[1]), ['refs/tags/v1']);
  assert.deepEqual(none, []);
});
