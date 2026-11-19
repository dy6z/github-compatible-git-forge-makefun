import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.ts';

async function startApp(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  process.env.MAKEFUN_SHOP_TOKEN = 'integration-token';
  process.env.MAKEFUN_LOGIN = 'adaiversen';
  const server = createApp();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const headers = { authorization: 'Bearer integration-token', 'content-type': 'application/json' };

test('app routes REST, GraphQL, MCP, and JSON errors over one store', async () => {
  const app = await startApp();
  try {
    const health = await fetch(`${app.baseUrl}/healthz`, { headers });
    assert.equal(health.status, 200);

    const created = await fetch(`${app.baseUrl}/api/v3/user/repos`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'integration', private: true }),
    });
    assert.equal(created.status, 201);

    const issue = await fetch(`${app.baseUrl}/api/v3/repos/adaiversen/integration/issues`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Shared issue', body: 'Visible everywhere' }),
    });
    assert.equal(issue.status, 201);

    const gql = await fetch(`${app.baseUrl}/api/graphql`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: 'query Q($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){number title}}}',
        variables: { owner: 'adaiversen', name: 'integration', number: 1 },
      }),
    });
    const gqlBody = await gql.json() as any;
    assert.equal(gql.status, 200, JSON.stringify(gqlBody));
    assert.equal(gqlBody.data.repository.issue.title, 'Shared issue');

    const mcp = await fetch(`${app.baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }),
    });
    assert.equal(mcp.status, 200);
    const mcpBody = await mcp.json() as any;
    assert.equal(mcpBody.id, 7);
    assert.ok(mcpBody.result.tools.length >= 6);

    const malformed = await fetch(`${app.baseUrl}/api/v3/user/repos`, {
      method: 'POST',
      headers,
      body: '{bad',
    });
    assert.equal(malformed.status, 400);
    assert.equal(typeof (await malformed.json() as any).message, 'string');

    const unauthenticated = await fetch(`${app.baseUrl}/api/v3/user/repos`);
    assert.equal(unauthenticated.status, 401);
  } finally {
    await app.close();
    delete process.env.MAKEFUN_SHOP_TOKEN;
    delete process.env.MAKEFUN_LOGIN;
  }
});
