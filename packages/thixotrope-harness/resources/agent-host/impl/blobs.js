// @ts-check
/**
 * The adapter's blob store (M1b W1b.1; architecture D-10, D-15;
 * `designs/m1b-interfaces.md` sections 3.1, 4 and 11).
 *
 * Text over `inlineBytes` never crosses into a vat: it is written to a file
 * here and a vat gets a `StagedText { blob, preview, bytes }` instead. The
 * `Blob` handles are durable exos minted by the agent-host manager vat in
 * batches (`AgentHostSink.mintBlobs`); this store keeps a stock of them in
 * memory and binds one to a file when it stages a text:
 *
 *   write `<dir>/<key>.part`, fsync it, rename it to `<dir>/<key>`, fsync
 *   the directory, record `presence -> { key, bytes }`, and only then
 *   answer the StagedText (whose handle may now leave the process).
 *
 * A handle in the stock is never sent anywhere, so every handle any vat
 * holds is readable (section 4.2). After a restart the presence map is
 * empty: a miss asks the manager for the keys of the handles
 * (`resolveBlobs`, at most `blobResolveBatch` per manager crank) and reads
 * the files, which the state directory carries. The stock dies with the
 * process; its handles were exported only to this adapter session, so the
 * manager's WeakMap lets them go.
 *
 * Quotas (M1b follow-ups, J-9361; contract 17.1): a staging that would
 * take its session (`owner`) over `blobLimits.sessionBytes`, or the whole
 * directory over `blobLimits.daemonBytes`, is refused before anything is
 * written (`textOf.blobSessionQuota`, `textOf.blobDaemonQuota`). A writer is
 * checked piece by piece. Deleted files are refunded. The daemon count
 * starts from one sweep per incarnation; no staging is reserved before that
 * sweep has succeeded (HR-SYN-9).
 *
 * Provenance (J-9364; contract 17.3): each bound handle records the session
 * it was staged for; `read`/`readPage`/`claim` with an owner refuse another
 * session's handle (`texts.blobNotOwned`). A handle resolved after a restart
 * has no owner until the first session presents it.
 *
 * Node only. Reading is in process (`read`, `readPage`); the `Content`
 * exo (content.js) answers vats from `readPage`; `writers` is the
 * `BlobWriters` exo of `TurnPorts.writers` (the exec vat writes large
 * results through it).
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { E } from '@endo/far';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  open,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { argv as processArgv, pid } from 'node:process';

import { interfaces, textOf, texts } from '../../../guest/lib/interfaces.js';
import { limits } from '../../../guest/lib/limits.js';
import { previewText } from '../../../guest/lib/bounded.js';
import { blobLimits } from '../../../config/defaults.js';
import { makeTimers } from './timers.js';
/* eslint-enable import/no-relative-packages */

const { makeExo } = /** @type {any} */ (globalThis);

/** The stock is refilled when it holds fewer handles than this (section 4.1). */
export const STOCK_LOW = 8;
/** File keys the manager mints: `b<n>`. Anything else is refused (no path games). */
const KEY = /^b[1-9][0-9]*$/;
/** A UTF-8 continuation byte (10xxxxxx) cannot start a code point. @param {number} byte */
const isContinuation = byte => byte >= 0x80 && byte < 0xc0;

