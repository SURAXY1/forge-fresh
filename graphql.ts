// A small GraphQL engine for the forge's schema: a tokenizer, a parser for
// the document shapes clients use (fields, arguments, variables, input
// objects, enum values, inline fragments, aliases) and an executor over the
// shared store. Unknown fields answer with a GraphQL error naming the field,
// exactly as the real API does, rather than a transport failure.

import { flatTreeOfCommit } from './gitcore.ts';
import { VIEWER } from './scenario.ts';
import {
  createIssue,
  createPull,
  findIssue,
  findPull,
  issueGlobalId,
  mergePull,
  parseGlobalId,
  pullGlobalId,
  pullMergeable,
  repoGlobalId,
  store,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------- tokenizer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:$=!@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end < 0 ? source.length : end) });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'int', value: Number(source.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${ch}`);
  }
  return tokens;
}

// ---------------------------------------------------------------- AST

type Value =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

interface FieldNode {
  alias: string | null;
  name: string;
  args: { name: string; value: Value }[];
  selection: FieldNode[] | null;
  fragmentType: string | null;
}

interface Operation {
  type: 'query' | 'mutation';
  fields: FieldNode[];
}

class Parser {
  private tokens: Token[];
  private pos = 0;
  constructor(source: string) {
    this.tokens = tokenize(source);
  }
  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const token = this.tokens[this.pos];
    this.pos += 1;
    if (!token) throw new Error('unexpected end of document');
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }
  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  private name(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): Operation {
    let type: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first && first.kind === 'name' && (first.value === 'query' || first.value === 'mutation' || first.value === 'subscription')) {
      this.next();
      type = first.value === 'mutation' ? 'mutation' : 'query';
      const maybeName = this.peek();
      if (maybeName && maybeName.kind === 'name') this.next();
      if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') this.parseVariableDefinitions();
    }
    const fields = this.parseSelectionSet();
    return { type, fields };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      this.name();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
    }
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.name();
    }
    this.skipPunct('!');
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.name() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (!this.skipPunct(']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: Value }[] = [];
      while (!this.skipPunct('}')) {
        const name = this.name();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value token');
  }

  private parseSelectionSet(): FieldNode[] {
    this.expectPunct('{');
    const fields: FieldNode[] = [];
    while (!this.skipPunct('}')) fields.push(this.parseField());
    return fields;
  }

  private parseField(): FieldNode {
    const head = this.peek();
    if (head && head.kind === 'spread') {
      this.next();
      const keyword = this.name();
      if (keyword !== 'on') throw new Error('only inline fragments are supported');
      const typeName = this.name();
      const selection = this.parseSelectionSet();
      return { alias: null, name: '', args: [], selection, fragmentType: typeName };
    }
    let name = this.name();
    let alias: string | null = null;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.name();
    }
    const args: { name: string; value: Value }[] = [];
    if (this.skipPunct('(')) {
      while (!this.skipPunct(')')) {
        const argName = this.name();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    let selection: FieldNode[] | null = null;
    const nextToken = this.peek();
    if (nextToken && nextToken.kind === 'punct' && nextToken.value === '{') selection = this.parseSelectionSet();
    return { alias, name, args, selection, fragmentType: null };
  }
}

// ---------------------------------------------------------------- resolution

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'string':
    case 'int':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'variable':
      return variables[value.name] ?? null;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

class GqlError extends Error {}

const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'];
const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body'];
const PULL_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'];

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: REPO_FIELDS,
  Issue: ISSUE_FIELDS,
  PullRequest: PULL_FIELDS,
  User: ['id', 'login', 'name', 'email'],
  IssueComment: ['id', 'body'],
  Label: ['id', 'name', 'color'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  Permission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

interface Ctx {
  variables: Record<string, unknown>;
}

function select(
  typeName: string,
  value: Record<string, (field: FieldNode, ctx: Ctx) => unknown> | null,
  fields: FieldNode[] | null,
  ctx: Ctx,
): Record<string, unknown> | null {
  if (value === null) return null;
  if (!fields) return {};
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.fragmentType) {
      if (field.fragmentType === typeName && field.selection) {
        Object.assign(out, select(typeName, value, field.selection, ctx));
      }
      continue;
    }
    const key = field.alias ?? field.name;
    const resolver = value[field.name];
    if (!resolver) {
      if (field.name === '__typename') {
        out[key] = typeName;
        continue;
      }
      throw new GqlError(`Field '${field.name}' doesn't exist on type '${typeName}'`);
    }
    out[key] = resolver(field, ctx);
  }
  return out;
}

