// @ts-check
/* global globalThis */

// Cloudflare storage platform for the Endo daemon. Design:
// designs/endo-daemon-cloudflare-storage.md.
//
// This module is a derivative of daemon-node-powers.js the same way
// daemon-go-powers.js is: it shares the daemon's own storage modules —
// daemon-database.js (over the better-sqlite3-do.js Durable Object
// shim), pet-store.js, and daemon-persistence-powers.js — and replaces
// only the platform substrate:
//
// - Structured state (formulas, root nonce and keypair, agent keys,
//   pet-store entries, retention) lives in the Durable Object's
//   SQLite storage, reached through the better-sqlite3-compatible
//   constructor from better-sqlite3-do.js.
// - The SHA-256 content store lives in an R2 bucket, reached through
//   a FilePowers implementation over the R2 binding, so the shared
//   makeDaemonicPersistencePowers content store runs unchanged.
// - Crypto is injected: the daemon needs a synchronous incremental
//   SHA-256 digester and synchronous Ed25519 signing, which WebCrypto
//   does not provide, so a Workers deployment injects @noble/hashes
//   and @noble/curves; randomness comes from the host WebCrypto.
//
// Control powers (worker spawning) are an execution design, not a
// storage design, and are stubbed pending that work; see the design
// document's runtime analysis.
//
// No Cloudflare API is touched outside the R2 adapter and the
// better-sqlite3-do.js shim, and no account identifier or credential
// appears anywhere: Cloudflare bindings are injected capabilities,
// which is the same powers discipline the daemon already practices.

import harden from '@endo/harden';
import { q } from '@endo/errors';
import { toHex } from './hex.js';
import { makeDatabaseConstructor } from './better-sqlite3-do.js';
import { makeDaemonDatabase } from './daemon-database.js';
import { makePetStoreMaker } from './pet-store.js';
import { makeDaemonicPersistencePowers } from './daemon-persistence-powers.js';

/** @import { Reader, Writer } from '@endo/stream' */
/** @import { Config, CryptoPowers, DaemonicControlPowers, DaemonicPowers, Ed25519Keypair, FilePowers, Sha256 } from './types.js' */
/** @import { DurableObjectSqlStorage } from './better-sqlite3-do.js' */

// #region Cloudflare R2 binding surface types
// Minimal structural types for the R2 bucket binding, so the package
// does not take a dependency on @cloudflare/workers-types. They
// describe only the subset of the binding API the adapter uses.

/**
 * @typedef {object} R2ObjectHead
 * @property {string} key
 * @property {number} size
 *
 * @typedef {object} R2ObjectBody
 * @property {ReadableStream<Uint8Array>} body
 * @property {() => Promise<string>} text
 * @property {() => Promise<ArrayBuffer>} arrayBuffer
 *
 * @typedef {object} R2ListResult
 * @property {Array<R2ObjectHead>} objects
 * @property {Array<string>} delimitedPrefixes
 *
 * @typedef {object} R2Bucket
 * @property {(key: string, value: Uint8Array) => Promise<unknown>} put
 * @property {(key: string, options?: { range?: { offset: number, length?: number } }) => Promise<R2ObjectBody | null>} get
 * @property {(key: string) => Promise<R2ObjectHead | null>} head
 * @property {(key: string) => Promise<void>} delete
 * @property {(options?: { prefix?: string, delimiter?: string, limit?: number }) => Promise<R2ListResult>} list
 */

// #endregion

const textEncoder = new TextEncoder();

/**
 * Iterates a Web ReadableStream as Uint8Array chunks, tolerating hosts
 * where ReadableStream is not itself async-iterable.
 *
 * @param {ReadableStream<Uint8Array>} body
 * @returns {AsyncGenerator<Uint8Array, undefined, undefined>}
 */
const iterateBody = async function* iterateBody(body) {
  // No synchronous preamble.
  await null;

  const asyncIterable = /** @type {AsyncIterable<Uint8Array>} */ (
    /** @type {unknown} */ (body)
  );
  if (Symbol.asyncIterator in asyncIterable) {
    yield* asyncIterable;
    return undefined;
  }
  const reader = body.getReader();
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) {
        return undefined;
      }
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
};

