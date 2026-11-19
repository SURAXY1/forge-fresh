// The HTTP layer: one node:http server routing the four surfaces — git smart
// HTTP, REST v3, GraphQL and MCP — over the shared store. Handlers stay
// allocation-light: the URL is split by hand, cached serialised views are
// served as-is, and every response carries the request id the API promises.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { advertisementV0, advertisementV2, receivePack, uploadPack } from './git.ts';
import { executeGraphql } from './graphql.ts';
import { handleRpc } from './mcp.ts';
import { routeRest } from './rest.ts';
import { store } from './store.ts';

let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return requestSeq.toString(16).padStart(16, '0');
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

interface Reply {
  status: number;
  body: string | Buffer;
  contentType: string;
  headers?: Record<string, string>;
}

function send(response: ServerResponse, reply: Reply, requestId: string): void {
  const body = typeof reply.body === 'string' ? Buffer.from(reply.body, 'utf8') : reply.body;
  response.writeHead(reply.status, {
    'content-type': reply.contentType,
    'content-length': body.length,
    'x-github-request-id': requestId,
    'x-github-media-type': 'github.v3',
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': '4999',
    'x-ratelimit-reset': '0',
    ...reply.headers,
  });
  response.end(body);
}

const JSON_TYPE = 'application/json; charset=utf-8';

function jsonReply(status: number, value: unknown): Reply {
  return { status, body: JSON.stringify(value), contentType: JSON_TYPE };
}

function authed(request: IncomingMessage, token: string): boolean {
  if (token === '') return true;
  const header = request.headers.authorization;
  return header === `Bearer ${token}`;
}

function unauthorized(): Reply {
  return jsonReply(401, { message: 'Bad credentials' });
}

export function createApp(token: string): Server {
  const server = createServer((request, response) => {
    handle(request, response, token).catch(() => {
      if (!response.headersSent) {
        try {
          send(response, jsonReply(500, { message: 'Internal error' }), nextRequestId());
        } catch {
          // The socket is gone; nothing more to do.
        }
      }
    });
  });
  server.keepAliveTimeout = 30_000;
  return server;
}

