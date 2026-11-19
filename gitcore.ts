// Git object model: hashing, parsing (memoised on each object), packfile read
// and write, delta application, reachability, tree flatten/rebuild and the
// three-way tree merge the pull-request and contents APIs share.
//
// Performance notes, baked in from the start:
//  - an object is parsed at most once; the parsed form rides on the record.
//  - an object's zlib-deflated pack form is computed at most once and cached.
//  - pack parsing is the only place a consumed-length zlib read is needed, so
//    it is the only place that asks zlib for stream info; every other inflate
//    and every deflate is the plain fast call.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitType = 'commit' | 'tree' | 'blob' | 'tag';
export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_CODE: Record<GitType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface Ident {
  name: string;
  email: string;
  timestamp: number;
  timezone: string;
  raw: string;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: Ident;
  committer: Ident;
  message: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface TagView {
  object: string;
  type: GitType;
  tag: string;
  tagger: string;
  message: string;
}

/** One stored object plus every derived form this server has computed for it. */
export interface ObjectRecord {
  type: GitType;
  data: Buffer;
  commit?: CommitView;
  tree?: TreeEntry[];
  tag?: TagView;
  /** path -> blob entry, for the tree this record holds (trees only). */
  flat?: Map<string, FlatEntry>;
  /** deflated data, as a pack entry body (no header). */
  packed?: Buffer;
}

export interface FlatEntry {
  mode: string;
  oid: string;
}

export function hashObject(type: GitType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function isOid(value: string): boolean {
  if (value.length !== 40) return false;
  for (let i = 0; i < 40; i += 1) {
    const c = value.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return false;
  }
  return true;
}

function parseIdent(raw: string): Ident {
  // "Name <email> 1735689600 +0000"
  const lt = raw.indexOf('<');
  const gt = raw.indexOf('>', lt + 1);
  if (lt < 0 || gt < 0) return { name: raw, email: '', timestamp: 0, timezone: '+0000', raw };
  const rest = raw.slice(gt + 2);
  const space = rest.indexOf(' ');
  const timestamp = space < 0 ? Number(rest) || 0 : Number(rest.slice(0, space)) || 0;
  const timezone = space < 0 ? '+0000' : rest.slice(space + 1);
  return { name: raw.slice(0, lt).trimEnd(), email: raw.slice(lt + 1, gt), timestamp, timezone, raw };
}

export function commitOf(record: ObjectRecord): CommitView {
  if (record.commit) return record.commit;
  const data = record.data;
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const header = data.toString('utf8', 0, headerEnd);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  let start = 0;
  while (start < header.length) {
    let end = header.indexOf('\n', start);
    if (end < 0) end = header.length;
    const line = header.slice(start, end);
    start = end + 1;
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  const view: CommitView = {
    tree,
    parents,
    author: parseIdent(author),
    committer: parseIdent(committer),
    message: blank < 0 ? '' : data.toString('utf8', blank + 2),
  };
  record.commit = view;
  return view;
}

export function treeOf(record: ObjectRecord): TreeEntry[] {
  if (record.tree) return record.tree;
  const data = record.data;
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    const mode = data.toString('ascii', offset, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  record.tree = entries;
  return entries;
}

export function tagOf(record: ObjectRecord): TagView {
  if (record.tag) return record.tag;
  const data = record.data;
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const header = data.toString('utf8', 0, headerEnd);
  let object = '';
  let type: GitType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7);
    else if (line.startsWith('type ')) type = line.slice(5) as GitType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  const view: TagView = { object, type, tag, tagger, message: blank < 0 ? '' : data.toString('utf8', blank + 2) };
  record.tag = view;
  return view;
}

/** Follow a tag chain to the commit it ultimately names (or the object itself). */
export function peelToCommit(objects: Map<string, ObjectRecord>, oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const record = objects.get(current);
    if (!record || record.type !== 'tag') return current;
    current = tagOf(record).object;
  }
  return current;
}

/** The oid a ref advertisement peels to, when the ref names an annotated tag. */
export function peeledOf(objects: Map<string, ObjectRecord>, oid: string): string | null {
  const record = objects.get(oid);
  if (!record || record.type !== 'tag') return null;
  return peelToCommit(objects, oid);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  timestamp: number;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} +0000`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} +0000`);
  lines.push('');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** Store one object (idempotent) and answer its id. */
export function putObject(objects: Map<string, ObjectRecord>, type: GitType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------- packfiles

function packEntryHeader(type: GitType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function packedOf(record: ObjectRecord): Buffer {
  if (!record.packed) record.packed = deflateSync(record.data);
  return record.packed;
}

/** A whole packfile for `records`, in the order given, with its SHA-1 trailer. */
export function buildPack(records: readonly ObjectRecord[]): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(records.length, 8);
  const parts: Buffer[] = [header];
  for (const record of records) {
    parts.push(packEntryHeader(record.type, record.data.length));
    parts.push(packedOf(record));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git delta to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readSize();
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  data: Buffer;
  baseOffset: number;
  baseOid: string;
}

/**
 * Read a packfile's objects, resolving OFS/REF deltas. A REF delta base may
 * live in `external` (a thin pack against the repository's own store).
 * Throws on any structural problem; the caller turns that into unpack ng.
 */
export function readPack(
  pack: Buffer,
  external?: Map<string, ObjectRecord>,
): Map<string, ObjectRecord> {
  if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('bad pack version');
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack checksum mismatch');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOffset = 0;
    let baseOid = '';
    if (typeCode === 6) {
      byte = pack[offset] as number;
      offset += 1;
      let value = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset] as number;
        offset += 1;
        value = (value + 1) * 128 + (byte & 0x7f);
      }
      baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error('unknown pack type');
    }
    // The one consumed-length read in the server: a pack entry's compressed
    // length is not recorded anywhere else in the format.
    const inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (inflated.buffer.length !== size) throw new Error('pack entry size mismatch');
    offset += inflated.engine.bytesWritten;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, data: inflated.buffer, baseOffset, baseOid };
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has trailing bytes');

  const resolved = new Map<string, ObjectRecord>();
  const byOid = new Map<string, { type: GitType; data: Buffer }>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): { type: GitType; data: Buffer } => {
    if (entry.typeCode !== 6 && entry.typeCode !== 7) {
      return { type: CODE_TYPE[entry.typeCode] as GitType, data: entry.data };
    }
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let base: { type: GitType; data: Buffer };
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      base = resolve(baseEntry);
    } else {
      const inPack = byOid.get(entry.baseOid);
      if (inPack) base = inPack;
      else {
        const outside = external?.get(entry.baseOid);
        if (!outside) throw new Error('ref-delta base missing');
        base = { type: outside.type, data: outside.data };
      }
    }
    const out = { type: base.type, data: applyDelta(base.data, entry.data) };
    resolving.delete(entry.offset);
    return out;
  };
  for (const entry of raw) {
    const object = resolve(entry);
    const oid = hashObject(object.type, object.data);
    byOid.set(oid, object);
    if (!resolved.has(oid)) resolved.set(oid, { type: object.type, data: object.data });
  }
  return resolved;
}

