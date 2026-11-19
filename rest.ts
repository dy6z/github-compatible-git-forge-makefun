import {
  Store,
  parseCommit,
  type Repository,
  type Issue,
  type PullRequest,
  type Label,
} from './store.ts';

export interface RestContext {
  store: Store;
  owner: string;
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  authenticated: boolean;
  requestId: string;
}

export interface RestAnswer {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

let requestSequence = 0;

function json(status: number, body: unknown, headers?: Record<string, string>): RestAnswer {
  requestSequence += 1;
  return { status, body, headers: { 'x-github-request-id': `forge-${requestSequence.toString(36)}`, ...headers } };
}

function message(status: number, text: string, headers?: Record<string, string>): RestAnswer {
  return json(status, { message: text }, headers);
}

function encodeSegment(segment: string): string {
  return encodeURIComponent(segment);
}

function encodePath(path: string): string {
  return path.split('/').map(encodeSegment).join('/');
}

function repoJson(store: Store, repo: Repository): Record<string, unknown> {
  return {
    id: repo.databaseId,
    node_id: `R_${repo.databaseId}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: { login: repo.owner, id: 1001, type: 'User' },
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    open_issues_count: store.listIssues(repo.owner, repo.name, 'open').length,
    url: `http://forge/api/v3/repos/${encodeSegment(repo.owner)}/${encodeSegment(repo.name)}`,
    html_url: `http://forge/${repo.owner}/${repo.name}`,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

function issueJson(store: Store, repo: Repository, issue: Issue): Record<string, unknown> {
  const comments = store.listComments(repo.owner, repo.name, issue.number);
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: issue.user.login, id: 1001, type: 'User' },
    labels: issue.labels.map((l) => {
      const lbls = store.listLabels(repo.owner, repo.name);
      const found = lbls.find((x) => x.name.toLowerCase() === l.toLowerCase());
      return { name: l, color: found?.color ?? 'ededed' };
    }),
    comments: comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    url: `http://forge/api/v3/repos/${encodeSegment(repo.owner)}/${encodeSegment(repo.name)}/issues/${issue.number}`,
    html_url: `http://forge/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `http://forge/api/v3/repos/${encodeSegment(repo.owner)}/${encodeSegment(repo.name)}`,
  };
}

function pullJson(store: Store, repo: Repository, pull: PullRequest): Record<string, unknown> {
  const headSha = store.getRef(repo.owner, repo.name, pull.headRefName) ?? '0000000000000000000000000000000000000000';
  const baseSha = store.getRef(repo.owner, repo.name, pull.baseRefName) ?? '0000000000000000000000000000000000000000';
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'closed' : pull.state,
    merged: pull.merged,
    merged_at: pull.merged ? pull.updatedAt : null,
    user: { login: pull.user.login, id: 1001, type: 'User' },
    labels: [],
    head: { ref: pull.headRefName, sha: headSha, label: `${repo.owner}:${pull.headRefName}` },
    base: { ref: pull.baseRefName, sha: baseSha, label: `${repo.owner}:${pull.baseRefName}` },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' || pull.merged ? pull.updatedAt : null,
    url: `http://forge/api/v3/repos/${encodeSegment(repo.owner)}/${encodeSegment(repo.name)}/pulls/${pull.number}`,
    html_url: `http://forge/${repo.owner}/${repo.name}/pull/${pull.number}`,
    merge_commit_sha: pull.mergeCommitSha ?? null,
  };
}

function commentJson(store: Store, repo: Repository, issueNumber: number, comment: { id: number; body: string; user: { login: string }; createdAt: string }): Record<string, unknown> {
  void store;
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    body: comment.body,
    user: { login: comment.user.login, id: 1001, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    issue_url: `http://forge/api/v3/repos/${encodeSegment(repo.owner)}/${encodeSegment(repo.name)}/issues/${issueNumber}`,
    html_url: `http://forge/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return {
    id: Math.abs([...label.name].reduce((acc, ch) => acc * 31 + ch.charCodeAt(0), 7)) % 100000,
    name: label.name,
    color: label.color,
    default: false,
    url: `http://forge/api/v3/repos/labels/${encodeSegment(label.name)}`,
  };
}

