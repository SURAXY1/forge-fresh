// Git smart HTTP: the info/refs advertisement (v0 and protocol v2),
// upload-pack (v2 ls-refs and fetch, plus a v0 fetch), and receive-pack
// (v0, report-status, fast-forward enforcement).
//
// Replies that depend only on repository state — advertisements, ls-refs
// answers and fetch packs — are memoised in the repository's git cache,
// which store.touch() clears on every mutation (epoch invalidation), so a
// repeated clone or fetch is a map lookup and a buffer copy.

import {
  ZERO_OID,
  buildPack,
  collectReachable,
  commitOf,
  isAncestor,
  isOid,
  peeledOf,
  readPack,
  treeClosure,
  type ObjectRecord,
} from './gitcore.ts';
import { store, type Repo } from './store.ts';

// ---------------------------------------------------------------- pkt-lines

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' };

/** Parse a pkt-line stream; throws on malformed framing. */
export function parsePackets(body: Buffer, start = 0): { packets: Packet[]; rest: number } {
  const packets: Packet[] = [];
  let offset = start;
  while (offset + 4 <= body.length) {
    const header = body.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('bad pkt-line header');
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2 || length === 3) {
      offset += 4;
      continue;
    }
    if (offset + length > body.length) throw new Error('pkt-line overruns body');
    packets.push({ kind: 'data', payload: body.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: offset };
}

function linesOf(packets: Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// ---------------------------------------------------------------- refs view

interface RefLine {
  oid: string;
  name: string;
  peeled: string | null;
  symref: string | null;
  unborn: boolean;
}

/** Every advertised ref: HEAD first, then the refs in name order. */
export function refLines(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (headOid) {
    lines.push({ oid: headOid, name: 'HEAD', peeled: null, symref: headTarget, unborn: false });
  } else {
    lines.push({ oid: ZERO_OID, name: 'HEAD', peeled: null, symref: headTarget, unborn: true });
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    lines.push({ oid, name, peeled: peeledOf(repo.objects, oid), symref: null, unborn: false });
  }
  return lines;
}

const UPLOAD_CAPS_V0 =
  'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not no-progress include-tag agent=forge-fresh/1.0 object-format=sha1';
const RECEIVE_CAPS_V0 =
  'report-status delete-refs side-band-64k ofs-delta quiet agent=forge-fresh/1.0 object-format=sha1';

export function advertisementV0(repo: Repo, service: string): Buffer {
  const cacheKey = `adv0:${service}`;
  const cached = repo.gitCache.get(cacheKey);
  if (cached) return cached;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const caps = service === 'git-receive-pack' ? RECEIVE_CAPS_V0 : `${UPLOAD_CAPS_V0} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const lines = refLines(repo).filter((line) => !line.unborn);
  if (lines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    lines.forEach((line, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${line.oid} ${line.name}${suffix}\n`));
      if (line.peeled) parts.push(pktLine(`${line.peeled} ${line.name}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  repo.gitCache.set(cacheKey, body);
  return body;
}

const V2_ADVERTISEMENT = Buffer.concat([
  pktLine('# service=git-upload-pack\n'),
  PKT_FLUSH,
  pktLine('version 2\n'),
  pktLine('agent=forge-fresh/1.0\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow wait-for-done filter\n'),
  pktLine('object-format=sha1\n'),
  PKT_FLUSH,
]);

export function advertisementV2(): Buffer {
  return V2_ADVERTISEMENT;
}

// ---------------------------------------------------------------- ls-refs

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

export function lsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const cacheKey = `lsrefs:${args.peel ? 1 : 0}${args.symrefs ? 1 : 0}${args.unborn ? 1 : 0}:${args.prefixes.join(',')}`;
  const cached = repo.gitCache.get(cacheKey);
  if (cached) return cached;
  const parts: Buffer[] = [];
  for (const line of refLines(repo)) {
    if (args.prefixes.length > 0 && !args.prefixes.some((prefix) => line.name.startsWith(prefix))) continue;
    if (line.unborn) {
      if (!args.unborn) continue;
      const symref = args.symrefs && line.symref ? ` symref-target:${line.symref}` : '';
      parts.push(pktLine(`unborn HEAD${symref}\n`));
      continue;
    }
    let text = `${line.oid} ${line.name}`;
    if (args.symrefs && line.symref) text += ` symref-target:${line.symref}`;
    if (args.peel && line.peeled) text += ` peeled:${line.peeled}`;
    parts.push(pktLine(`${text}\n`));
  }
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  repo.gitCache.set(cacheKey, body);
  return body;
}

// ---------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  done: boolean;
}

/**
 * The set of objects the client already holds: the full closure of its
 * haves, except that a shallow boundary commit contributes only itself and
 * its tree closure (its parents are exactly what the client lacks).
 */
function heldObjects(repo: Repo, args: FetchArgs): Set<string> {
  const shallowSet = new Set(args.shallow);
  const held = new Set<string>();
  for (const have of args.haves) {
    if (!repo.objects.has(have)) continue;
    if (shallowSet.has(have)) {
      held.add(have);
      const record = repo.objects.get(have) as ObjectRecord;
      if (record.type === 'commit') treeClosure(repo.objects, commitOf(record).tree, held);
      continue;
    }
    for (const oid of collectReachable(repo.objects, [have])) held.add(oid);
  }
  return held;
}

interface FetchPlan {
  records: ObjectRecord[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Plan a fetch: BFS generations from the wants, honouring the depth limit
 * (a deepen against an existing shallow boundary counts from the wants,
 * which is the generation count the client asked to end up with), minus
 * everything the client already holds.
 */
export function planFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const held = heldObjects(repo, args);
  const depthLimit = args.depth ?? Infinity;
  const generations = new Map<string, number>();
  const queue: string[] = [];
  for (const want of args.wants) {
    if (!repo.objects.has(want) || generations.has(want)) continue;
    generations.set(want, 1);
    queue.push(want);
  }
  const included = new Set<string>();
  const boundary = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    const gen = generations.get(oid) as number;
    const record = repo.objects.get(oid);
    if (!record) continue;
    if (record.type === 'commit') {
      included.add(oid);
      treeClosure(repo.objects, commitOf(record).tree, included);
      if (gen >= depthLimit) {
        // Report a boundary only when history is actually cut off here.
        if (commitOf(record).parents.length > 0) boundary.add(oid);
        continue;
      }
      for (const parent of commitOf(record).parents) {
        if (!generations.has(parent)) {
          generations.set(parent, gen + 1);
          queue.push(parent);
        }
      }
    } else {
      // A want naming a tag or tree: send its closure.
      for (const inner of collectReachable(repo.objects, [oid])) included.add(inner);
    }
  }
  const clientShallow = new Set(args.shallow);
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    if (included.has(oid) && !boundary.has(oid)) {
      const record = repo.objects.get(oid);
      if (record && record.type === 'commit' && commitOf(record).parents.some((parent) => included.has(parent))) {
        unshallow.push(oid);
      }
    }
  }
  const records: ObjectRecord[] = [];
  for (const oid of included) {
    if (held.has(oid)) continue;
    const record = repo.objects.get(oid);
    if (record) records.push(record);
  }
  return { records, shallow: [...boundary], unshallow };
}

function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65500;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), pack])));
  }
  return parts;
}

export function fetchV2(repo: Repo, args: FetchArgs): Buffer {
  const cacheKey = `fetch2:${args.wants.join(',')}|${args.haves.join(',')}|${args.shallow.join(',')}|${args.depth ?? ''}`;
  const cached = repo.gitCache.get(cacheKey);
  if (cached) return cached;
  const plan = planFetch(repo, args);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  const common = args.haves.filter((have) => repo.objects.has(have));
  if (common.length === 0) parts.push(pktLine('NAK\n'));
  else for (const have of common) parts.push(pktLine(`ACK ${have}\n`));
  parts.push(PKT_FLUSH);
  if (args.depth !== null || args.shallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  const pack = buildPack(plan.records);
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  repo.gitCache.set(cacheKey, body);
  return body;
}

export function fetchV0(repo: Repo, args: FetchArgs): Buffer {
  const cacheKey = `fetch0:${args.wants.join(',')}|${args.haves.join(',')}|${args.shallow.join(',')}|${args.depth ?? ''}`;
  const cached = repo.gitCache.get(cacheKey);
  if (cached) return cached;
  const plan = planFetch(repo, args);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const common = args.haves.filter((have) => repo.objects.has(have));
  if (common.length === 0) parts.push(pktLine('NAK\n'));
  else for (const have of common) parts.push(pktLine(`ACK ${have} ready\n`));
  const pack = buildPack(plan.records);
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  repo.gitCache.set(cacheKey, body);
  return body;
}

/** Parse and answer one upload-pack POST body (v2 or v0). */
export function uploadPack(repo: Repo, body: Buffer, protocolV2: boolean): Buffer {
  const { packets } = parsePackets(body);
  // Split into argument sections on delim/flush boundaries.
  const sections: string[][] = [[]];
  for (const packet of packets) {
    if (packet.kind === 'data') {
      (sections[sections.length - 1] as string[]).push(packet.payload.toString('utf8').replace(/\n$/, ''));
    } else {
      sections.push([]);
    }
  }
  const head = sections[0] ?? [];
  const commandLine = head.find((line) => line.startsWith('command='));
  if (protocolV2 && commandLine) {
    const command = commandLine.slice('command='.length);
    const args = sections[1] ?? [];
    if (command === 'ls-refs') {
      const lsArgs: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const line of args) {
        if (line === 'peel') lsArgs.peel = true;
        else if (line === 'symrefs') lsArgs.symrefs = true;
        else if (line === 'unborn') lsArgs.unborn = true;
        else if (line.startsWith('ref-prefix ')) lsArgs.prefixes.push(line.slice('ref-prefix '.length));
      }
      return lsRefs(repo, lsArgs);
    }
    if (command === 'fetch') {
      const fetchArgs: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [], done: false };
      for (const line of args) {
        if (line.startsWith('want ')) fetchArgs.wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) fetchArgs.haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) fetchArgs.shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) fetchArgs.depth = Number(line.slice(7)) || null;
        else if (line.startsWith('deepen-since ')) fetchArgs.deepenSince = Number(line.slice(13)) || null;
        else if (line.startsWith('deepen-not ')) fetchArgs.deepenNot.push(line.slice(11).trim());
        else if (line === 'done') fetchArgs.done = true;
      }
      return fetchV2(repo, fetchArgs);
    }
    throw new Error(`unknown v2 command ${command}`);
  }
  // Protocol v0: wants in the first section, haves after the flush.
  const fetchArgs: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [], done: true };
  for (const line of head) {
    if (line.startsWith('want ')) fetchArgs.wants.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) fetchArgs.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) fetchArgs.depth = Number(line.slice(7)) || null;
    else if (line.startsWith('deepen-since ')) fetchArgs.deepenSince = Number(line.slice(13)) || null;
    else if (line.startsWith('deepen-not ')) fetchArgs.deepenNot.push(line.slice(11).trim());
  }
  for (const section of sections.slice(1)) {
    for (const line of section) {
      if (line.startsWith('have ')) fetchArgs.haves.push(line.slice(5).trim());
    }
  }
  return fetchV0(repo, fetchArgs);
}

// ---------------------------------------------------------------- receive-pack

export interface PushOutcome {
  body: Buffer;
}

/**
 * Answer one receive-pack POST: unpack the pack into the repository, then
 * apply each ref update that fast-forwards (or creates/deletes), reporting
 * per-ref status in the framing the client asked for.
 */
export function receivePack(repo: Repo, body: Buffer): PushOutcome {
  const { packets, rest } = parsePackets(body);
  const commandLines = linesOf(packets);
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
    caps: string;
  }
  const commands: Command[] = [];
  for (const line of commandLines) {
    const nul = line.indexOf('\0');
    const text = nul >= 0 ? line.slice(0, nul) : line;
    const caps = nul >= 0 ? line.slice(nul + 1) : '';
    const parts = text.split(' ');
    if (parts.length !== 3 || !isOid(parts[0] as string) || !isOid(parts[1] as string)) continue;
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string, caps });
  }
  const caps = commands.length > 0 ? (commands[0] as Command).caps : '';
  const wantReport = caps.includes('report-status');
  const wantSideband = caps.includes('side-band-64k');

  let unpackOk = true;
  let unpackDetail = 'ok';
  const packBytes = body.subarray(rest);
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, repo.objects);
      for (const [oid, record] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, record);
      }
    } catch {
      unpackOk = false;
      unpackDetail = 'pack parse error';
    }
  } else if (updatesRef) {
    unpackOk = false;
    unpackDetail = 'no pack for an updating push';
  }

  const results: { ref: string; ok: boolean; reason: string }[] = [];
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? ZERO_OID;
      if (command.newOid === ZERO_OID) {
        if (current === ZERO_OID) {
          results.push({ ref: command.ref, ok: false, reason: 'reference does not exist' });
        } else if (command.oldOid !== current) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          repo.refs.delete(command.ref);
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      const record = repo.objects.get(command.newOid);
      if (!record) {
        results.push({ ref: command.ref, ok: false, reason: 'new object not in pack' });
        continue;
      }
      if (current !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (current !== ZERO_OID && record.type === 'commit') {
        if (!isAncestor(repo.objects, current, command.newOid)) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
      }
      if (current === ZERO_OID && command.oldOid !== ZERO_OID) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
    }
    if (results.some((result) => result.ok)) store.touch(repo);
    else if (packBytes.length > 0) store.touch(repo);
  } else {
    for (const command of commands) results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
  }

  if (!wantReport) return { body: Buffer.alloc(0) };
  const reportParts: Buffer[] = [pktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`)];
  for (const result of results) {
    reportParts.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);
  if (!wantSideband) return { body: report };
  const framed: Buffer[] = [];
  const CHUNK = 65500;
  for (let offset = 0; offset < report.length; offset += CHUNK) {
    framed.push(pktLine(Buffer.concat([Buffer.from([1]), report.subarray(offset, Math.min(report.length, offset + CHUNK))])));
  }
  framed.push(PKT_FLUSH);
  return { body: Buffer.concat(framed) };
}
