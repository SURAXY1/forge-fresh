// The in-memory store: repositories with their git objects, refs, issues,
// pull requests, labels and comments, plus the JSON views the three API
// surfaces share. One mutation epoch per repository invalidates every cached
// view and every cached git reply for that repository, so a cached answer is
// never served for a different state.

import {
  ZERO_OID,
  buildCommit,
  buildTreeFromFlat,
  commitOf,
  flatTreeOfCommit,
  isAncestor,
  mergeBase,
  mergeFlats,
  putObject,
  type ObjectRecord,
} from './gitcore.ts';
import { VIEWER } from './scenario.ts';

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** bumped whenever the rendered view changes (close, comment, edit). */
  version: number;
  jsonCache?: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, ObjectRecord>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextNumber: number;
  epoch: number;
  jsonCache?: string;
  jsonCacheEpoch: number;
  /** advertisement / ls-refs / fetch caches, keyed under the epoch. */
  gitCache: Map<string, Buffer>;
}

export class Store {
  repos = new Map<string, Repo>();
  private repoSeq = 0;
  private issueSeq = 0;
  private pullSeq = 0;
  private commentSeq = 0;

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    const key = `${VIEWER.login}/${name}`;
    if (this.repos.has(key)) return null;
    this.repoSeq += 1;
    const now = new Date().toISOString();
    const repo: Repo = {
      id: this.repoSeq,
      owner: VIEWER.login,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      epoch: 1,
      jsonCacheEpoch: -1,
      gitCache: new Map(),
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | null {
    if (owner !== VIEWER.login) return null;
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  getRepoById(id: number): Repo | null {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return null;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(`${repo.owner}/${repo.name}`);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  touch(repo: Repo): void {
    repo.epoch += 1;
    repo.updatedAt = new Date().toISOString();
    repo.gitCache.clear();
  }

  nextIssueId(): number {
    this.issueSeq += 1;
    return this.issueSeq;
  }

  nextPullId(): number {
    this.pullSeq += 1;
    return this.pullSeq;
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }
}

export const store = new Store();

// ---------------------------------------------------------------- global ids

/** Opaque, stable global ids (Relay style): base64 of a typed locator. */
export function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    const kind = parts.shift();
    if (!kind) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: Repo): string {
  return globalId('Repository', repo.id);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', repo.id, issue.number);
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return globalId('PullRequest', repo.id, pull.number);
}

export function commentGlobalId(repo: Repo, ownerNumber: number, comment: Comment): string {
  return globalId('IssueComment', repo.id, ownerNumber, comment.id);
}

// ---------------------------------------------------------------- identities

export function viewerIdent(): string {
  return `${VIEWER.name} <${VIEWER.email}>`;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------- git writes

/**
 * Commit a flat tree onto a branch, creating the branch (from the default
 * branch tip, or as a root) when it does not exist yet. Returns the new
 * commit oid.
 */
export function commitFlat(
  repo: Repo,
  branch: string,
  flat: Map<string, { mode: string; oid: string }>,
  message: string,
): string {
  const tree = buildTreeFromFlat(repo.objects, flat);
  const ref = `refs/heads/${branch}`;
  let parent = repo.refs.get(ref);
  if (parent === undefined) {
    parent = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }
  const commitData = buildCommit({
    tree,
    parents: parent ? [parent] : [],
    author: viewerIdent(),
    committer: viewerIdent(),
    timestamp: nowSeconds(),
    message: message.endsWith('\n') ? message : `${message}\n`,
  });
  const oid = putObject(repo.objects, 'commit', commitData);
  repo.refs.set(ref, oid);
  store.touch(repo);
  return oid;
}

/** The tip commit oid of a branch or tag ref name, or a raw oid; else null. */
export function resolveRef(repo: Repo, ref: string): string | null {
  if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const direct = repo.refs.get(ref);
  if (direct) return direct;
  const asBranch = repo.refs.get(`refs/heads/${ref}`);
  if (asBranch) return asBranch;
  const asTag = repo.refs.get(`refs/tags/${ref}`);
  if (asTag) return asTag;
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
  return null;
}

// ---------------------------------------------------------------- domain ops

export function createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
  const now = new Date().toISOString();
  const issue: Issue = {
    id: store.nextIssueId(),
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    version: 1,
  };
  repo.nextNumber += 1;
  repo.issues.push(issue);
  store.touch(repo);
  return issue;
}

export function createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull | null {
  const headSha = repo.refs.get(`refs/heads/${head}`);
  if (!headSha) return null;
  if (!repo.refs.get(`refs/heads/${base}`)) return null;
  const now = new Date().toISOString();
  const pull: Pull = {
    id: store.nextPullId(),
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    head,
    base,
    headSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: now,
    updatedAt: now,
    comments: [],
  };
  repo.nextNumber += 1;
  repo.pulls.push(pull);
  store.touch(repo);
  return pull;
}

export type MergeResult =
  | { ok: true; sha: string }
  | { ok: false; reason: 'not-found' | 'conflict' | 'already-merged' };

/**
 * Merge a pull request into its base branch. Squash makes one commit with
 * the merged tree on top of the base tip; merge keeps both parents.
 */
export function mergePull(repo: Repo, pull: Pull, method: string): MergeResult {
  if (pull.merged) return { ok: false, reason: 'already-merged' };
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`);
  if (!baseSha) return { ok: false, reason: 'conflict' };
  const base = mergeBase(repo.objects, baseSha, headSha);
  const baseFlat = base ? flatTreeOfCommit(repo.objects, base) : new Map();
  const oursFlat = flatTreeOfCommit(repo.objects, baseSha);
  const theirsFlat = flatTreeOfCommit(repo.objects, headSha);
  const merged = mergeFlats(baseFlat, oursFlat, theirsFlat);
  if (!merged.ok) return { ok: false, reason: 'conflict' };
  const tree = buildTreeFromFlat(repo.objects, merged.flat);
  let sha: string;
  if (method === 'merge') {
    const data = buildCommit({
      tree,
      parents: [baseSha, headSha],
      author: viewerIdent(),
      committer: viewerIdent(),
      timestamp: nowSeconds(),
      message: `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}\n`,
    });
    sha = putObject(repo.objects, 'commit', data);
  } else {
    const body = pull.body ? `\n\n${pull.body}\n` : '\n';
    const data = buildCommit({
      tree,
      parents: [baseSha],
      author: viewerIdent(),
      committer: viewerIdent(),
      timestamp: nowSeconds(),
      message: `${pull.title} (#${pull.number})${body}`,
    });
    sha = putObject(repo.objects, 'commit', data);
  }
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = new Date().toISOString();
  pull.mergeCommitSha = sha;
  pull.updatedAt = pull.mergedAt;
  store.touch(repo);
  return { ok: true, sha };
}

/** Whether a pull request would merge cleanly right now. */
export function pullMergeable(repo: Repo, pull: Pull): boolean {
  if (pull.merged) return false;
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`);
  if (!baseSha) return false;
  if (isAncestor(repo.objects, headSha, baseSha)) return true;
  const base = mergeBase(repo.objects, baseSha, headSha);
  const merged = mergeFlats(
    base ? flatTreeOfCommit(repo.objects, base) : new Map(),
    flatTreeOfCommit(repo.objects, baseSha),
    flatTreeOfCommit(repo.objects, headSha),
  );
  return merged.ok;
}

export function findIssue(repo: Repo, number: number): Issue | null {
  for (const issue of repo.issues) if (issue.number === number) return issue;
  return null;
}

export function findPull(repo: Repo, number: number): Pull | null {
  for (const pull of repo.pulls) if (pull.number === number) return pull;
  return null;
}

/** The commits reachable from a tip, newest first (DFS pre-order). */
export function listCommits(repo: Repo, tip: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const record = repo.objects.get(oid);
    if (!record || record.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    const parents = commitOf(record).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
  }
  return out;
}

export { ZERO_OID };
