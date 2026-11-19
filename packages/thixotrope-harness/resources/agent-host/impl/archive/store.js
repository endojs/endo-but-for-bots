// @ts-check
/**
 * The record archive's adapter side (M2 W2.8; D-M2-1;
 * `designs/m2-interfaces.md` 4.4-4.12).
 *
 * A session vat seals its oldest settled turns into segment files held here
 * and drops its copy of them only when this store answered that the segment
 * is durable; the vat stays the system of record (it decides what and when
 * to seal and keeps the `ArchiveState`, whose chained digest names exactly
 * the segments it acknowledged). Per session, under
 * `<root>/<key>/` (`key` = the archive key `h<n>` the manager assigned to
 * the session's host facet; mode 0700):
 *
 * - `seg-*.jsonl` (segment.js): the system of record for sealed records;
 * - `manifest.json`: the chain as this store knows it, each entry
 *   acknowledged (the vat's state names it) or not (answered, the vat's
 *   acknowledgment not yet seen; or an orphan): a cache, rebuilt from the
 *   segment files;
 * - `context.jsonl` (context-file.js): the persisted projection of the
 *   acknowledged segments, so a context rebuild after a restart reads one
 *   file and the live tail instead of a vat page per 512 records: a cache;
 * - `mirror.jsonl` (mirror.js): the kept records as the adapter received
 *   them, so a seal does not page its range out of the vat: a cache.
 *
 * Sealing (4.4): `ArchivePort.seal` takes the range from the mirror (pages
 * the rest from the vat), checks the vat's fingerprint, writes the segment
 * durably (`.part`, fsync, rename, directory fsync), records it in the
 * manifest as unacknowledged and only then answers. The acknowledgment
 * (A4) is the next `ArchiveState` that names it (a `RoundRequest.base` or a
 * vat history page): the entry is marked, its projection appended to
 * `context.jsonl`, the mirror rewritten from `sealedTo`.
 *
 * Validation (4.7) against a vat state: the acknowledged chain must reach
 * the vat's digest at its segment count, else the files are walked; a
 * segment of the chain that is gone is data loss (`textOf.archiveFailed(
 * 'segment <n> is missing')`). No final-named segment file is ever deleted
 * here (only session delete, `release`, removes one; J-9485): a file the
 * manifest records as acknowledged, or one that chains forward from the
 * vat's state (a seal the vat may still acknowledge), is kept; only a file
 * at an ordinal the vat's chain already fixes with another digest is an
 * orphan, and it is renamed `<name>.orphan`, not removed. A file that does
 * not verify stays where it is and is reported; a read error is thrown.
 * Staleness follows the persisted acknowledged chain, not memory: a state
 * that is a prefix of the manifest's acknowledged entries is older than
 * what the vat already named and changes nothing, so validation does not
 * depend on the order in which a new incarnation sees the vat's states
 * (J-0493 (3) no longer holds anything up).
 *
 * Every per-session operation runs in one queue per session, so a seal, an
 * acknowledgment, a validation and the mirror's appends never interleave.
 *
 * Node only.
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { E } from '@endo/far';
import { Buffer } from 'node:buffer';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  archiveKindLetters,
  interfaces,
  textOf,
} from '../../../../guest/lib/interfaces.js';
import { limits } from '../../../../guest/lib/limits.js';
import { inCallOrder } from '../../../../guest/session/records.js';
import { blobsOf } from '../../../../guest/session/staging.js';
/* eslint-enable import/no-relative-packages */
import {
  appendContext,
  keysOfTranscript,
  loadContextFile,
  peekContextFile,
  projectKeyed,
  resolveKeys,
  writeContextFile,
} from './context-file.js';
import { appendMirror, loadMirror, rewriteMirror } from './mirror.js';
import {
  SEGMENT_NAME,
  decodeRecord,
  encodeRecord,
  forEachKey,
  readSegment,
  writeSegment,
} from './segment.js';
import { makeHistory } from './history.js';
import { writeFileAtomic } from '../files.js';

const { makeExo } = /** @type {any} */ (globalThis);

/** `manifest.json`'s format. */
export const MANIFEST_FORMAT = 'thixotrope-harness-manifest-1';
/** Archive keys the manager assigns (`h<n>`); anything else is refused. */
export const ARCHIVE_KEY = /^h[1-9][0-9]*$/;

/** Record kind -> its letter in `SealRequest.kinds`. */
const letterOf = new Map(
  archiveKindLetters.map(([kind, letter]) => [kind, letter]),
);

/**
 * @template T
 * @param {T | (() => T)} value
 * @returns {T}
 */
const resolveLazy = value =>
  typeof value === 'function' ? /** @type {() => T} */ (value)() : value;

/** @param {unknown} error */
const messageOf = error =>
  /** @type {Error} */ (error)?.message ?? String(error);

/** @param {string} message */
const failed = message => Error(textOf.archiveFailed(message));

/**
 * The archive root next to the blob directory: `<state>/agent-host/archive`.
 * @param {string} blobDir `<state>/agent-host/blobs`
 */
export const archiveDirFor = blobDir => join(dirname(blobDir), 'archive');
harden(archiveDirFor);

/**
 * @typedef {object} ManifestEntry
 * @property {number} ordinal
 * @property {string} file
 * @property {number} from
 * @property {number} to
 * @property {number} firstTurn
 * @property {number} turns
 * @property {number} records
 * @property {number} bytes
 * @property {string} digest
 * @property {string} previous
 * @property {number} epoch
 * @property {boolean} acknowledged
 * @property {string[]} turnIds the segment's turns in start order
 * @property {Array<[string, string, number]>} resolutions every
 *   `TurnResolved` in the segment: turn id, note, at
 * @property {number} blobBytes bytes of the blob files its records name
 *
 * @typedef {object} Manifest
 * @property {string} format
 * @property {number} epoch
 * @property {number} boundary
 * @property {ManifestEntry[]} segments by ordinal, from 1
 *
 * @typedef {{ sealedTo: number, sealedTurns: number, segments: number, digest: string }} ArchiveState
 *
 * @typedef {object} SessionArchive one session's archive in this incarnation
 * @property {string} key
 * @property {string} dir
 * @property {Manifest | undefined} manifest
 * @property {ArchiveState | undefined} validated the newest vat state checked
 * @property {any} owner the Session presence (quotas), once known
 * @property {boolean} charged its sealed blob bytes were counted
 * @property {Promise<unknown>} tail its queue
 * @property {number} busy operations queued or running
 * @property {number | undefined} mirrorEnd index after the mirror's last
 *   line, when this incarnation wrote it
 * @property {number} contextThrough ordinal of the last part known in
 *   `context.jsonl` (0: none or unknown)
 * @property {Map<string, number> | undefined} ordinals turn id -> ordinal
 * @property {Map<string, [string, number]> | undefined} resolved turn id ->
 *   note and at of its sealed TurnResolved
 *
 * @typedef {'a1' | 'write' | 'fsync' | 'rename' | 'fsync-dir' | 'manifest' | 'answer' | 'ack' | 'context' | 'mirror'} ArchiveStep
 */

