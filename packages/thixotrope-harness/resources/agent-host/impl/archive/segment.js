// @ts-check
/**
 * Segment files of the record archive (M2 W2.8; D-M2-1;
 * `designs/m2-interfaces.md` 4.2).
 *
 * A segment is records [from, to) of one session's log, whole settled
 * turns, as JSON lines:
 *
 * 1. a header `{ format, ordinal, from, to, firstTurn, turns, records,
 *    bytes, epoch, previous }`;
 * 2. one line per record in log order, every staged field
 *    (`{ blob, preview, bytes, digest? }`) written as
 *    `{ "$staged": { key, preview, bytes, digest? } }` (the blob file stays
 *    in the blob directory, named by its key);
 * 3. a trailer `{ "end": true, "digest" }`, digest = SHA-256 over the
 *    previous segment's digest (hex text) followed by every byte of lines 1
 *    and 2 (`chainDigest`).
 *
 * Written as `<name>.part`, fsynced, renamed to
 * `seg-<ordinal, 6 digits>-<first 16 hex of the digest>.jsonl`, and the
 * directory fsynced: only then is the segment durable and may the caller
 * answer the vat (D-15's rule for blobs). A file without a trailer, or whose
 * trailer does not verify, is half-written and never read (`readSegment`
 * throws).
 *
 * The record codec lives here too: `encodeRecord` turns a record with Blob
 * handles into its keyed form, `decodeRecord` turns a keyed record back into
 * one whose staged fields are whatever `toStaged` makes of `{ key, preview,
 * bytes, digest? }` (a token blob for the projection, a `SealedField` for
 * `History`).
 *
 * Node only.
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { isStaged } from '../../../../guest/session/staging.js';
/* eslint-enable import/no-relative-packages */

/** `header.format` of a segment file. */
export const SEGMENT_FORMAT = 'thixotrope-harness-segment-1';
/** Blob file keys the manager mints (`b<n>`). */
export const BLOB_KEY = /^b[1-9][0-9]*$/;
/** Segment file names. */
export const SEGMENT_NAME = /^seg-([0-9]{6})-([0-9a-f]{16})\.jsonl$/;

/**
 * @typedef {object} SegmentHeader
 * @property {string} format
 * @property {number} ordinal 1-based position in the session's chain
 * @property {number} from
 * @property {number} to
 * @property {number} firstTurn ordinal of the first turn
 * @property {number} turns
 * @property {number} records
 * @property {number} bytes record bytes as the vat measures them
 * @property {number} epoch
 * @property {string} previous the digest this segment chains to ('' first)
 *
 * @typedef {object} WrittenSegment
 * @property {string} file the segment's file name (in `dir`)
 * @property {number} from
 * @property {number} to
 * @property {number} firstTurn
 * @property {number} turns
 * @property {number} records
 * @property {number} bytes
 * @property {string} digest
 * @property {boolean} reused an identical file was already in place
 *
 * @typedef {'write' | 'fsync' | 'rename' | 'fsync-dir'} SegmentStep
 */

/** @param {string} path */
export const syncDirectory = async path => {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};
harden(syncDirectory);

/**
 * The chained digest of a segment: SHA-256 over the previous digest (hex
 * text) followed by `bytes` (its header and record lines).
 * @param {string} previous
 * @param {Uint8Array | string} bytes
 */
export const chainDigest = (previous, bytes) =>
  createHash('sha256').update(previous, 'utf8').update(bytes).digest('hex');
harden(chainDigest);

/**
 * @param {number} ordinal
 * @param {string} digest
 */
export const segmentName = (ordinal, digest) =>
  `seg-${String(ordinal).padStart(6, '0')}-${digest.slice(0, 16)}.jsonl`;
harden(segmentName);

