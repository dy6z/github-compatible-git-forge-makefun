import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcpSurface } from './mcp.ts';
import { handleGitRequest } from './git-http.ts';

export interface SurfaceResponse {
  status: number;
  headers?: Record<string, string>;
  body?: Buffer | string | unknown;
}

export interface SurfaceRequest {
  method: string;
  url: URL;
  headers: IncomingMessage['headers'];
  body: Buffer;
  owner: string;
}

const MAX_BODY_BYTES = 64 * 1024 * 1024;
let responseSequence = 0;

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new Error('request body is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function requestOwner(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ') || authorization.length <= 7) return null;
  const token = authorization.slice(7);
  const configured = process.env.MAKEFUN_SHOP_TOKEN;
  if (configured && token !== configured) return null;
  return process.env.MAKEFUN_LOGIN || process.env.MAKEFUN_SHOP_LOGIN || 'adaiversen';
}

function writeResponse(response: ServerResponse, result: SurfaceResponse): void {
  response.statusCode = result.status;
  response.setHeader('x-github-request-id', `forge-${(++responseSequence).toString(36)}`);
  for (const [name, value] of Object.entries(result.headers ?? {})) response.setHeader(name, value);
  if (result.body === undefined || result.status === 204) {
    response.end();
    return;
  }
  if (Buffer.isBuffer(result.body) || typeof result.body === 'string') {
    response.end(result.body);
    return;
  }
  if (!response.hasHeader('content-type')) response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(result.body));
}

function errorResult(status: number, message: string): SurfaceResponse {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: { message } };
}

export function createApp(): Server {
  const store = new Store();
  return createServer({ keepAlive: true, requestTimeout: 0, headersTimeout: 0 }, async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://forge.local');
      if (url.pathname === '/healthz') {
        writeResponse(response, { status: 200, body: { ok: true } });
        return;
      }
      const owner = requestOwner(request);
      if (owner === null) {
        writeResponse(response, errorResult(401, 'Requires authentication'));
        return;
      }
      const body = await readRequestBody(request);
      const common: SurfaceRequest = {
        method: request.method ?? 'GET',
        url,
        headers: request.headers,
        body,
        owner,
      };

      let result: SurfaceResponse | null = null;
      if (url.pathname === '/mcp') {
        result = await handleMcpSurface(store, common);
      } else if (url.pathname === '/api/graphql') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          result = errorResult(400, 'Malformed JSON');
        }
        if (result === null) {
          const executed = await executeGraphQL(store, parsed, request.headers.authorization);
          result = { status: executed.status, body: executed.body };
        }
      } else if (url.pathname === '/api/v3' || url.pathname.startsWith('/api/v3/')) {
        let parsed: unknown = undefined;
        if (body.length > 0) {
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            result = errorResult(400, 'Malformed JSON');
          }
        }
        if (result === null) {
          const path = url.pathname === '/api/v3' ? '' : url.pathname.slice('/api/v3/'.length);
          const answer = handleRest({
            store,
            owner,
            method: common.method,
            path,
            query: url.searchParams,
            body: parsed,
            authenticated: true,
            requestId: 'forge',
          });
          const answerHeaders = { ...(answer.headers ?? {}) };
          if (answerHeaders.link && request.headers.host) {
            answerHeaders.link = answerHeaders.link.replaceAll('http://forge', `http://${request.headers.host}`);
          }
          result = { status: answer.status, headers: answerHeaders, body: answer.body };
        }
      } else if (url.pathname.includes('.git/')) {
        const headers = Object.fromEntries(
          Object.entries(request.headers).flatMap(([name, value]) => typeof value === 'string' ? [[name, value]] : []),
        );
        result = await handleGitRequest(store, common.method, `${url.pathname}${url.search}`, headers, body);
      }
      writeResponse(response, result ?? errorResult(404, 'Not Found'));
    } catch (error) {
      writeResponse(response, errorResult(500, error instanceof Error ? error.message : String(error)));
    }
  });
}