/** @param {ArchiveState | undefined} state */
const segmentsOf = state => state?.segments ?? 0;

/** @returns {ArchiveState} */
const emptyState = () => ({
  sealedTo: 0,
  sealedTurns: 0,
  segments: 0,
  digest: '',
});

/**
 * What a segment's keyed records say about themselves (manifest fields).
 * @param {readonly any[]} keyed
 */
const describeRecords = keyed => {
  /** @type {string[]} */
  const turnIds = [];
  /** @type {Array<[string, string, number]>} */
  const resolutions = [];
  let blobBytes = 0;
  for (const record of keyed) {
    if (record.kind === 'turn-started') turnIds.push(record.turnId);
    if (record.kind === 'turn-resolved') {
      resolutions.push([record.turnId, record.note, record.at]);
    }
    forEachKey(record, (_key, info) => {
      if (info !== undefined) blobBytes += info.bytes;
    });
  }
  return { turnIds, resolutions, blobBytes };
};

/**
 * The vat's fingerprint of the range against the records here (4.4 A1).
 * @param {readonly any[]} keyed
 * @param {any} req
 */
export const checkFingerprint = (keyed, req) => {
  if (keyed.length !== req.to - req.from || keyed.length !== req.records) {
    throw failed('the range does not hold the records the session sealed');
  }
  const first = keyed[0];
  if (first?.kind !== 'turn-started' || first.turnId !== req.firstTurnId) {
    throw failed('the range does not start with its first turn');
  }
  /** @type {string[]} */
  const started = [];
  const settled = new Set();
  /** @type {string[]} */
  const letters = [];
  for (const record of keyed) {
    if (record.kind === 'turn-started') started.push(record.turnId);
    if (record.kind === 'turn-settled') settled.add(record.turnId);
    if (letters.length < limits.archiveSegmentRecords) {
      const letter = letterOf.get(record.kind);
      if (letter === undefined) throw failed('a record of no known kind');
      letters.push(letter);
    }
  }
  if (started.length !== req.turns) {
    throw failed('the range does not hold the turns the session sealed');
  }
  if (started[started.length - 1] !== req.lastTurnId) {
    throw failed('the range does not end with its last turn');
  }
  if (!started.every(turnId => settled.has(turnId))) {
    throw failed('the range holds a turn that has not settled');
  }
  if (letters.join('') !== req.kinds) {
    throw failed('the records differ from the range the session sealed');
  }
};
harden(checkFingerprint);

/**
 * Every blob key named by the segment, mirror and context files of one
 * session's archive directory, read leniently (a half-written file's keys
 * count too: they are in the vat's live records).
 * @param {string} dir
 * @param {Set<string>} into
 */
const keysInDir = async (dir, into) => {
  /** @type {string[]} */
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return into;
  }
  for (const name of names) {
    if (
      name.startsWith('seg-') ||
      name.startsWith('mirror.jsonl') ||
      name.startsWith('context.jsonl')
    ) {
      /** @type {string} */
      let text;
      try {
        // eslint-disable-next-line no-await-in-loop
        text = await readFile(join(dir, name), 'utf8');
      } catch {
        text = '';
      }
      for (const line of text.split('\n')) {
        if (line.includes('"$staged"') || line.includes('"$key"')) {
          try {
            forEachKey(JSON.parse(line), key => into.add(key));
          } catch {
            // A torn line: its keys are in a whole one or in the vat.
          }
        }
      }
    }
  }
  return into;
};

/**
 * Every blob key any segment, mirror or persisted context under the archive
 * root names (m2-interfaces.md 4.10: M13's collection sweep treats them as
 * live; the manager no longer holds a handle for a sealed field).
 * @param {string} root `<state>/agent-host/archive`
 * @returns {Promise<Set<string>>}
 */
export const archiveKeys = async root => {
  /** @type {Set<string>} */
  const keys = new Set();
  /** @type {string[]} */
  let names;
  try {
    names = await readdir(root);
  } catch {
    return keys;
  }
  for (const name of names) {
    // eslint-disable-next-line no-await-in-loop
    if (ARCHIVE_KEY.test(name)) await keysInDir(join(root, name), keys);
  }
  return keys;
};
harden(archiveKeys);

/**
 * @param {object} options
 * @param {string | (() => string)} options.dir the archive root
 *   (`<state>/agent-host/archive`, or how to find it on first use)
 * @param {import('../blobs.js').BlobStore} options.blobs
 * @param {any} options.sink the manager's `AgentHostSink`
 *   (`resolveSessions`), or a function returning the current one
 * @param {(step: ArchiveStep, key: string) => void} [options.trace] called
 *   before each step of a seal and an acknowledgment (tests: order; kills)
 * @param {number} [options.maxSessions] sessions whose archive state stays
 *   in memory (least recently used first out; idle ones only)
 * @param {number} [options.readsInFlight] blob files read at once
 * @param {number} [options.segmentCache] parsed segments kept for history
 */
