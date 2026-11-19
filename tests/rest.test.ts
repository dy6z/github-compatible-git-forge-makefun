import test from 'node:test';
import assert from 'node:assert';
import { Store } from '../store.ts';
import { handleRest, type RestContext } from '../rest.ts';

function callRest(store: Store, method: string, path: string, options: { query?: URLSearchParams; body?: unknown; authenticated?: boolean } = {}) {
  const ctx: RestContext = {
    store,
    owner: 'testowner',
    method,
    path,
    query: options.query ?? new URLSearchParams(),
    body: options.body,
    authenticated: options.authenticated ?? true,
    requestId: 'req_123',
  };
  return handleRest(ctx);
}

test('REST v3 - Root and Meta', () => {
  const store = new Store();
  const rootRes = callRest(store, 'GET', '');
  assert.strictEqual(rootRes.status, 200);
  assert.ok((rootRes.headers as any)['x-github-request-id']);

  const metaRes = callRest(store, 'GET', 'meta');
  assert.strictEqual(metaRes.status, 200);
  assert.deepStrictEqual(metaRes.body, { installed_version: 'forge-1.0.0' });
});

test('REST v3 - Repositories CRUD and Pagination', () => {
  const store = new Store();
  
  // Unauthorized
  const unauth = callRest(store, 'GET', 'user/repos', { authenticated: false });
  assert.strictEqual(unauth.status, 401);

  // Create repo
  const createRes = callRest(store, 'POST', 'user/repos', { body: { name: 'hello-world', description: 'Test repo', private: true } });
  assert.strictEqual(createRes.status, 201);
  assert.strictEqual((createRes.body as any).name, 'hello-world');
  assert.strictEqual((createRes.body as any).private, true);

  // Get repo
  const getRes = callRest(store, 'GET', 'repos/testowner/hello-world');
  assert.strictEqual(getRes.status, 200);
  assert.strictEqual((getRes.body as any).name, 'hello-world');

  // Patch repo
  const patchRes = callRest(store, 'PATCH', 'repos/testowner/hello-world', { body: { description: 'Updated desc' } });
  assert.strictEqual(patchRes.status, 200);
  assert.strictEqual((patchRes.body as any).description, 'Updated desc');

  // List user repos
  const listRes = callRest(store, 'GET', 'user/repos', { query: new URLSearchParams('per_page=10') });
  assert.strictEqual(listRes.status, 200);
  assert.strictEqual(Array.isArray(listRes.body), true);
  assert.strictEqual((listRes.body as any[]).length, 1);

  // Delete repo
  const delRes = callRest(store, 'DELETE', 'repos/testowner/hello-world');
  assert.strictEqual(delRes.status, 204);

  const getMissing = callRest(store, 'GET', 'repos/testowner/hello-world');
  assert.strictEqual(getMissing.status, 404);
});

test('REST v3 - Contents and Commits', () => {
  const store = new Store();
  callRest(store, 'POST', 'user/repos', { body: { name: 'content-repo', private: true } });

  // Put file content
  const contentBase64 = Buffer.from('Hello Forge').toString('base64');
  const putRes = callRest(store, 'PUT', 'repos/testowner/content-repo/contents/README.md', {
    body: { message: 'Initial commit', content: contentBase64 }
  });
  assert.strictEqual(putRes.status, 201);
  assert.ok((putRes.body as any).commit.sha);

  // Get file content
  const getRes = callRest(store, 'GET', 'repos/testowner/content-repo/contents/README.md');
  assert.strictEqual(getRes.status, 200);
  assert.strictEqual((getRes.body as any).encoding, 'base64');
  assert.strictEqual(Buffer.from((getRes.body as any).content, 'base64').toString(), 'Hello Forge');

  // Stale SHA conflict (409)
  const staleRes = callRest(store, 'PUT', 'repos/testowner/content-repo/contents/README.md', {
    body: { message: 'Update', content: contentBase64, sha: 'wrongsha' }
  });
  assert.strictEqual(staleRes.status, 409);
});

test('REST v3 - Issues, Labels and Comments', () => {
  const store = new Store();
  callRest(store, 'POST', 'user/repos', { body: { name: 'issue-repo' } });

  // Create label
  const labelRes = callRest(store, 'POST', 'repos/testowner/issue-repo/labels', {
    body: { name: 'bug', color: 'ff0000' }
  });
  assert.strictEqual(labelRes.status, 201);
  assert.strictEqual((labelRes.body as any).name, 'bug');

  // Create issue with label
  const issueRes = callRest(store, 'POST', 'repos/testowner/issue-repo/issues', {
    body: { title: 'Bug found', body: 'Fix please', labels: ['bug'] }
  });
  assert.strictEqual(issueRes.status, 201);
  assert.strictEqual((issueRes.body as any).number, 1);
  assert.strictEqual((issueRes.body as any).state, 'open');

  // Unknown label should return 422
  const badIssueRes = callRest(store, 'POST', 'repos/testowner/issue-repo/issues', {
    body: { title: 'Bug 2', labels: ['unknown-label'] }
  });
  assert.strictEqual(badIssueRes.status, 422);

  // Add comment
  const commentRes = callRest(store, 'POST', 'repos/testowner/issue-repo/issues/1/comments', {
    body: { body: 'Looking into it' }
  });
  assert.strictEqual(commentRes.status, 201);
  assert.strictEqual((commentRes.body as any).body, 'Looking into it');

  // List comments
  const commentsList = callRest(store, 'GET', 'repos/testowner/issue-repo/issues/1/comments');
  assert.strictEqual(commentsList.status, 200);
  assert.strictEqual((commentsList.body as any[]).length, 1);

  // Close issue
  const patchIssue = callRest(store, 'PATCH', 'repos/testowner/issue-repo/issues/1', {
    body: { state: 'closed' }
  });
  assert.strictEqual(patchIssue.status, 200);
  assert.strictEqual((patchIssue.body as any).state, 'closed');
});

test('REST v3 - Pull Requests and Merging', () => {
  const store = new Store();
  callRest(store, 'POST', 'user/repos', { body: { name: 'pr-repo' } });

  // Initial commit on main
  callRest(store, 'PUT', 'repos/testowner/pr-repo/contents/main.txt', {
    body: { message: 'main commit', content: Buffer.from('v1').toString('base64') }
  });

  // Create branch feature
  const mainSha = store.getRef('testowner', 'pr-repo', 'refs/heads/main')!;
  callRest(store, 'POST', 'repos/testowner/pr-repo/git/refs', {
    body: { ref: 'refs/heads/feature', sha: mainSha }
  });

  // Commit on feature
  callRest(store, 'PUT', 'repos/testowner/pr-repo/contents/feature.txt', {
    body: { message: 'feature commit', content: Buffer.from('v2').toString('base64'), branch: 'feature' }
  });

  // Create PR
  const prRes = callRest(store, 'POST', 'repos/testowner/pr-repo/pulls', {
    body: { title: 'Add feature', head: 'feature', base: 'main' }
  });
  assert.strictEqual(prRes.status, 201);
  assert.strictEqual((prRes.body as any).number, 1);
  assert.strictEqual((prRes.body as any).state, 'open');

  // List PR files
  const filesRes = callRest(store, 'GET', 'repos/testowner/pr-repo/pulls/1/files');
  assert.strictEqual(filesRes.status, 200);
  assert.strictEqual(Array.isArray(filesRes.body), true);

  // Merge PR
  const mergeRes = callRest(store, 'PUT', 'repos/testowner/pr-repo/pulls/1/merge');
  assert.strictEqual(mergeRes.status, 200);
  assert.strictEqual((mergeRes.body as any).merged, true);
});
