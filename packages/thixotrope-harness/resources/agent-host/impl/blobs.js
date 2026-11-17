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
 * Node only. Reading is in process (`read`, `readPage`); the `Content`
 * exo (content.js) answers vats from `readPage`; `writers` is the
 * `BlobWriters` exo of `TurnPorts.writers` (the exec vat writes large
 * results through it).
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { E } from '@endo/far';
import { Buffer } from 'node:buffer';
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

import { m1bInterfaces, texts } from '../../../guest/lib/interfaces.js';
import { limits } from '../../../guest/lib/limits.js';
import { previewText } from '../../../guest/lib/bounded.js';
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
 *
 * @typedef {object} ContentPage
 * @property {string} text
 * @property {number} next
 * @property {boolean} done
 *
 * @typedef {object} BlobStore
 * @property {(text: string, options?: { previewUnits?: number }) => Promise<StagedText>} stage
 * @property {(blob: any) => Promise<string>} read the whole text
 * @property {(blob: any, offset: number, maxBytes: number) => Promise<ContentPage>} readPage
 * @property {(blobs: readonly any[]) => Promise<void>} resolveMany
 * @property {any} writers the BlobWriters exo
 * @property {() => Promise<void>} sweep deletes `*.part` (writes that never completed)
 * @property {(blob: any) => boolean} knows the handle is bound in this incarnation
 * @property {(blob: any) => Promise<boolean>} discard delete the file of a
 *   handle this incarnation bound and the caller knows no vat keeps (M1b QC,
 *   J-0393: superseded progress checkpoints, staged submissions a session
 *   refused or already had); true when a file was deleted. The handle stays
 *   minted; a later read of it fails with `texts.blobUnknown`.
 * @property {() => Record<string, number>} stats counters (tests, perf)
 *
 * @typedef {'write' | 'fsync' | 'rename' | 'fsync-dir' | 'bind'} Step
 */

/**
 * `<state>/agent-host/blobs`, from the adapter process's bundle path:
 * `argv[3]` is `<state>/bundles/<digest>.cjs` (pkg store-fs.js `bundlePath`,
 * adapter-process-entry.js), so state copies and templates carry their blobs.
 * @param {readonly string[]} [argv]
 */
export const findBlobDir = (argv = processArgv) => {
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
  return join(dirname(dirname(bundle)), 'agent-host', 'blobs');
};
harden(findBlobDir);

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

/**
 * @param {object} options
 * @param {string | (() => string)} options.dir the blob directory (or how to
 *   find it, asked on first use)
 * @param {any} options.sink the manager's `AgentHostSink` (`mintBlobs`,
 *   `resolveBlobs`), or a function returning the current one
 * @param {import('./timers.js').Timers} [options.timers]
 * @param {(step: Step, key: string) => void} [options.trace] called before
 *   each durable step and the bind (tests: order; a throw fails the staging)
 * @returns {BlobStore}
 */