/**
 * @typedef {object} StagedText
 * @property {any} blob
 * @property {string} preview
 * @property {number} bytes
 * @property {string} [digest] SHA-256 of the UTF-8 bytes, hex (J-9363)
 *
 * @typedef {object} ContentPage
 * @property {string} text
 * @property {number} next
 * @property {boolean} done
 *
 * @typedef {{ previewUnits?: number, owner?: any }} StageOptions `owner`:
 *   the Session presence the text is staged for (its quota; J-9361, J-9364)
 *
 * @typedef {object} BlobStore
 * @property {(text: string, options?: StageOptions) => Promise<StagedText>} stage
 *   write, fsync, name, fsync the directory, bind: the handle may leave now
 * @property {(text: string, options?: StageOptions) => Promise<StagedText>} stagePending
 *   write and fsync `<key>.part` only; the handle must not leave the process
 *   before `commit` (a crash before it leaves a `.part` the next start
 *   deletes; J-9361)
 * @property {(staged: ReadonlyArray<StagedText | undefined>) => Promise<void>} commit
 *   name the pending files and fsync the directory once; then bind them
 *   (committed or unknown entries are skipped)
 * @property {(staged: ReadonlyArray<StagedText | undefined>) => Promise<number>} drop
 *   delete the files of the entries still pending (their handles never left
 *   the process: a round cancelled or failed before it was sent); committed
 *   entries are left alone. Answers how many were deleted.
 * @property {(blob: any, owner?: any) => Promise<string>} read the whole
 *   text; with `owner`, refused (`texts.blobNotOwned`) for another
 *   session's handle
 * @property {(blob: any, offset: number, maxBytes: number, owner?: any) => Promise<ContentPage>} readPage
 * @property {(blobs: readonly any[]) => Promise<void>} resolveMany
 * @property {(blob: any, owner: any) => void} claim refuses
 *   (`texts.blobNotOwned`) a bound handle of another session; an ownerless
 *   one (resolved after a restart) becomes `owner`'s (J-9364)
 * @property {any} writers the BlobWriters exo (no owner)
 * @property {(owner: any) => any} writersFor a BlobWriters exo whose
 *   blobs are `owner`'s (its quota; TurnPorts.writers)
 * @property {() => Promise<void>} sweep once per incarnation (HR-SYN-9):
 *   deletes `*.part` (writes of an earlier incarnation that never completed
 *   or were never committed) and sets the daemon count to the bytes on
 *   disk. A later call answers the same settled sweep (a rebind neither
 *   counts the files again nor deletes this incarnation's `.part` files);
 *   a failed sweep rejects with its error and is tried again by the next
 *   call. The first staging runs it if no one has; until one succeeds every
 *   staging is refused (`blobsUncountedText`), so the daemon quota never
 *   checks against an uncounted directory.
 * @property {(blob: any) => boolean} knows the handle is bound in this incarnation
 * @property {(blob: any) => Promise<boolean>} discard delete the file of a
 *   handle this incarnation bound (or wrote and did not commit) and the
 *   caller knows no vat keeps (M1b QC, J-0393: superseded progress
 *   checkpoints, staged submissions a session refused or already had;
 *   J-9361: stagings of a round that was cancelled before it was sent);
 *   true when a file was deleted. The handle stays minted; a later read of
 *   it fails with `texts.blobUnknown`.
 * @property {(owner: any) => { session: number, daemon: number }} usage
 *   bytes held by `owner` and on disk in all (quotas)
 * @property {() => Record<string, number>} stats counters (tests, perf)
 * @property {(key: string) => Promise<string>} readKey M2 (W2.8): the whole
 *   text of the file `key` names (the archive reads sealed fields by key:
 *   their handles are gone); `texts.blobUnknown` when there is none
 * @property {(key: string, offset: number, maxBytes: number) => Promise<ContentPage>} readPageKey
 *   M2: a page of the file `key` names, as `readPage`
 * @property {(keys: readonly string[]) => Promise<number>} release M2:
 *   delete the files `keys` name (missing files are fine) and refund their
 *   bytes; answers how many were deleted. For deleting a session (M1b 4.8,
 *   m2-interfaces.md 4.11), never for a seal (4.10).
 * @property {(blob: any) => string | undefined} keyOf M2: the file key of a
 *   handle bound or resolved in this incarnation
 * @property {(owner: any, bytes: number) => void} chargeArchived M2: count
 *   a session's sealed blob bytes against its quota (once per incarnation,
 *   when its archive is first validated; 4.10 item 4)
 *
 * @typedef {'write' | 'fsync' | 'rename' | 'fsync-dir' | 'bind'} Step
 */