/**
 * A record in its keyed form: every staged field becomes
 * `{ $staged: { key, preview, bytes, digest? } }`; everything else is
 * copied as is (records are plain data: strings, numbers, booleans,
 * arrays and records).
 * @param {any} value
 * @param {(blob: any) => string | undefined} keyOf
 * @returns {any}
 */
export const encodeRecord = (value, keyOf) => {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map(item => encodeRecord(item, keyOf));
  if (isStaged(value)) {
    const key = keyOf(value.blob);
    if (key === undefined || !BLOB_KEY.test(key)) {
      throw Error('a staged field has no blob key here');
    }
    /** @type {Record<string, any>} */
    const staged = { key, preview: value.preview, bytes: value.bytes };
    if (typeof value.digest === 'string') staged.digest = value.digest;
    return { $staged: staged };
  }
  /** @type {Record<string, any>} */
  const out = {};
  for (const name of Object.keys(value)) {
    out[name] = encodeRecord(value[name], keyOf);
  }
  return out;
};
harden(encodeRecord);

/** @param {any} value */
export const isKeyedStaged = value =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  typeof value.$staged === 'object' &&
  value.$staged !== null;
harden(isKeyedStaged);

/**
 * A keyed record back to a record: every `{ $staged }` becomes
 * `toStaged(info)`.
 * @param {any} value
 * @param {(info: { key: string, preview: string, bytes: number, digest?: string }) => any} toStaged
 * @returns {any}
 */
export const decodeRecord = (value, toStaged) => {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value))
    return value.map(item => decodeRecord(item, toStaged));
  if (isKeyedStaged(value)) return toStaged(value.$staged);
  /** @type {Record<string, any>} */
  const out = {};
  for (const name of Object.keys(value)) {
    out[name] = decodeRecord(value[name], toStaged);
  }
  return out;
};
harden(decodeRecord);

/**
 * Every blob key a keyed record (or any keyed value) names.
 * @param {any} value
 * @param {(key: string, info: any) => void} visit
 */
export const forEachKey = (value, visit) => {
  if (typeof value !== 'object' || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) forEachKey(item, visit);
    return;
  }
  if (isKeyedStaged(value)) {
    visit(value.$staged.key, value.$staged);
    return;
  }
  if (typeof value.$key === 'string') {
    visit(value.$key, undefined);
    return;
  }
  for (const name of Object.keys(value)) forEachKey(value[name], visit);
};
harden(forEachKey);

/**
 * A segment's bytes and chained digest (pure: `writeSegment` writes them;
 * the in-memory fake archive of the vat's unit tests computes the same).
 * @param {Omit<SegmentHeader, 'format' | 'previous' | 'records'>} header
 * @param {readonly any[]} records keyed records, in segment order
 * @param {string} previous
 */
export const formatSegment = (header, records, previous) => {
  /** @type {SegmentHeader} */
  const full = {
    format: SEGMENT_FORMAT,
    ordinal: header.ordinal,
    from: header.from,
    to: header.to,
    firstTurn: header.firstTurn,
    turns: header.turns,
    records: records.length,
    bytes: header.bytes,
    epoch: header.epoch,
    previous,
  };
  if (full.to - full.from !== records.length) {
    throw Error(
      `a segment of ${records.length} records cannot be [${full.from}, ${full.to})`,
    );
  }
  /** @type {string[]} */
  const lines = [JSON.stringify(full)];
  for (const record of records) lines.push(JSON.stringify(record));
  const body = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
  const digest = chainDigest(previous, body);
  const trailer = Buffer.from(
    `${JSON.stringify({ end: true, digest })}\n`,
    'utf8',
  );
  return { header: full, body, trailer, digest };
};
harden(formatSegment);

/**
 * Write a segment durably: `<name>.part`, fsync, rename, fsync the
 * directory. An identical file already in place (an orphan of an earlier
 * attempt of the same range, same digest) is verified and reused.
 *
 * @param {string} dir the session's archive directory (exists)
 * @param {Omit<SegmentHeader, 'format' | 'previous' | 'records'>} header
 * @param {readonly any[]} records keyed records (`encodeRecord`), in log order
 * @param {string} previous the digest this segment chains to ('' first)
 * @param {{ trace?: (step: SegmentStep, name: string) => void }} [options]
 * @returns {Promise<WrittenSegment>}
 */