export const makeArchiveStore = ({
  dir,
  blobs,
  sink,
  trace = () => {},
  maxSessions = 64,
  readsInFlight = 32,
  segmentCache = 8,
}) => {
  /** @type {Promise<string> | undefined} */
  let ready;
  const rootDir = () => {
    ready ??= (async () => {
      const path = resolveLazy(dir);
      await mkdir(path, { recursive: true, mode: 0o700 });
      return path;
    })();
    ready.catch(() => {
      ready = undefined;
    });
    return ready;
  };
  /** Session presence -> its archive key (this incarnation). */
  /** @type {WeakMap<any, string>} */
  const keyOfSession = new WeakMap();
  /** Sessions the manager said have no key yet. @type {WeakSet<any>} */
  const keyless = new WeakSet();
  /** key -> state, least recently used first. @type {Map<string, SessionArchive>} */
  const sessions = new Map();
  /** Session presence -> its port (one per incarnation). @type {WeakMap<any, any>} */
  const ports = new WeakMap();
  /**
   * `<key>/<file>` of segments answered in this incarnation and not yet
   * acknowledged: the vat may still acknowledge them, so validation never
   * deletes them (removed on acknowledgment or replacement).
   * @type {Set<string>}
   */
  const answered = new Set();
  /** Token blobs of keyed fields: token -> key (cache, mirror). */
  /** @type {WeakMap<object, string>} */
  const tokenKeys = new WeakMap();
  /** @type {Map<string, object>} */
  const tokens = new Map();
  const counts = {
    seals: 0,
    sealsReused: 0,
    sealFailures: 0,
    pagesPulled: 0,
    recordsPulled: 0,
    acknowledged: 0,
    validations: 0,
    scans: 0,
    orphans: 0,
    unreadable: 0,
    contextAppends: 0,
    contextRewrites: 0,
    mirrorAppends: 0,
    mirrorRewrites: 0,
    mirrorDrops: 0,
    released: 0,
  };

  /**
   * A token blob for `key`: stands for the handle a vat dropped (or one
   * this incarnation never saw) wherever a staged field needs a blob.
   * Bounded: tokens of keys no longer used are dropped with their entry.
   * @param {string} key
   */
  const tokenFor = key => {
    let token = tokens.get(key);
    if (token === undefined) {
      token = harden({ archivedKey: key });
      tokens.set(key, token);
      tokenKeys.set(token, key);
      if (tokens.size > 65_536) {
        const oldest = tokens.keys().next().value;
        if (oldest !== undefined) tokens.delete(oldest);
      }
    }
    return token;
  };

  /** @param {any} blob */
  const keyOf = blob =>
    (typeof blob === 'object' && blob !== null
      ? tokenKeys.get(blob)
      : undefined) ?? blobs.keyOf(blob);

  /** @param {any} record */
  const encode = record => encodeRecord(record, keyOf);

  /** @param {any} keyed */
  const decodeWithTokens = keyed =>
    harden(
      decodeRecord(keyed, info => {
        /** @type {Record<string, any>} */
        const staged = {
          blob: tokenFor(info.key),
          preview: info.preview,
          bytes: info.bytes,
        };
        if (typeof info.digest === 'string') staged.digest = info.digest;
        return staged;
      }),
    );

  /**
   * @param {string} key
   * @param {any} [owner]
   * @returns {Promise<SessionArchive>}
   */
  const stateOf = async (key, owner) => {
    if (!ARCHIVE_KEY.test(key)) throw failed('not an archive key');
    let st = sessions.get(key);
    if (st === undefined) {
      const root = await rootDir();
      st = sessions.get(key);
      if (st === undefined) {
        st = {
          key,
          dir: join(root, key),
          manifest: undefined,
          validated: undefined,
          owner,
          charged: false,
          tail: Promise.resolve(),
          busy: 0,
          mirrorEnd: undefined,
          contextThrough: 0,
          ordinals: undefined,
          resolved: undefined,
        };
        sessions.set(key, st);
      }
    } else {
      sessions.delete(key);
      sessions.set(key, st);
    }
    if (st.owner === undefined && owner !== undefined) st.owner = owner;
    // Idle states beyond the bound go (oldest first).
    for (const [other, state] of sessions) {
      if (sessions.size <= maxSessions) break;
      if (state !== st && state.busy === 0) sessions.delete(other);
    }
    return st;
  };

  /** Operations started and not finished (`drain`). @type {Set<Promise<unknown>>} */
  const inFlight = new Set();
  /**
   * @template T
   * @param {Promise<T>} promise
   * @returns {Promise<T>}
   */
  const track = promise => {
    const settled = promise.then(
      () => {},
      () => {},
    );
    inFlight.add(settled);
    void settled.then(() => inFlight.delete(settled));
    return promise;
  };

  /**
   * Run `step` in the session's queue.
   * @template T
   * @param {SessionArchive} st
   * @param {() => Promise<T>} step
   * @returns {Promise<T>}
   */
  const queued = (st, step) => {
    st.busy += 1;
    const result = st.tail.then(step);
    track(result);
    st.tail = result.then(
      () => {
        st.busy -= 1;
      },
      () => {
        st.busy -= 1;
      },
    );
    return result;
  };

  /** @param {SessionArchive} st */
  const ensureDir = st => mkdir(st.dir, { recursive: true, mode: 0o700 });

  /** @param {SessionArchive} st */
  const manifestPath = st => join(st.dir, 'manifest.json');
  /** @param {SessionArchive} st */
  const contextPath = st => join(st.dir, 'context.jsonl');
  /** @param {SessionArchive} st */
  const mirrorPath = st => join(st.dir, 'mirror.jsonl');

  /** @param {SessionArchive} st */
  const writeManifest = async st => {
    await ensureDir(st);
    // No directory fsync: a manifest that power loss turns back is rebuilt
    // from the segment files (`scanSegments`).
    await writeFileAtomic(
      manifestPath(st),
      JSON.stringify(/** @type {Manifest} */ (st.manifest)),
      { syncDirectory: false },
    );
    st.ordinals = undefined;
    st.resolved = undefined;
  };

  /**
   * Every readable segment file of the session: its manifest entry
   * (unacknowledged) by file name. A final-named file exists only after
   * fsync and rename, so one that does not verify is damaged, not
   * half-written: it is kept in place, left out and counted
   * (`unreadable`); a read error (EMFILE, EIO, ...) is thrown, never taken
   * for damage (J-9485).
   * @param {SessionArchive} st
   * @returns {Promise<ManifestEntry[]>}
   */
  const scanSegments = async st => {
    counts.scans += 1;
    /** @type {string[]} */
    let names;
    try {
      names = await readdir(st.dir);
    } catch {
      return [];
    }
    /** @type {ManifestEntry[]} */
    const found = [];
    for (const name of names) {
      if (SEGMENT_NAME.test(name)) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const { header, records, digest } = await readSegment(
            join(st.dir, name),
          );
          found.push({
            ordinal: header.ordinal,
            file: name,
            from: header.from,
            to: header.to,
            firstTurn: header.firstTurn,
            turns: header.turns,
            records: header.records,
            bytes: header.bytes,
            digest,
            previous: header.previous,
            epoch: header.epoch,
            acknowledged: false,
            ...describeRecords(records),
          });
        } catch (error) {
          const code = /** @type {any} */ (error)?.code;
          if (typeof code === 'string' && code !== 'ENOENT') {
            throw failed(`segment file ${name} could not be read (${code})`);
          }
          // Damaged or foreign: never read (4.2), never removed. (ENOENT:
          // gone since the listing, nothing to count.)
          if (code === undefined) counts.unreadable += 1;
        }
      }
    }
    found.sort((a, b) => a.ordinal - b.ordinal);
    return found;
  };

  /**
   * The manifest from its file, or rebuilt from the segment files (every
   * entry unacknowledged until a vat state names it).
   * @param {SessionArchive} st
   * @returns {Promise<Manifest>}
   */
  const loadManifest = async st => {
    if (st.manifest !== undefined) return st.manifest;
    try {
      const parsed = JSON.parse(await readFile(manifestPath(st), 'utf8'));
      if (parsed?.format === MANIFEST_FORMAT) {
        st.manifest = parsed;
        return parsed;
      }
    } catch {
      // Rebuilt below.
    }
    st.manifest = {
      format: MANIFEST_FORMAT,
      epoch: 0,
      boundary: 0,
      segments: await scanSegments(st),
    };
    return st.manifest;
  };

  /**
   * The chain from ordinal 1 to `state` among `candidates`: entries whose
   * `previous` links, ending at `state.digest` at `state.segments`.
   * @param {readonly ManifestEntry[]} candidates
   * @param {ArchiveState} state
   * @returns {ManifestEntry[] | undefined}
   */
  const chainTo = (candidates, state) => {
    if (state.segments === 0) return [];
    /** @type {Map<number, ManifestEntry[]>} */
    const byOrdinal = new Map();
    for (const entry of candidates) {
      const list = byOrdinal.get(entry.ordinal) ?? [];
      list.push(entry);
      byOrdinal.set(entry.ordinal, list);
    }
    // Walk back from the target: each digest names exactly one previous.
    /** @type {ManifestEntry[]} */
    const chain = [];
    let want = state.digest;
    for (let ordinal = state.segments; ordinal >= 1; ordinal -= 1) {
      const entry = (byOrdinal.get(ordinal) ?? []).find(e => e.digest === want);
      if (entry === undefined) return undefined;
      chain.push(entry);
      want = entry.previous;
    }
    if (want !== '') return undefined;
    chain.reverse();
    return chain;
  };

  /**
   * The first ordinal of the vat's chain that has no verified file: from
   * the vat's own entries when a ContextSource is at hand, else from the
   * longest linked prefix.
   * @param {SessionArchive} st
   * @param {readonly ManifestEntry[]} candidates
   * @param {ArchiveState} state
   * @param {any} [context]
   */
  const missingOrdinal = async (st, candidates, state, context) => {
    const digests = new Set(candidates.map(e => e.digest));
    if (context !== undefined) {
      try {
        let ordinal = 0;
        /** @type {string | undefined} */
        let cursor;
        for (;;) {
          /** @type {any} */
          // eslint-disable-next-line no-await-in-loop
          const page = await E(context).segments(
            ...(cursor === undefined ? [] : [cursor]),
          );
          for (const entry of page.segments) {
            ordinal += 1;
            if (!digests.has(entry.digest)) return ordinal;
          }
          if (page.next === undefined) break;
          cursor = page.next;
        }
      } catch {
        // Fall back below.
      }
    }
    let ordinal = 1;
    let previous = '';
    for (;;) {
      const next = candidates.find(
        e => e.ordinal === ordinal && e.previous === previous,
      );
      if (next === undefined || ordinal > state.segments) return ordinal;
      previous = next.digest;
      ordinal += 1;
    }
  };

  /**
   * Set orphans aside: `<name>.orphan`, out of every later scan, kept (with
   * the blob keys it names) until the session is deleted. Never an unlink.
   * @param {SessionArchive} st
   * @param {readonly string[]} files
   */
  const setAside = async (st, files) => {
    for (const file of files) {
      // eslint-disable-next-line no-await-in-loop
      await rename(join(st.dir, file), join(st.dir, `${file}.orphan`)).catch(
        () => {},
      );
      counts.orphans += 1;
    }
  };

  /**
   * The vat state the manifest's acknowledged prefix stands for.
   * @param {readonly ManifestEntry[]} entries
   * @returns {ArchiveState}
   */
  const stateOfEntries = entries => {
    let acked = 0;
    while (acked < entries.length && entries[acked].acknowledged) acked += 1;
    if (acked === 0) return emptyState();
    const last = entries[acked - 1];
    return harden({
      sealedTo: last.to,
      sealedTurns: last.firstTurn + last.turns - 1,
      segments: acked,
      digest: last.digest,
    });
  };

  /**
   * The entries that chain forward from `state` (ordinal after its head,
   * previous linking back to it), every branch.
   * @param {readonly ManifestEntry[]} candidates
   * @param {ArchiveState} state
   */
  const forwardFrom = (candidates, state) => {
    /** @type {ManifestEntry[]} */
    const found = [];
    let heads = new Set([state.digest]);
    for (let ordinal = state.segments + 1; heads.size > 0; ordinal += 1) {
      const next = candidates.filter(
        e => e.ordinal === ordinal && heads.has(e.previous),
      );
      found.push(...next);
      heads = new Set(next.map(e => e.digest));
    }
    return found;
  };

  /**
   * Stat `entries`' files; the first ordinal whose file is gone, or 0.
   * @param {SessionArchive} st
   * @param {readonly ManifestEntry[]} entries
   */
  const firstAbsent = async (st, entries) => {
    const present = await Promise.all(
      entries.map(e =>
        stat(join(st.dir, e.file)).then(
          () => true,
          () => false,
        ),
      ),
    );
    const at = present.indexOf(false);
    return at < 0 ? 0 : entries[at].ordinal;
  };

  /**
   * The acknowledged entries the context file should hold (those with
   * records at or past the compaction boundary).
   * @param {Manifest} manifest
   * @param {number} segments
   */
  const contextEntries = (manifest, segments) =>
    manifest.segments
      .slice(0, segments)
      .filter(entry => entry.to > manifest.boundary);

  /**
   * One acknowledged segment's projection (keyed), from the boundary on.
   * @param {SessionArchive} st
   * @param {ManifestEntry} entry
   * @param {number} boundary
   */
  const projectEntry = async (st, entry, boundary) => {
    const { records } = await readSegment(join(st.dir, entry.file));
    const from = Math.max(0, boundary - entry.from);
    return projectKeyed(from > 0 ? records.slice(from) : records);
  };

  /**
   * Bring `context.jsonl` to the acknowledged chain: keep the parts the
   * chain confirms, cut the rest, extend from the segment files. Returns
   * every part (keyed transcripts) when `want` is set.
   * @param {SessionArchive} st
   * @param {number} segments acknowledged count
   * @param {boolean} want
   * @returns {Promise<any[][] | undefined>}
   */
  const syncContext = async (st, segments, want) => {
    const manifest = /** @type {Manifest} */ (st.manifest);
    const expected = contextEntries(manifest, segments);
    const path = contextPath(st);
    if (!want && st.contextThrough === 0 && expected.length > 0) {
      // First look in this incarnation: the last marker alone, when it is
      // on the chain, vouches for every part before it (chained digests).
      const peek = await peekContextFile(path);
      const at =
        peek.clean && peek.last !== undefined
          ? expected.findIndex(
              e =>
                e.ordinal === peek.last?.through &&
                e.digest === peek.last.digest,
            )
          : -1;
      if (
        at >= 0 &&
        peek.head?.epoch === manifest.epoch &&
        peek.head?.boundary === manifest.boundary
      ) {
        st.contextThrough = expected[at].ordinal;
      }
    }
    if (!want && st.contextThrough > 0) {
      // Known in this incarnation: append what is missing only.
      const lastKnown = expected.findIndex(
        e => e.ordinal === st.contextThrough,
      );
      if (lastKnown >= 0 || st.contextThrough === 0) {
        for (const entry of expected.slice(lastKnown + 1)) {
          trace('context', st.key);
          // eslint-disable-next-line no-await-in-loop
          const transcript = await projectEntry(st, entry, manifest.boundary);
          // eslint-disable-next-line no-await-in-loop
          await appendContext(path, transcript, {
            through: entry.ordinal,
            digest: entry.digest,
          });
          counts.contextAppends += 1;
          st.contextThrough = entry.ordinal;
        }
        return undefined;
      }
    }
    const loaded = await loadContextFile(path);
    let keep = 0;
    if (
      loaded.head !== undefined &&
      loaded.head.epoch === manifest.epoch &&
      loaded.head.boundary === manifest.boundary
    ) {
      while (
        keep < loaded.parts.length &&
        keep < expected.length &&
        loaded.parts[keep].through === expected[keep].ordinal &&
        loaded.parts[keep].digest === expected[keep].digest
      ) {
        keep += 1;
      }
    }
    const parts = loaded.parts.slice(0, keep);
    const rewrite =
      loaded.head === undefined ||
      keep !== loaded.parts.length ||
      loaded.torn ||
      keep === 0;
    /** @type {Array<{ transcript: any[], through: number, digest: string }>} */
    const added = [];
    for (const entry of expected.slice(keep)) {
      // eslint-disable-next-line no-await-in-loop
      const transcript = await projectEntry(st, entry, manifest.boundary);
      added.push({
        transcript,
        through: entry.ordinal,
        digest: entry.digest,
      });
    }
    await ensureDir(st);
    if (rewrite) {
      trace('context', st.key);
      await writeContextFile(path, manifest, [...parts, ...added]);
      counts.contextRewrites += 1;
    } else {
      for (const part of added) {
        trace('context', st.key);
        // eslint-disable-next-line no-await-in-loop
        await appendContext(path, part.transcript, {
          through: part.through,
          digest: part.digest,
        });
        counts.contextAppends += 1;
      }
    }
    st.contextThrough =
      expected.length === 0 ? 0 : expected[expected.length - 1].ordinal;
    if (!want) return undefined;
    return [...parts, ...added].map(part => part.transcript);
  };

  /**
   * Rewrite the mirror from `sealedTo` (records below it are sealed now).
   * @param {SessionArchive} st
   * @param {number} sealedTo
   */
  const cutMirror = async (st, sealedTo) => {
    const path = mirrorPath(st);
    const kept = await loadMirror(path, { from: sealedTo });
    trace('mirror', st.key);
    if (kept.records.length === 0 || kept.from !== sealedTo) {
      await unlink(path).catch(() => {});
      st.mirrorEnd = undefined;
      counts.mirrorDrops += 1;
      return;
    }
    await rewriteMirror(path, sealedTo, kept.records);
    st.mirrorEnd = sealedTo + kept.records.length;
    counts.mirrorRewrites += 1;
  };

  /**
   * Make the session's files agree with the vat's `state` (4.7) or, for a
   * state the store's unacknowledged entries already reach, acknowledge
   * them (A4). In the session's queue.
   * @param {SessionArchive} st
   * @param {ArchiveState} state
   * @param {any} [context] the session's ContextSource (names a missing
   *   segment)
   */
  const observeNow = async (st, state, context) => {
    if (
      st.validated !== undefined &&
      (state.segments < st.validated.segments ||
        (state.segments === st.validated.segments &&
          state.digest === st.validated.digest))
    ) {
      // The same, or older than what was checked (a page answered before
      // a seal arriving after a request that carried it).
      return;
    }
    const manifest = await loadManifest(st);
    // Staleness from the persisted acknowledged chain (J-9485): the vat's
    // chain only grows, so a state that is a proper prefix of what the vat
    // already named is old (a page answered before a seal, seen after an
    // eviction or a restart) and changes nothing.
    const named = stateOfEntries(manifest.segments);
    if (
      state.segments < named.segments &&
      (state.segments === 0 ||
        manifest.segments[state.segments - 1].digest === state.digest)
    ) {
      if (st.validated === undefined) {
        const acked = manifest.segments.slice(0, named.segments);
        const absent = await firstAbsent(st, acked);
        if (absent > 0) throw failed(`segment ${absent} is missing`);
        st.validated = named;
      }
      return;
    }
    const known = manifest.segments;
    let chain = chainTo(known, state);
    if (chain !== undefined && st.validated === undefined) {
      // First check in this incarnation: the chain's files must be there.
      if ((await firstAbsent(st, chain)) > 0) chain = undefined;
    }
    /** @type {readonly ManifestEntry[]} */
    let candidates = known;
    if (chain === undefined) {
      // The manifest does not know the chain: the files decide.
      const scanned = await scanSegments(st);
      chain = chainTo(scanned, state);
      if (chain === undefined) {
        const n = await missingOrdinal(st, scanned, state, context);
        throw failed(`segment ${n} is missing`);
      }
      candidates = scanned;
    }
    counts.validations += 1;
    const onChain = new Set(chain.map(e => e.file));
    // Entries past the chain that the vat may still acknowledge: any that
    // chain forward from its head (a seal answered in this or an earlier
    // incarnation whose crank Z has not run yet).
    const pending = forwardFrom(candidates, state).filter(
      e => !onChain.has(e.file),
    );
    const keepFiles = new Set([
      ...onChain,
      ...pending.map(e => e.file),
      ...known.filter(e => e.acknowledged).map(e => e.file),
    ]);
    // Orphans (4.5, 4.7): a file at an ordinal the vat's chain fixes, with
    // another digest. Set aside, never deleted; anything else is kept.
    const fixed = new Map(chain.map(e => [e.ordinal, e.digest]));
    /** @type {string[]} */
    let names = [];
    try {
      names = await readdir(st.dir);
    } catch {
      names = [];
    }
    const orphans = names.filter(name => {
      const match = SEGMENT_NAME.exec(name);
      if (match === null || keepFiles.has(name)) return false;
      const digest = fixed.get(Number(match[1]));
      return digest !== undefined && !digest.startsWith(match[2]);
    });
    await setAside(st, orphans);
    for (const file of orphans) answered.delete(`${st.key}/${file}`);
    const newly = chain.filter(e => !e.acknowledged).length;
    trace('ack', st.key);
    manifest.segments = [
      ...chain.map(e => ({ ...e, acknowledged: true })),
      ...pending,
    ];
    for (const e of chain) answered.delete(`${st.key}/${e.file}`);
    counts.acknowledged += newly;
    if (state.segments > 0 || orphans.length > 0 || newly > 0) {
      await writeManifest(st);
    }
    const previous = st.validated;
    st.validated = harden({ ...state });
    if (!st.charged && st.owner !== undefined) {
      // Sealed blob bytes count against the session's quota (4.10 item 4).
      let bytes = 0;
      for (const e of chain) bytes += e.blobBytes;
      blobs.chargeArchived(st.owner, bytes);
      st.charged = true;
    }
    if (state.segments > 0) {
      await syncContext(st, state.segments, false);
    }
    if (segmentsOf(previous) !== state.segments && state.sealedTo > 0) {
      await cutMirror(st, state.sealedTo);
    }
  };

  /**
   * The session's records [from, to) in keyed form: the mirror's, the rest
   * paged from the vat (`context`, never below `from`).
   * @param {SessionArchive} st
   * @param {any} req a SealRequest
   */
  const rangeOf = async (st, req) => {
    const { from, to } = /** @type {{ from: number, to: number }} */ (req);
    const mirror = await loadMirror(mirrorPath(st), { from, until: to });
    /** @type {any[]} */
    const keyed = mirror.from === from ? [...mirror.records] : [];
    let at = from + keyed.length;
    while (at < to) {
      /** @type {any} */
      let page;
      try {
        // eslint-disable-next-line no-await-in-loop
        page = await E(req.context).page(`p${at}`);
      } catch (error) {
        throw failed(`context page failed: ${messageOf(error)}`);
      }
      counts.pagesPulled += 1;
      if (page.from !== at) throw failed('the context page is not contiguous');
      const take = page.records.slice(0, to - at);
      if (take.length === 0) throw failed('the session has fewer records');
      const handles = take.flatMap(blobsOf);
      // eslint-disable-next-line no-await-in-loop
      await blobs.resolveMany(handles);
      for (const record of take) keyed.push(encode(record));
      counts.recordsPulled += take.length;
      at += take.length;
    }
    return keyed;
  };

  /**
   * ArchivePort.seal (4.4 A1-A3).
   * @param {SessionArchive} st
   * @param {any} req a SealRequest
   */
  const sealNow = async (st, req) => {
    const manifest = await loadManifest(st);
    /** @param {readonly ManifestEntry[]} list */
    const findPrevious = list => list.find(e => e.digest === req.previous);
    let ordinal = 1;
    if (req.previous !== '') {
      let previous = findPrevious(manifest.segments);
      if (previous === undefined) {
        manifest.segments = await scanSegments(st);
        previous = findPrevious(manifest.segments);
      }
      if (previous === undefined) {
        throw failed('the previous segment is not here');
      }
      if (previous.to !== req.from) {
        throw failed('the range does not follow the previous segment');
      }
      ordinal = previous.ordinal + 1;
    } else if (req.from !== 0) {
      throw failed('the first segment must start at record 0');
    }
    // Canonical order: log order with tool results in call order, the
    // order RoundRequest.append carries them (turn.js `inCallOrder`), so a
    // range read from the mirror and one paged from the vat are the same
    // segment.
    const keyed = inCallOrder(await rangeOf(st, req));
    checkFingerprint(keyed, req);
    trace('a1', st.key);
    await ensureDir(st);
    const written = await writeSegment(
      st.dir,
      {
        ordinal,
        from: req.from,
        to: req.to,
        firstTurn: req.firstTurn,
        turns: req.turns,
        bytes: req.bytes,
        epoch: req.epoch,
      },
      keyed,
      req.previous,
      { trace: step => trace(step, st.key) },
    );
    if (written.reused) counts.sealsReused += 1;
    // Entries at or past this ordinal are replaced: the vat's head is the
    // previous segment, so none of them may be acknowledged; they are set
    // aside, never deleted (J-9485).
    const replaced = manifest.segments.filter(
      e => e.ordinal >= ordinal && e.file !== written.file,
    );
    if (replaced.some(e => e.acknowledged)) {
      throw failed("the previous segment is not the session's head");
    }
    for (const e of replaced) answered.delete(`${st.key}/${e.file}`);
    await setAside(
      st,
      replaced.map(e => e.file),
    );
    /** @type {ManifestEntry} */
    const entry = {
      ordinal,
      file: written.file,
      from: written.from,
      to: written.to,
      firstTurn: written.firstTurn,
      turns: written.turns,
      records: written.records,
      bytes: written.bytes,
      digest: written.digest,
      previous: req.previous,
      epoch: req.epoch,
      acknowledged: false,
      ...describeRecords(keyed),
    };
    manifest.segments = [
      ...manifest.segments.filter(e => e.ordinal < ordinal),
      entry,
    ];
    trace('manifest', st.key);
    await writeManifest(st);
    answered.add(`${st.key}/${entry.file}`);
    counts.seals += 1;
    trace('answer', st.key);
    return harden({
      from: entry.from,
      to: entry.to,
      firstTurn: entry.firstTurn,
      turns: entry.turns,
      records: entry.records,
      bytes: entry.bytes,
      digest: entry.digest,
    });
  };

  /**
   * Read blob texts by key, `readsInFlight` at a time.
   * @param {Iterable<string>} keys
   */
  const readTexts = async keys => {
    const list = [...keys];
    /** @type {Map<string, string>} */
    const texts = new Map();
    let next = 0;
    const worker = async () => {
      while (next < list.length) {
        const key = list[next];
        next += 1;
        // eslint-disable-next-line no-await-in-loop
        texts.set(key, await blobs.readKey(key));
      }
    };
    const workers = [];
    for (let i = 0; i < Math.min(readsInFlight, list.length); i += 1) {
      workers.push(worker());
    }
    await Promise.all(workers);
    return texts;
  };

  /**
   * @param {any[][]} parts keyed transcripts
   */
  const resolveParts = async parts => {
    const keys = new Set();
    for (const part of parts) keysOfTranscript(part, keys);
    const texts = await readTexts(keys);
    /** @type {any[]} */
    const transcript = [];
    for (const part of parts) {
      for (const record of part) {
        transcript.push(
          harden(
            resolveKeys(record, key => /** @type {string} */ (texts.get(key))),
          ),
        );
      }
    }
    return { transcript, blobs: keys.size };
  };

  /**
   * The archive key of `session`: the one its ports were opened with, else
   * the manager's (`resolveSessions`), else none.
   * @param {any} session
   * @returns {Promise<string | undefined>}
   */
  const keyFor = async session => {
    const known = keyOfSession.get(session);
    if (known !== undefined) return known;
    if (keyless.has(session)) return undefined;
    const theSink = resolveLazy(sink);
    if (theSink === undefined) return undefined;
    /** @type {any[]} */
    const keys = await E(theSink).resolveSessions(harden([session]));
    const key = keys[0];
    if (typeof key === 'string' && ARCHIVE_KEY.test(key)) {
      keyOfSession.set(session, key);
      return key;
    }
    keyless.add(session);
    return undefined;
  };

  /**
   * @param {any} session
   * @param {string} key
   */
  const learn = (session, key) => {
    if (!ARCHIVE_KEY.test(key)) throw Error('not an archive key');
    keyOfSession.set(session, key);
  };

  /**
   * Observe a vat state for `session` (validation or acknowledgment).
   * @param {any} session
   * @param {string} key
   * @param {ArchiveState | undefined} state
   * @param {any} [context]
   */
  const observe = async (session, key, state, context) => {
    const st = await stateOf(key, session);
    return queued(st, () => observeNow(st, state ?? emptyState(), context));
  };

  /** @param {SessionArchive} st */
  const acknowledged = st =>
    (st.manifest?.segments ?? []).slice(0, segmentsOf(st.validated));

  const history = makeHistory({
    blobs,
    keyFor,
    /**
     * The session's archive, validated against its newest vat state in this
     * incarnation (asked once), or undefined without one.
     * @param {any} session
     * @param {(() => Promise<any>)} newestPage
     */
    archiveOf: async (session, newestPage) => {
      const key = await keyFor(session);
      if (key === undefined) return undefined;
      const st = await stateOf(key, session);
      if (st.validated === undefined) {
        const page = await newestPage();
        await queued(st, () => observeNow(st, page?.archive ?? emptyState()));
      }
      return harden({
        key,
        dir: st.dir,
        state: /** @type {ArchiveState} */ (st.validated),
        entries: acknowledged(st),
      });
    },
    observe,
    segmentCache,
  });

  return harden({
    /**
     * This session's ArchivePort in this incarnation (TurnPorts.archive).
     * Without `key` (a manager that does not pass `archiveKey` to `open`)
     * the key is resolved through the manager at the first seal.
     * @param {{ session: any, key?: string }} options
     */
    portFor: ({ session, key }) => {
      if (key !== undefined) learn(session, key);
      let port = ports.get(session);
      if (port === undefined) {
        port = makeExo('ArchivePort', interfaces.ArchivePort, {
          /** @param {any} req */
          seal: async req => {
            try {
              // Without a key from `open`, the manager names it (once).
              const known = key ?? (await keyFor(session));
              if (known === undefined) {
                throw failed('no archive key for this session');
              }
              const st = await stateOf(known, session);
              return await queued(st, () => sealNow(st, req));
            } catch (error) {
              counts.sealFailures += 1;
              const message = messageOf(error);
              if (message.startsWith(textOf.archiveFailed(''))) throw error;
              throw failed(message);
            }
          },
        });
        ports.set(session, port);
      }
      return port;
    },
    /**
     * The archive key of `session` (from `open`, else the manager's
     * `resolveSessions`, once per incarnation), or undefined.
     * @param {any} session
     */
    keyFor,
    /** The `History` exo of this incarnation. */
    history: () => history,
    /**
     * Delete a session's archive (4.11): every blob file its segments and
     * mirror name, then its directory. Idempotent.
     * @param {string} key
     */
    release: async key => {
      if (!ARCHIVE_KEY.test(key)) throw Error('not an archive key');
      const st = await stateOf(key);
      await queued(st, async () => {
        const keys = await keysInDir(st.dir, new Set());
        await blobs.release([...keys]);
        await rm(st.dir, { recursive: true, force: true });
        st.manifest = undefined;
        st.validated = undefined;
        st.mirrorEnd = undefined;
        st.contextThrough = 0;
        for (const name of [...answered]) {
          if (name.startsWith(`${key}/`)) answered.delete(name);
        }
        counts.released += 1;
      });
      sessions.delete(key);
    },
    /**
     * The projected transcript of the sealed part (4.8): validates against
     * `state` (acknowledging new segments), then the whole persisted
     * projection with its texts, or only the segments after `after`.
     * @param {any} session
     * @param {string} key
     * @param {ArchiveState | undefined} state the request's `base.archive`
     * @param {{ after?: { segments: number, digest: string }, context?: any }} [options]
     * @returns {Promise<{ transcript: any[], sealedTo: number, segments: number, digest: string, blobs: number, units: number }>}
     */
    prepareSealed: async (session, key, state, { after, context } = {}) => {
      learn(session, key);
      const st = await stateOf(key, session);
      const vat = state ?? emptyState();
      return queued(st, async () => {
        await observeNow(st, vat, context);
        const entries = acknowledged(st);
        /** @type {any[][]} */
        let parts;
        const base = after === undefined ? 0 : after.segments;
        if (
          after !== undefined &&
          base <= entries.length &&
          (base === 0 || entries[base - 1].digest === after.digest)
        ) {
          const manifest = /** @type {Manifest} */ (st.manifest);
          parts = [];
          for (const entry of entries.slice(base)) {
            if (entry.to > manifest.boundary) {
              // eslint-disable-next-line no-await-in-loop
              parts.push(await projectEntry(st, entry, manifest.boundary));
            }
          }
        } else {
          parts =
            entries.length === 0
              ? []
              : /** @type {any[][]} */ (
                  await syncContext(st, entries.length, true)
                );
        }
        const resolved = await resolveParts(parts);
        let units = 0;
        for (const record of resolved.transcript) {
          if (typeof record.content === 'string')
            units += record.content.length;
          if (typeof record.args === 'string') units += record.args.length;
        }
        return {
          transcript: resolved.transcript,
          sealedTo: vat.sealedTo,
          segments: vat.segments,
          digest: vat.digest,
          blobs: resolved.blobs,
          units,
        };
      });
    },
    /**
     * Keep the mirror up to date with the records a request brought (4.7):
     * `records` are records `from`.. with Blob handles (or the tokens of
     * `tail`); `replace` rewrites the mirror from `from`. Never fails the
     * caller: a mirror that cannot be written is dropped.
     * @param {any} session
     * @param {string} key
     * @param {{ from: number, records: readonly any[], replace?: boolean }} request
     */
    record: (session, key, { from, records, replace = false }) => {
      learn(session, key);
      /** @type {any[]} */
      let keyed;
      try {
        keyed = records.map(encode);
      } catch {
        keyed = [];
        replace = true;
        records = [];
      }
      return track(stateOf(key, session)).then(st =>
        queued(st, async () => {
          const path = mirrorPath(st);
          try {
            if (replace) {
              await ensureDir(st);
              if (keyed.length === 0) {
                await unlink(path).catch(() => {});
                st.mirrorEnd = undefined;
                counts.mirrorDrops += 1;
                return;
              }
              await rewriteMirror(path, from, keyed);
              st.mirrorEnd = from + keyed.length;
              counts.mirrorRewrites += 1;
              return;
            }
            if (st.mirrorEnd !== from) {
              // Not contiguous with what this incarnation wrote: stale.
              await unlink(path).catch(() => {});
              st.mirrorEnd = undefined;
              counts.mirrorDrops += 1;
              return;
            }
            await appendMirror(path, from, keyed);
            st.mirrorEnd = from + keyed.length;
            counts.mirrorAppends += 1;
          } catch {
            await unlink(path).catch(() => {});
            st.mirrorEnd = undefined;
            counts.mirrorDrops += 1;
          }
        }),
      );
    },
    /**
     * The mirror's records from `from` up to `until` (exclusive), decoded
     * with token blobs (`tokenKey` names their keys): a context rebuild's
     * tail (4.8). Empty when there is none.
     * @param {any} session
     * @param {string} key
     * @param {{ from: number, until: number }} range
     */
    tail: async (session, key, { from, until }) => {
      learn(session, key);
      const st = await stateOf(key, session);
      return queued(st, async () => {
        const mirror = await loadMirror(mirrorPath(st), { from, until });
        if (mirror.from !== from) return { from, records: [] };
        return {
          from,
          records: mirror.records.map(decodeWithTokens),
        };
      });
    },
    /**
     * The blob key a token stands for (undefined for a real handle).
     * @param {any} blob
     */
    tokenKey: blob =>
      typeof blob === 'object' && blob !== null
        ? tokenKeys.get(blob)
        : undefined,
    /**
     * The M8 hook (4.12): a new epoch and compaction boundary; the persisted
     * projection is rewritten from the boundary.
     * @param {{ key: string, epoch: number, boundary: number }} change
     */
    compacted: async ({ key, epoch, boundary }) => {
      const st = await stateOf(key);
      await queued(st, async () => {
        const manifest = await loadManifest(st);
        manifest.epoch = epoch;
        manifest.boundary = boundary;
        await writeManifest(st);
        st.contextThrough = 0;
        await syncContext(st, segmentsOf(st.validated), false);
      });
    },
    /**
     * Delete writes that never completed (`*.part`, `*.tmp`) in every
     * session's directory: adapter start (4.5).
     */
    sweep: async () => {
      const root = await rootDir();
      let removed = 0;
      for (const name of await readdir(root)) {
        if (ARCHIVE_KEY.test(name)) {
          const path = join(root, name);
          // eslint-disable-next-line no-await-in-loop
          const files = await readdir(path).catch(() => []);
          for (const file of files) {
            if (file.endsWith('.part') || file.endsWith('.tmp')) {
              // eslint-disable-next-line no-await-in-loop
              await unlink(join(path, file)).catch(() => {});
              removed += 1;
            }
          }
        }
      }
      return removed;
    },
    /**
     * Wait until every operation started so far (mirror writes included)
     * has finished: shutdown, tests.
     */
    drain: async () => {
      while (inFlight.size > 0) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.all([...inFlight]);
      }
    },
    /** Observe a vat state (tests; History uses it for vat pages). */
    observe,
    /** @param {string} key the session's acknowledged chain (tests) */
    entriesOf: async key => {
      const st = await stateOf(key);
      return harden([...acknowledged(st)]);
    },
    stats: () =>
      harden({
        ...counts,
        sessions: sessions.size,
        answered: answered.size,
        tokens: tokens.size,
      }),
    /** Bytes of a string (tests). @param {string} s */
    utf8: s => Buffer.byteLength(s),
  });
};
harden(makeArchiveStore);