/** @param {Array<Uint8Array>} chunks */
const concatChunks = chunks => {
  let length = 0;
  for (const chunk of chunks) {
    length += chunk.length;
  }
  const bytes = new Uint8Array(length);
  let index = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, index);
    index += chunk.length;
  }
  return bytes;
};

/**
 * A FilePowers implementation over an R2 bucket binding, sufficient
 * for the shared daemon-persistence-powers.js content store (and
 * therefore reusing it unchanged): streaming writes and reads, the
 * atomic-visibility commit via renamePath, ranged reads for
 * BlobRef-style windows, stat for blob sizes. Paths are R2 object
 * keys; directories are implicit prefixes.
 *
 * Semantics notes, per the design document:
 * - Writes buffer in Worker memory in this scaffold (fine for the
 *   content store's typical payloads; the R2 multipart spool path for
 *   objects beyond the memory budget is build-phase work).
 * - renamePath is copy-then-delete: the R2 Workers binding has no
 *   server-side rename. The copy lands at the target key atomically
 *   (an R2 put is visible all-or-nothing), which is the property the
 *   content store's temp-then-rename commit protocol actually needs;
 *   the source delete is cleanup, and orphaned temp objects are
 *   reaped by an R2 lifecycle rule on the temp prefix.
 * - removePath has force semantics (missing is not an error), which
 *   is what the content store's remove() expects.
 * - Members with no meaningful object-store analog (realPath and
 *   friends) resolve trivially; watchDirectory follows the documented
 *   FilePowers fallback of terminating immediately where the platform
 *   cannot watch.
 *
 * @param {R2Bucket} bucket
 * @param {object} [options]
 * @param {() => Sha256} [options.makeSha256] - Required only for the
 * filePowers.sha256 member; the content store digests through
 * CryptoPowers instead.
 * @returns {FilePowers}
 */