function commitJson(store: Store, repo: Repository, sha: string): Record<string, unknown> {
  const obj = store.getObject(sha);
  const view = obj && obj.type === 'commit' ? parseCommit(obj.content) : null;
  return {
    sha,
    node_id: `C_${sha.slice(0, 12)}`,
    commit: {
      message: view?.message.replace(/\n$/, '') ?? '',
      author: { name: 'forge', email: 'forge@forge.local', date: '2025-01-01T00:00:00Z' },
      committer: { name: 'forge', email: 'forge@forge.local', date: '2025-01-01T00:00:00Z' },
      tree: { sha: view?.tree ?? '0000000000000000000000000000000000000000', url: `http://forge/api/v3/repos/${encodeSegment(repo.owner)}/${encodeSegment(repo.name)}/git/trees/${view?.tree}` },
    },
    url: `http://forge/api/v3/repos/${encodeSegment(repo.owner)}/${encodeSegment(repo.name)}/commits/${sha}`,
    html_url: `http://forge/${repo.owner}/${repo.name}/commit/${sha}`,
    parents: (view?.parents ?? []).map((p) => ({ sha: p, url: `http://forge/api/v3/repos/${encodeSegment(repo.owner)}/${encodeSegment(repo.name)}/commits/${p}` })),
  };
}

function paginate(items: unknown[], query: URLSearchParams, makeLink: (page: number) => string): RestAnswer {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const links: string[] = [];
  if (start + perPage < items.length) links.push(`<${makeLink(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${makeLink(Math.max(1, page - 1))}>; rel="prev"`);
  links.push(`<${makeLink(1)}>; rel="first"`);
  links.push(`<${makeLink(Math.max(1, Math.ceil(items.length / perPage)))}>; rel="last"`);
  return json(200, slice, links.length > 0 ? { link: links.join(', ') } : undefined);
}

