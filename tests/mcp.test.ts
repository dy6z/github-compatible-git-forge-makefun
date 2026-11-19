import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { handleMcp } from '../mcp.ts';
import { Store } from '../store.ts';

async function makeTestServer() {
  const store = new Store();
  const server = http.createServer((req, res) => {
    handleMcp(req, res, store);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function rpcPost(url: string, body: any, headers: Record<string, string> = { authorization: 'Bearer secret' }) {
  const res = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, text, json };
}

test('MCP - server/discover', async () => {
  const srv = await makeTestServer();
  try {
    const res = await rpcPost(srv.url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: {},
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.result.resultType, 'discover');
    assert.ok(Array.isArray(res.json.result.supportedVersions));
    assert.ok(res.json.result.supportedVersions.includes('2026-07-28'));
    assert.strictEqual(res.json.result.serverInfo.name, 'github-core-clone-forge');
  } finally {
    await srv.close();
  }
});

test('MCP - initialize and tools/list', async () => {
  const srv = await makeTestServer();
  try {
    // initialize
    const initRes = await rpcPost(srv.url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {} },
    });
    assert.strictEqual(initRes.status, 200);
    assert.strictEqual(initRes.json.result.protocolVersion, '2025-11-25');

    // tools/list
    const listRes = await rpcPost(srv.url, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });
    assert.strictEqual(listRes.status, 200);
    const tools = listRes.json.result.tools;
    assert.ok(tools.length >= 6);

    const names = tools.map((t: any) => t.name);
    for (const required of ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request']) {
      assert.ok(names.includes(required), `Missing required tool: ${required}`);
    }

    // verify tool schemas
    for (const tool of tools) {
      assert.ok(typeof tool.description === 'string' && tool.description.length > 0);
      assert.strictEqual(tool.inputSchema.type, 'object');
    }
  } finally {
    await srv.close();
  }
});

test('MCP - tools/call all 6 tools workflow', async () => {
  const srv = await makeTestServer();
  try {
    // 1. create_repo
    const createRepoRes = await rpcPost(srv.url, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'create_repo',
        arguments: { owner: 'octocat', name: 'hello-world', description: 'Test repo', private: true },
      },
    });
    assert.strictEqual(createRepoRes.status, 200);
    assert.strictEqual(createRepoRes.json.error, undefined);
    assert.strictEqual(createRepoRes.json.result.structuredContent.name, 'hello-world');

    // 2. get_repo
    const getRepoRes = await rpcPost(srv.url, {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: {
        name: 'get_repo',
        arguments: { owner: 'octocat', repo: 'hello-world' },
      },
    });
    assert.strictEqual(getRepoRes.status, 200);
    assert.strictEqual(getRepoRes.json.result.structuredContent.owner, 'octocat');

    // 3. create_issue
    const createIssueRes = await rpcPost(srv.url, {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: {
        name: 'create_issue',
        arguments: { owner: 'octocat', repo: 'hello-world', title: 'Bug in login', body: 'Please fix' },
      },
    });
    assert.strictEqual(createIssueRes.status, 200);
    const issueNum = createIssueRes.json.result.structuredContent.number;
    assert.strictEqual(issueNum, 1);

    // 4. list_issues
    const listIssuesRes = await rpcPost(srv.url, {
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: {
        name: 'list_issues',
        arguments: { owner: 'octocat', repo: 'hello-world', state: 'open' },
      },
    });
    assert.strictEqual(listIssuesRes.status, 200);
    assert.strictEqual(listIssuesRes.json.result.structuredContent.length, 1);

    // 5. create_pull_request
    const createPrRes = await rpcPost(srv.url, {
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: {
        name: 'create_pull_request',
        arguments: { owner: 'octocat', repo: 'hello-world', title: 'Feature fix', head: 'feature', base: 'main', body: 'PR body' },
      },
    });
    assert.strictEqual(createPrRes.status, 200);
    const prNum = createPrRes.json.result.structuredContent.number;
    assert.strictEqual(prNum, 1);

    // 6. merge_pull_request
    const mergePrRes = await rpcPost(srv.url, {
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: {
        name: 'merge_pull_request',
        arguments: { owner: 'octocat', repo: 'hello-world', pull_number: 1 },
      },
    });
    assert.strictEqual(mergePrRes.status, 200);
    assert.strictEqual(mergePrRes.json.result.structuredContent.merged, true);
  } finally {
    await srv.close();
  }
});

test('MCP - error paths (unknown tool, parse error, missing args, auth required)', async () => {
  const srv = await makeTestServer();
  try {
    // Unknown tool (-32601)
    const unknownRes = await rpcPost(srv.url, {
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: { name: 'non_existent_tool', arguments: {} },
    });
    assert.strictEqual(unknownRes.status, 200);
    assert.strictEqual(unknownRes.json.error.code, -32601);

    // Missing arguments (-32602)
    const missingArgsRes = await rpcPost(srv.url, {
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: { name: 'create_repo', arguments: {} },
    });
    assert.strictEqual(missingArgsRes.status, 200);
    assert.strictEqual(missingArgsRes.json.error.code, -32602);

    // Parse error (-32700 with HTTP 400)
    const parseErrRes = await rpcPost(srv.url, '{"jsonrpc": "2.0", "id": 22, "method": "tools/list"');
    assert.strictEqual(parseErrRes.status, 400);
    assert.strictEqual(parseErrRes.json.error.code, -32700);

    // Auth required (HTTP 401)
    const authRes = await rpcPost(srv.url, {
      jsonrpc: '2.0',
      id: 23,
      method: 'tools/list',
    }, {}); // no auth header
    assert.strictEqual(authRes.status, 401);
  } finally {
    await srv.close();
  }
});

test('MCP - concurrent calls and idempotency', async () => {
  const srv = await makeTestServer();
  try {
    // Concurrent tools/list
    const [p1, p2] = await Promise.all([
      rpcPost(srv.url, { jsonrpc: '2.0', id: 30, method: 'tools/list', params: {} }),
      rpcPost(srv.url, { jsonrpc: '2.0', id: 31, method: 'tools/list', params: {} }),
    ]);

    assert.strictEqual(p1.status, 200);
    assert.strictEqual(p2.status, 200);
    assert.strictEqual(p1.json.id, 30);
    assert.strictEqual(p2.json.id, 31);
    assert.strictEqual(JSON.stringify(p1.json.result), JSON.stringify(p2.json.result));
  } finally {
    await srv.close();
  }
});