export const makeBlobStore = ({
  dir,
  sink,
  timers = makeTimers(),
  trace = () => {},
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

  /** presence -> its file key and byte length (this incarnation). */
  /** @type {WeakMap<any, { key: string, bytes: number }>} */
  const known = new WeakMap();
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

  /** A stock handle; refills in the background below STOCK_LOW. */
  const take = async () => {
    let tries = 0;
    while (stock.length === 0) {
      tries += 1;
      if (tries > 3) throw Error('the manager minted no blob handles');
      // eslint-disable-next-line no-await-in-loop
      await refill();
    }
    const entry = /** @type {{ blob: any, key: string }} */ (stock.shift());
    if (stock.length < STOCK_LOW) refill().catch(() => {});
    return entry;
  };

  /**
   * The durable part of a staging: the file is complete and named before
   * its handle is bound.
   * @param {string} key
   * @param {string} part path of the written, unsynced file handle's file
   * @param {import('node:fs/promises').FileHandle} handle open on `part`
   */
  const commit = async (key, part, handle) => {
    const path = await directory();
    try {
      trace('fsync', key);
      await handle.sync();
    } finally {
      await handle.close();
    }
    trace('rename', key);
    await rename(part, join(path, key));
    trace('fsync-dir', key);
    await syncDirectory(path);
  };

  /**
   * @param {any} blob
   * @param {string} key
   * @param {number} bytes
   * @param {string} preview
   */
  const bind = (blob, key, bytes, preview) => {
    trace('bind', key);
    known.set(blob, { key, bytes });
    counts.staged += 1;
    counts.stagedBytes += bytes;
    return harden({ blob, preview, bytes });
  };

  /** @type {BlobStore['stage']} */
  const stage = async (
    text,
    { previewUnits = limits.messagePreviewUnits } = {},
  ) => {
    const path = await directory();
    const { blob, key } = await take();
    const buffer = Buffer.from(text, 'utf8');
    const part = join(path, `${key}.part`);
    const handle = await open(part, 'w', 0o600);
    try {
      trace('write', key);
      await handle.writeFile(buffer);
    } catch (error) {
      await handle.close();
      throw error;
    }
    await commit(key, part, handle);
    return bind(blob, key, buffer.length, previewText(text, previewUnits));
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
                known.set(blob, { key, bytes: info.size });
                counts.resolved += 1;
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

  /** @param {any} blob */
  const locate = async blob => {
    if (!known.has(blob)) await resolveMany([blob]);
    const found = known.get(blob);
    if (found === undefined) throw Error(texts.blobUnknown);
    return { ...found, path: join(await directory(), found.key) };
  };

  /** @type {BlobStore['read']} */
  const read = async blob => {
    const { path } = await locate(blob);
    return (await readFile(path)).toString('utf8');
  };

  /** @type {BlobStore['readPage']} */
  const readPage = async (blob, offset, maxBytes) => {
    const { path, bytes } = await locate(blob);
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

  let writerSerial = 0;
  const makeWriter = () => {
    writerSerial += 1;
    const serial = writerSerial;
    /** @type {'open' | 'closed'} */
    let state = 'open';
    let bytes = 0;
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

    return makeExo('BlobWriter', m1bInterfaces.BlobWriter, {
      /** @param {string} piece */
      append: piece =>
        inOrder(async () => {
          if (state !== 'open') throw Error(texts.writerClosed);
          touch();
          if (handle === undefined) {
            const path = await directory();
            part = join(path, `w${pid}-${serial}.part`);
            handle = await open(part, 'w', 0o600);
          }
          const buffer = Buffer.from(piece, 'utf8');
          await handle.write(buffer);
          bytes += buffer.length;
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
          const path = await directory();
          if (handle === undefined) {
            part = join(path, `w${pid}-${serial}.part`);
            handle = await open(part, 'w', 0o600);
          }
          const { blob, key } = await take();
          await commit(key, /** @type {string} */ (part), handle);
          handle = undefined;
          state = 'closed';
          counts.writersOpen -= 1;
          return bind(
            blob,
            key,
            bytes,
            previewText(head.join(''), limits.toolPreviewUnits),
          );
        }),
      abort: () => {
        void drop();
      },
    });
  };

  const writers = makeExo('BlobWriters', m1bInterfaces.BlobWriters, {
    open: async () => makeWriter(),
  });

  /** @type {BlobStore['discard']} */
  const discard = async blob => {
    const found = known.get(blob);
    if (found === undefined) return false;
    known.delete(blob);
    const path = await directory();
    try {
      await unlink(join(path, found.key));
    } catch {
      return false;
    }
    counts.discarded += 1;
    counts.discardedBytes += found.bytes;
    return true;
  };

  /** @type {BlobStore['sweep']} */
  const sweep = async () => {
    const path = await directory();
    const names = await readdir(path);
    await Promise.all(
      names
        .filter(name => name.endsWith('.part'))
        .map(name => unlink(join(path, name)).catch(() => {})),
    );
  };

  return harden({
    stage,
    read,
    readPage,
    resolveMany,
    writers,
    sweep,
    knows: blob => known.has(blob),
    discard,
    stats: () => harden({ ...counts, stock: stock.length }),
  });
};
harden(makeBlobStore);
