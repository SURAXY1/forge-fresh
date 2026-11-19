// The MCP endpoint: JSON-RPC 2.0 over POST /mcp, speaking both discovery
// eras — server/discover for modern clients and the initialize handshake for
// legacy ones. The tools list is a constant, pre-serialised once: tools/list
// is byte-identical across calls and costs one string lookup.

import { VIEWER } from './scenario.ts';
import { createIssue, createPull, findIssue, mergePull, store, type Repo } from './store.ts';
import { issueView, pullView, repoView } from './views.ts';

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'Repository name.' },
      description: { type: 'string', description: 'Optional repository description.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Open a new issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      title: { type: 'string', description: 'Issue title.' },
      body: { type: 'string', description: 'Optional issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      state: { type: 'string', description: 'open, closed or all (default open).' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'get_issue',
    description: 'Read one issue by number.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      issue_number: { type: 'number', description: 'Issue number.' },
    },
    required: ['owner', 'repo', 'issue_number'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      title: { type: 'string', description: 'Pull request title.' },
      head: { type: 'string', description: 'Head branch name.' },
      base: { type: 'string', description: 'Base branch name.' },
      body: { type: 'string', description: 'Optional pull request body.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      state: { type: 'string', description: 'open, closed or all (default open).' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      pull_number: { type: 'number', description: 'Pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

const TOOLS_LIST_JSON = JSON.stringify({
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.properties,
      required: tool.required,
      additionalProperties: false,
    },
  })),
});

const SERVER_INFO = { name: 'forge-fresh', version: '1.0.0' };
const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function result(id: unknown, value: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result: value });
}

function error(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function toolSuccess(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoArg(args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER.login;
  const repo = typeof args.repo === 'string' ? args.repo : '';
  return store.getRepo(owner, repo);
}

function callTool(name: string, args: Record<string, unknown>): { rpcError?: { code: number; message: string }; value?: Record<string, unknown> } {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return { rpcError: { code: -32602, message: `unknown tool: ${name}` } };
  for (const required of tool.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { rpcError: { code: -32602, message: `missing required argument: ${required}` } };
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const existing = store.getRepo(VIEWER.login, repoName);
      if (existing) return { value: toolSuccess(repoView(existing)) };
      const repo = store.createRepo(repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
      if (!repo) return { value: toolFailure('repository already exists') };
      return { value: toolSuccess(repoView(repo)) };
    }
    case 'get_repo': {
      const repo = repoArg(args);
      if (!repo) return { value: toolFailure('repository not found') };
      return { value: toolSuccess(repoView(repo)) };
    }
    case 'create_issue': {
      const repo = repoArg(args);
      if (!repo) return { value: toolFailure('repository not found') };
      const issue = createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      return { value: toolSuccess(issueView(repo, issue)) };
    }
    case 'list_issues': {
      const repo = repoArg(args);
      if (!repo) return { value: toolFailure('repository not found') };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return { value: toolSuccess(issues.map((issue) => issueView(repo, issue))) };
    }
    case 'get_issue': {
      const repo = repoArg(args);
      if (!repo) return { value: toolFailure('repository not found') };
      const issue = findIssue(repo, Number(args.issue_number));
      if (!issue) return { value: toolFailure('issue not found') };
      return { value: toolSuccess(issueView(repo, issue)) };
    }
    case 'create_pull_request': {
      const repo = repoArg(args);
      if (!repo) return { value: toolFailure('repository not found') };
      const pull = createPull(
        repo,
        String(args.title),
        typeof args.body === 'string' ? args.body : '',
        String(args.head),
        String(args.base),
      );
      if (!pull) return { value: toolFailure('head or base branch does not exist') };
      return { value: toolSuccess(pullView(repo, pull)) };
    }
    case 'list_pull_requests': {
      const repo = repoArg(args);
      if (!repo) return { value: toolFailure('repository not found') };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const pulls = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
      return { value: toolSuccess(pulls.map((pull) => pullView(repo, pull))) };
    }
    case 'merge_pull_request': {
      const repo = repoArg(args);
      if (!repo) return { value: toolFailure('repository not found') };
      const pull = repo.pulls.find((candidate) => candidate.number === Number(args.pull_number));
      if (!pull) return { value: toolFailure('pull request not found') };
      const merged = mergePull(repo, pull, 'squash');
      if (!merged.ok) return { value: toolFailure('pull request is not mergeable') };
      return { value: toolSuccess({ ...pullView(repo, pull), sha: merged.sha, merged: true }) };
    }
    default:
      return { rpcError: { code: -32602, message: `unknown tool: ${name}` } };
  }
}

/**
 * Handle one JSON-RPC request object. Returns the response text, or null
 * for notifications (no id), which the HTTP layer answers 202 with no body.
 */
export function handleRpc(request: Record<string, unknown>): string | null {
  const hasId = 'id' in request;
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
  switch (method) {
    case 'server/discover':
      return result(id, {
        supportedVersions: PROTOCOL_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = PROTOCOL_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return result(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return hasId ? result(id, {}) : null;
    case 'tools/list':
      return `{"jsonrpc":"2.0","id":${JSON.stringify(id ?? null)},"result":${TOOLS_LIST_JSON}}`;
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const outcome = callTool(name, args);
      if (outcome.rpcError) return error(id, outcome.rpcError.code, outcome.rpcError.message);
      return result(id, outcome.value);
    }
    default:
      if (!hasId) return null;
      return error(id, -32601, `method not found: ${method}`);
  }
}
