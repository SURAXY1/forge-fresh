// REST v3: repositories, branches, tags, refs, commits, contents, labels,
// issues, comments and pull requests. Handlers return {status, text} and the
// HTTP layer stamps the shared headers.

import {
  commitOf,
  countLines,
  flatTreeOfCommit,
  flattenTree,
  hashObject,
  lineDiff,
  putObject,
  treeOf,
} from './gitcore.ts';
import { VIEWER } from './scenario.ts';
import {
  commitFlat,
  createIssue,
  createPull,
  findIssue,
  findPull,
  listCommits,
  mergePull,
  pullMergeable,
  resolveRef,
  store,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import {
  branchView,
  commentView,
  commitView,
  issueJson,
  issueView,
  labelView,
  pullView,
  repoJson,
  repoView,
  userView,
} from './views.ts';

export interface RestResult {
  status: number;
  text: string;
  contentType?: string;
  headers?: Record<string, string>;
}

const json = (status: number, value: unknown): RestResult => ({ status, text: JSON.stringify(value) });
const notFound = (): RestResult => json(404, { message: 'Not Found' });
const unprocessable = (message: string): RestResult => json(422, { message, errors: [{ message }] });

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// ---------------------------------------------------------------- helpers

function issueFiles(repo: Repo, pull: Pull): Record<string, unknown>[] {
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`);
  if (!baseSha) return [];
  const baseFlat = flatTreeOfCommit(repo.objects, baseSha);
  const headFlat = flatTreeOfCommit(repo.objects, headSha);
  const paths = new Set<string>();
  for (const key of baseFlat.keys()) paths.add(key);
  for (const key of headFlat.keys()) paths.add(key);
  const files: Record<string, unknown>[] = [];
  for (const path of [...paths].sort()) {
    const before = baseFlat.get(path);
    const after = headFlat.get(path);
    if (before?.oid === after?.oid) continue;
    const read = (oid: string | undefined): string => {
      if (!oid) return '';
      const record = repo.objects.get(oid);
      return record ? record.data.toString('utf8') : '';
    };
    const oldText = read(before?.oid);
    const newText = read(after?.oid);
    let status = 'modified';
    if (!before) status = 'added';
    else if (!after) status = 'removed';
    const diff = lineDiff(oldText, newText);
    const additions = before ? diff.additions : countLines(newText);
    const deletions = after ? diff.deletions : countLines(oldText);
    files.push({
      sha: after?.oid ?? before?.oid ?? '',
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: '',
      raw_url: '',
      contents_url: '',
      patch: '',
    });
  }
  return files;
}

// ---------------------------------------------------------------- handlers

function createRepoHandler(body: unknown): RestResult {
  const input = asObject(body);
  const name = str(input.name);
  if (name === '') return unprocessable('name is required');
  const existing = store.getRepo(VIEWER.login, name);
  if (existing) return unprocessable(`name already exists on this account (${name})`);
  const repo = store.createRepo(name, str(input.description), bool(input.private));
  if (!repo) return unprocessable('name already exists on this account');
  return { status: 201, text: repoJson(repo) };
}

function listUserRepos(query: URLSearchParams, origin: string): RestResult {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page')) || 30));
  const page = Math.max(1, Number(query.get('page')) || 1);
  const all = store.listRepos();
  const slice = all.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  if (page * perPage < all.length) {
    headers.Link = `<${origin}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next", <${origin}/api/v3/user/repos?per_page=${perPage}&page=${Math.ceil(all.length / perPage)}>; rel="last"`;
  }
  return { status: 200, text: `[${slice.map((repo) => repoJson(repo)).join(',')}]`, headers };
}