async function handle(request: IncomingMessage, response: ServerResponse, token: string): Promise<void> {
  const requestId = nextRequestId();
  const method = request.method ?? 'GET';
  const rawUrl = request.url ?? '/';
  const queryIndex = rawUrl.indexOf('?');
  const path = queryIndex >= 0 ? rawUrl.slice(0, queryIndex) : rawUrl;
  const query = new URLSearchParams(queryIndex >= 0 ? rawUrl.slice(queryIndex + 1) : '');
  const host = request.headers.host ?? 'localhost';
  const origin = `http://${host}`;

  if (path === '/healthz') {
    send(response, { status: 200, body: '{"ok":true}', contentType: JSON_TYPE }, requestId);
    return;
  }

  // ---- MCP: auth before parsing, JSON-RPC errors for bad bodies.
  if (path === '/mcp') {
    if (!authed(request, token)) {
      send(response, unauthorized(), requestId);
      return;
    }
    if (method !== 'POST') {
      send(response, jsonReply(405, { message: 'Method Not Allowed' }), requestId);
      return;
    }
    const body = await readBody(request);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      send(response, {
        status: 400,
        body: '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}',
        contentType: JSON_TYPE,
      }, requestId);
      return;
    }
    if (Array.isArray(parsed)) {
      const replies: string[] = [];
      for (const item of parsed) {
        const reply = handleRpc(item as Record<string, unknown>);
        if (reply !== null) replies.push(reply);
      }
      send(response, { status: 200, body: `[${replies.join(',')}]`, contentType: JSON_TYPE }, requestId);
      return;
    }
    const reply = handleRpc(parsed as Record<string, unknown>);
    if (reply === null) {
      response.writeHead(202, { 'x-github-request-id': requestId });
      response.end();
      return;
    }
    send(response, { status: 200, body: reply, contentType: JSON_TYPE }, requestId);
    return;
  }

  // ---- GraphQL.
  if (path === '/api/graphql') {
    if (!authed(request, token)) {
      send(response, unauthorized(), requestId);
      return;
    }
    if (method !== 'POST') {
      send(response, jsonReply(405, { message: 'Method Not Allowed' }), requestId);
      return;
    }
    const body = await readBody(request);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      send(response, jsonReply(400, { errors: [{ message: 'request body is not valid JSON' }] }), requestId);
      return;
    }
    if (Array.isArray(parsed)) {
      const results = parsed.map((item) => {
        const op = (item ?? {}) as { query?: unknown; variables?: unknown };
        return executeGraphql(
          typeof op.query === 'string' ? op.query : '',
          (op.variables ?? {}) as Record<string, unknown>,
        );
      });
      send(response, { status: 200, body: JSON.stringify(results), contentType: JSON_TYPE }, requestId);
      return;
    }
    const op = (parsed ?? {}) as { query?: unknown; variables?: unknown };
    const result = executeGraphql(
      typeof op.query === 'string' ? op.query : '',
      (op.variables ?? {}) as Record<string, unknown>,
    );
    send(response, { status: 200, body: JSON.stringify(result), contentType: JSON_TYPE }, requestId);
    return;
  }

  // ---- REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authed(request, token)) {
      send(response, unauthorized(), requestId);
      return;
    }
    let body: unknown = undefined;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(request);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          send(response, jsonReply(400, { message: 'Problems parsing JSON' }), requestId);
          return;
        }
      }
    }
    const result = routeRest(method, path, query, body, origin);
    send(response, {
      status: result.status,
      body: result.text,
      contentType: result.contentType ?? JSON_TYPE,
      headers: result.headers,
    }, requestId);
    return;
  }

  // ---- Git smart HTTP: /{owner}/{repo}.git/...
  if (path.endsWith('/info/refs') || path.endsWith('/git-upload-pack') || path.endsWith('/git-receive-pack')) {
    if (!authed(request, token)) {
      send(response, unauthorized(), requestId);
      return;
    }
    const segments = path.split('/');
    // ['', owner, repo.git, ...]
    const owner = decodeURIComponent(segments[1] ?? '');
    const repoSegment = segments[2] ?? '';
    const repoName = repoSegment.endsWith('.git') ? repoSegment.slice(0, -4) : repoSegment;
    const repo = store.getRepo(owner, decodeURIComponent(repoName));
    if (!repo) {
      send(response, jsonReply(404, { message: 'Not Found' }), requestId);
      return;
    }
    if (path.endsWith('/info/refs')) {
      const service = query.get('service') ?? '';
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        send(response, { status: 400, body: 'missing or unknown service', contentType: 'text/plain; charset=utf-8' }, requestId);
        return;
      }
      const protocol = request.headers['git-protocol'];
      const isV2 = service === 'git-upload-pack' && typeof protocol === 'string' && protocol.includes('version=2');
      const body = isV2 ? advertisementV2() : advertisementV0(repo, service);
      send(response, {
        status: 200,
        body,
        contentType: `application/x-${service}-advertisement`,
        headers: { 'cache-control': 'no-cache' },
      }, requestId);
      return;
    }
    const isUpload = path.endsWith('/git-upload-pack');
    const raw = await readBody(request);
    try {
      if (isUpload) {
        const protocol = request.headers['git-protocol'];
        const isV2 = typeof protocol === 'string' && protocol.includes('version=2');
        const body = uploadPack(repo, raw, isV2);
        send(response, { status: 200, body, contentType: 'application/x-git-upload-pack-result' }, requestId);
      } else {
        const outcome = receivePack(repo, raw);
        send(response, { status: 200, body: outcome.body, contentType: 'application/x-git-receive-pack-result' }, requestId);
      }
    } catch {
      send(response, { status: 400, body: 'bad request', contentType: 'text/plain; charset=utf-8' }, requestId);
    }
    return;
  }

  send(response, jsonReply(404, { message: 'Not Found' }), requestId);
}