export const writeSegment = async (
  dir,
  header,
  records,
  previous,
  { trace = () => {} } = {},
) => {
  const {
    header: full,
    body,
    trailer,
    digest,
  } = formatSegment(header, records, previous);
  const name = segmentName(full.ordinal, digest);
  const path = join(dir, name);
  const entry = {
    file: name,
    from: full.from,
    to: full.to,
    firstTurn: full.firstTurn,
    turns: full.turns,
    records: full.records,
    bytes: full.bytes,
    digest,
  };
  const existing = await stat(path).catch(() => undefined);
  if (existing !== undefined) {
    try {
      const found = await readSegment(path);
      if (found.digest === digest) {
        return harden({ ...entry, reused: true });
      }
    } catch {
      // Damaged: kept aside as `<name>.bad` (never removed), replaced below.
      await rename(path, `${path}.bad`).catch(() => {});
    }
  }
  const part = `${path}.part`;
  const handle = await open(part, 'w', 0o600);
  try {
    try {
      trace('write', name);
      await handle.writev([body, trailer]);
      trace('fsync', name);
      await handle.sync();
    } finally {
      await handle.close();
    }
    trace('rename', name);
    await rename(part, path);
  } catch (error) {
    await unlink(part).catch(() => {});
    throw error;
  }
  trace('fsync-dir', name);
  await syncDirectory(dir);
  return harden({ ...entry, reused: false });
};
harden(writeSegment);

/**
 * Split a file's text into lines; the last element is what follows the
 * last newline ('' for a whole file).
 * @param {string} text
 */
const linesOf = text => text.split('\n');

/**
 * Read and verify a segment file.
 * @param {string} path
 * @param {{ records?: boolean }} [options] `records: false` hashes the
 *   whole file but parses only the header (validation walks the chain)
 * @returns {Promise<{ header: SegmentHeader, records: any[], digest: string, size: number }>}
 */
export const readSegment = async (path, { records: parse = true } = {}) => {
  const buffer = await readFile(path);
  // The trailer is the last line: find the newline before it.
  if (buffer.length === 0 || buffer[buffer.length - 1] !== 0x0a) {
    throw Error(`segment ${path} is half-written`);
  }
  const cut = buffer.lastIndexOf(0x0a, buffer.length - 2);
  if (cut < 0) throw Error(`segment ${path} has no trailer`);
  const body = buffer.subarray(0, cut + 1);
  /** @type {any} */
  let trailer;
  try {
    trailer = JSON.parse(
      buffer.subarray(cut + 1, buffer.length - 1).toString('utf8'),
    );
  } catch {
    throw Error(`segment ${path} has no trailer`);
  }
  if (trailer?.end !== true || typeof trailer.digest !== 'string') {
    throw Error(`segment ${path} has no trailer`);
  }
  const lines = linesOf(body.toString('utf8'));
  lines.pop();
  /** @type {any} */
  const header = JSON.parse(lines[0]);
  if (header?.format !== SEGMENT_FORMAT) {
    throw Error(`segment ${path} is not a segment`);
  }
  const digest = chainDigest(header.previous, body);
  if (digest !== trailer.digest) {
    throw Error(`segment ${path} does not verify`);
  }
  if (lines.length - 1 !== header.records) {
    throw Error(`segment ${path} does not hold its records`);
  }
  const records = parse ? lines.slice(1).map(line => JSON.parse(line)) : [];
  if (header.to - header.from !== header.records) {
    throw Error(`segment ${path} does not hold its records`);
  }
  return { header, records, digest, size: buffer.length };
};
harden(readSegment);