// ---------------------------------------------------------------- traversal

/** Every object reachable from `roots`, following commits, trees and tags. */
export function collectReachable(objects: Map<string, ObjectRecord>, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root) && root !== ZERO_OID) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const record = objects.get(oid);
    if (!record) continue;
    seen.add(oid);
    if (record.type === 'commit') {
      const commit = commitOf(record);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (record.type === 'tag') {
      queue.push(tagOf(record).object);
    } else if (record.type === 'tree') {
      for (const entry of treeOf(record)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** The tree closure of one commit (the commit's tree and everything under it). */
export function treeClosure(objects: Map<string, ObjectRecord>, treeOid: string, into: Set<string>): void {
  const queue = [treeOid];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (into.has(oid)) continue;
    const record = objects.get(oid);
    if (!record) continue;
    into.add(oid);
    if (record.type === 'tree') {
      for (const entry of treeOf(record)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
}

/** Is `ancestor` reachable from `descendant` through commit parents? */
export function isAncestor(objects: Map<string, ObjectRecord>, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const record = objects.get(oid);
    if (!record || record.type !== 'commit') continue;
    for (const parent of commitOf(record).parents) queue.push(parent);
  }
  return false;
}

/** Ancestor set of a commit with BFS generation numbers (for merge bases). */
function generations(objects: Map<string, ObjectRecord>, tip: string): Map<string, number> {
  const gens = new Map<string, number>();
  gens.set(tip, 0);
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    const gen = gens.get(oid) as number;
    const record = objects.get(oid);
    if (!record || record.type !== 'commit') continue;
    for (const parent of commitOf(record).parents) {
      if (!gens.has(parent)) {
        gens.set(parent, gen + 1);
        queue.push(parent);
      }
    }
  }
  return gens;
}

/** The best common ancestor of two commits, or null when unrelated. */
export function mergeBase(objects: Map<string, ObjectRecord>, a: string, b: string): string | null {
  if (a === b) return a;
  const gensA = generations(objects, a);
  const gensB = generations(objects, b);
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [oid, genA] of gensA) {
    const genB = gensB.get(oid);
    if (genB === undefined) continue;
    const score = genA + genB;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

// ---------------------------------------------------------------- flat trees

/** Flatten a tree object into path -> entry, memoised on the tree record. */
export function flattenTree(objects: Map<string, ObjectRecord>, treeOid: string): Map<string, FlatEntry> {
  const root = objects.get(treeOid);
  if (root && root.flat) return root.flat;
  const out = new Map<string, FlatEntry>();
  const walk = (oid: string, prefix: string): void => {
    const record = objects.get(oid);
    if (!record || record.type !== 'tree') return;
    for (const entry of treeOf(record)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  if (root) walk(treeOid, '');
  if (root) root.flat = out;
  return out;
}

/** Rebuild nested tree objects from a flat path map; returns the root tree oid. */
export function buildTreeFromFlat(objects: Map<string, ObjectRecord>, flat: Map<string, FlatEntry>): string {
  interface Node {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      let child = node.dirs.get(name);
      if (!child) {
        child = make();
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(objects, 'tree', buildTree(entries));
  };
  return build(root);
}

/** The flat tree a commit holds (empty map for a missing commit). */
export function flatTreeOfCommit(objects: Map<string, ObjectRecord>, commitOid: string): Map<string, FlatEntry> {
  const record = objects.get(commitOid);
  if (!record || record.type !== 'commit') return new Map();
  return flattenTree(objects, commitOf(record).tree);
}

export interface MergeOutcome {
  ok: boolean;
  flat: Map<string, FlatEntry>;
  conflicts: string[];
}

/**
 * Three-way merge of flattened trees: a path changed on only one side takes
 * that side; changed on both sides to different results is a conflict.
 */
export function mergeFlats(
  base: Map<string, FlatEntry>,
  ours: Map<string, FlatEntry>,
  theirs: Map<string, FlatEntry>,
): MergeOutcome {
  const out = new Map<string, FlatEntry>();
  const conflicts: string[] = [];
  const paths = new Set<string>();
  for (const key of base.keys()) paths.add(key);
  for (const key of ours.keys()) paths.add(key);
  for (const key of theirs.keys()) paths.add(key);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const sameOT = o?.oid === t?.oid && o?.mode === t?.mode;
    if (sameOT) {
      if (o) out.set(path, o);
      continue;
    }
    const oursChanged = o?.oid !== b?.oid || o?.mode !== b?.mode;
    const theirsChanged = t?.oid !== b?.oid || t?.mode !== b?.mode;
    if (oursChanged && !theirsChanged) {
      if (o) out.set(path, o);
    } else if (theirsChanged && !oursChanged) {
      if (t) out.set(path, t);
    } else {
      conflicts.push(path);
    }
  }
  return { ok: conflicts.length === 0, flat: out, conflicts };
}

/** Line counts for a blob pair, by bag difference of lines (for PR files). */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const countLines = (text: string): Map<string, number> => {
    const counts = new Map<string, number>();
    if (text === '') return counts;
    for (const line of text.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
    return counts;
  };
  const oldCounts = countLines(oldText);
  const newCounts = countLines(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newCounts) additions += Math.max(0, count - (oldCounts.get(line) ?? 0));
  for (const [line, count] of oldCounts) deletions += Math.max(0, count - (newCounts.get(line) ?? 0));
  return { additions, deletions };
}

export function countLines(text: string): number {
  if (text === '') return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) lines += 1;
  if (text.charCodeAt(text.length - 1) === 10) lines -= 1;
  return lines;
}