function getContents(repo: Repo, path: string, query: URLSearchParams): RestResult {
  const refParam = query.get('ref') ?? repo.defaultBranch;
  const tip = resolveRef(repo, refParam);
  if (!tip) return notFound();
  const commitRecord = repo.objects.get(tip);
  if (!commitRecord || commitRecord.type !== 'commit') return notFound();
  const tree = commitOf(commitRecord).tree;
  if (path === '') {
    const root = repo.objects.get(tree);
    if (!root) return notFound();
    const listing = treeOf(root).map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: entry.name,
      sha: entry.oid,
      size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
      url: '',
      html_url: '',
      git_url: '',
      download_url: null,
      _links: {},
    }));
    return json(200, listing);
  }
  const flat = flattenTree(repo.objects, tree);
  const entry = flat.get(path);
  if (entry) {
    const blob = repo.objects.get(entry.oid);
    if (!blob) return notFound();
    return json(200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name: path.slice(path.lastIndexOf('/') + 1),
      path,
      sha: entry.oid,
      content: blob.data.toString('base64'),
      url: '',
      git_url: '',
      html_url: '',
      download_url: '',
      _links: {},
    });
  }
  const prefix = `${path}/`;
  const children = new Map<string, { type: string; name: string; path: string; sha: string }>();
  for (const [candidate, candidateEntry] of flat) {
    if (!candidate.startsWith(prefix)) continue;
    const rest = candidate.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      children.set(candidate, { type: 'file', name: rest, path: candidate, sha: candidateEntry.oid });
    } else {
      const dirName = rest.slice(0, slash);
      const dirPath = `${path}/${dirName}`;
      if (!children.has(dirPath)) {
        children.set(dirPath, { type: 'dir', name: dirName, path: dirPath, sha: '' });
      }
    }
  }
  if (children.size === 0) return notFound();
  // Directory entries need a real subtree sha where cheap to compute.
  const listing = [...children.values()].map((child) => ({
    ...child,
    size: 0,
    url: '',
    html_url: '',
    git_url: '',
    download_url: null,
    _links: {},
  }));
  return json(200, listing);
}

function putContents(repo: Repo, path: string, body: unknown): RestResult {
  const input = asObject(body);
  const message = str(input.message, `Update ${path}`);
  const branch = str(input.branch, repo.defaultBranch);
  const tip = resolveRef(repo, branch);
  const flat = tip ? new Map(flatTreeOfCommit(repo.objects, tip)) : new Map();
  const existing = flat.get(path);
  const providedSha = typeof input.sha === 'string' ? input.sha : undefined;
  if (existing && providedSha !== undefined && providedSha !== existing.oid) {
    return json(409, { message: `${path} does not match the provided sha` });
  }
  if (existing && providedSha === undefined && input.sha !== undefined) {
    return json(422, { message: 'sha is required when updating' });
  }
  const rawContent = str(input.content);
  const data = Buffer.from(rawContent.replace(/\s+/g, ''), 'base64');
  const blobOid = putObject(repo.objects, 'blob', data);
  flat.set(path, { mode: '100644', oid: blobOid });
  const commit = commitFlat(repo, branch, flat, message);
  return {
    status: existing ? 200 : 201,
    text: JSON.stringify({
      content: {
        name: path.slice(path.lastIndexOf('/') + 1),
        path,
        sha: blobOid,
        size: data.length,
        type: 'file',
        encoding: 'base64',
      },
      commit: { sha: commit, message },
    }),
  };
}

function deleteContents(repo: Repo, path: string, body: unknown): RestResult {
  const input = asObject(body);
  const message = str(input.message, `Delete ${path}`);
  const branch = str(input.branch, repo.defaultBranch);
  const tip = resolveRef(repo, branch);
  if (!tip) return notFound();
  const flat = new Map(flatTreeOfCommit(repo.objects, tip));
  if (!flat.has(path)) return notFound();
  flat.delete(path);
  const commit = commitFlat(repo, branch, flat, message);
  return json(200, { content: null, commit: { sha: commit, message } });
}

function issueToJson(repo: Repo, issue: Issue): string {
  return issueJson(repo, issue);
}

function createComment(repo: Repo, number: number, body: unknown, inPull: boolean): RestResult {
  const input = asObject(body);
  const text = str(input.body);
  const target = inPull ? findPull(repo, number) : findIssue(repo, number);
  if (!target) return notFound();
  const now = new Date().toISOString();
  const comment = { id: store.nextCommentId(), body: text, createdAt: now, updatedAt: now };
  target.comments.push(comment);
  if (!inPull) {
    const issue = target as Issue;
    issue.version += 1;
    issue.updatedAt = now;
  }
  store.touch(repo);
  return json(201, commentView(repo, number, comment));
}

// ---------------------------------------------------------------- router

