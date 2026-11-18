// @ts-check
/**
 * `context.jsonl`: the persisted projection of a session's sealed turns
 * (M2 W2.8; `designs/m2-interfaces.md` 4.7, 4.8, 4.12; J-0322 option (b)).
 *
 * First line `{ format, epoch, boundary }`; then, per acknowledged segment
 * in chain order, the projected transcript records of its records (from the
 * compaction boundary on) followed by a marker
 * `{ "through": <ordinal>, "digest": <chain head> }`. A staged text is
 * written `{ "$key": "b<n>" }` (its blob file holds the text). Appended
 * (no fsync: a cache, rebuilt from the segment files); everything after
 * the last marker the chain confirms is cut at load.
 *
 * Projecting segment by segment and concatenating equals projecting the
 * whole log: `projectRecords` groups by turn, a segment holds whole turns,
 * and a `TurnResolved` (the only record outside its turn) projects to
 * nothing. Projection hooks (M8) run over the whole transcript in the
 * context cache, not here.
 *
 * Node only.
 */
import { appendFile, open, readFile } from 'node:fs/promises';

import { Buffer } from 'node:buffer';

import { projectRecords } from '../projection.js';
import { decodeRecord } from './segment.js';
import { writeFileAtomic } from '../files.js';

/**
 * The file is a cache, rebuilt from the segments when it does not verify:
 * written through a scratch file and a rename, with neither fsynced.
 */
const CACHE_WRITE = harden({ sync: false, syncDirectory: false });

/** `format` of the first line. */
export const CONTEXT_FORMAT = 'thixotrope-harness-context-1';

/**
 * The projected transcript of keyed records, staged texts as `{ $key }`.
 * @param {readonly any[]} keyed keyed records (a segment's, from the boundary)
 * @returns {any[]}
 */
export const projectKeyed = keyed => {
  /** key -> its token blob (one per key, so `texts` finds it). */
  /** @type {Map<string, object>} */
  const tokens = new Map();
  /** @type {Map<any, any>} */
  const texts = new Map();
  const records = keyed.map(record =>
    decodeRecord(record, info => {
      let token = tokens.get(info.key);
      if (token === undefined) {
        token = harden({ key: info.key });
        tokens.set(info.key, token);
        texts.set(token, harden({ $key: info.key }));
      }
      return { blob: token, preview: info.preview, bytes: info.bytes };
    }),
  );
  const { transcript } = projectRecords(records, { texts, hooks: [] });
  return [...transcript];
};
harden(projectKeyed);

/**
 * @param {readonly any[]} transcript
 */
const linesOf = transcript =>
  transcript.map(record => `${JSON.stringify(record)}\n`).join('');

/**
 * Start the file: its header only.
 * @param {string} path
 * @param {{ epoch: number, boundary: number }} head
 */
export const resetContextFile = async (path, { epoch, boundary }) => {
  await writeFileAtomic(
    path,
    `${JSON.stringify({ format: CONTEXT_FORMAT, epoch, boundary })}\n`,
    CACHE_WRITE,
  );
};
harden(resetContextFile);

/**
 * Append one segment's projection and its marker.
 * @param {string} path
 * @param {readonly any[]} transcript keyed transcript (`projectKeyed`)
 * @param {{ through: number, digest: string }} marker
 */
export const appendContext = async (path, transcript, marker) => {
  await appendFile(path, `${linesOf(transcript)}${JSON.stringify(marker)}\n`);
};
harden(appendContext);

/**
 * Rewrite the file to exactly `parts` (temp file and rename): after a cut
 * or a new epoch.
 * @param {string} path
 * @param {{ epoch: number, boundary: number }} head
 * @param {ReadonlyArray<{ transcript: readonly any[], through: number, digest: string }>} parts
 */
export const writeContextFile = async (path, { epoch, boundary }, parts) => {
  let text = `${JSON.stringify({ format: CONTEXT_FORMAT, epoch, boundary })}\n`;
  /** @type {string[]} */
  const pieces = [text];
  for (const part of parts) {
    pieces.push(linesOf(part.transcript));
    pieces.push(
      `${JSON.stringify({ through: part.through, digest: part.digest })}\n`,
    );
  }
  text = pieces.join('');
  await writeFileAtomic(path, text, CACHE_WRITE);
};
harden(writeContextFile);

/**
 * @typedef {object} LoadedContext
 * @property {{ epoch: number, boundary: number } | undefined} head
 * @property {Array<{ through: number, digest: string, transcript: any[] }>} parts
 *   one per marker, in file order
 * @property {boolean} torn lines after the last marker were dropped
 */

