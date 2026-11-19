import test from 'node:test';
import assert from 'node:assert';
import { Store } from '../store.ts';

test('Store - Repositories CRUD', () => {
  const store = new Store();
  const repo = store.createRepo('owner1', 'test-repo', 'A test repo');
  assert.strictEqual(repo.name, 'test-repo');
  assert.strictEqual(repo.owner, 'owner1');
  assert.strictEqual(repo.description, 'A test repo');

  const fetched = store.getRepo('owner1', 'test-repo');
  assert.ok(fetched);
  assert.strictEqual(fetched?.name, 'test-repo');

  const updated = store.updateRepo('owner1', 'test-repo', { description: 'Updated desc' });
  assert.strictEqual(updated.description, 'Updated desc');

  const repos = store.listRepos('owner1');
  assert.strictEqual(repos.length, 1);

  store.deleteRepo('owner1', 'test-repo');
  assert.strictEqual(store.getRepo('owner1', 'test-repo'), undefined);
});

test('Store - Labels and Issues', () => {
  const store = new Store();
  store.createRepo('owner1', 'repo1');
  
  // Creating label
  const label = store.createLabel('owner1', 'repo1', 'bug', 'ff0000', 'Something is broken');
  assert.strictEqual(label.name, 'bug');

  // Issue requiring valid label
  assert.throws(() => {
    store.createIssue('owner1', 'repo1', 'Issue 1', 'Body 1', ['nonexistent']);
  });

  const issue = store.createIssue('owner1', 'repo1', 'Issue 1', 'Body 1', ['bug']);
  assert.strictEqual(issue.number, 1);
  assert.strictEqual(issue.state, 'open');
  assert.deepStrictEqual(issue.labels, ['bug']);

  const issues = store.listIssues('owner1', 'repo1', 'open');
  assert.strictEqual(issues.length, 1);
  assert.strictEqual(issues[0].title, 'Issue 1');

  const updatedIssue = store.updateIssue('owner1', 'repo1', 1, { state: 'closed' });
  assert.strictEqual(updatedIssue.state, 'closed');
  assert.strictEqual(store.listIssues('owner1', 'repo1', 'open').length, 0);
  assert.strictEqual(store.listIssues('owner1', 'repo1', 'closed').length, 1);
});

test('Store - Contents and Git Objects', () => {
  const store = new Store();
  store.createRepo('owner1', 'repo2');

  // Put file content
  const result = store.putFileContent('owner1', 'repo2', 'README.md', Buffer.from('# Hello'), 'Initial commit');
  assert.ok(result.commitSha);
  assert.ok(result.contentSha);

  const file = store.getFileContent('owner1', 'repo2', 'README.md');
  assert.ok(file);
  assert.strictEqual(file.content.toString(), '# Hello');

  // Update file content
  const updateResult = store.putFileContent('owner1', 'repo2', 'README.md', Buffer.from('# Hello World'), 'Update README', 'refs/heads/main', file.sha);
  assert.ok(updateResult.commitSha);

  const updatedFile = store.getFileContent('owner1', 'repo2', 'README.md');
  assert.ok(updatedFile);
  assert.strictEqual(updatedFile.content.toString(), '# Hello World');
});

test('Store - Pull Requests and Merging', () => {
  const store = new Store();
  store.createRepo('owner1', 'repo3');

  // Initial commit on main
  store.putFileContent('owner1', 'repo3', 'file.txt', Buffer.from('v1'), 'Commit 1', 'refs/heads/main');

  // Create feature branch
  const mainSha = store.getRef('owner1', 'repo3', 'refs/heads/main')!;
  store.setRef('owner1', 'repo3', 'refs/heads/feature', mainSha);

  // Commit on feature branch
  store.putFileContent('owner1', 'repo3', 'file.txt', Buffer.from('v2'), 'Commit 2', 'refs/heads/feature');

  // Create PR
  const pr = store.createPullRequest('owner1', 'repo3', 'Feature PR', 'feature', 'main');
  assert.strictEqual(pr.number, 1);
  assert.strictEqual(pr.state, 'open');

  // Merge PR
  const mergeResult = store.mergePullRequest('owner1', 'repo3', 1);
  assert.ok(mergeResult.merged);
  assert.ok(mergeResult.sha);

  const mergedPr = store.getPullRequest('owner1', 'repo3', 1);
  assert.strictEqual(mergedPr?.state, 'merged');

  // Check file on main is now v2
  const file = store.getFileContent('owner1', 'repo3', 'file.txt', 'refs/heads/main');
  assert.strictEqual(file?.content.toString(), 'v2');
});