export function routeRest(
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
  origin: string,
): RestResult {
  // path starts with /api/v3
  const rest = path.slice('/api/v3'.length) || '/';
  if (rest === '/' || rest === '') {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      text: JSON.stringify({
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues',
        current_user_repositories_url: '/api/v3/user/repos',
      }),
      headers: { 'X-OAuth-Scopes': 'repo, read:org' },
    };
  }
  if (rest === '/meta' && method === 'GET') {
    return json(200, { installed_version: 'forge-fresh-1.0.0', hooks: [] });
  }
  if (rest === '/rate_limit' && method === 'GET') {
    return json(200, { rate: { limit: 5000, remaining: 4999, reset: 0, used: 1 }, resources: {} });
  }
  if (rest === '/user' && method === 'GET') return json(200, userView());
  if (rest === '/user/repos') {
    if (method === 'POST') return createRepoHandler(body);
    if (method === 'GET') return listUserRepos(query, origin);
    return notFound();
  }

  if (!rest.startsWith('/repos/')) return notFound();
  const segments = rest.slice('/repos/'.length).split('/');
  const owner = decodeURIComponent(segments[0] ?? '');
  const repoName = decodeURIComponent(segments[1] ?? '');
  const tail = segments.slice(2).map((segment) => decodeURIComponent(segment));
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFound();

  // /repos/{o}/{r}
  if (tail.length === 0) {
    if (method === 'GET') return { status: 200, text: repoJson(repo) };
    if (method === 'PATCH') {
      const input = asObject(body);
      if (typeof input.description === 'string') repo.description = input.description;
      if (typeof input.name === 'string' && input.name !== '' && input.name !== repo.name) {
        store.repos.delete(`${repo.owner}/${repo.name}`);
        repo.name = input.name;
        store.repos.set(`${repo.owner}/${repo.name}`, repo);
      }
      if (typeof input.default_branch === 'string') repo.defaultBranch = input.default_branch;
      if (typeof input.private === 'boolean') repo.isPrivate = input.private;
      store.touch(repo);
      return { status: 200, text: repoJson(repo) };
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      return { status: 204, text: '' };
    }
    return notFound();
  }

  const [head, ...more] = tail as [string, ...string[]];

  if (head === 'branches') {
    if (more.length === 0 && method === 'GET') {
      const branches = [];
      for (const [ref, oid] of repo.refs) {
        if (ref.startsWith('refs/heads/')) branches.push(branchView(repo, ref.slice('refs/heads/'.length), oid));
      }
      branches.sort((a, b) => (String(a.name) < String(b.name) ? -1 : 1));
      return json(200, branches);
    }
    if (more.length >= 1 && method === 'GET') {
      const name = more.join('/');
      const oid = repo.refs.get(`refs/heads/${name}`);
      if (!oid) return notFound();
      return json(200, branchView(repo, name, oid));
    }
    return notFound();
  }

  if (head === 'tags' && more.length === 0 && method === 'GET') {
    const tags = [];
    for (const [ref, oid] of repo.refs) {
      if (ref.startsWith('refs/tags/')) {
        const name = ref.slice('refs/tags/'.length);
        tags.push({ name, commit: { sha: oid, url: '' }, zipball_url: '', tarball_url: '', node_id: '' });
      }
    }
    tags.sort((a, b) => (a.name < b.name ? -1 : 1));
    return json(200, tags);
  }

  if (head === 'git' && more[0] === 'refs') {
    if (method === 'POST' && more.length === 1) {
      const input = asObject(body);
      const ref = str(input.ref);
      const sha = str(input.sha);
      if (!ref.startsWith('refs/') || !repo.objects.has(sha)) return unprocessable('invalid ref or sha');
      repo.refs.set(ref, sha);
      store.touch(repo);
      return json(201, { ref, node_id: '', url: '', object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } });
    }
    if (method === 'GET') {
      const name = more.slice(1).join('/');
      if (name === '' || name === 'heads' || name === 'tags') {
        const prefix = name === '' ? 'refs/' : `refs/${name}/`;
        const out = [];
        for (const [ref, oid] of repo.refs) {
          if (ref.startsWith(prefix)) out.push({ ref, node_id: '', url: '', object: { sha: oid, type: 'commit', url: '' } });
        }
        out.sort((a, b) => (a.ref < b.ref ? -1 : 1));
        return json(200, out);
      }
      const full = name.startsWith('refs/') ? name : `refs/${name}`;
      const oid = repo.refs.get(full);
      if (!oid) return notFound();
      return json(200, { ref: full, node_id: '', url: '', object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit', url: '' } });
    }
    if (method === 'DELETE') {
      const name = more.slice(1).join('/');
      const full = name.startsWith('refs/') ? name : `refs/${name}`;
      if (!repo.refs.has(full)) return notFound();
      repo.refs.delete(full);
      store.touch(repo);
      return { status: 204, text: '' };
    }
    return notFound();
  }

  if (head === 'commits') {
    if (more.length === 0 && method === 'GET') {
      const refParam = query.get('sha') ?? query.get('branch') ?? repo.defaultBranch;
      const tip = resolveRef(repo, refParam);
      if (!tip) return json(200, []);
      const perPage = Math.max(1, Math.min(100, Number(query.get('per_page')) || 30));
      const page = Math.max(1, Number(query.get('page')) || 1);
      const commits = listCommits(repo, tip).slice((page - 1) * perPage, page * perPage);
      return json(200, commits.map((oid) => commitView(repo, oid)));
    }
    if (more.length === 1 && method === 'GET') {
      const oid = more[0] as string;
      if (!repo.objects.has(oid)) return notFound();
      return json(200, commitView(repo, oid));
    }
    return notFound();
  }

  if (head === 'contents') {
    const contentPath = more.join('/');
    if (method === 'GET') return getContents(repo, contentPath, query);
    if (method === 'PUT') return putContents(repo, contentPath, body);
    if (method === 'DELETE') return deleteContents(repo, contentPath, body);
    return notFound();
  }

  if (head === 'labels') {
    if (more.length === 0) {
      if (method === 'GET') return json(200, [...repo.labels.values()].map(labelView));
      if (method === 'POST') {
        const input = asObject(body);
        const name = str(input.name);
        if (name === '') return unprocessable('name is required');
        if (repo.labels.has(name)) return unprocessable('already_exists: label name');
        const label = { name, color: str(input.color, 'ededed'), description: str(input.description) };
        repo.labels.set(name, label);
        store.touch(repo);
        return json(201, labelView(label));
      }
      return notFound();
    }
    if (more.length === 1) {
      const label = repo.labels.get(more[0] as string);
      if (!label) return notFound();
      if (method === 'GET') return json(200, labelView(label));
      if (method === 'DELETE') {
        repo.labels.delete(label.name);
        store.touch(repo);
        return { status: 204, text: '' };
      }
      return notFound();
    }
    return notFound();
  }

  if (head === 'issues') {
    if (more.length === 0) {
      if (method === 'POST') {
        const input = asObject(body);
        const title = str(input.title);
        if (title === '') return unprocessable('title is required');
        const labelNames: string[] = [];
        if (Array.isArray(input.labels)) {
          for (const raw of input.labels) {
            const name = typeof raw === 'string' ? raw : str(asObject(raw).name);
            if (name === '') continue;
            if (!repo.labels.has(name)) return unprocessable(`unknown label: ${name}`);
            labelNames.push(name);
          }
        }
        const issue = createIssue(repo, title, str(input.body), labelNames);
        return { status: 201, text: issueToJson(repo, issue) };
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
        if (sort === 'created') {
          issues = [...issues].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        }
        const perPage = Math.max(1, Math.min(100, Number(query.get('per_page')) || 30));
        const page = Math.max(1, Number(query.get('page')) || 1);
        const slice = issues.slice((page - 1) * perPage, page * perPage);
        return { status: 200, text: `[${slice.map((issue) => issueToJson(repo, issue)).join(',')}]` };
      }
      return notFound();
    }
    const number = Number(more[0]);
    if (!Number.isInteger(number)) return notFound();
    if (more.length === 1) {
      const issue = findIssue(repo, number);
      if (!issue) return notFound();
      if (method === 'GET') return { status: 200, text: issueToJson(repo, issue) };
      if (method === 'PATCH') {
        const input = asObject(body);
        if (typeof input.title === 'string') issue.title = input.title;
        if (typeof input.body === 'string') issue.body = input.body;
        if (input.state === 'closed' || input.state === 'open') {
          issue.state = input.state;
          issue.closedAt = input.state === 'closed' ? new Date().toISOString() : null;
        }
        if (Array.isArray(input.labels)) {
          const names: string[] = [];
          for (const raw of input.labels) {
            const name = typeof raw === 'string' ? raw : str(asObject(raw).name);
            if (name !== '' && !repo.labels.has(name)) return unprocessable(`unknown label: ${name}`);
            if (name !== '') names.push(name);
          }
          issue.labels = names;
        }
        issue.version += 1;
        issue.updatedAt = new Date().toISOString();
        store.touch(repo);
        return { status: 200, text: issueToJson(repo, issue) };
      }
      return notFound();
    }
    if (more.length === 2 && more[1] === 'comments') {
      const issue = findIssue(repo, number);
      const pull = issue ? null : findPull(repo, number);
      if (!issue && !pull) return notFound();
      if (method === 'GET') {
        const source = (issue ?? pull) as Issue | Pull;
        return json(200, source.comments.map((comment) => commentView(repo, number, comment)));
      }
      if (method === 'POST') return createComment(repo, number, body, !issue);
      return notFound();
    }
    if (more.length === 2 && more[1] === 'labels') {
      const issue = findIssue(repo, number);
      if (!issue) return notFound();
      if (method === 'GET') {
        return json(200, issue.labels.map((name) => labelView(repo.labels.get(name) ?? { name, color: 'ededed', description: '' })));
      }
      if (method === 'POST') {
        const input = asObject(body);
        const names = Array.isArray(input.labels) ? input.labels : Array.isArray(body) ? body : [];
        for (const raw of names) {
          const name = typeof raw === 'string' ? raw : str(asObject(raw).name);
          if (name !== '' && !repo.labels.has(name)) return unprocessable(`unknown label: ${name}`);
          if (name !== '' && !issue.labels.includes(name)) issue.labels.push(name);
        }
        issue.version += 1;
        store.touch(repo);
        return json(200, issue.labels.map((name) => labelView(repo.labels.get(name) ?? { name, color: 'ededed', description: '' })));
      }
      return notFound();
    }
    return notFound();
  }

  if (head === 'pulls') {
    if (more.length === 0) {
      if (method === 'POST') {
        const input = asObject(body);
        const headRef = str(input.head);
        const baseRef = str(input.base, repo.defaultBranch);
        if (!repo.refs.has(`refs/heads/${headRef}`)) return unprocessable(`head ref does not exist: ${headRef}`);
        if (!repo.refs.has(`refs/heads/${baseRef}`)) return unprocessable(`base ref does not exist: ${baseRef}`);
        const pull = createPull(repo, str(input.title, 'Pull request'), str(input.body), headRef, baseRef);
        if (!pull) return unprocessable('could not create the pull request');
        return json(201, pullView(repo, pull));
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let pulls = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
        const direction = query.get('direction') ?? 'desc';
        pulls = [...pulls].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        return json(200, pulls.map((pull) => pullView(repo, pull)));
      }
      return notFound();
    }
    const number = Number(more[0]);
    if (!Number.isInteger(number)) return notFound();
    const pull = findPull(repo, number);
    if (more.length === 1) {
      if (!pull) return notFound();
      if (method === 'GET') return json(200, pullView(repo, pull));
      if (method === 'PATCH') {
        const input = asObject(body);
        if (typeof input.title === 'string') pull.title = input.title;
        if (typeof input.body === 'string') pull.body = input.body;
        if (input.state === 'closed' && !pull.merged) pull.state = 'closed';
        if (input.state === 'open') pull.state = 'open';
        pull.updatedAt = new Date().toISOString();
        store.touch(repo);
        return json(200, pullView(repo, pull));
      }
      return notFound();
    }
    if (!pull) return notFound();
    if (more.length === 2 && more[1] === 'files' && method === 'GET') {
      return json(200, issueFiles(repo, pull));
    }
    if (more.length === 2 && more[1] === 'merge' && method === 'PUT') {
      const input = asObject(body);
      const methodName = str(input.merge_method, 'squash');
      const result = mergePull(repo, pull, methodName);
      if (!result.ok) {
        if (result.reason === 'already-merged') return json(405, { message: 'Pull Request is already merged', documentation_url: '' });
        return json(405, { message: 'Pull Request is not mergeable', documentation_url: '' });
      }
      return json(200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
    }
    if (more.length === 2 && more[1] === 'comments') {
      if (method === 'GET') return json(200, pull.comments.map((comment) => commentView(repo, number, comment)));
      if (method === 'POST') return createComment(repo, number, body, true);
      return notFound();
    }
    return notFound();
  }

  return notFound();
}