export function handleRest(ctx: RestContext): RestAnswer {
  const { store, method, path, query, body, authenticated } = ctx;
  const viewer = ctx.owner;
  const segments = path.split('/').filter((s) => s !== '');
  const record = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;

  if (segments.length === 0 && method === 'GET') {
    return json(200, {
      current_user_url: 'http://forge/api/v3/user',
      repository_url: 'http://forge/api/v3/repos/{owner}/{repo}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
    return json(200, { installed_version: 'forge-1.0.0' });
  }

  if (segments[0] === 'user') {
    if (segments.length === 1 && method === 'GET') {
      if (!authenticated) return message(401, 'Requires authentication');
      return json(200, { login: viewer, id: 1001, type: 'User', name: 'Forge Agent' });
    }
    if (segments[1] === 'repos' && segments.length === 2) {
      if (!authenticated) return message(401, 'Requires authentication');
      if (method === 'GET') {
        const repos = store.listRepos(viewer);
        return paginate(repos.map((r) => repoJson(store, r)), query, (p) => `http://forge/api/v3/user/repos?per_page=${query.get('per_page') ?? '30'}&page=${p}`);
      }
      if (method === 'POST') {
        const name = typeof record.name === 'string' ? record.name.trim() : '';
        if (name === '') return message(422, 'Repository name is required');
        const existing = store.getRepo(viewer, name);
        if (existing) return message(422, 'name already exists on this account');
        const description = typeof record.description === 'string' ? record.description : '';
        const isPrivate = record.private === true;
        const repo = store.createRepo(viewer, name, description, isPrivate);
        if (typeof record.default_branch === 'string' && record.default_branch !== '') {
          repo.defaultBranch = record.default_branch;
        }
        return json(201, repoJson(store, repo));
      }
      return message(405, 'Method not allowed');
    }
    return message(404, 'Not Found');
  }

  if (segments[0] !== 'repos' || segments.length < 3) return message(404, 'Not Found');
  const owner = decodeURIComponent(segments[1]!);
  const name = decodeURIComponent(segments[2]!);
  const repo = store.getRepo(owner, name);
  const rest = segments.slice(3);
  const repoPath = `/api/v3/repos/${encodeSegment(owner)}/${encodeSegment(name)}`;

  const readable = repo !== undefined && repo.owner.toLowerCase() === viewer.toLowerCase();
  if (method === 'GET' && rest.length === 0) {
    if (!authenticated) return message(401, 'Requires authentication');
    if (!readable) return message(404, 'Not Found');
    return json(200, repoJson(store, repo!));
  }

  if (!authenticated) return message(401, 'Requires authentication');
  if (!readable) return message(404, 'Not Found');

  const repository = repo!;

  if (rest.length === 0) {
    if (method === 'PATCH') {
      const updates: Partial<Repository> = {};
      if (typeof record.description === 'string') updates.description = record.description;
      if (typeof record.private === 'boolean') updates.isPrivate = record.private;
      if (typeof record.default_branch === 'string' && record.default_branch !== '') updates.defaultBranch = record.default_branch;
      const updated = store.updateRepo(owner, name, updates);
      return json(200, repoJson(store, updated));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, name);
      return json(204, null);
    }
    return message(405, 'Method not allowed');
  }

  const head = rest[0]!;

  if (head === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      const ref = typeof record.ref === 'string' ? record.ref : '';
      const sha = typeof record.sha === 'string' ? record.sha : '';
      if (!ref.startsWith('refs/')) return message(422, 'ref must start with refs/');
      if (!store.getObject(sha)) return message(422, 'sha does not point at an object');
      store.setRef(owner, name, ref, sha);
      return json(201, { ref, object: { sha, type: 'commit' } });
    }
    if (rest.length >= 3 && method === 'GET') {
      const refName = rest.slice(2).map(decodeURIComponent).join('/');
      const candidates = refName.startsWith('refs/') ? [refName] : [`refs/heads/${refName}`, `refs/tags/${refName}`, refName];
      for (const candidate of candidates) {
        const sha = store.getRef(owner, name, candidate);
        if (sha !== undefined) {
          return json(200, { ref: candidate, object: { sha, type: 'commit' } });
        }
      }
      return message(404, 'Reference not found');
    }
    return message(405, 'Method not allowed');
  }

  if (head === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const refs = store.listRefs(owner, name);
      const branches = refs
        .filter((r) => r.name.startsWith('refs/heads/'))
        .map((r) => ({ name: r.name.slice('refs/heads/'.length), commit: { sha: r.sha } }));
      return json(200, branches);
    }
    if (rest.length === 2 && method === 'GET') {
      const branchName = decodeURIComponent(rest[1]!);
      const sha = store.getRef(owner, name, `refs/heads/${branchName}`);
      if (!sha) return message(404, 'Branch not found');
      return json(200, { name: branchName, commit: { sha } });
    }
    return message(405, 'Method not allowed');
  }

  if (head === 'commits' && method === 'GET') {
    const ref = query.get('sha') ?? repository.defaultBranch;
    const tip = store.getRef(owner, name, `refs/heads/${ref}`) ?? store.getRef(owner, name, ref) ?? (store.getObject(ref) ? ref : null);
    if (!tip) return message(404, 'No commits found');
    const commits: unknown[] = [];
    let current: string | null = tip;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      commits.push(commitJson(store, repository, current));
      const obj = store.getObject(current);
      if (!obj || obj.type !== 'commit') break;
      const parsed = parseCommit(obj.content);
      current = parsed.parents[0] ?? null;
    }
    return json(200, commits);
  }

  if (head === 'contents') {
    const filePath = rest.slice(1).map(decodeURIComponent).join('/');
    if (method === 'GET') {
      const ref = query.get('ref') ?? repository.defaultBranch;
      const file = store.getFileContent(owner, name, filePath, ref);
      if (file !== undefined) {
        return json(200, {
          type: 'file',
          encoding: 'base64',
          content: file.content.toString('base64'),
          sha: file.sha,
          size: file.content.length,
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
        });
      }
      const dirList = store.listDirectory(owner, name, filePath, ref);
      if (dirList !== undefined) {
        return json(200, dirList);
      }
      return message(404, 'Not Found');
    }
    if (method === 'PUT') {
      const branch = typeof record.branch === 'string' && record.branch !== '' ? record.branch : repository.defaultBranch;
      const contentStr = typeof record.content === 'string' ? record.content : '';
      const msg = typeof record.message === 'string' ? record.message : 'update file';
      const expectedSha = typeof record.sha === 'string' ? record.sha : undefined;
      let buf: Buffer;
      try {
        buf = Buffer.from(contentStr, 'base64');
      } catch {
        return message(400, 'Invalid base64 content');
      }
      try {
        const res = store.putFileContent(owner, name, filePath, buf, msg, branch, expectedSha);
        return json(expectedSha ? 200 : 201, {
          content: { sha: res.contentSha, encoding: 'base64', content: contentStr, size: buf.length, name: filePath.split('/').pop(), path: filePath },
          commit: { sha: res.commitSha, message: msg },
        });
      } catch (err: any) {
        if (err.message && err.message.includes('stale sha')) {
          return message(409, 'Conflict: stale sha');
        }
        return message(422, err.message);
      }
    }
    if (method === 'DELETE') {
      const branch = repository.defaultBranch;
      const expectedSha = typeof record.sha === 'string' ? record.sha : undefined;
      const msg = typeof record.message === 'string' ? record.message : 'delete file';
      try {
        const res = store.deleteFileContent(owner, name, filePath, msg, branch, expectedSha);
        return json(200, { commit: { sha: res.commitSha, message: msg } });
      } catch (err: any) {
        if (err.message && err.message.includes('stale sha')) {
          return message(409, 'Conflict: stale sha');
        }
        return message(404, 'Not Found');
      }
    }
    return message(405, 'Method not allowed');
  }

  if (head === 'labels') {
    if (rest.length === 1 && method === 'POST') {
      const labelName = typeof record.name === 'string' ? record.name.trim() : '';
      if (labelName === '') return message(422, 'Label name is required');
      const color = typeof record.color === 'string' ? record.color.replace('#', '') : 'ededed';
      const label = store.createLabel(owner, name, labelName, color, typeof record.description === 'string' ? record.description : '');
      return json(201, labelJson(label));
    }
    if (rest.length === 1 && method === 'GET') {
      const labels = store.listLabels(owner, name);
      return json(200, labels.map(labelJson));
    }
    return message(405, 'Method not allowed');
  }

  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let issues = store.listIssues(owner, name, state);
        issues.sort((a, b) => {
          const factor = direction === 'asc' ? 1 : -1;
          if (sort === 'created') return factor * a.createdAt.localeCompare(b.createdAt);
          if (sort === 'updated') return factor * a.updatedAt.localeCompare(b.updatedAt);
          return 0;
        });
        return paginate(issues.map((i) => issueJson(store, repository, i)), query, (p) => `http://forge${repoPath}/issues?state=${state}&per_page=${query.get('per_page') ?? '30'}&page=${p}`);
      }
      if (method === 'POST') {
        const title = typeof record.title === 'string' ? record.title : '';
        if (title === '') return message(422, 'title is required');
        const bodyText = typeof record.body === 'string' ? record.body : '';
        const labelNames = Array.isArray(record.labels) ? record.labels.filter((l): l is string => typeof l === 'string') : [];
        try {
          const issue = store.createIssue(owner, name, title, bodyText, labelNames);
          return json(201, issueJson(store, repository, issue));
        } catch (err: any) {
          return message(422, err.message);
        }
      }
      return message(405, 'Method not allowed');
    }
    const issueNum = Number.parseInt(rest[1] ?? '', 10);
    if (!Number.isNaN(issueNum)) {
      const issue = store.getIssue(owner, name, issueNum);
      if (!issue) return message(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return json(200, issueJson(store, repository, issue));
        if (method === 'PATCH') {
          const updates: Partial<Issue> = {};
          if (typeof record.title === 'string') updates.title = record.title;
          if (typeof record.body === 'string') updates.body = record.body;
          if (record.state === 'open' || record.state === 'closed') updates.state = record.state;
          const updated = store.updateIssue(owner, name, issueNum, updates);
          return json(200, issueJson(store, repository, updated));
        }
        return message(405, 'Method not allowed');
      }
      if (rest[2] === 'comments') {
        if (rest.length === 3 && method === 'GET') {
          const comments = store.listComments(owner, name, issueNum);
          return json(200, comments.map((c) => commentJson(store, repository, issueNum, c)));
        }
        if (rest.length === 3 && method === 'POST') {
          const bodyText = typeof record.body === 'string' ? record.body : '';
          if (bodyText === '') return message(422, 'body is required');
          try {
            const comment = store.createComment(owner, name, issueNum, bodyText);
            return json(201, commentJson(store, repository, issueNum, comment));
          } catch (err: any) {
            return message(422, err.message);
          }
        }
      }
    }
    return message(404, 'Not Found');
  }

  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let pulls = store.listPullRequests(owner, name, state === 'all' ? 'all' : state);
        if (state === 'open') {
          pulls = pulls.filter((p) => p.state === 'open' && !p.merged);
        }
        pulls.sort((a, b) => b.number - a.number);
        return paginate(pulls.map((p) => pullJson(store, repository, p)), query, (p) => `http://forge${repoPath}/pulls?state=${state}&per_page=${query.get('per_page') ?? '30'}&page=${p}`);
      }
      if (method === 'POST') {
        const title = typeof record.title === 'string' ? record.title : '';
        const headRef = typeof record.head === 'string' ? record.head : '';
        const baseRef = typeof record.base === 'string' ? record.base : repository.defaultBranch;
        if (title === '' || headRef === '') return message(422, 'title and head are required');
        try {
          const pr = store.createPullRequest(owner, name, title, headRef, baseRef, typeof record.body === 'string' ? record.body : '');
          return json(201, pullJson(store, repository, pr));
        } catch (err: any) {
          return message(422, err.message);
        }
      }
      return message(405, 'Method not allowed');
    }
    const prNum = Number.parseInt(rest[1] ?? '', 10);
    if (!Number.isNaN(prNum)) {
      const pr = store.getPullRequest(owner, name, prNum);
      if (!pr) return message(404, 'Not Found');
      if (rest.length === 2 && method === 'GET') {
        return json(200, pullJson(store, repository, pr));
      }
      if (rest[2] === 'files' && method === 'GET') {
        const files: unknown[] = [];
        const headSha = store.getRef(owner, name, pr.headRefName);
        const baseSha = store.getRef(owner, name, pr.baseRefName);
        if (headSha && baseSha) {
          const headObj = store.getObject(headSha);
          const baseObj = store.getObject(baseSha);
          const headFlat = headObj && headObj.type === 'commit' ? store.flattenTree(owner, name, parseCommit(headObj.content).tree) : new Map();
          const baseFlat = baseObj && baseObj.type === 'commit' ? store.flattenTree(owner, name, parseCommit(baseObj.content).tree) : new Map();
          for (const [p, v] of headFlat.entries()) {
            if (!baseFlat.has(p) || baseFlat.get(p)?.sha !== v.sha) {
              files.push({
                filename: p,
                status: baseFlat.has(p) ? 'modified' : 'added',
                additions: 1,
                deletions: 0,
                changes: 1,
              });
            }
          }
        }
        return json(200, files);
      }
      if (rest[2] === 'merge' && method === 'PUT') {
        try {
          if (store.pullRequestConflicts(owner, name, prNum)) return message(405, 'Pull request is not mergeable');
          const res = store.mergePullRequest(owner, name, prNum);
          return json(200, res);
        } catch (err: any) {
          const msg = err.message || '';
          if (msg.includes('not found')) return message(404, 'Not Found');
          return message(405, msg);
        }
      }
    }
    return message(404, 'Not Found');
  }

  return message(404, 'Not Found');
}