/**
 * The daemon's state directory, from the adapter process's bundle path:
 * `argv[3]` is `<state>/bundles/<digest>.cjs` (pkg store-fs.js `bundlePath`,
 * adapter-process-entry.js), so state copies and templates carry their
 * files. The core gives an adapter no state directory (AR-SYN-28); this is
 * the one place that reads it from argv (HR-SYN-22).
 * @param {readonly string[]} [argv]
 */
export const findStateDir = (argv = processArgv) => {
  const bundle = argv[3];
  if (
    typeof bundle !== 'string' ||
    !bundle.endsWith('.cjs') ||
    basename(dirname(bundle)) !== 'bundles'
  ) {
    throw Error(
      'agent host: no state directory (argv[3] is not <state>/bundles/<digest>.cjs)',
    );
  }
  return dirname(dirname(bundle));
};
harden(findStateDir);

/**
 * The blob directory in a state directory.
 * @param {string} stateDir
 */
export const blobDirIn = stateDir => join(stateDir, 'agent-host', 'blobs');
harden(blobDirIn);

/**
 * `<state>/agent-host/blobs`, from the adapter process's bundle path
 * (`findStateDir`).
 * @param {readonly string[]} [argv]
 */
export const findBlobDir = (argv = processArgv) =>
  blobDirIn(findStateDir(argv));
harden(findBlobDir);

/**
 * What a staging is refused with while the store has not counted the files
 * already on disk (its sweep failed): the daemon quota would check against
 * a count that leaves them out (HR-SYN-9). The sweep's own error is the
 * adapter's to report (`impl/index.js`); it may name paths, so it is not
 * part of this text.
 */
export const blobsUncountedText =
  'the blob directory has not been counted (its start-up sweep failed); staging is refused until a sweep succeeds';

