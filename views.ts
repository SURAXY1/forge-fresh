// The REST v3 JSON views. Serialised views of a repository and of an issue
// are cached against the mutation epoch / issue version, because the read
// workload asks for the same issue thousands of times: a cache hit is one
// string lookup, not a rebuild.

import { commitOf } from './gitcore.ts';
import { VIEWER } from './scenario.ts';
import {
  commentGlobalId,
  issueGlobalId,
  pullGlobalId,
  repoGlobalId,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';

export function userView(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: Buffer.from(`User:${VIEWER.id}`, 'utf8').toString('base64'),
    type: 'User',
    name: VIEWER.name,
    email: VIEWER.email,
    site_admin: false,
  };
}

export function ownerView(repo: Repo): Record<string, unknown> {
  return { login: repo.owner, id: VIEWER.id, type: 'User', site_admin: false };
}

export function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: ownerView(repo),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: repo.objects.size,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length +
      repo.pulls.filter((pull) => pull.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
    html_url: `/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `/${repo.owner}/${repo.name}.git`,
  };
}

/** The repository's serialised view, cached per epoch. */
export function repoJson(repo: Repo): string {
  if (repo.jsonCache !== undefined && repo.jsonCacheEpoch === repo.epoch) return repo.jsonCache;
  const text = JSON.stringify(repoView(repo));
  repo.jsonCache = text;
  repo.jsonCacheEpoch = repo.epoch;
  return text;
}

export function labelView(label: Label): Record<string, unknown> {
  return {
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

export function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelView(label) : { name, color: 'ededed', description: '' };
    }),
    user: userView(),
    author: userView(),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/** An issue's serialised view, cached per issue version (the hot read path). */
export function issueJson(repo: Repo, issue: Issue): string {
  const cacheKey = `${repo.epoch}:${issue.version}`;
  if (issue.jsonCache !== undefined && (issue as { cacheKey?: string }).cacheKey === cacheKey) {
    return issue.jsonCache;
  }
  const text = JSON.stringify(issueView(repo, issue));
  issue.jsonCache = text;
  (issue as { cacheKey?: string }).cacheKey = cacheKey;
  return text;
}

export function commentView(repo: Repo, ownerNumber: number, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: commentGlobalId(repo, ownerNumber, comment),
    body: comment.body,
    user: userView(),
    author: userView(),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `/${repo.owner}/${repo.name}/issues/${ownerNumber}#issuecomment-${comment.id}`,
  };
}

function refView(repo: Repo, refName: string, sha: string): Record<string, unknown> {
  return {
    label: `${repo.owner}:${refName}`,
    ref: refName,
    sha,
    user: userView(),
    repo: repoView(repo),
  };
}

export function pullView(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? '';
  return {
    id: pull.id,
    node_id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: userView(),
    author: userView(),
    labels: [],
    head: refView(repo, pull.head, headSha),
    base: refView(repo, pull.base, baseSha),
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    comments: pull.comments.length,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.merged ? pull.mergedAt : pull.state === 'closed' ? pull.updatedAt : null,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    _links: {},
  };
}

export function branchView(repo: Repo, name: string, sha: string): Record<string, unknown> {
  return {
    name,
    commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
    protected: false,
    _links: {},
  };
}

export function commitView(repo: Repo, oid: string): Record<string, unknown> {
  const record = repo.objects.get(oid);
  if (!record) return { sha: oid };
  const commit = commitOf(record);
  const iso = (timestamp: number): string => new Date(timestamp * 1000).toISOString();
  return {
    sha: oid,
    node_id: Buffer.from(`Commit:${oid}`, 'utf8').toString('base64'),
    commit: {
      author: { name: commit.author.name, email: commit.author.email, date: iso(commit.author.timestamp) },
      committer: { name: commit.committer.name, email: commit.committer.email, date: iso(commit.committer.timestamp) },
      message: commit.message.replace(/\n$/, ''),
      tree: { sha: commit.tree, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${commit.tree}` },
      comment_count: 0,
    },
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    parents: commit.parents.map((parent) => ({ sha: parent, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${parent}` })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `/${repo.owner}/${repo.name}/commit/${oid}`,
  };
}
