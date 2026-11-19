import { Store } from './store.ts';
import {
  GitProtocolError,
  type GitPacket,
  PktLineDecoder,
  encodePktLines,
  encodePktLine,
  pktLineFlush,
  pktLineDelim,
  decodePktLines,
} from './packet.ts';
import {
  writePack,
  readPack,
  verifyPackChecksum,
  collectReachable,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
} from './pack.ts';

const ZERO_OID = '0'.repeat(40);

export function parseRepoPath(urlOrPath: string): { owner: string; repo: string; suffix: string } | null {
  try {
    const url = urlOrPath.startsWith('http://') || urlOrPath.startsWith('https://') || urlOrPath.startsWith('/')
      ? new URL(urlOrPath, 'http://localhost')
      : new URL(`/${urlOrPath}`, 'http://localhost');
    const pathname = url.pathname;
    const match = pathname.match(/^\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\.git(\/.*)?$/);
    if (!match) return null;
    return {
      owner: match[1],
      repo: match[2],
      suffix: match[3] || '',
    };
  } catch {
    return null;
  }
}

export interface GitResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const packCache = new Map<string, Buffer>();

export async function handleGitRequest(
  store: Store,
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: Buffer,
): Promise<GitResponse> {
  const parsedPath = parseRepoPath(url);
  if (!parsedPath) {
    return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('Not Found', 'utf8') };
  }

  const { owner, repo, suffix } = parsedPath;
  const repoExists = store.getRepo(owner, repo) !== undefined;

  if (!repoExists) {
    return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('Repository not found', 'utf8') };
  }

  const normalizedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    normalizedHeaders[k.toLowerCase()] = v;
  }

  const gitProtocolHeader = normalizedHeaders['git-protocol'] || '';
  const isV2 = gitProtocolHeader.includes('version=2');

  if (method === 'GET' && suffix === '/info/refs') {
    const urlObj = new URL(url, 'http://localhost');
    const service = urlObj.searchParams.get('service');

    if (service === 'git-upload-pack') {
      if (isV2) {
        const packets: (string | 'flush')[] = [
          'version 2\n',
          'ls-refs=unborn\n',
          'fetch=shallow filter\n',
          'object-format=sha1\n',
          'agent=makefun-git-server/1.0\n',
          'flush',
        ];
        return {
          status: 200,
          headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
          body: encodePktLines(packets),
        };
      } else {
        return handleUploadPackAdvertisement(store, owner, repo);
      }
    } else if (service === 'git-receive-pack') {
      return handleReceivePackAdvertisement(store, owner, repo);
    }
  }

  if (method === 'POST') {
    const reqBody = body || Buffer.alloc(0);
    if (suffix === '/git-upload-pack') {
      return handleUploadPackPost(store, owner, repo, reqBody, isV2 || gitProtocolHeader.includes('version=2'));
    } else if (suffix === '/git-receive-pack') {
      return handleReceivePackPost(store, owner, repo, reqBody);
    }
  }

  return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('Not Found', 'utf8') };
}

function handleUploadPackAdvertisement(store: Store, owner: string, repo: string): GitResponse {
  const repoRefs = store.listRefs(owner, repo);
  const refs: Array<{ name: string; oid: string; peeled?: string }> = [];

  let headOid = ZERO_OID;
  const mainRef = repoRefs.find(r => r.name === 'refs/heads/main');
  if (mainRef) {
    headOid = mainRef.sha;
  }

  refs.push({ name: 'HEAD', oid: headOid });

  for (const ref of repoRefs) {
    if (ref.name !== 'HEAD') {
      refs.push({ name: ref.name, oid: ref.sha });
      const obj = store.getObject(ref.sha);
      if (obj && obj.type === 'tag') {
        try {
          const parsed = parseTag(obj.content);
          if (parsed.object) {
            refs.push({ name: `${ref.name}^{}`, oid: parsed.object });
          }
        } catch {}
      }
    }
  }

  const packets: (string | 'flush')[] = [];
  packets.push('# service=git-upload-pack\n');
  packets.push('flush');

  const capabilities = 'symref=HEAD:refs/heads/main side-band-64k ofs-delta agent=makefun-git-server/1.0';

  if (refs.length <= 1) {
    packets.push(`${ZERO_OID} capabilities^{}\0${capabilities}\n`);
  } else {
    refs.forEach((ref, idx) => {
      const line = idx === 0
        ? `${ref.oid} ${ref.name}\0${capabilities}\n`
        : `${ref.oid} ${ref.name}\n`;
      packets.push(line);
      if (ref.peeled) {
        packets.push(`${ref.peeled} ${ref.name}^{}\n`);
      }
    });
  }
  packets.push('flush');

  return {
    status: 200,
    headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
    body: encodePktLines(packets),
  };
}