function userNode(): Record<string, (field: FieldNode, ctx: Ctx) => unknown> {
  return {
    id: () => Buffer.from(`User:${VIEWER.id}`, 'utf8').toString('base64'),
    login: () => VIEWER.login,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
  };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueNode(repo: Repo, issue: Issue): Record<string, (field: FieldNode, ctx: Ctx) => unknown> {
  return {
    id: () => issueGlobalId(repo, issue),
    number: () => issue.number,
    title: () => issue.title,
    state: () => issueState(issue),
    body: () => issue.body,
  };
}

function pullNode(repo: Repo, pull: Pull): Record<string, (field: FieldNode, ctx: Ctx) => unknown> {
  return {
    id: () => pullGlobalId(repo, pull),
    number: () => pull.number,
    title: () => pull.title,
    body: () => pull.body,
    state: () => pullState(pull),
    merged: () => pull.merged,
    headRefName: () => pull.head,
    baseRefName: () => pull.base,
    mergeable: () => (pull.merged ? 'UNKNOWN' : pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING'),
    files: (field, ctx) => {
      const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
      const baseSha = repo.refs.get(`refs/heads/${pull.base}`);
      const paths = new Set<string>();
      if (baseSha) {
        // File paths whose blob differs between the base and head trees.
        const baseFlat = flatTreeOfCommit(repo.objects, baseSha);
        const headFlat = flatTreeOfCommit(repo.objects, headSha);
        for (const key of baseFlat.keys()) paths.add(key);
        for (const key of headFlat.keys()) paths.add(key);
        for (const path of [...paths]) {
          if (baseFlat.get(path)?.oid === headFlat.get(path)?.oid) paths.delete(path);
        }
      }
      const nodes = [...paths].sort().map((path) => select('PullRequestFile', { path: () => path }, field.selection, ctx));
      return select('PullRequestFileConnection', { nodes: () => nodes }, field.selection, ctx);
    },
  };
}

function connection<T>(
  items: T[],
  field: FieldNode,
  ctx: Ctx,
  nodeType: string,
  makeNode: (item: T) => Record<string, (f: FieldNode, c: Ctx) => unknown>,
): Record<string, unknown> | null {
  const args = argsOf(field, ctx.variables);
  const first = typeof args.first === 'number' ? args.first : items.length;
  const sliced = items.slice(0, Math.max(0, first));
  return select(
    `${nodeType}Connection`,
    {
      nodes: (sub) => sliced.map((item) => select(nodeType, makeNode(item), sub.selection, ctx)),
      edges: (sub) =>
        sliced.map((item) => select(`${nodeType}Edge`, { node: (n) => select(nodeType, makeNode(item), n.selection, ctx), cursor: () => '' }, sub.selection, ctx)),
      pageInfo: (sub) =>
        select('PageInfo', {
          hasNextPage: () => items.length > sliced.length,
          hasPreviousPage: () => false,
          startCursor: () => null,
          endCursor: () => null,
        }, sub.selection, ctx),
      totalCount: () => items.length,
    },
    field.selection,
    ctx,
  );
}

function issueConnection(repo: Repo, field: FieldNode, ctx: Ctx): Record<string, unknown> | null {
  const args = argsOf(field, ctx.variables);
  let issues = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  issues.sort((a, b) => a.number - b.number);
  if (orderBy?.direction === 'DESC') issues.reverse();
  const first = typeof args.first === 'number' ? args.first : issues.length;
  const after = typeof args.after === 'string' ? args.after : null;
  let startIndex = 0;
  if (after) {
    const decoded = Number(Buffer.from(after, 'base64').toString('utf8'));
    if (Number.isFinite(decoded)) {
      const index = issues.findIndex((issue) => issue.number === decoded);
      if (index >= 0) startIndex = index + 1;
    }
  }
  const page = issues.slice(startIndex, startIndex + Math.max(0, first));
  const hasNext = startIndex + page.length < issues.length;
  const endCursor = page.length > 0
    ? Buffer.from(String((page[page.length - 1] as Issue).number), 'utf8').toString('base64')
    : null;
  return select(
    'IssueConnection',
    {
      nodes: (sub) => page.map((issue) => select('Issue', issueNode(repo, issue), sub.selection, ctx)),
      edges: (sub) =>
        page.map((issue) =>
          select('IssueEdge', {
            node: (n) => select('Issue', issueNode(repo, issue), n.selection, ctx),
            cursor: () => Buffer.from(String(issue.number), 'utf8').toString('base64'),
          }, sub.selection, ctx)),
      pageInfo: (sub) =>
        select('PageInfo', {
          hasNextPage: () => hasNext,
          hasPreviousPage: () => startIndex > 0,
          startCursor: () => (page.length > 0 ? Buffer.from(String((page[0] as Issue).number), 'utf8').toString('base64') : null),
          endCursor: () => endCursor,
        }, sub.selection, ctx),
      totalCount: () => issues.length,
    },
    field.selection,
    ctx,
  );
}

function repoNode(repo: Repo): Record<string, (field: FieldNode, ctx: Ctx) => unknown> {
  return {
    id: () => repoGlobalId(repo),
    databaseId: () => repo.id,
    name: () => repo.name,
    nameWithOwner: () => `${repo.owner}/${repo.name}`,
    owner: (field, ctx) => select('User', userNode(), field.selection, ctx),
    defaultBranchRef: (field, ctx) =>
      select('Ref', { name: () => repo.defaultBranch, prefix: () => 'refs/heads/', target: () => null }, field.selection, ctx),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (field, ctx) => {
      const args = argsOf(field, ctx.variables);
      const issue = typeof args.number === 'number' ? findIssue(repo, args.number) : null;
      return issue ? select('Issue', issueNode(repo, issue), field.selection, ctx) : null;
    },
    issues: (field, ctx) => issueConnection(repo, field, ctx),
    pullRequests: (field, ctx) =>
      connection([...repo.pulls].sort((a, b) => a.number - b.number), field, ctx, 'PullRequest', (pull) => pullNode(repo, pull)),
    pullRequest: (field, ctx) => {
      const args = argsOf(field, ctx.variables);
      const pull = typeof args.number === 'number' ? findPull(repo, args.number) : null;
      return pull ? select('PullRequest', pullNode(repo, pull), field.selection, ctx) : null;
    },
  };
}

function typeNode(name: string): Record<string, (field: FieldNode, ctx: Ctx) => unknown> | null {
  const fields = TYPE_FIELDS[name];
  const enumValues = ENUM_VALUES[name];
  if (!fields && !enumValues) return null;
  return {
    name: () => name,
    kind: () => (enumValues ? 'ENUM' : 'OBJECT'),
    fields: (field, ctx) =>
      (fields ?? []).map((fieldName) =>
        select('Field', {
          name: () => fieldName,
          description: () => null,
          type: (sub) => select('Type', { name: () => 'String', kind: () => 'SCALAR' }, sub.selection, ctx),
        }, field.selection, ctx)),
    enumValues: (field, ctx) =>
      (enumValues ?? []).map((value) =>
        select('EnumValue', { name: () => value, description: () => null, isDeprecated: () => false }, field.selection, ctx)),
    possibleTypes: () => [],
    inputFields: () => [],
    interfaces: () => [],
    ofType: () => null,
    description: () => null,
  };
}

function nodeById(id: string, field: FieldNode, ctx: Ctx): Record<string, unknown> | null {
  const parsed = parseGlobalId(id);
  if (!parsed) return null;
  const repoId = Number(parsed.parts[0]);
  const repo = Number.isFinite(repoId) ? store.getRepoById(repoId) : null;
  if (!repo) return null;
  if (parsed.kind === 'Repository') return select('Repository', repoNode(repo), field.selection, ctx);
  if (parsed.kind === 'Issue') {
    const issue = findIssue(repo, Number(parsed.parts[1]));
    return issue ? select('Issue', issueNode(repo, issue), field.selection, ctx) : null;
  }
  if (parsed.kind === 'PullRequest') {
    const pull = findPull(repo, Number(parsed.parts[1]));
    return pull ? select('PullRequest', pullNode(repo, pull), field.selection, ctx) : null;
  }
  return null;
}

function repoFromGlobalId(id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'Repository') return null;
  return store.getRepoById(Number(parsed.parts[0]));
}

function queryRoot(): Record<string, (field: FieldNode, ctx: Ctx) => unknown> {
  return {
    viewer: (field, ctx) => select('User', userNode(), field.selection, ctx),
    repository: (field, ctx) => {
      const args = argsOf(field, ctx.variables);
      const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? select('Repository', repoNode(repo), field.selection, ctx) : null;
    },
    node: (field, ctx) => {
      const args = argsOf(field, ctx.variables);
      return typeof args.id === 'string' ? nodeById(args.id, field, ctx) : null;
    },
    __type: (field, ctx) => {
      const args = argsOf(field, ctx.variables);
      const node = typeof args.name === 'string' ? typeNode(args.name) : null;
      return node ? select('Type', node, field.selection, ctx) : null;
    },
    __schema: () => null,
  };
}

function mutationRoot(): Record<string, (field: FieldNode, ctx: Ctx) => unknown> {
  return {
    createIssue: (field, ctx) => {
      const args = argsOf(field, ctx.variables);
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoFromGlobalId(input.repositoryId);
      if (!repo) throw new GqlError('repository not found');
      const labelNames: string[] = [];
      if (Array.isArray(input.labelIds)) {
        for (const raw of input.labelIds) {
          const parsed = typeof raw === 'string' ? parseGlobalId(raw) : null;
          const name = parsed?.kind === 'Label' ? parsed.parts[1] : typeof raw === 'string' ? raw : '';
          if (name && repo.labels.has(name)) labelNames.push(name);
        }
      }
      const issue = createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), labelNames);
      return select('CreateIssuePayload', {
        issue: (sub) => select('Issue', issueNode(repo, issue), sub.selection, ctx),
        clientMutationId: () => (typeof input.clientMutationId === 'string' ? input.clientMutationId : null),
      }, field.selection, ctx);
    },
    closeIssue: (field, ctx) => {
      const args = argsOf(field, ctx.variables);
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = typeof input.issueId === 'string' ? parseGlobalId(input.issueId) : null;
      const repo = parsed ? store.getRepoById(Number(parsed.parts[0])) : null;
      const issue = repo && parsed ? findIssue(repo, Number(parsed.parts[1])) : null;
      if (!repo || !issue) throw new GqlError('issue not found');
      issue.state = 'closed';
      issue.closedAt = new Date().toISOString();
      issue.version += 1;
      store.touch(repo);
      return select('CloseIssuePayload', {
        issue: (sub) => select('Issue', issueNode(repo, issue), sub.selection, ctx),
        clientMutationId: () => null,
      }, field.selection, ctx);
    },
    createPullRequest: (field, ctx) => {
      const args = argsOf(field, ctx.variables);
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoFromGlobalId(input.repositoryId);
      if (!repo) throw new GqlError('repository not found');
      const pull = createPull(
        repo,
        String(input.title ?? ''),
        String(input.body ?? ''),
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? repo.defaultBranch),
      );
      if (!pull) throw new GqlError('head or base ref does not exist');
      return select('CreatePullRequestPayload', {
        pullRequest: (sub) => select('PullRequest', pullNode(repo, pull), sub.selection, ctx),
        clientMutationId: () => null,
      }, field.selection, ctx);
    },
    mergePullRequest: (field, ctx) => {
      const args = argsOf(field, ctx.variables);
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = typeof input.pullRequestId === 'string' ? parseGlobalId(input.pullRequestId) : null;
      const repo = parsed ? store.getRepoById(Number(parsed.parts[0])) : null;
      const pull = repo && parsed ? findPull(repo, Number(parsed.parts[1])) : null;
      if (!repo || !pull) throw new GqlError('pull request not found');
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'squash';
      const result = mergePull(repo, pull, method === 'merge' ? 'merge' : 'squash');
      if (!result.ok) throw new GqlError('Pull Request is not mergeable');
      return select('MergePullRequestPayload', {
        pullRequest: (sub) => select('PullRequest', pullNode(repo, pull), sub.selection, ctx),
        clientMutationId: () => null,
      }, field.selection, ctx);
    },
    addComment: (field, ctx) => {
      const args = argsOf(field, ctx.variables);
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = typeof input.subjectId === 'string' ? parseGlobalId(input.subjectId) : null;
      const repo = parsed ? store.getRepoById(Number(parsed.parts[0])) : null;
      if (!repo || !parsed) throw new GqlError('subject not found');
      const number = Number(parsed.parts[1]);
      const target = parsed.kind === 'PullRequest' ? findPull(repo, number) : findIssue(repo, number);
      if (!target) throw new GqlError('subject not found');
      const now = new Date().toISOString();
      const comment = { id: store.nextCommentId(), body: String(input.body ?? ''), createdAt: now, updatedAt: now };
      target.comments.push(comment);
      if (parsed.kind !== 'PullRequest') (target as Issue).version += 1;
      store.touch(repo);
      const commentId = Buffer.from(`IssueComment:${repo.id}:${number}:${comment.id}`, 'utf8').toString('base64');
      const commentNode = {
        id: () => commentId,
        body: () => comment.body,
      };
      return select('AddCommentPayload', {
        commentEdge: (sub) =>
          select('IssueCommentEdge', {
            node: (n) => select('IssueComment', commentNode, n.selection, ctx),
            cursor: () => '',
          }, sub.selection, ctx),
        clientMutationId: () => null,
      }, field.selection, ctx);
    },
  };
}

/** Execute one GraphQL operation document; returns the response object. */
export function executeGraphql(document: string, variables: Record<string, unknown>): Record<string, unknown> {
  try {
    const operation = new Parser(document).parseDocument();
    const ctx: Ctx = { variables };
    const root = operation.type === 'mutation' ? mutationRoot() : queryRoot();
    const typeName = operation.type === 'mutation' ? 'Mutation' : 'Query';
    const data = select(typeName, root, operation.fields, ctx);
    return { data };
  } catch (error) {
    if (error instanceof GqlError) return { errors: [{ message: error.message }] };
    return { errors: [{ message: error instanceof Error ? error.message : 'graphql error' }] };
  }
}