/** @param {string} path */
const syncDirectory = async path => {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/**
 * @template T
 * @param {T | (() => T)} value
 * @returns {T}
 */
const resolveLazy = value =>
  typeof value === 'function' ? /** @type {() => T} */ (value)() : value;

/** The SHA-256 of `buffer`, 64 lowercase hex digits (StagedText.digest). @param {Buffer} buffer */
export const digestOf = buffer =>
  createHash('sha256').update(buffer).digest('hex');
harden(digestOf);

/**
 * @param {object} options
 * @param {string | (() => string)} options.dir the blob directory (or how to
 *   find it, asked on first use)
 * @param {any} options.sink the manager's `AgentHostSink` (`mintBlobs`,
 *   `resolveBlobs`), or a function returning the current one
 * @param {import('./timers.js').Timers} [options.timers]
 * @param {(step: Step, key: string) => void} [options.trace] called before
 *   each durable step and the bind (tests: order; a throw fails the staging)
 * @param {{ sessionBytes: number, daemonBytes: number }} [options.quota]
 *   disk quotas (`config/defaults.js` `blobLimits`; J-9361)
 * @returns {BlobStore}
 */
export const makeBlobStore = ({
  dir,
  sink,
  timers = makeTimers(),
  trace = () => {},
  quota = blobLimits,
}) => {
  /** @type {string | undefined} */
  let blobDir;
  /** @type {Promise<string> | undefined} */
  let ready;
  const directory = () => {
    ready ??= (async () => {
      blobDir = resolveLazy(dir);
      await mkdir(blobDir, { recursive: true, mode: 0o700 });
      return blobDir;
    })();
    ready.catch(() => {
      ready = undefined;
    });
    return ready;
  };
  const sinkOf = () => resolveLazy(sink);

  /**
   * presence -> its file key, byte length and owner (this incarnation). The
   * owner is the Session presence the text was staged for, or the first
   * session that claimed the handle after a restart (J-9364).
   * @type {WeakMap<any, { key: string, bytes: number, owner?: any }>}
   */
  const known = new WeakMap();
  /**
   * Handles written to `<key>.part` and fsynced but not yet committed (named
   * and bound): they have not left this process (J-9361).
   * @type {WeakMap<any, { key: string, bytes: number, owner?: any }>}
   */
  const pending = new WeakMap();
  /** owner -> bytes of its staged text this incarnation knows. @type {WeakMap<any, number>} */
  const ownerBytes = new WeakMap();
  /** Bytes of staged text on disk (files counted by `sweep`, then kept up). */
  let diskBytes = 0;
  /**
   * This incarnation's one sweep: pending or settled with success; a
   * failure clears it so the next call tries again (HR-SYN-9).
   * @type {Promise<void> | undefined}
   */
  let sweeping;
  /** @type {Array<{ blob: any, key: string }>} */
  const stock = [];
  /** @type {Promise<void> | undefined} */
  let refilling;
  const counts = {
    staged: 0,
    stagedBytes: 0,
    refills: 0,
    resolveCalls: 0,
    resolved: 0,
    writersOpen: 0,
    writersAborted: 0,
    discarded: 0,
    discardedBytes: 0,
    dropped: 0,
    refusedSession: 0,
    refusedDaemon: 0,
    refusedOwner: 0,
    swept: 0,
    released: 0,
    releasedBytes: 0,
  };

  /** @param {any} owner */
  const heldBy = owner =>
    owner === undefined ? 0 : (ownerBytes.get(owner) ?? 0);
  /**
   * @param {any} owner
   * @param {number} delta
   */
  const charge = (owner, delta) => {
    diskBytes += delta;
    if (owner !== undefined)
      ownerBytes.set(owner, Math.max(0, heldBy(owner) + delta));
  };
  /**
   * Refuse `bytes` more for `owner` over either quota (nothing written yet),
   * else charge them (the caller refunds them if the staging fails).
   * @param {any} owner
   * @param {number} bytes
   */
  const reserve = (owner, bytes) => {
    if (owner !== undefined && heldBy(owner) + bytes > quota.sessionBytes) {
      counts.refusedSession += 1;
      throw Error(
        textOf.blobSessionQuota(bytes, heldBy(owner), quota.sessionBytes),
      );
    }
    if (diskBytes + bytes > quota.daemonBytes) {
      counts.refusedDaemon += 1;
      throw Error(textOf.blobDaemonQuota(bytes, diskBytes, quota.daemonBytes));
    }
    charge(owner, bytes);
  };

  const refill = () => {
    if (refilling === undefined) {
      counts.refills += 1;
      refilling = (async () => {
        try {
          const entries = await E(sinkOf()).mintBlobs();
          for (const entry of entries) {
            if (!KEY.test(entry.key))
              throw Error('bad blob key from the manager');
            stock.push(entry);
          }
        } finally {
          refilling = undefined;
        }
      })();
    }
    return refilling;
  };

  /**
   * A stock handle; refills in the background below STOCK_LOW. Many
   * stagings at once (a round of 100 large tool arguments) may each wait
   * for several refills: only refills that left the stock empty count
   * against the bound (J-9361; before, the fourth waiter of one refill
   * failed with "minted no blob handles").
   */
  const take = async () => {
    let empty = 0;
    while (stock.length === 0) {
      // eslint-disable-next-line no-await-in-loop
      await refill();
      if (stock.length === 0) {
        empty += 1;
        if (empty > 3) throw Error('the manager minted no blob handles');
      }
    }
    const entry = /** @type {{ blob: any, key: string }} */ (stock.shift());
    if (stock.length < STOCK_LOW) refill().catch(() => {});
    return entry;
  };

  /**
   * fsync and close a written part file.
   * @param {string} key
   * @param {import('node:fs/promises').FileHandle} handle
   */
  const syncPart = async (key, handle) => {
    try {
      trace('fsync', key);
      await handle.sync();
    } finally {
      await handle.close();
    }
  };

  /**
   * Name synced part files and fsync the directory once for all of them:
   * after this their handles may leave the process.
   * @param {Array<{ key: string, part: string }>} files
   */
  const name = async files => {
    if (files.length === 0) return;
    const path = await directory();
    for (const { key, part } of files) {
      trace('rename', key);
      // eslint-disable-next-line no-await-in-loop
      await rename(part, join(path, key));
    }
    trace('fsync-dir', files[files.length - 1].key);
    await syncDirectory(path);
  };

  /**
   * @param {any} blob
   * @param {{ key: string, bytes: number, owner?: any }} info
   */
  const bind = (blob, info) => {
    trace('bind', info.key);
    known.set(blob, info);
    counts.staged += 1;
    counts.stagedBytes += info.bytes;
  };

  /**
   * Write `text` to `<key>.part` and fsync it; quotas first.
   * @param {string} text
   * @param {{ previewUnits?: number, owner?: any }} options
   */
  const writePart = async (
    text,
    { previewUnits = limits.messagePreviewUnits, owner } = {},
  ) => {
    const buffer = Buffer.from(text, 'utf8');
    // eslint-disable-next-line no-use-before-define
    await counted();
    reserve(owner, buffer.length);
    try {
      const path = await directory();
      const { blob, key } = await take();
      const part = join(path, `${key}.part`);
      const handle = await open(part, 'w', 0o600);
      try {
        trace('write', key);
        await handle.writeFile(buffer);
      } catch (error) {
        await handle.close();
        await unlink(part).catch(() => {});
        throw error;
      }
      try {
        await syncPart(key, handle);
      } catch (error) {
        await unlink(part).catch(() => {});
        throw error;
      }
      const staged = harden({
        blob,
        preview: previewText(text, previewUnits),
        bytes: buffer.length,
        digest: digestOf(buffer),
      });
      return { staged, key, part, info: { key, bytes: buffer.length, owner } };
    } catch (error) {
      charge(owner, -buffer.length);
      throw error;
    }
  };

  /** @type {BlobStore['stage']} */
  const stage = async (text, options = {}) => {
    const { staged, key, part, info } = await writePart(text, options);
    try {
      await name([{ key, part }]);
    } catch (error) {
      await unlink(part).catch(() => {});
      charge(info.owner, -info.bytes);
      throw error;
    }
    bind(staged.blob, info);
    return staged;
  };

  /** @type {BlobStore['stagePending']} */
  const stagePending = async (text, options = {}) => {
    const { staged, info } = await writePart(text, options);
    pending.set(staged.blob, info);
    return staged;
  };

  /** @type {BlobStore['commit']} */
  const commit = async stagedTexts => {
    /** @type {Array<{ blob: any, key: string, part: string, info: any }>} */
    const files = [];
    if (
      !stagedTexts.some(
        staged =>
          staged !== undefined &&
          typeof staged === 'object' &&
          pending.has(staged.blob),
      )
    )
      return;
    const path = await directory();
    for (const staged of stagedTexts) {
      const info =
        staged === undefined || typeof staged !== 'object'
          ? undefined
          : pending.get(staged.blob);
      if (staged !== undefined && info !== undefined) {
        pending.delete(staged.blob);
        files.push({
          blob: staged.blob,
          key: info.key,
          part: join(path, `${info.key}.part`),
          info,
        });
      }
    }
    try {
      await name(files);
    } catch (error) {
      for (const file of files) {
        // eslint-disable-next-line no-await-in-loop
        await unlink(file.part).catch(() => {});
        // eslint-disable-next-line no-await-in-loop
        await unlink(join(path, file.key)).catch(() => {});
        charge(file.info.owner, -file.info.bytes);
      }
      throw error;
    }
    for (const file of files) bind(file.blob, file.info);
  };

  /** @type {BlobStore['resolveMany']} */
  const resolveMany = async blobs => {
    /** @type {any[]} */
    const missing = [];
    const seen = new Set();
    for (const blob of blobs) {
      if (!known.has(blob) && !seen.has(blob)) {
        seen.add(blob);
        missing.push(blob);
      }
    }
    if (missing.length === 0) return;
    const path = await directory();
    /** @type {Promise<void>[]} */
    const batches = [];
    for (let i = 0; i < missing.length; i += limits.blobResolveBatch) {
      const batch = harden(missing.slice(i, i + limits.blobResolveBatch));
      counts.resolveCalls += 1;
      batches.push(
        (async () => {
          const keys = await E(sinkOf()).resolveBlobs(batch);
          await Promise.all(
            batch.map(async (blob, index) => {
              const key = keys[index];
              if (typeof key !== 'string' || !KEY.test(key)) return;
              try {
                const info = await stat(join(path, key));
                if (!known.has(blob)) {
                  known.set(blob, { key, bytes: info.size });
                  counts.resolved += 1;
                }
              } catch {
                // No file: the handle stays unknown (texts.blobUnknown).
              }
            }),
          );
        })(),
      );
    }
    await Promise.all(batches);
  };

  /** @type {BlobStore['claim']} */
  const claim = (blob, owner) => {
    const found = known.get(blob);
    if (found === undefined) return;
    if (found.owner === undefined) {
      // Staged before this incarnation (or without an owner): the first
      // session that presents the handle holds it from now on (J-9364).
      found.owner = owner;
      if (owner !== undefined)
        ownerBytes.set(owner, heldBy(owner) + found.bytes);
      return;
    }
    if (found.owner !== owner) {
      counts.refusedOwner += 1;
      throw Error(texts.blobNotOwned);
    }
  };

  /**
   * @param {any} blob
   * @param {any} [owner] when given, the handle must be that session's
   */
  const locate = async (blob, owner) => {
    if (!known.has(blob)) await resolveMany([blob]);
    const found = known.get(blob);
    if (found === undefined) throw Error(texts.blobUnknown);
    if (owner !== undefined) claim(blob, owner);
    return { ...found, path: join(await directory(), found.key) };
  };

  /** @type {BlobStore['read']} */
  const read = async (blob, owner) => {
    const { path } = await locate(blob, owner);
    return (await readFile(path)).toString('utf8');
  };

  /**
   * A page of the file at `path` (`bytes` long): whole code points.
   * @param {string} path
   * @param {number} bytes
   * @param {number} offset
   * @param {number} maxBytes
   */
  const readRange = async (path, bytes, offset, maxBytes) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes) {
      throw Error(`offset ${offset} is outside the blob (${bytes} bytes)`);
    }
    // One byte past the page shows whether its end splits a character.
    const want = Math.min(maxBytes + 1, bytes - offset);
    const buffer = Buffer.alloc(want);
    let got = 0;
    if (want > 0) {
      const handle = await open(path, 'r');
      try {
        while (got < want) {
          // eslint-disable-next-line no-await-in-loop
          const { bytesRead } = await handle.read(
            buffer,
            got,
            want - got,
            offset + got,
          );
          if (bytesRead === 0) break;
          got += bytesRead;
        }
      } finally {
        await handle.close();
      }
    }
    if (got > 0 && isContinuation(buffer[0])) {
      throw Error(`offset ${offset} is not at a character boundary`);
    }
    let end = Math.min(got, maxBytes);
    // Whole code points only: never end before a continuation byte.
    while (end > 0 && end < got && isContinuation(buffer[end])) end -= 1;
    const next = offset + end;
    return harden({
      text: buffer.subarray(0, end).toString('utf8'),
      next,
      done: next === bytes,
    });
  };

  /** @type {BlobStore['readPage']} */
  const readPage = async (blob, offset, maxBytes, owner) => {
    const { path, bytes } = await locate(blob, owner);
    return readRange(path, bytes, offset, maxBytes);
  };

  /** @param {string} key */
  const pathOfKey = async key => {
    if (!KEY.test(key)) throw Error(texts.blobUnknown);
    return join(await directory(), key);
  };

  /** @type {BlobStore['readKey']} */
  const readKey = async key => {
    const path = await pathOfKey(key);
    try {
      return (await readFile(path)).toString('utf8');
    } catch {
      throw Error(texts.blobUnknown);
    }
  };

  /** @type {BlobStore['readPageKey']} */
  const readPageKey = async (key, offset, maxBytes) => {
    const path = await pathOfKey(key);
    /** @type {number} */
    let bytes;
    try {
      bytes = (await stat(path)).size;
    } catch {
      throw Error(texts.blobUnknown);
    }
    return readRange(path, bytes, offset, maxBytes);
  };

  /** @type {BlobStore['release']} */
  const release = async keys => {
    // The incarnation's one sweep counts what it stats; a file deleted under
    // it would stay counted, or be refunded twice. Start or join that sweep
    // before any unlink; a failed sweep still lets the release go on
    // (HR-SYN-9).
    await sweep().catch(() => {});
    const path = await directory();
    let removed = 0;
    for (const key of keys) {
      if (typeof key === 'string' && KEY.test(key)) {
        const file = join(path, key);
        // eslint-disable-next-line no-await-in-loop
        const size = await stat(file).then(
          info => info.size,
          () => -1,
        );
        if (size >= 0) {
          // eslint-disable-next-line no-await-in-loop
          const gone = await unlink(file).then(
            () => true,
            () => false,
          );
          if (gone) {
            diskBytes = Math.max(0, diskBytes - size);
            removed += 1;
            counts.released += 1;
            counts.releasedBytes += size;
          }
        }
      }
    }
    return removed;
  };

  /** @type {BlobStore['keyOf']} */
  const keyOf = blob => known.get(blob)?.key;

  /** @type {BlobStore['chargeArchived']} */
  const chargeArchived = (owner, bytes) => {
    if (owner === undefined || !(bytes > 0)) return;
    ownerBytes.set(owner, heldBy(owner) + bytes);
  };

  let writerSerial = 0;
  /** @param {any} owner */
  const makeWriter = owner => {
    writerSerial += 1;
    const serial = writerSerial;
    /** @type {'open' | 'closed'} */
    let state = 'open';
    let bytes = 0;
    const hash = createHash('sha256');
    /** @type {string[]} */
    const head = [];
    let headUnits = 0;
    /** @type {import('node:fs/promises').FileHandle | undefined} */
    let handle;
    /** @type {string | undefined} */
    let part;
    /** Appends are written in arrival order. */
    /** @type {Promise<unknown>} */
    let tail = Promise.resolve();
    /** @type {() => void} */
    let cancelIdle = () => {};
    counts.writersOpen += 1;

    const drop = async () => {
      cancelIdle();
      if (state === 'closed') return;
      state = 'closed';
      counts.writersOpen -= 1;
      counts.writersAborted += 1;
      await tail.catch(() => {});
      await handle?.close().catch(() => {});
      if (part !== undefined) await unlink(part).catch(() => {});
      charge(owner, -bytes);
    };
    const touch = () => {
      cancelIdle();
      cancelIdle = timers.after(limits.blobWriterIdleMs, () => {
        void drop();
      });
    };
    touch();

    /** @param {() => Promise<any>} step */
    const inOrder = step => {
      const result = tail.then(step);
      tail = result.catch(() => {});
      return result;
    };

    return makeExo('BlobWriter', interfaces.BlobWriter, {
      /** @param {string} piece */
      append: piece =>
        inOrder(async () => {
          if (state !== 'open') throw Error(texts.writerClosed);
          touch();
          const buffer = Buffer.from(piece, 'utf8');
          // Quotas per piece, before the bytes are written (J-9361); the
          // writer's earlier pieces are already charged.
          // eslint-disable-next-line no-use-before-define
          await counted();
          reserve(owner, buffer.length);
          try {
            if (handle === undefined) {
              const path = await directory();
              part = join(path, `w${pid}-${serial}.part`);
              handle = await open(part, 'w', 0o600);
            }
            await handle.write(buffer);
          } catch (error) {
            charge(owner, -buffer.length);
            throw error;
          }
          bytes += buffer.length;
          hash.update(buffer);
          if (headUnits < limits.toolPreviewUnits) {
            head.push(piece);
            headUnits += piece.length;
          }
          return undefined;
        }),
      close: () =>
        inOrder(async () => {
          if (state !== 'open') throw Error(texts.writerClosed);
          cancelIdle();
          // No `.part` is written before this incarnation's sweep (HR-SYN-9).
          // eslint-disable-next-line no-use-before-define
          await counted();
          const path = await directory();
          if (handle === undefined) {
            part = join(path, `w${pid}-${serial}.part`);
            handle = await open(part, 'w', 0o600);
          }
          const { blob, key } = await take();
          await syncPart(key, handle);
          await name([{ key, part: /** @type {string} */ (part) }]);
          handle = undefined;
          state = 'closed';
          counts.writersOpen -= 1;
          bind(blob, { key, bytes, owner });
          return harden({
            blob,
            preview: previewText(head.join(''), limits.toolPreviewUnits),
            bytes,
            digest: hash.digest('hex'),
          });
        }),
      abort: () => {
        void drop();
      },
    });
  };

  /** @param {any} [owner] */
  const writersFor = owner =>
    makeExo('BlobWriters', interfaces.BlobWriters, {
      open: async () => makeWriter(owner),
    });
  const writers = writersFor(undefined);

  /** @type {BlobStore['discard']} */
  const discard = async blob => {
    const path = await directory();
    const waiting = pending.get(blob);
    if (waiting !== undefined) {
      // Written but never committed: its handle never left this process.
      pending.delete(blob);
      await unlink(join(path, `${waiting.key}.part`)).catch(() => {});
      charge(waiting.owner, -waiting.bytes);
      counts.dropped += 1;
      return true;
    }
    const found = known.get(blob);
    if (found === undefined) return false;
    known.delete(blob);
    try {
      await unlink(join(path, found.key));
    } catch {
      return false;
    }
    charge(found.owner, -found.bytes);
    counts.discarded += 1;
    counts.discardedBytes += found.bytes;
    return true;
  };

  /** @type {BlobStore['drop']} */
  const drop = async stagedTexts => {
    let dropped = 0;
    for (const staged of stagedTexts) {
      if (
        staged !== undefined &&
        typeof staged === 'object' &&
        pending.has(staged.blob)
      ) {
        // eslint-disable-next-line no-await-in-loop
        if (await discard(staged.blob)) dropped += 1;
      }
    }
    return dropped;
  };

  const sweepNow = async () => {
    const path = await directory();
    const names = await readdir(path);
    let total = 0;
    await Promise.all(
      names.map(async entry => {
        if (entry.endsWith('.part')) {
          await unlink(join(path, entry)).catch(() => {});
          counts.swept += 1;
          return;
        }
        if (!KEY.test(entry)) return;
        try {
          const { size } = await stat(join(path, entry));
          total += size;
        } catch {
          // Gone meanwhile.
        }
      }),
    );
    // No staging reserved anything before this (`counted`), so the files
    // on disk are the whole count.
    diskBytes = total;
  };

  /** @type {BlobStore['sweep']} */
  const sweep = () => {
    if (sweeping === undefined) {
      const attempt = sweepNow();
      sweeping = attempt;
      attempt.catch(() => {
        if (sweeping === attempt) sweeping = undefined;
      });
    }
    return sweeping;
  };

  /**
   * Before a reservation: this incarnation's sweep has succeeded (run now
   * if no one ran it), else the staging is refused (HR-SYN-9).
   */
  const counted = async () => {
    try {
      await sweep();
    } catch {
      throw Error(blobsUncountedText);
    }
  };

  return harden({
    stage,
    stagePending,
    commit,
    drop,
    read,
    readPage,
    readKey,
    readPageKey,
    release,
    keyOf,
    chargeArchived,
    resolveMany,
    claim,
    writers,
    writersFor,
    sweep,
    knows: blob => known.has(blob),
    discard,
    usage: owner => harden({ session: heldBy(owner), daemon: diskBytes }),
    stats: () => harden({ ...counts, stock: stock.length, diskBytes }),
  });
};
harden(makeBlobStore);