function handleReceivePackAdvertisement(store: Store, owner: string, repo: string): GitResponse {
  const repoRefs = store.listRefs(owner, repo);
  const refs: Array<{ name: string; oid: string }> = [];

  let headOid = ZERO_OID;
  const mainRef = repoRefs.find(r => r.name === 'refs/heads/main');
  if (mainRef) headOid = mainRef.sha;
  refs.push({ name: 'HEAD', oid: headOid });

  for (const ref of repoRefs) {
    if (ref.name !== 'HEAD') {
      refs.push({ name: ref.name, oid: ref.sha });
    }
  }

  const packets: (string | 'flush')[] = [];
  packets.push('# service=git-receive-pack\n');
  packets.push('flush');

  const capabilities = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=makefun-git-server/1.0';

  if (refs.length <= 1) {
    packets.push(`${ZERO_OID} capabilities^{}\0${capabilities}\n`);
  } else {
    refs.forEach((ref, idx) => {
      const line = idx === 0
        ? `${ref.oid} ${ref.name}\0${capabilities}\n`
        : `${ref.oid} ${ref.name}\n`;
      packets.push(line);
    });
  }
  packets.push('flush');

  return {
    status: 200,
    headers: { 'content-type': 'application/x-git-receive-pack-advertisement' },
    body: encodePktLines(packets),
  };
}

async function handleUploadPackPost(
  store: Store,
  owner: string,
  repo: string,
  body: Buffer,
  isV2: boolean,
): Promise<GitResponse> {
  const packets = decodePktLines(body, { allowTrailing: true });

  if (isV2 || packets.some(p => p.kind === 'data' && p.payload.toString('utf8').startsWith('command='))) {
    return handleV2UploadPack(store, owner, repo, packets, body);
  } else {
    return handleV0UploadPack(store, owner, repo, packets);
  }
}