/**
 * Read the file: the header and every complete part (lines followed by
 * their marker). Lines after the last marker are dropped (`torn`).
 * @param {string} path
 * @returns {Promise<LoadedContext>}
 */
export const loadContextFile = async path => {
  /** @type {string} */
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { head: undefined, parts: [], torn: false };
  }
  const lines = text.split('\n');
  /** @type {any} */
  let head;
  try {
    head = JSON.parse(lines[0]);
  } catch {
    return { head: undefined, parts: [], torn: true };
  }
  if (head?.format !== CONTEXT_FORMAT) {
    return { head: undefined, parts: [], torn: true };
  }
  /** @type {LoadedContext['parts']} */
  const parts = [];
  /** @type {any[]} */
  let current = [];
  let torn = false;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === '') {
      if (i !== lines.length - 1) torn = true;
      break;
    }
    /** @type {any} */
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      torn = true;
      break;
    }
    if (
      typeof parsed?.through === 'number' &&
      typeof parsed.digest === 'string' &&
      parsed.kind === undefined
    ) {
      parts.push({
        through: parsed.through,
        digest: parsed.digest,
        transcript: current,
      });
      current = [];
    } else {
      current.push(parsed);
    }
  }
  if (current.length > 0) torn = true;
  return {
    head: { epoch: head.epoch, boundary: head.boundary },
    parts,
    torn,
  };
};
harden(loadContextFile);

/**
 * Replace every `{ $key }` in a keyed transcript by its text.
 * @param {any} value
 * @param {(key: string) => string} textOfKey
 * @returns {any}
 */
export const resolveKeys = (value, textOfKey) => {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map(v => resolveKeys(v, textOfKey));
  if (typeof value.$key === 'string' && Object.keys(value).length === 1) {
    return textOfKey(value.$key);
  }
  /** @type {Record<string, any>} */
  const out = {};
  for (const name of Object.keys(value)) {
    out[name] = resolveKeys(value[name], textOfKey);
  }
  return out;
};
harden(resolveKeys);

/**
 * Every `$key` of a keyed transcript.
 * @param {any} value
 * @param {Set<string>} into
 */
export const keysOfTranscript = (value, into) => {
  if (typeof value !== 'object' || value === null) return into;
  if (Array.isArray(value)) {
    for (const v of value) keysOfTranscript(v, into);
    return into;
  }
  if (typeof value.$key === 'string' && Object.keys(value).length === 1) {
    into.add(value.$key);
    return into;
  }
  for (const name of Object.keys(value)) keysOfTranscript(value[name], into);
  return into;
};
harden(keysOfTranscript);

/**
 * The file's header and its last marker, reading only its first line and
 * its last bytes (a first validation in an incarnation need not parse the
 * whole projection: the last marker's chained digest stands for every part
 * before it). `clean` is false when anything follows the last marker or it
 * is not found in the tail read.
 * @param {string} path
 * @param {number} [tailBytes]
 * @returns {Promise<{ head?: { epoch: number, boundary: number }, last?: { through: number, digest: string }, clean: boolean }>}
 */
export const peekContextFile = async (path, tailBytes = 65_536) => {
  /** @type {import('node:fs/promises').FileHandle | undefined} */
  let handle;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    const headBuffer = Buffer.alloc(Math.min(size, 4096));
    await handle.read(headBuffer, 0, headBuffer.length, 0);
    const firstLine = headBuffer.toString('utf8').split('\n')[0];
    /** @type {any} */
    const head = JSON.parse(firstLine);
    if (head?.format !== CONTEXT_FORMAT) return { clean: false };
    const start = Math.max(0, size - tailBytes);
    const tail = Buffer.alloc(size - start);
    await handle.read(tail, 0, tail.length, start);
    const text = tail.toString('utf8');
    if (!text.endsWith('\n')) return { head, clean: false };
    const lines = text.slice(0, -1).split('\n');
    const lastLine = lines[lines.length - 1];
    /** @type {any} */
    let last;
    try {
      last = JSON.parse(lastLine);
    } catch {
      return { head, clean: false };
    }
    if (
      typeof last?.through === 'number' &&
      typeof last.digest === 'string' &&
      last.kind === undefined
    ) {
      return {
        head: { epoch: head.epoch, boundary: head.boundary },
        last: { through: last.through, digest: last.digest },
        clean: true,
      };
    }
    return { head, clean: lines.length === 1 && start === 0 };
  } catch {
    return { clean: false };
  } finally {
    await handle?.close();
  }
};
harden(peekContextFile);
