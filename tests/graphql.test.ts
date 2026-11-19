import test from 'node:test';
import assert from 'node:assert';
import { Store } from '../store.ts';
import { executeGraphQL } from '../graphql.ts';

test('GraphQL - ViewerLogin', async () => {
  const store = new Store();
  store.createRepo('owner1', 'test-repo');

  const res = await executeGraphQL(
    store,
    { query: 'query ViewerLogin { viewer { login } }' },
    'Bearer token123'
  );

  assert.strictEqual(res.status, 200);
  const body: any = res.body;
  assert.strictEqual(body.data.viewer.login, 'owner1');
  assert.strictEqual(body.errors.length, 0);
});

test('GraphQL - Unauthenticated', async () => {
  const store = new Store();
  const res = await executeGraphQL(
    store,
    { query: 'query ViewerLogin { viewer { login } }' },
    undefined
  );

  assert.strictEqual(res.status, 401);
});

test('GraphQL - UnknownRepository', async () => {
  const store = new Store();
  store.createRepo('owner1', 'existing-repo');

  const res = await executeGraphQL(
    store,
    {
      query: 'query Repo($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id name } }',
      variables: { owner: 'owner1', name: 'nonexistent' }
    },
    'Bearer token123'
  );

  assert.strictEqual(res.status, 200);
  const body: any = res.body;
  assert.strictEqual(body.data.repository, null);
  assert.strictEqual(body.errors.length, 0);
});

test('GraphQL - InvalidField error', async () => {
  const store = new Store();
  store.createRepo('owner1', 'test-repo');

  const res = await executeGraphQL(
    store,
    { query: 'query Invalid { viewer { login noSuchField } }' },
    'Bearer token123'
  );

  assert.strictEqual(res.status, 200);
  const body: any = res.body;
  assert.ok(body.errors.length > 0);
});

test('GraphQL - Mutations (Create Issue, Close Issue, Add Comment)', async () => {
  const store = new Store();
  const repo = store.createRepo('owner1', 'test-repo');
  const repoId = Buffer.from(JSON.stringify({ t: 'repo', owner: 'owner1', name: 'test-repo' })).toString('base64');

  // Create issue
  const createRes = await executeGraphQL(
    store,
    {
      query: 'mutation Create($input: CreateIssueInput!) { createIssue(input: $input) { issue { number id state } } }',
      variables: { input: { repositoryId: repoId, title: 'Bug in login', body: 'Please fix' } }
    },
    'Bearer token123'
  );

  const createBody: any = createRes.body;
  assert.strictEqual(createBody.data.createIssue.issue.number, 1);
  assert.strictEqual(createBody.data.createIssue.issue.state, 'OPEN');
  const issueId = createBody.data.createIssue.issue.id;

  // Add comment
  const commentRes = await executeGraphQL(
    store,
    {
      query: 'mutation Comment($input: AddCommentInput!) { addComment(input: $input) { commentEdge { node { id body } } } }',
      variables: { input: { subjectId: issueId, body: 'Looking into this' } }
    },
    'Bearer token123'
  );
  const commentBody: any = commentRes.body;
  assert.strictEqual(commentBody.data.addComment.commentEdge.node.body, 'Looking into this');

  // Close issue
  const closeRes = await executeGraphQL(
    store,
    {
      query: 'mutation Close($input: CloseIssueInput!) { closeIssue(input: $input) { issue { number state } } }',
      variables: { input: { issueId } }
    },
    'Bearer token123'
  );
  const closeBody: any = closeRes.body;
  assert.strictEqual(closeBody.data.closeIssue.issue.state, 'CLOSED');
});

test('GraphQL - Batching operations', async () => {
  const store = new Store();
  store.createRepo('owner1', 'test-repo');

  const res = await executeGraphQL(
    store,
    [
      { query: 'query Viewer { viewer { login } }' },
      { query: 'query IssueType { __type(name: "Issue") { name fields { name } } }' }
    ],
    'Bearer token123'
  );

  assert.strictEqual(res.status, 200);
  const body: any = res.body;
  assert.ok(Array.isArray(body));
  assert.strictEqual(body.length, 2);
  assert.strictEqual(body[0].data.viewer.login, 'owner1');
  assert.strictEqual(body[1].data.__type.name, 'Issue');
});