async function handleV2UploadPack(
  store: Store,
  owner: string,
  repo: string,
  packets: readonly GitPacket[],
  rawBody: Buffer,
): Promise<GitResponse> {
  let command = '';
  const args: string[] = [];

  for (const pkt of packets) {
    if (pkt.kind === 'data') {
      const text = pkt.payload.toString('utf8').replace(/\n$/, '');
      if (text.startsWith('command=')) {
        command = text.slice(8);
      } else {
        args.push(text);
      }
    }
  }

  const repoRefs = store.listRefs(owner, repo);

  if (command === 'ls-refs') {
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];

    for (const arg of args) {
      if (arg === 'peel') peel = true;
      else if (arg === 'symrefs') symrefs = true;
      else if (arg === 'unborn') unborn = true;
      else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice(11));
    }

    const respPackets: (string | 'flush')[] = [];
    const matchingRefs: Array<{ name: string; oid: string; peeled?: string; symrefTarget?: string }> = [];

    if (symrefs || prefixes.length === 0 || prefixes.some(p => 'HEAD'.startsWith(p))) {
      const mainRef = repoRefs.find(r => r.name === 'refs/heads/main');
      if (mainRef) {
        matchingRefs.push({ name: 'HEAD', oid: mainRef.sha, symrefTarget: 'refs/heads/main' });
      } else if (unborn) {
        matchingRefs.push({ name: 'HEAD', oid: ZERO_OID, symrefTarget: 'refs/heads/main' });
      }
    }

    for (const ref of repoRefs) {
      if (prefixes.length === 0 || prefixes.some(p => ref.name.startsWith(p))) {
        let peeled: string | undefined;
        if (peel) {
          const obj = store.getObject(ref.sha);
          if (obj && obj.type === 'tag') {
            try {
              const parsed = parseTag(obj.content);
              if (parsed.object) peeled = parsed.object;
            } catch {}
          }
        }
        matchingRefs.push({ name: ref.name, oid: ref.sha, peeled });
      }
    }

    for (const ref of matchingRefs) {
      let line = `${ref.oid} ${ref.name}`;
      if (ref.peeled) line += ` peeled:${ref.peeled}`;
      if (ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
      respPackets.push(`${line}\n`);
    }
    respPackets.push('flush');

    return {
      status: 200,
      headers: { 'content-type': 'application/x-git-upload-pack-result' },
      body: encodePktLines(respPackets),
    };
  }

  if (command === 'fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    let depth: number | undefined;

    for (const arg of args) {
      if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
      else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
      else if (arg.startsWith('deepen ')) depth = Number.parseInt(arg.slice(7), 10);
    }

    const lookup = (oid: string) => {
      const obj = store.getObject(oid);
      return obj ? { type: obj.type as any, data: obj.content } : undefined;
    };

    const serverTips = repoRefs.map(r => r.sha);
    const serverReachable = collectReachable(serverTips, lookup, { allowMissing: true });
    const wantReachable = collectReachable(wants, lookup);
    const clientReachable = collectReachable(haves, lookup, { allowMissing: true });

    const sendObjects: any[] = [];
    for (const oid of wantReachable) {
      if (!clientReachable.has(oid)) {
        const obj = store.getObject(oid);
        if (obj) sendObjects.push({ type: obj.type, data: obj.content });
      }
    }

    const cacheKey = `${owner}/${repo}:${wants.join(',')}:${depth || 0}`;
    let packBuf = packCache.get(cacheKey);
    if (!packBuf) {
      packBuf = writePack(sendObjects);
      packCache.set(cacheKey, packBuf);
    }

    const respPackets: (string | 'flush' | 'delim')[] = [];
    respPackets.push('acknowledgments\n');
    for (const have of haves) {
      if (serverReachable.has(have)) {
        respPackets.push(`ACK ${have}\n`);
      }
    }
    respPackets.push('NAK\n');
    respPackets.push('flush');

    respPackets.push('packfile\n');

    const chunkBytes = 65519;
    const sidebandChunks: Buffer[] = [];
    sidebandChunks.push(encodeSideband(2, Buffer.from('Counting objects: 100% done\r\n', 'utf8')));

    for (let offset = 0; offset < packBuf.length; offset += chunkBytes) {
      const chunk = packBuf.subarray(offset, Math.min(offset + chunkBytes, packBuf.length));
      sidebandChunks.push(encodeSideband(1, chunk));
    }

    const finalBody = Buffer.concat([
      encodePktLines(respPackets),
      Buffer.concat(sidebandChunks),
      Buffer.from('0000', 'ascii'),
    ]);

    return {
      status: 200,
      headers: { 'content-type': 'application/x-git-upload-pack-result' },
      body: finalBody,
    };
  }

  return {
    status: 200,
    headers: { 'content-type': 'application/x-git-upload-pack-result' },
    body: encodePktLines(['flush']),
  };
}

function handleV0UploadPack(
  store: Store,
  owner: string,
  repo: string,
  packets: readonly GitPacket[],
): GitResponse {
  const wants: string[] = [];
  const haves: string[] = [];

  for (const pkt of packets) {
    if (pkt.kind === 'data') {
      const text = pkt.payload.toString('utf8').replace(/\n$/, '');
      if (text.startsWith('want ')) {
        const parts = text.slice(5).split(' ');
        wants.push(parts[0]);
      } else if (text.startsWith('have ')) {
        haves.push(text.slice(5).trim());
      }
    }
  }

  const repoRefs = store.listRefs(owner, repo);
  const lookup = (oid: string) => {
    const obj = store.getObject(oid);
    return obj ? { type: obj.type as any, data: obj.content } : undefined;
  };

  const serverTips = repoRefs.map(r => r.sha);
  const serverReachable = collectReachable(serverTips, lookup, { allowMissing: true });
  const wantReachable = collectReachable(wants, lookup);

  const sendObjects: any[] = [];
  for (const oid of wantReachable) {
    const obj = store.getObject(oid);
    if (obj) sendObjects.push({ type: obj.type, data: obj.content });
  }

  const packBuf = writePack(sendObjects);

  const respPackets: (string | 'flush')[] = [];
  respPackets.push('NAK\n');

  const sidebandChunks: Buffer[] = [];
  sidebandChunks.push(encodeSideband(2, Buffer.from('Counting objects: done\n', 'utf8')));

  const chunkBytes = 65519;
  for (let offset = 0; offset < packBuf.length; offset += chunkBytes) {
    const chunk = packBuf.subarray(offset, Math.min(offset + chunkBytes, packBuf.length));
    sidebandChunks.push(encodeSideband(1, chunk));
  }

  const finalBody = Buffer.concat([
    encodePktLines(respPackets),
    Buffer.concat(sidebandChunks),
    Buffer.from('0000', 'ascii'),
  ]);

  return {
    status: 200,
    headers: { 'content-type': 'application/x-git-upload-pack-result' },
    body: finalBody,
  };
}

