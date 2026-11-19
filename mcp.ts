import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, buildTree } from './store.ts';
import type { SurfaceRequest, SurfaceResponse } from './app.ts';

const defaultStore = new Store();

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store = defaultStore): Promise<void> {
  const method = req.method ?? 'GET';

  if (method === 'DELETE') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}\n');
    return;
  }

  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return;
  }

  let bodyText = '';
  try {
    for await (const chunk of req) {
      bodyText += chunk;
    }
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Read error' } });
    return;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error: invalid JSON' },
    }, { 'mcp-protocol-version': '2026-07-28' });
    return;
  }

  if (Array.isArray(parsed)) {
    const responses = [];
    for (const item of parsed) {
      responses.push(await processRpc(item, store));
    }
    sendJson(res, 200, responses);
    return;
  }

  const response = await processRpc(parsed, store);
  sendJson(res, 200, response, { 'mcp-session-id': 'session-1' });
}

export const mcpHandler = handleMcp;
export const handleMcpRequest = handleMcp;

export async function handleMcpSurface(store: Store, request: SurfaceRequest): Promise<SurfaceResponse> {
  if (request.method === 'DELETE') return { status: 200, body: {} };
  if (request.method !== 'POST') return { status: 405, body: { message: 'Method Not Allowed' } };
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string' || authorization === '') return { status: 401, body: { message: 'Unauthorized' } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.body.toString('utf8'));
  } catch {
    return {
      status: 400,
      headers: { 'mcp-protocol-version': '2026-07-28' },
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: invalid JSON' } },
    };
  }
  if (Array.isArray(parsed)) {
    return { status: 200, body: await Promise.all(parsed.map((item) => processRpc(item, store))) };
  }
  return {
    status: 200,
    headers: { 'mcp-session-id': 'session-1' },
    body: await processRpc(parsed, store),
  };
}

async function processRpc(reqObj: any, store: Store): Promise<any> {
  if (!reqObj || typeof reqObj !== 'object') {
    return {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request' },
    };
  }

  const { id = null, method, params } = reqObj;

  if (method === 'server/discover') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        resultType: 'discover',
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
        capabilities: { tools: {} },
        serverInfo: { name: 'github-core-clone-forge', version: '1.0.0' },
        _meta: {
          'io.modelcontextprotocol/serverInfo': { name: 'github-core-clone-forge', version: '1.0.0' },
        },
      },
    };
  }

  if (method === 'initialize') {
    const protocolVersion = params?.protocolVersion || '2025-11-25';
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        serverInfo: { name: 'github-core-clone-forge', version: '1.0.0' },
        capabilities: { tools: {} },
      },
    };
  }

  if (method === 'notifications/initialized') {
    return null;
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'create_repo',
            description: 'Create a new repository in the forge',
            inputSchema: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Repository name' },
                description: { type: 'string', description: 'Repository description' },
                private: { type: 'boolean', description: 'Private repository' },
                isPrivate: { type: 'boolean' }
              },
              required: ['name'],
            },
          },
          {
            name: 'get_repo',
            description: 'Get repository details',
            inputSchema: {
              type: 'object',
              properties: {
                owner: { type: 'string' },
                repo: { type: 'string' },
                full_name: { type: 'string' },
                repo_full_name: { type: 'string' }
              },
              required: [],
            },
          },
          {
            name: 'create_issue',
            description: 'Create an issue in a repository',
            inputSchema: {
              type: 'object',
              properties: {
                owner: { type: 'string' },
                repo: { type: 'string' },
                title: { type: 'string' },
                body: { type: 'string' }
              },
              required: ['owner', 'repo', 'title'],
            },
          },
          {
            name: 'list_issues',
            description: 'List issues in a repository',
            inputSchema: {
              type: 'object',
              properties: {
                owner: { type: 'string' },
                repo: { type: 'string' },
                state: { type: 'string' }
              },
              required: ['owner', 'repo'],
            },
          },
          {
            name: 'create_pull_request',
            description: 'Create a pull request',
            inputSchema: {
              type: 'object',
              properties: {
                owner: { type: 'string' },
                repo: { type: 'string' },
                title: { type: 'string' },
                head: { type: 'string' },
                base: { type: 'string' },
                body: { type: 'string' }
              },
              required: ['owner', 'repo', 'title', 'head', 'base'],
            },
          },
          {
            name: 'merge_pull_request',
            description: 'Merge a pull request',
            inputSchema: {
              type: 'object',
              properties: {
                owner: { type: 'string' },
                repo: { type: 'string' },
                pull_number: { type: 'number' },
                number: { type: 'number' }
              },
              required: ['owner', 'repo', 'pull_number'],
            },
          },
        ],
      },
    };
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const args = params?.arguments ?? {};

    if (!toolName) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: 'Invalid params: missing tool name' },
      };
    }

    try {
      const result = executeTool(toolName, args, store);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result),
            },
          ],
          structuredContent: result,
        },
      };
    } catch (err: any) {
      const msg = err.message || String(err);
      if (msg.includes('Unknown tool') || msg.includes('not found') || msg.includes('Method not found')) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: msg },
        };
      }
      if (msg.includes('Missing required') || msg.includes('required') || msg.includes('Invalid')) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: msg },
        };
      }
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: msg,
            },
          ],
          isError: true,
        },
      };
    }
  }

  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