export const makeR2FilePowers = (bucket, { makeSha256 } = {}) => {
  /** @param {string} path */
  const readFileBytes = async path => {
    const object = await bucket.get(path);
    if (object === null) {
      throw Error(`ENOENT: no such object, read ${q(path)}`);
    }
    return new Uint8Array(await object.arrayBuffer());
  };

  /** @param {string} path */
  const readFileText = async path => {
    const object = await bucket.get(path);
    if (object === null) {
      throw Error(`ENOENT: no such object, read ${q(path)}`);
    }
    return object.text();
  };

  /** @param {string} path */
  const maybeReadFile = async path => {
    const object = await bucket.get(path);
    if (object === null) {
      return undefined;
    }
    return new Uint8Array(await object.arrayBuffer());
  };

  /** @param {string} path */
  const maybeReadFileText = async path => {
    const object = await bucket.get(path);
    if (object === null) {
      return undefined;
    }
    return object.text();
  };

  /**
   * @param {string} path
   * @param {string} text
   */
  const writeFileText = async (path, text) => {
    await bucket.put(path, textEncoder.encode(text));
  };

  /**
   * Read-modify-write: R2 objects are immutable, so append is not
   * atomic. The daemon's content store never appends; this exists for
   * FilePowers completeness (log-shaped consumers should not target
   * the blob store).
   *
   * @param {string} path
   * @param {string} text
   */
  const appendFileText = async (path, text) => {
    const existing = await maybeReadFileText(path);
    await bucket.put(path, textEncoder.encode(`${existing ?? ''}${text}`));
  };

  /**
   * @param {string} path
   * @param {number} offset
   * @param {number} length
   */
  const readFileRange = async (path, offset, length) => {
    const object = await bucket.get(path, { range: { offset, length } });
    if (object === null) {
      throw Error(`ENOENT: no such object, read range ${q(path)}`);
    }
    return new Uint8Array(await object.arrayBuffer());
  };

  /**
   * @param {string} path
   * @returns {Reader<Uint8Array>}
   */
  const makeFileReader = path => {
    /** @returns {AsyncGenerator<Uint8Array, undefined, undefined>} */
    async function* generate() {
      const object = await bucket.get(path);
      if (object === null) {
        throw Error(`ENOENT: no such object, read ${q(path)}`);
      }
      yield* iterateBody(object.body);
      return undefined;
    }
    return generate();
  };

  /**
   * @param {string} path
   * @returns {Writer<Uint8Array>}
   */
  const makeFileWriter = path => {
    /** @type {Array<Uint8Array>} */
    const chunks = [];
    /** @type {Writer<Uint8Array>} */
    const writer = harden({
      async next(chunk) {
        chunks.push(chunk);
        return harden({ done: false, value: undefined });
      },
      async return(_value) {
        await bucket.put(path, concatChunks(chunks));
        return harden({ done: true, value: undefined });
      },
      async throw(_error) {
        return harden({ done: true, value: undefined });
      },
      [Symbol.asyncIterator]() {
        return writer;
      },
    });
    return writer;
  };

  /** @param {string} path */
  const listImmediate = async path => {
    const prefix = `${path}/`;
    const { objects, delimitedPrefixes } = await bucket.list({
      prefix,
      delimiter: '/',
    });
    const names = new Set();
    for (const { key } of objects) {
      names.add(key.slice(prefix.length));
    }
    for (const delimited of delimitedPrefixes) {
      names.add(delimited.slice(prefix.length).replace(/\/$/, ''));
    }
    names.delete('');
    return harden([...names]);
  };

  /** @param {string} path */
  const readDirectory = async path => listImmediate(path);

  /** @param {string} _path */
  const makePath = async _path => {
    // Directories are implicit prefixes in the key space.
  };

  /** @param {...string} components */
  const joinPath = (...components) => components.join('/');

  /** @param {string} path */
  const removePath = async path => {
    // Force semantics, like fs.rm { force: true }: removing a missing
    // object is not an error.
    await bucket.delete(path);
  };

  /** @param {string} path */
  const removeDirectory = async path => {
    const prefix = `${path}/`;
    const { objects } = await bucket.list({ prefix });
    for (const { key } of objects) {
      // eslint-disable-next-line no-await-in-loop
      await bucket.delete(key);
    }
  };

  /**
   * @param {string} source
   * @param {string} target
   */
  const renamePath = async (source, target) => {
    const bytes = await maybeReadFile(source);
    if (bytes === undefined) {
      throw Error(`ENOENT: no such object, rename ${q(source)}`);
    }
    await bucket.put(target, bytes);
    await bucket.delete(source);
  };

  /** @param {string} path */
  const realPath = async path => path;

  /** @param {string} path */
  const pathIdentity = async path => path;

  /** @param {string} path */
  const statPath = async path => {
    const head = await bucket.head(path);
    if (head === null) {
      throw Error(`ENOENT: no such object, stat ${q(path)}`);
    }
    return harden({
      kind: /** @type {const} */ ('file'),
      size: BigInt(head.size),
      // R2 tracks upload time, not filesystem times; the daemon's
      // content store consumes only `size`.
      mtime: 0n,
      atime: 0n,
    });
  };

  /** @param {string} path */
  const isDirectory = async path => {
    const { objects, delimitedPrefixes } = await bucket.list({
      prefix: `${path}/`,
      limit: 1,
    });
    return objects.length > 0 || delimitedPrefixes.length > 0;
  };

  /** @param {string} path */
  const exists = async path => {
    const head = await bucket.head(path);
    if (head !== null) {
      return true;
    }
    return isDirectory(path);
  };

  /** @param {string} path */
  const sha256 = async path => {
    if (makeSha256 === undefined) {
      throw Error(
        'R2 file powers were constructed without a makeSha256 digester',
      );
    }
    const digester = makeSha256();
    for await (const chunk of makeFileReader(path)) {
      digester.update(chunk);
    }
    return digester.digestHex();
  };

  /** @param {string} _path */
  const readLink = async _path => undefined;

  /**
   * Object stores emit no change events at this seam; per the
   * FilePowers contract, where watching is unavailable the events
   * stream terminates immediately rather than hanging.
   *
   * @param {string} _path
   */
  const watchDirectory = _path => {
    /** @returns {AsyncGenerator<never, undefined, undefined>} */
    // eslint-disable-next-line require-yield
    async function* noEvents() {
      return undefined;
    }
    return harden({
      events: noEvents(),
      cancel: () => {},
    });
  };

  return harden({
    makeFileReader,
    makeFileWriter,
    writeFileText,
    appendFileText,
    readFileText,
    readFileBytes,
    readFile: readFileBytes,
    readFileRange,
    sha256,
    maybeReadFile,
    maybeReadFileText,
    readDirectory,
    makePath,
    joinPath,
    removePath,
    removeDirectory,
    renamePath,
    realPath,
    readLink,
    pathIdentity,
    statPath,
    isDirectory,
    exists,
    watchDirectory,
  });
};