function encodeSideband(band: number, data: Buffer): Buffer {
  const header = Buffer.allocUnsafe(4);
  const length = data.length + 5;
  header.write(length.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  const bandBuf = Buffer.from([band]);
  return Buffer.concat([header, bandBuf, data]);
}

async function handleReceivePackPost(
  store: Store,
  owner: string,
  repo: string,
  body: Buffer,
): Promise<GitResponse> {
  const decoder = new PktLineDecoder(body);
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  const capabilities = new Set<string>();

  let hasCapabilities = false;
  for (;;) {
    const pkt = decoder.next();
    if (!pkt) break;
    if (pkt.kind === 'flush') break;
    if (pkt.kind === 'data') {
      let text = pkt.payload.toString('utf8').replace(/\n$/, '');
      if (!hasCapabilities) {
        const nulIdx = text.indexOf('\u0000');
        if (nulIdx >= 0) {
          const caps = text.slice(nulIdx + 1);
          for (const cap of caps.split(' ')) capabilities.add(cap);
          text = text.slice(0, nulIdx);
        }
        hasCapabilities = true;
      }
      const parts = text.split(' ');
      if (parts.length >= 3) {
        commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
      }
    }
  }

  const remainingBytes = decoder.takeBuffered();
  const hasUpdates = commands.some(c => c.newOid !== ZERO_OID);

  if (hasUpdates && remainingBytes.length > 0) {
    try {
      const packResult = readPack(remainingBytes);
      for (const [oid, obj] of packResult.objects.entries()) {
        store.storeObject(obj.type, obj.data);
      }
    } catch (err) {
      const errReport = encodePushReport(false, `unpack failed: ${(err as Error).message}`, [], capabilities.has('side-band-64k'));
      return {
        status: 200,
        headers: { 'content-type': 'application/x-git-receive-pack-result' },
        body: errReport,
      };
    }
  }

  const refReports: Array<{ ref: string; ok: boolean; reason: string }> = [];

  for (const cmd of commands) {
    const currentOid = store.getRef(owner, repo, cmd.ref) || ZERO_OID;
    if (cmd.oldOid !== currentOid) {
      refReports.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }

    if (cmd.oldOid !== ZERO_OID && cmd.newOid !== ZERO_OID) {
      const isAnc = store.isAncestor(owner, repo, cmd.oldOid, cmd.newOid);
      if (!isAnc) {
        refReports.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }

    if (cmd.newOid === ZERO_OID) {
      store.deleteRef(owner, repo, cmd.ref);
    } else {
      store.setRef(owner, repo, cmd.ref, cmd.newOid);
      if (cmd.ref === 'refs/heads/main') {
        store.setRef(owner, repo, 'HEAD', cmd.newOid);
      }
    }
    refReports.push({ ref: cmd.ref, ok: true, reason: '' });
  }

  const reportBytes = encodePushReport(true, '', refReports, capabilities.has('side-band-64k'));
  return {
    status: 200,
    headers: { 'content-type': 'application/x-git-receive-pack-result' },
    body: reportBytes,
  };
}

function encodePushReport(
  unpackOk: boolean,
  unpackDetail: string,
  refReports: Array<{ ref: string; ok: boolean; reason: string }>,
  sideband: boolean,
): Buffer {
  const lines: string[] = [];
  if (unpackOk) {
    lines.push('unpack ok\n');
  } else {
    lines.push(`unpack error ${unpackDetail}\n`);
  }

  for (const r of refReports) {
    if (r.ok) {
      lines.push(`ok ${r.ref}\n`);
    } else {
      lines.push(`ng ${r.ref} ${r.reason}\n`);
    }
  }

  const reportText = encodePktLines([...lines, 'flush']);
  if (sideband) {
    return Buffer.concat([
      encodeSideband(2, Buffer.from('Counting objects: 100% done\n', 'utf8')),
      encodeSideband(1, reportText),
      Buffer.from('0000', 'ascii'),
    ]);
  }
  return reportText;
}