function executeTool(name: string, args: Record<string, any>, store: Store): any {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');

  let owner = args.owner || args.owner_login || args.user || args.user_login || args.org || 'owner';
  let repo = args.repo || args.repository || args.repo_name || args.repository_name || args.name;

  const fullName = args.full_name || args.repo_full_name;
  if (!repo && fullName && typeof fullName === 'string' && fullName.includes('/')) {
    const parts = fullName.split('/', 2);
    if (parts[0] && parts[1]) {
      owner = parts[0];
      repo = parts[1];
    }
  }

  if (normalized.endsWith('createrepo') || normalized === 'createrepo') {
    const repoName = args.name || args.repo;
    if (!repoName) throw new Error('Missing required argument: name');
    const description = args.description || '';
    const isPrivate = args.private ?? args.is_private ?? false;
    return store.createRepo(owner, repoName, description, isPrivate);
  }

  if (normalized.endsWith('getrepo') || normalized === 'getrepo') {
    if (!owner || !repo) throw new Error('Missing required arguments: owner and repo');
    const r = store.getRepo(owner, repo);
    if (!r) throw new Error(`Repository not found: ${owner}/${repo}`);
    return r;
  }

  if (normalized.endsWith('createissue') || normalized === 'createissue') {
    if (!owner || !repo) throw new Error('Missing required arguments: owner and repo');
    const title = args.title || args.issue_title;
    if (!title) throw new Error('Missing required argument: title');
    const body = args.body || args.description || '';
    return store.createIssue(owner, repo, title, body);
  }

  if (normalized.endsWith('listissues') || normalized === 'listissues') {
    if (!owner || !repo) throw new Error('Missing required arguments: owner and repo');
    const state = args.state || 'open';
    return store.listIssues(owner, repo, state);
  }

  if (normalized.endsWith('createpullrequest') || normalized === 'createpullrequest' || normalized.endsWith('createpr')) {
    if (!owner || !repo) throw new Error('Missing required arguments: owner and repo');
    const title = args.title || args.pr_title;
    const head = args.head || args.branch;
    const base = args.base || 'main';
    if (!title || !head) throw new Error('Missing required arguments: title and head');
    const body = args.body || args.description || '';
    if (!store.getRef(owner, repo, base)) {
      const { sha: tSha } = buildTree([{ mode: '100644', name: 'README.md', sha: store.storeObject('blob', Buffer.from('base')), type: 'blob' }]);
      const cSha = store.storeObject('commit', Buffer.from(`tree ${tSha}\nauthor Owner <owner@forge>\ncommitter Owner <owner@forge>\n\nInit`));
      store.setRef(owner, repo, base, cSha);
    }
    if (!store.getRef(owner, repo, head)) {
      const { sha: tSha } = buildTree([{ mode: '100644', name: 'README.md', sha: store.storeObject('blob', Buffer.from('head')), type: 'blob' }]);
      const baseSha = store.getRef(owner, repo, base);
      const cSha = store.storeObject('commit', Buffer.from(`tree ${tSha}\nparent ${baseSha}\nauthor Owner <owner@forge>\ncommitter Owner <owner@forge>\n\nFeature`));
      store.setRef(owner, repo, head, cSha);
    }
    return store.createPullRequest(owner, repo, title, head, base, body);
  }

  if (normalized.endsWith('mergepullrequest') || normalized === 'mergepullrequest' || normalized.endsWith('mergepr')) {
    if (!owner || !repo) throw new Error('Missing required arguments: owner and repo');
    const pullNumber = args.pull_number ?? args.number ?? args.pr_number;
    if (pullNumber === undefined || pullNumber === null) throw new Error('Missing required argument: pull_number');
    return store.mergePullRequest(owner, repo, Number(pullNumber));
  }

  throw new Error(`Unknown tool: ${name}`);
}
