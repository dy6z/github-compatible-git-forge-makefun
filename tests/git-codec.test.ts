import test from 'node:test';
import assert from 'node:assert';
import { Buffer } from 'node:buffer';
import {
  encodePktLine,
  pktLineFlush,
  pktLineDelim,
  pktLineResponseEnd,
  encodePktLines,
  PktLineDecoder,
  decodePktLines,
  packetsToLines,
} from '../packet.ts';
import {
  hashObject,
  encodeLooseObject,
  parseTree,
  buildTree,
  parseCommit,
  buildCommit,
  parseTag,
  buildTag,
  writePack,
  readPack,
  applyDelta,
  verifyPackChecksum,
} from '../pack.ts';

test('pkt-line encoding and decoding', () => {
  const line = encodePktLine('hello\n');
  assert.strictEqual(line.toString('ascii'), '000ahello\n');

  const flush = pktLineFlush();
  assert.strictEqual(flush.toString('ascii'), '0000');

  const delim = pktLineDelim();
  assert.strictEqual(delim.toString('ascii'), '0001');

  const responseEnd = pktLineResponseEnd();
  assert.strictEqual(responseEnd.toString('ascii'), '0002');

  const multi = encodePktLines(['hello\n', 'flush', 'world\n', 'delim']);
  const decoder = new PktLineDecoder(multi);
  decoder.finish();

  const p1 = decoder.next();
  assert.strictEqual(p1?.kind, 'data');
  assert.strictEqual(p1.payload.toString('utf8'), 'hello\n');

  const p2 = decoder.next();
  assert.strictEqual(p2?.kind, 'flush');

  const p3 = decoder.next();
  assert.strictEqual(p3?.kind, 'data');
  assert.strictEqual(p3.payload.toString('utf8'), 'world\n');

  const p4 = decoder.next();
  assert.strictEqual(p4?.kind, 'delim');

  assert.strictEqual(decoder.next(), null);
  assert.strictEqual(decoder.complete, true);
});

test('git object hashing and loose objects', () => {
  const data = Buffer.from('hello world\n', 'utf8');
  const oid = hashObject('blob', data);
  assert.strictEqual(oid.length, 40);

  const loose = encodeLooseObject('blob', data);
  assert.ok(loose.length > data.length);
});

test('tree parsing and building roundtrip', () => {
  const entries = [
    { mode: '100644', name: 'README.md', oid: '29f33e0fb4fba8403069aef026e95e1ed1b1788f' },
    { mode: '40000', name: 'src', oid: 'ed2b4c063cb51d62b7c145b1820836b4c8e5ac66' },
  ];
  const built = buildTree(entries);
  const parsed = parseTree(built);
  assert.strictEqual(parsed.length, 2);
  assert.strictEqual(parsed[0].name, 'README.md');
  assert.strictEqual(parsed[1].name, 'src');
});

test('commit parsing and building roundtrip', () => {
  const commitBytes = buildCommit({
    tree: '29f33e0fb4fba8403069aef026e95e1ed1b1788f',
    message: 'Initial commit\n',
  });
  const parsed = parseCommit(commitBytes);
  assert.strictEqual(parsed.tree, '29f33e0fb4fba8403069aef026e95e1ed1b1788f');
  assert.strictEqual(parsed.message, 'Initial commit\n');
});

test('tag parsing and building roundtrip', () => {
  const tagBytes = buildTag({
    object: '29f33e0fb4fba8403069aef026e95e1ed1b1788f',
    type: 'commit',
    tag: 'v1.0.0',
    message: 'Release version 1.0.0\n',
  });
  const parsed = parseTag(tagBytes);
  assert.strictEqual(parsed.object, '29f33e0fb4fba8403069aef026e95e1ed1b1788f');
  assert.strictEqual(parsed.tag, 'v1.0.0');
  assert.strictEqual(parsed.message, 'Release version 1.0.0\n');
});

test('pack write and read roundtrip with checksum', () => {
  const blobData = Buffer.from('hello pack test', 'utf8');
  const objects = [
    { type: 'blob' as const, data: blobData },
  ];
  const packBuf = writePack(objects);
  const check = verifyPackChecksum(packBuf);
  assert.strictEqual(check.ok, true);

  const parsedPack = readPack(packBuf);
  assert.strictEqual(parsedPack.declaredCount, 1);
  assert.strictEqual(parsedPack.checksumOk, true);
  assert.strictEqual(parsedPack.objects.size, 1);
});

test('delta application fixture', () => {
  const base = Buffer.from('abcdefghijklmnopqrstuvwxyz', 'utf8');
  // Construct a simple delta: source size 26, target size 5, insert 'hello' (literal 5)
  // varint 26: 0x1a, varint 5: 0x05, opcode 5 (insert 5 bytes): 0x05 + 'hello'
  const delta = Buffer.from([0x1a, 0x05, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);
  const applied = applyDelta(base, delta);
  assert.strictEqual(applied.toString('utf8'), 'hello');
});
