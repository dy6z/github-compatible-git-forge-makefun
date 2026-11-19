import crypto from 'node:crypto';

export interface Repository {
  owner: string;
  name: string;
  description: string;
  defaultBranch: string;
  isPrivate: boolean;
  createdAt: string;
  updatedAt: string;
  databaseId: number;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  user: { login: string };
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  headRefName: string;
  baseRefName: string;
  merged: boolean;
  mergeCommitSha?: string;
  createdAt: string;
  updatedAt: string;
  user: { login: string };
}

export interface TreeEntry {
  mode: string; // e.g. '100644', '040000'
  name: string;
  sha: string; // 40-char hex
  type: 'blob' | 'tree';
}

export interface CommitObject {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function hashObject(type: string, content: Buffer): { sha: string; objBuffer: Buffer } {
  const header = Buffer.from(`${type} ${content.length}\0`);
  const objBuffer = Buffer.concat([header, content]);
  const sha = crypto.createHash('sha1').update(objBuffer).digest('hex');
  return { sha, objBuffer };
}

export function parseTree(content: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < content.length) {
    const spaceIdx = content.indexOf(32, offset); // space ' '
    if (spaceIdx === -1) break;
    const mode = content.toString('utf8', offset, spaceIdx);
    
    const nullIdx = content.indexOf(0, spaceIdx);
    if (nullIdx === -1) break;
    const name = content.toString('utf8', spaceIdx + 1, nullIdx);
    
    const shaBuf = content.subarray(nullIdx + 1, nullIdx + 21);
    if (shaBuf.length < 20) break;
    const sha = shaBuf.toString('hex');
    
    const type = mode === '040000' || mode === '40000' ? 'tree' : 'blob';
    entries.push({ mode, name, sha, type });
    offset = nullIdx + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): { sha: string; content: Buffer } {
  const sorted = [...entries].sort((a, b) => {
    const nameA = a.type === 'tree' ? a.name + '/' : a.name;
    const nameB = b.type === 'tree' ? b.name + '/' : b.name;
    return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
  });

  const buffers: Buffer[] = [];
  for (const entry of sorted) {
    const mode = entry.mode;
    const header = Buffer.from(`${mode} ${entry.name}\0`, 'utf8');
    const shaBin = Buffer.from(entry.sha, 'hex');
    buffers.push(header, shaBin);
  }
  const content = Buffer.concat(buffers);
  const hashed = hashObject('tree', content);
  return { sha: hashed.sha, content };
}

export function parseCommit(content: Buffer): CommitObject {
  const text = content.toString('utf8');
  const parts = text.split('\n\n');
  const headerPart = parts[0] || '';
  const message = parts.slice(1).join('\n\n');

  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';

  for (const line of headerPart.split('\n')) {
    if (line.startsWith('tree ')) {
      tree = line.slice(5).trim();
    } else if (line.startsWith('parent ')) {
      parents.push(line.slice(7).trim());
    } else if (line.startsWith('author ')) {
      author = line.slice(7).trim();
    } else if (line.startsWith('committer ')) {
      committer = line.slice(10).trim();
    }
  }

  return { tree, parents, author, committer, message };
}

export function buildCommit(commit: CommitObject): { sha: string; content: Buffer } {
  const lines: string[] = [];
  lines.push(`tree ${commit.tree}`);
  for (const parent of commit.parents) {
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${commit.author}`);
  lines.push(`committer ${commit.committer}`);
  lines.push('');
  lines.push(commit.message);

  const content = Buffer.from(lines.join('\n'), 'utf8');
  const hashed = hashObject('commit', content);
  return { sha: hashed.sha, content };
}

export class Store {
  private repos = new Map<string, Repository>();
  private labels = new Map<string, Map<string, Label>>();
  private issues = new Map<string, Map<number, Issue>>();
  private pulls = new Map<string, Map<number, PullRequest>>();
  private objects = new Map<string, { type: string; content: Buffer }>();
  private refs = new Map<string, Map<string, string>>();
  private issueCounters = new Map<string, number>();
  private prCounters = new Map<string, number>();
  private repoIdCounter = 1000;
  private issueIdCounter = 10000;
  private prIdCounter = 20000;
  private logicalCounter = 0;

  public now(): string {
    this.logicalCounter++;
    const baseTime = 1770000000000;
    return new Date(baseTime + this.logicalCounter * 1000).toISOString();
  }

  public storeObject(type: string, content: Buffer): string {
    const { sha } = hashObject(type, content);
    this.objects.set(sha, { type, content });
    return sha;
  }

  public getObject(sha: string): { type: string; content: Buffer } | undefined {
    return this.objects.get(sha);
  }

  public createRepo(owner: string, name: string, description: string = '', isPrivate: boolean = false): Repository {
    const key = `${owner}/${name}`;
    const timestamp = this.now();
    const repo: Repository = {
      owner,
      name,
      description,
      defaultBranch: 'main',
      isPrivate,
      createdAt: timestamp,
      updatedAt: timestamp,
      databaseId: this.repoIdCounter++
    };
    this.repos.set(key, repo);
    this.labels.set(key, new Map());
    this.issues.set(key, new Map());
    this.pulls.set(key, new Map());
    this.refs.set(key, new Map());
    this.issueCounters.set(key, 0);
    this.prCounters.set(key, 0);
    return repo;
  }

  public getRepo(owner: string, name: string): Repository | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  public updateRepo(owner: string, name: string, updates: Partial<Repository>): Repository {
    const key = `${owner}/${name}`;
    const repo = this.getRepo(owner, name);
    if (!repo) throw new Error(`Repository not found: ${key}`);
    Object.assign(repo, updates, { updatedAt: this.now() });
    return repo;
  }

  public deleteRepo(owner: string, name: string): boolean {
    const key = `${owner}/${name}`;
    this.labels.delete(key);
    this.issues.delete(key);
    this.pulls.delete(key);
    this.refs.delete(key);
    this.issueCounters.delete(key);
    this.prCounters.delete(key);
    return this.repos.delete(key);
  }

  public listRepos(owner?: string): Repository[] {
    const list = Array.from(this.repos.values());
    if (owner) {
      return list.filter(r => r.owner.toLowerCase() === owner.toLowerCase());
    }
    return list;
  }

  public createLabel(owner: string, repo: string, name: string, color: string = 'ededed', description: string = ''): Label {
    const key = `${owner}/${repo}`;
    const repoLabels = this.labels.get(key);
    if (!repoLabels) throw new Error(`Repository not found: ${key}`);
    const label: Label = { name, color, description };
    repoLabels.set(name, label);
    return label;
  }

  public listLabels(owner: string, repo: string): Label[] {
    const key = `${owner}/${repo}`;
    const repoLabels = this.labels.get(key);
    if (!repoLabels) return [];
    return Array.from(repoLabels.values());
  }

  public createIssue(owner: string, repo: string, title: string, body: string = '', labels: string[] = []): Issue {
    const key = `${owner}/${repo}`;
    const repoIssues = this.issues.get(key);
    const repoLabels = this.labels.get(key);
    if (!repoIssues || !repoLabels) throw new Error(`Repository not found: ${key}`);

    for (const labelName of labels) {
      if (!repoLabels.has(labelName)) {
        throw new Error(`Label does not exist: ${labelName}`);
      }
    }

    const count = (this.issueCounters.get(key) || 0) + 1;
    this.issueCounters.set(key, count);
    const timestamp = this.now();

    const issue: Issue = {
      id: this.issueIdCounter++,
      number: count,
      title,
      body,
      state: 'open',
      labels,
      createdAt: timestamp,
      updatedAt: timestamp,
      user: { login: owner }
    };
    repoIssues.set(count, issue);
    return issue;
  }

  public getIssue(owner: string, repo: string, number: number): Issue | undefined {
    const key = `${owner}/${repo}`;
    return this.issues.get(key)?.get(number);
  }

  public updateIssue(owner: string, repo: string, number: number, updates: Partial<Issue>): Issue {
    const key = `${owner}/${repo}`;
    const issue = this.getIssue(owner, repo, number);
    if (!issue) throw new Error(`Issue not found: #${number}`);
    Object.assign(issue, updates, { updatedAt: this.now() });
    return issue;
  }

  public listIssues(owner: string, repo: string, state?: string): Issue[] {
    const key = `${owner}/${repo}`;
    const repoIssues = this.issues.get(key);
    if (!repoIssues) return [];
    let list = Array.from(repoIssues.values());
    if (state && state !== 'all') {
      list = list.filter(i => i.state === state);
    }
    return list;
  }

  public createPullRequest(owner: string, repo: string, title: string, head: string, base: string, body: string = ''): PullRequest {
    const key = `${owner}/${repo}`;
    const repoPulls = this.pulls.get(key);
    if (!repoPulls) throw new Error(`Repository not found: ${key}`);

    const count = (this.prCounters.get(key) || 0) + 1;
    this.prCounters.set(key, count);
    const timestamp = this.now();

    const pr: PullRequest = {
      id: this.prIdCounter++,
      number: count,
      title,
      body,
      state: 'open',
      headRefName: head,
      baseRefName: base,
      merged: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      user: { login: owner }
    };
    repoPulls.set(count, pr);
    return pr;
  }

  public getPullRequest(owner: string, repo: string, number: number): PullRequest | undefined {
    const key = `${owner}/${repo}`;
    return this.pulls.get(key)?.get(number);
  }

  public listPullRequests(owner: string, repo: string, state?: string): PullRequest[] {
    const key = `${owner}/${repo}`;
    const repoPulls = this.pulls.get(key);
    if (!repoPulls) return [];
    let list = Array.from(repoPulls.values());
    if (state && state !== 'all') {
      list = list.filter(p => p.state === state);
    }
    return list;
  }

  public getRef(owner: string, repo: string, refName: string): string | undefined {
    const key = `${owner}/${repo}`;
    const repoRefs = this.refs.get(key);
    if (!repoRefs) return undefined;
    const fullRef = refName.startsWith('refs/') ? refName : `refs/heads/${refName}`;
    return repoRefs.get(fullRef);
  }

  public setRef(owner: string, repo: string, refName: string, sha: string): void {
    const key = `${owner}/${repo}`;
    let repoRefs = this.refs.get(key);
    if (!repoRefs) {
      repoRefs = new Map();
      this.refs.set(key, repoRefs);
    }
    const fullRef = refName.startsWith('refs/') ? refName : `refs/heads/${refName}`;
    repoRefs.set(fullRef, sha);
  }

  public getCommitReachable(owner: string, repo: string, tipSha: string): Set<string> {
    const visited = new Set<string>();
    const queue = [tipSha];
    while (queue.length > 0) {
      const sha = queue.pop()!;
      if (visited.has(sha)) continue;
      visited.add(sha);
      const obj = this.getObject(sha);
      if (obj && obj.type === 'commit') {
        const commit = parseCommit(obj.content);
        for (const parent of commit.parents) {
          if (!visited.has(parent)) {
            queue.push(parent);
          }
        }
      }
    }
    return visited;
  }

  public isAncestor(owner: string, repo: string, ancestorSha: string, commitSha: string): boolean {
    const reachable = this.getCommitReachable(owner, repo, commitSha);
    return reachable.has(ancestorSha);
  }

  public flattenTree(owner: string, repo: string, treeSha: string, prefix: string = ''): Map<string, { mode: string; sha: string }> {
    const result = new Map<string, { mode: string; sha: string }>();
    const obj = this.getObject(treeSha);
    if (!obj || obj.type !== 'tree') return result;

    const entries = parseTree(obj.content);
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.type === 'blob') {
        result.set(path, { mode: entry.mode, sha: entry.sha });
      } else if (entry.type === 'tree') {
        const subMap = this.flattenTree(owner, repo, entry.sha, path);
        for (const [subPath, subVal] of subMap.entries()) {
          result.set(subPath, subVal);
        }
      }
    }
    return result;
  }

  public putFileContent(
    owner: string,
    repo: string,
    filePath: string,
    content: Buffer,
    message: string,
    branchRef: string = 'refs/heads/main',
    expectedSha?: string
  ): { commitSha: string; contentSha: string } {
    const contentSha = this.storeObject('blob', content);
    const fullRef = branchRef.startsWith('refs/') ? branchRef : `refs/heads/${branchRef}`;
    const currentTipSha = this.getRef(owner, repo, fullRef);

    let flatFiles = new Map<string, { mode: string; sha: string }>();
    let parentSha = currentTipSha;

    if (currentTipSha) {
      const commitObj = this.getObject(currentTipSha);
      if (commitObj && commitObj.type === 'commit') {
        const commit = parseCommit(commitObj.content);
        flatFiles = this.flattenTree(owner, repo, commit.tree);
      }
    }

    if (expectedSha) {
      const existing = flatFiles.get(filePath);
      if (existing && existing.sha !== expectedSha) {
        throw new Error('Conflict: stale sha');
      }
    }

    flatFiles.set(filePath, { mode: '100644', sha: contentSha });

    const newTreeSha = this.buildTreeFromFlat(flatFiles);

    const author = `${owner} <${owner}@forge.local>`;
    const committer = author;
    const commitObj: CommitObject = {
      tree: newTreeSha,
      parents: parentSha ? [parentSha] : [],
      author,
      committer,
      message
    };

    const { sha: commitSha, content: commitContent } = buildCommit(commitObj);
    this.storeObject('commit', commitContent);

    this.setRef(owner, repo, fullRef, commitSha);
    return { commitSha, contentSha };
  }

  public getFileContent(owner: string, repo: string, filePath: string, branchRef: string = 'refs/heads/main'): { content: Buffer; sha: string } | undefined {
    const fullRef = branchRef.startsWith('refs/') ? branchRef : `refs/heads/${branchRef}`;
    const tipSha = this.getRef(owner, repo, fullRef);
    if (!tipSha) return undefined;

    const commitObj = this.getObject(tipSha);
    if (!commitObj || commitObj.type !== 'commit') return undefined;

    const commit = parseCommit(commitObj.content);
    const flatFiles = this.flattenTree(owner, repo, commit.tree);
    const entry = flatFiles.get(filePath);
    if (!entry) return undefined;

    const blobObj = this.getObject(entry.sha);
    if (!blobObj || blobObj.type !== 'blob') return undefined;

    return { content: blobObj.content, sha: entry.sha };
  }

  private buildTreeFromFlat(flatFiles: Map<string, { mode: string; sha: string }>): string {
    const rootEntries: TreeEntry[] = [];
    const dirMap = new Map<string, Map<string, { mode: string; sha: string }>>();

    for (const [path, val] of flatFiles.entries()) {
      const parts = path.split('/');
      if (parts.length === 1) {
        rootEntries.push({
          mode: val.mode,
          name: parts[0],
          sha: val.sha,
          type: 'blob'
        });
      } else {
        const topDir = parts[0];
        const subPath = parts.slice(1).join('/');
        let subMap = dirMap.get(topDir);
        if (!subMap) {
          subMap = new Map();
          dirMap.set(topDir, subMap);
        }
        subMap.set(subPath, val);
      }
    }

    for (const [dirName, subMap] of dirMap.entries()) {
      const subTreeSha = this.buildTreeFromFlat(subMap);
      rootEntries.push({
        mode: '040000',
        name: dirName,
        sha: subTreeSha,
        type: 'tree'
      });
    }

    const { sha, content } = buildTree(rootEntries);
    this.storeObject('tree', content);
    return sha;
  }

  public mergePullRequest(owner: string, repo: string, number: number): { sha: string; merged: boolean; message: string } {
    const pr = this.getPullRequest(owner, repo, number);
    if (!pr) throw new Error(`Pull request not found: #${number}`);
    if (pr.state === 'merged') {
      return { sha: pr.mergeCommitSha || '', merged: true, message: 'Already merged' };
    }

    const baseRef = `refs/heads/${pr.baseRefName}`;
    const headRef = `refs/heads/${pr.headRefName}`;
    const baseSha = this.getRef(owner, repo, baseRef);
    const headSha = this.getRef(owner, repo, headRef);

    if (!baseSha || !headSha) {
      throw new Error('Base or head ref not found for merging');
    }

    const headCommitObj = this.getObject(headSha);
    if (!headCommitObj || headCommitObj.type !== 'commit') {
      throw new Error('Head commit not found');
    }
    const headCommit = parseCommit(headCommitObj.content);

    const author = `${owner} <${owner}@forge.local>`;
    const commitObj: CommitObject = {
      tree: headCommit.tree,
      parents: [baseSha],
      author,
      committer: author,
      message: `Merge pull request #${number} from ${pr.headRefName}\n\n${pr.title}`
    };

    const { sha: mergeCommitSha, content: commitContent } = buildCommit(commitObj);
    this.storeObject('commit', commitContent);

    this.setRef(owner, repo, baseRef, mergeCommitSha);
    pr.state = 'merged';
    pr.merged = true;
    pr.mergeCommitSha = mergeCommitSha;
    pr.updatedAt = this.now();

    return { sha: mergeCommitSha, merged: true, message: 'Pull request successfully merged' };
  }
}