/**
 * The daemon requires a synchronous incremental SHA-256 digester and
 * synchronous Ed25519 signing (see CryptoPowers), which WebCrypto's
 * one-shot async subtle API cannot provide, so those are injected: a
 * Workers deployment passes `@noble/hashes` and `@noble/curves`
 * implementations, while node-side tests pass the node crypto
 * implementations from daemon-node-powers.js. Randomness comes from
 * the host WebCrypto getRandomValues, present on Workers and modern
 * node alike.
 *
 * @param {object} args
 * @param {() => Sha256} args.makeSha256
 * @param {() => Promise<Ed25519Keypair>} args.generateEd25519Keypair
 * @param {(privateKey: Uint8Array, message: Uint8Array) => Uint8Array} args.ed25519Sign
 * @returns {CryptoPowers}
 */
export const makeCloudflareCryptoPowers = ({
  makeSha256,
  generateEd25519Keypair,
  ed25519Sign,
}) => {
  const randomHex256 = async () => {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    return toHex(bytes);
  };
  return harden({
    makeSha256,
    randomHex256,
    generateEd25519Keypair,
    ed25519Sign,
  });
};

/**
 * Endo workers require an execution design (isolate-per-worker
 * Durable Objects or dynamically dispatched Workers), not a storage
 * design; see designs/endo-daemon-cloudflare-storage.md's runtime analysis.
 *
 * @returns {DaemonicControlPowers}
 */
export const makeStubControlPowers = () =>
  harden({
    makeWorker: async workerId => {
      throw Error(
        `Endo workers are not yet supported on the Cloudflare platform (worker ${q(
          workerId,
        )}); see @endo/daemon designs/endo-daemon-cloudflare-storage.md`,
      );
    },
  });

/**
 * Assembles the daemon's powers from injected Cloudflare bindings,
 * mirroring makeDaemonicPowers in daemon-node-powers.js and
 * daemon-go-powers.js: the Durable Object's SQLite storage backs
 * daemon-database.js through the better-sqlite3-do.js shim, an R2
 * bucket backs the shared content store through makeR2FilePowers, and
 * pet stores and persistence powers are the daemon's own modules,
 * unchanged.
 *
 * @param {object} args
 * @param {Config} args.config
 * @param {DurableObjectSqlStorage} args.storage - The Durable
 * Object's storage handle (SQLite-backed).
 * @param {R2Bucket} args.bucket - The R2 bucket binding for the
 * content store.
 * @param {CryptoPowers} args.cryptoPowers
 * @param {Promise<never>} args.cancelled
 * @param {DaemonicControlPowers} [args.controlPowers]
 * @returns {Promise<DaemonicPowers>}
 */
export const makeCloudflareDaemonicPowers = async ({
  config,
  storage,
  bucket,
  cryptoPowers,
  cancelled,
  controlPowers = makeStubControlPowers(),
}) => {
  const Database = makeDatabaseConstructor(storage);
  const daemonDb = makeDaemonDatabase(config, { Database });
  cancelled.catch(() => daemonDb.close());

  const filePowers = makeR2FilePowers(bucket, {
    makeSha256: cryptoPowers.makeSha256,
  });
  const petStorePowers = makePetStoreMaker(daemonDb);
  const daemonicPersistencePowers = makeDaemonicPersistencePowers(
    daemonDb,
    filePowers,
    cryptoPowers,
    config,
  );

  return harden({
    crypto: cryptoPowers,
    petStore: petStorePowers,
    persistence: daemonicPersistencePowers,
    control: controlPowers,
    filePowers,
  });
};
