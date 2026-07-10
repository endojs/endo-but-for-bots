// @ts-check
/* global Buffer, process, setTimeout */

import { createHash } from 'node:crypto';
import { lstat, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import harden from '@endo/harden';
import { encodeHex } from '@endo/hex';
import { encodeUtf8 } from '@endo/utf8/encode.js';
import { makeError, q, X } from '@endo/errors';
import { makePromiseKit } from '@endo/promise-kit';
import { makePipe } from '@endo/stream';
import { makeNodeReader, makeNodeWriter } from '@endo/stream-node';
import { makeWatchDirectory } from '@endo/platform/fs/node/watch-directory';
import { makeNetstringCapTP } from './connection.js';
import { makePetStoreMaker } from './pet-store.js';
import { servePrivatePath } from './serve-private-path.js';
import {
  claimSocketLock,
  releaseSocketLock,
  socketLockPath,
} from './socket-lock.js';
import { makeSerialJobs } from './serial-jobs.js';
import { makeDaemonDatabase } from './manager-database-node.js';
import { makeRegistryNodePowers } from './registry-node-powers.js';
import { makeNodeHostToolPowers } from './host-tool-powers-node.js';
// The shared SQLite-backed persistence powers live in
// ./manager-persistence-powers.js so the XS-on-Rust supervisor can
// use them without importing the Node-only graph above.
import { makeDaemonicPersistencePowers } from './manager-persistence-powers.js';

export { makeDaemonicPersistencePowers };

const gunzipBuffer = promisify(zlib.gunzip);

/**
 * Resolve to `undefined` when the operation fails with ENOENT.
 *
 * @template T
 * @param {Promise<T>} operation
 * @returns {Promise<T | undefined>}
 */
const orAbsent = operation =>
  operation.catch(error => {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });

/**
 * @param {typeof import('net')} net
 * @param {string} path
 * @returns {Promise<'live' | 'stale' | 'absent' | 'unknown'>}
 */
const probeSocket = (net, path) =>
  new Promise(resolve => {
    const conn = net.createConnection({ path });
    /** @param {'live' | 'stale' | 'absent' | 'unknown'} status */
    const finish = status => {
      conn.destroy();
      resolve(status);
    };
    conn.once('connect', () => finish('live'));
    conn.once('error', error => {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (code === 'ECONNREFUSED') {
        finish('stale');
      } else if (code === 'ENOENT') {
        finish('absent');
      } else {
        finish('unknown');
      }
    });
    conn.setTimeout(100, () => finish('unknown'));
  });

/**
 * Make a Unix socket pathname available to bind, removing a socket left by a
 * dead owner. Removal needs both a refused connection and the same inode as
 * before the probe, leaving live sockets and racing replacements alone.
 *
 * @param {typeof import('net')} net
 * @param {string} path
 * @returns {Promise<boolean>} whether the pathname is free to bind
 */
const reclaimSocketPath = async (net, path) => {
  const before = await orAbsent(lstat(path));
  if (before === undefined) {
    return true;
  }
  if (!before.isSocket()) {
    return false;
  }

  const status = await probeSocket(net, path);
  if (status === 'absent') {
    return true;
  }
  if (status !== 'stale') {
    return false;
  }

  const after = await orAbsent(lstat(path));
  if (after === undefined) {
    // Someone else removed it between the probe and now.
    return true;
  }
  if (after.dev !== before.dev || after.ino !== before.ino) {
    // A different socket has taken the pathname since the probe.
    return false;
  }

  await rm(path, { force: true });
  return true;
};

/**
 * How long a closing server waits for its accepted connections to end before
 * hanging up on them.
 */
const serverCloseGraceMs = 1000;

/** @param {Uint8Array} bytes */
export const gunzip = async bytes => {
  const output = await gunzipBuffer(bytes);
  return new Uint8Array(output.buffer, output.byteOffset, output.byteLength);
};

/** @import { Reader, Writer } from '@endo/stream' */
/** @import { ERef, FarRef } from '@endo/eventual-send' */
/** @import { CapTpConnectionRegistrar, Config, CryptoPowers, DaemonWorkerFacet, DaemonicPersistencePowers, DaemonicPowers, EndoReadable, FilePowers, Formula, FormulaNumber, NetworkPowers, SocketPowers, WorkerDaemonFacet } from './types.js' */
/** @import { DaemonDatabase } from './manager-database.js' */
/** @import { WatchDirectory } from '@endo/platform/fs/node/watch-directory' */

/**
 * @param {object} modules
 * @param {typeof import('net')} modules.net
 * @param {Pick<typeof import('fs/promises'), 'access'>} modules.fsp
 * @returns {SocketPowers}
 */
export const makeSocketPowers = ({ net, fsp: { access } }) => {
  /**
   * @template {number | void} TPort
   * @param {(server: import('net').Server, erred: Promise<never>) => Promise<TPort>} listen
   * receives `erred`, which rejects on a server error, so that it can abandon
   * a bind that will never call back.
   * @param {Promise<never>} cancelled
   * @param {() => Promise<void>} [afterClose] runs once the server is closed,
   * whether it closed because listening failed or because it was cancelled.
   */
  const serveListener = async (listen, cancelled, afterClose = undefined) => {
    const [
      /** @type {Reader<Connection>} */ readFrom,
      /** @type {Writer<Connection} */ writeTo,
    ] = makePipe();

    const server = net.createServer();
    const { promise: erred, reject: err } =
      /** @type {import('@endo/promise-kit').PromiseKit<never>} */ (
        makePromiseKit()
      );
    server.on('error', error => {
      err(error);
      void writeTo.throw(error);
    });

    /** @type {Set<import('net').Socket>} */
    const accepted = new Set();
    server.on('connection', conn => {
      accepted.add(conn);
      conn.on('close', () => accepted.delete(conn));
    });

    // Racing `erred` makes a failed bind settle `bound`, which closing waits
    // for. Leaving that to each `listen` would hang the close whenever one
    // forgot.
    const bound = Promise.race([listen(server, erred), erred]);
    void bound.catch(() => {});

    let closeP;
    const closeServer = () => {
      closeP ??= (async () => {
        // A bind that lands after we decide to close would outlive this call.
        await bound.catch(() => {});
        if (server.listening) {
          // `close` releases the pathname at once but calls back only once
          // every accepted connection has ended, which a peer that never
          // hangs up can defer forever, so nothing awaits it.
          server.close();
          const graceTimer = setTimeout(() => {
            for (const conn of accepted) {
              conn.destroy();
            }
          }, serverCloseGraceMs);
          graceTimer.unref?.();
        }
        await afterClose?.();
      })();
      return closeP;
    };

    // Close before reporting, so the pathname is gone by the time the consumer
    // learns of the cancellation.
    void cancelled.catch(async error => {
      await closeServer().catch(() => {});
      void writeTo.throw(error);
    });

    try {
      await Promise.race([erred, cancelled, bound]);
    } catch (error) {
      // The server may have bound before failing.
      await closeServer().catch(() => {});
      // Nobody will read the connections stream, so own its rejection.
      void readFrom.next().catch(() => {});
      throw error;
    }

    server.on('connection', conn => {
      const reader = makeNodeReader(conn);
      const writer = makeNodeWriter(conn);
      const closed = new Promise(resolve => conn.on('close', resolve));
      // TODO Respect back-pressure signal and avoid accepting new connections.
      void writeTo.next({ reader, writer, closed });
    });

    const port = await bound;

    return harden({
      port,
      connections: readFrom,
    });
  };

  /** @type {SocketPowers['servePort']} */
  const servePort = async ({ port, host = '0.0.0.0', cancelled }) =>
    serveListener(
      server =>
        new Promise((resolve, reject) =>
          server.listen(port, host, () => {
            const address = server.address();
            if (address === null || typeof address === 'string') {
              reject(
                makeError(
                  X`Expected listener to be assigned a port on ${q(host)}`,
                ),
              );
              return;
            }
            resolve(address.port);
          }),
        ),
      cancelled,
    );

  /** @type {SocketPowers['connectPort']} */
  const connectPort = ({ port, host, cancelled }) =>
    new Promise((resolve, reject) => {
      const conn = net.connect(port, host);
      conn.on('connect', () => {
        const reader = makeNodeReader(conn);
        const writer = makeNodeWriter(conn);
        const closed = new Promise(close => conn.on('close', close));
        resolve({
          reader,
          writer,
          closed,
        });
      });
      conn.on('error', reject);
      cancelled.catch(error => {
        conn.destroy();
        reject(error);
      });
    });

  /**
   * @param {import('net').Server} server
   * @param {string} path
   * @param {Promise<never>} erred
   */
  const listenOnPath = (server, path, erred) =>
    Promise.race([
      new Promise(resolve => server.listen({ path }, () => resolve(undefined))),
      erred,
    ]);

  /** @param {import('ses').Details} details */
  const addressInUse = details =>
    makeError(details, undefined, { code: 'EADDRINUSE' });

  /** @type {SocketPowers['servePath']} */
  const servePath = async ({ path, cancelled }) => {
    // Windows named pipes leave no filesystem pathname behind, so neither the
    // lock nor the stale-pathname recovery applies there.
    const guarded = process.platform !== 'win32';
    const lockPath = socketLockPath(path);
    // `serveListener` runs this once the server closes, whether listening
    // failed or the service was cancelled, so it is the lock's only release.
    const releaseLock = guarded ? () => releaseSocketLock(lockPath) : undefined;
    const socketIsLive = async () => (await probeSocket(net, path)) === 'live';

    const { connections } = await serveListener(
      async (server, erred) => {
        await null;
        if (guarded) {
          if (!(await claimSocketLock(lockPath, socketIsLive))) {
            throw addressInUse(
              X`Socket path ${q(path)} is held by another live Endo daemon`,
            );
          }
          // Holding the lock means no other Endo daemon is binding this
          // pathname, so anything still here was left by a dead one and can
          // be reclaimed before binding rather than after a failed bind.
          if (!(await reclaimSocketPath(net, path))) {
            throw addressInUse(
              X`Socket path ${q(path)} is occupied and cannot be reclaimed`,
            );
          }
        }
        await listenOnPath(server, path, erred);

        // In some environments, an overly-long Unix domain socket path
        // (`sockaddr_un` `sun_path`) is silently truncated. This exposes the
        // problem, but we may still leak the incorrectly-named file and
        // thereby cause EADDRINUSE errors for future attempts to start.
        const error = await access(path).catch(err => err);
        if (error) {
          if (path.length >= 104) {
            console.warn(
              `Warning: Length of path for domain socket or named path exceeeds common maximum (104, possibly 108) for some platforms (length: ${path.length}, path: ${path})`,
            );
          }
          throw error;
        }
        return undefined;
      },
      cancelled,
      releaseLock,
    );
    return connections;
  };

  return { servePort, servePath, connectPort };
};

/**
 * @param {object} modules
 * @param {typeof import('net')} modules.net
 * @param {Pick<typeof import('fs/promises'), 'access'>} modules.fsp
 * @returns {NetworkPowers}
 */
export const makeNetworkPowers = ({ net, fsp }) => {
  const { servePort, servePath, connectPort } = makeSocketPowers({ net, fsp });

  const connectionNumbers = (function* generateNumbers() {
    let n = 0;
    for (;;) {
      yield n;
      n += 1;
    }
  })();

  /**
   * @param {FarRef<unknown>} endoBootstrap
   * @param {string} sockPath
   * @param {Promise<never>} cancelled
   * @param {(error: Error) => void} exitWithError
   * @param {CapTpConnectionRegistrar} [capTpConnectionRegistrar]
   * @param {(err: Error, errorId?: string) => void} [marshalSaveError]
   * @returns {{ started: Promise<void>, stopped: Promise<void> }}
   */
  const makePrivatePathService = (
    endoBootstrap,
    sockPath,
    cancelled,
    exitWithError,
    capTpConnectionRegistrar = undefined,
    marshalSaveError = undefined,
  ) => {
    const privatePathService = servePrivatePath(sockPath, endoBootstrap, {
      servePath,
      connectionNumbers,
      cancelled,
      exitWithError,
      capTpConnectionRegistrar,
      marshalSaveError,
    });
    return privatePathService;
  };

  return harden({
    servePort,
    servePath,
    connectPort,
    makePrivatePathService,
  });
};

export const makeFilePowers = ({ fs, path: fspath }) => {
  const writeJobs = makeSerialJobs();

  /**
   * @param {string} path
   */
  const makeFileReader = path => {
    const nodeReadStream = fs.createReadStream(path);
    return makeNodeReader(nodeReadStream);
  };

  /**
   * @param {string} path
   * @returns {Writer<Uint8Array>}
   */
  const makeFileWriter = path => {
    const nodeWriteStream = fs.createWriteStream(path);
    return makeNodeWriter(nodeWriteStream);
  };

  /**
   * @param {string} path
   * @param {string} text
   */
  const writeFileText = async (path, text) => {
    await writeJobs.enqueue(async () => {
      await fs.promises.writeFile(path, text);
    });
  };

  /**
   * @param {string} path
   * @param {string} text
   */
  const appendFileText = async (path, text) => {
    await writeJobs.enqueue(async () => {
      await fs.promises.appendFile(path, text);
    });
  };

  /**
   * @param {string} path
   */
  const readFileText = async path => {
    return fs.promises.readFile(path, 'utf-8');
  };

  /**
   * @param {string} path
   * @returns {Promise<Uint8Array>}
   */
  const readFileBytes = async path => {
    const buf = await fs.promises.readFile(path);
    // Return as a plain Uint8Array (Buffer is a subclass) so the
    // shape is portable across XS / Node and easy to harden.
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  };

  /**
   * Binary-safe whole-file read.  Returns the file contents as a
   * `Uint8Array` (Node's `Buffer` is a `Uint8Array` subclass, so the
   * value is interoperable with both runtimes).
   *
   * @param {string} path
   * @returns {Promise<Uint8Array>}
   */
  const readFile = async path => fs.promises.readFile(path);

  /**
   * Binary-safe range read: returns the bytes in `[offset, offset +
   * length)`, reading only that window from disk rather than the whole
   * file. Returns fewer bytes when the window extends past EOF (and an
   * empty array when `offset` is already at or beyond EOF), mirroring
   * the in-memory `BlobRef.fetch` clamp semantics.
   *
   * @param {string} path
   * @param {number} offset
   * @param {number} length
   * @returns {Promise<Uint8Array>}
   */
  const readFileRange = async (path, offset, length) => {
    if (length <= 0) {
      return new Uint8Array(0);
    }
    const handle = await fs.promises.open(path, 'r');
    try {
      // Clamp the request to the bytes actually available before allocating,
      // so a huge `length` against a small file can't drive a multi-GB host
      // allocation (the buffer stays bounded by the file size).
      const { size } = await handle.stat();
      const clamped = Math.min(length, Math.max(0, size - offset));
      if (clamped <= 0) {
        return new Uint8Array(0);
      }
      const buffer = new Uint8Array(clamped);
      const { bytesRead } = await handle.read(buffer, 0, clamped, offset);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  };

  /**
   * Content hash of a file: the hex sha256 of its current bytes. The `hash`
   * half of a content-addressed `getInfo()` triple for a *live* file (recomputed
   * on each call, since the file may change).
   *
   * @param {string} path
   * @returns {Promise<string>}
   */
  const sha256 = async path =>
    encodeHex(
      createHash('sha256')
        .update(await readFile(path))
        .digest(),
    );

  /**
   * Binary-safe whole-file read that returns `undefined` when the
   * file does not exist (ENOENT) or the path is a directory (EISDIR).
   * Other I/O errors propagate.
   *
   * @param {string} path
   * @returns {Promise<Uint8Array | undefined>}
   */
  const maybeReadFile = async path =>
    readFile(path).catch(error => {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (code === 'ENOENT' || code === 'EISDIR') {
        return undefined;
      }
      throw error;
    });

  /**
   * @param {string} path
   */
  const maybeReadFileText = async path =>
    readFileText(path).catch(error => {
      if (
        error.message.startsWith('ENOENT: ') ||
        error.message.startsWith('EISDIR: ')
      ) {
        return undefined;
      }
      throw error;
    });

  /**
   * @param {string} path
   */
  const readDirectory = async path => {
    return fs.promises.readdir(path);
  };

  /**
   * @param {string} path
   */
  const makePath = async path => {
    await fs.promises.mkdir(path, { recursive: true });
  };

  /**
   * @param {string} path
   */
  const removePath = async path => {
    await writeJobs.enqueue(async () => {
      // Use force: true to make removal idempotent (no error if already removed)
      return fs.promises.rm(path, { force: true });
    });
  };

  /**
   * Recursively remove a directory and its contents.  Idempotent:
   * removing a missing directory is not an error.
   *
   * @param {string} path
   */
  const removeDirectory = async path => {
    await writeJobs.enqueue(async () => {
      return fs.promises.rm(path, { force: true, recursive: true });
    });
  };

  const renamePath = async (source, target) => {
    await writeJobs.enqueue(async () => {
      return fs.promises.rename(source, target);
    });
  };

  const joinPath = (...components) => fspath.join(...components);

  /** @param {string} path */
  const realPath = async path => fs.promises.realpath(path);

  /** @param {string} path */
  const isDirectory = async path => {
    try {
      const stat = await fs.promises.stat(path);
      return stat.isDirectory();
    } catch {
      return false;
    }
  };

  /** @param {string} path */
  const statPath = async path => {
    // `bigint: true` yields `size` / `mtimeNs` / `atimeNs` as bigint
    // nanoseconds, matching the extended `Stat` shape (size: bigint,
    // mtime/atime: bigint ns) — see designs/fs-interface-consolidation.md.
    const stat = await fs.promises.lstat(path, { bigint: true });
    const kind = /** @type {'directory' | 'file' | 'symlink'} */ (
      stat.isDirectory()
        ? 'directory'
        : stat.isSymbolicLink()
          ? 'symlink'
          : 'file'
    );
    return harden({
      kind,
      size: stat.size,
      mtime: stat.mtimeNs,
      atime: stat.atimeNs,
    });
  };

  /**
   * Stable filesystem identity for a path, used as a content-store
   * key.  Returns `<dev>:<ino>` from `stat()` (which follows symlinks
   * intentionally — two symlinks to the same regular file should
   * share an identity).
   *
   * Unix-targeted: `dev`/`ino` are the POSIX device and inode pair
   * and are stable for the lifetime of the underlying inode on
   * Linux/macOS.  On Windows, Node's `fs.Stats.ino` is derived from
   * the NTFS file index (a 64-bit identifier that may collide across
   * volumes and is not always stable across renames); Windows
   * portability would need a different identity scheme (e.g.
   * `GetFileInformationByHandleEx`'s `FILE_ID_INFO`).  The daemon is
   * Unix-only today; this comment is the bookmark for a future
   * Windows port.
   *
   * @param {string} path
   */
  const pathIdentity = async path => {
    const stat = await fs.promises.stat(path);
    return `${stat.dev}:${stat.ino}`;
  };

  /** @param {string} path */
  const exists = async path => {
    try {
      await fs.promises.access(path);
      return true;
    } catch {
      return false;
    }
  };

  /** @type {WatchDirectory} */
  const watchDirectory = makeWatchDirectory(fs);

  return harden({
    makeFileReader,
    makeFileWriter,
    writeFileText,
    appendFileText,
    readFileText,
    readFileBytes,
    readFile,
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
    pathIdentity,
    statPath,
    isDirectory,
    exists,
    watchDirectory,
  });
};

/**
 * @param {typeof import('crypto')} crypto
 * @returns {CryptoPowers}
 */
export const makeCryptoPowers = crypto => {
  const makeSha256 = () => {
    const digester = crypto.createHash('sha256');
    return harden({
      update: chunk => digester.update(chunk),
      updateText: chunk => digester.update(encodeUtf8(chunk)),
      digestHex: () => encodeHex(digester.digest()),
    });
  };

  const randomHex256 = () =>
    new Promise((resolve, reject) =>
      crypto.randomBytes(32, (err, bytes) => {
        if (err) {
          reject(err);
        } else {
          resolve(encodeHex(bytes));
        }
      }),
    );

  // PKCS8 DER prefix for wrapping a raw 32-byte Ed25519 private key seed.
  const ED25519_PKCS8_PREFIX = Buffer.from(
    '302e020100300506032b657004220420',
    'hex',
  );

  /**
   * Sign a message with a raw 32-byte Ed25519 private key.
   *
   * @param {Uint8Array} privateKey - 32-byte raw Ed25519 private key seed
   * @param {Uint8Array} message - message bytes to sign
   * @returns {Uint8Array} 64-byte Ed25519 signature
   */
  const ed25519Sign = (privateKey, message) => {
    const derKey = Buffer.concat([ED25519_PKCS8_PREFIX, privateKey]);
    const keyObject = crypto.createPrivateKey({
      key: derKey,
      format: 'der',
      type: 'pkcs8',
    });
    const sig = crypto.sign(null, message, keyObject);
    return new Uint8Array(sig);
  };

  const generateEd25519Keypair = () =>
    new Promise((resolve, reject) =>
      crypto.generateKeyPair(
        'ed25519',
        {},
        (err, publicKeyObject, privateKeyObject) => {
          if (err) {
            reject(err);
          } else {
            const publicDer = publicKeyObject.export({
              type: 'spki',
              format: 'der',
            });
            const privateDer = privateKeyObject.export({
              type: 'pkcs8',
              format: 'der',
            });
            // Extract raw 32-byte keys from DER encoding.
            // Ed25519 SPKI DER has a 12-byte prefix before the 32-byte key.
            // Ed25519 PKCS8 DER has a 16-byte prefix before the 32-byte seed.
            const rawPublicKey = publicDer.subarray(publicDer.length - 32);
            const rawPrivateKey = privateDer.subarray(privateDer.length - 32);
            const publicKey = new Uint8Array(rawPublicKey);
            const privateKey = new Uint8Array(rawPrivateKey);
            resolve(
              harden({
                publicKey,
                privateKey,
                sign: message => ed25519Sign(privateKey, message),
              }),
            );
          }
        },
      ),
    );

  return harden({
    makeSha256,
    randomHex256,
    generateEd25519Keypair,
    ed25519Sign,
  });
};

/**
 * @param {Config} config
 * @param {import('url').fileURLToPath} fileURLToPath
 * @param {FilePowers} filePowers
 * @param {typeof import('fs')} fs
 * @param {typeof import('child_process')} popen
 */
export const makeDaemonicControlPowers = (
  config,
  fileURLToPath,
  filePowers,
  fs,
  popen,
) => {
  const endoWorkerPath =
    process.env.ENDO_WORKER_SUBPROCESS_PATH ||
    fileURLToPath(new URL('worker-node.js', import.meta.url));

  const endoWorkerWithShimsPath = fileURLToPath(
    new URL('worker-node-with-shims.js', import.meta.url),
  );

  /**
   * @param {string} workerId
   * @param {DaemonWorkerFacet} daemonWorkerFacet
   * @param {Promise<never>} cancelled - rejects to initiate shutdown (SIGTERM)
   * @param {Promise<never>} forceCancelled - rejects to force shutdown (SIGKILL)
   * @param {CapTpConnectionRegistrar} [capTpConnectionRegistrar]
   * @param {string[]} [trustedShims]
   * @param {string} [label]
   * @param {'locked' | 'node'} [kind]
   *   Worker kind. Currently unused by the Node powers implementation,
   *   but accepted to keep the positional arity aligned with the type
   *   in `types.d.ts` so `marshalLoadError` lands in the correct slot.
   * @param {(err: Error, errorId?: string) => void} [marshalLoadError]
   *   Forwarded to the worker connection's CapTP. Called for every error
   *   the daemon decodes from this worker, with the wire-level errorId
   *   so the daemon's trace aggregator can correlate inbound errors with
   *   the worker's prior trace push.
   */
  const makeWorker = async (
    workerId,
    daemonWorkerFacet,
    cancelled,
    forceCancelled,
    capTpConnectionRegistrar = undefined,
    trustedShims = undefined,
    label = '<untitled>',
    // eslint-disable-next-line no-unused-vars
    kind = undefined,
    marshalLoadError = undefined,
  ) => {
    const { statePath, ephemeralStatePath } = config;

    const workerStatePath = filePowers.joinPath(statePath, 'worker', workerId);
    const workerEphemeralStatePath = filePowers.joinPath(
      ephemeralStatePath,
      'worker',
      workerId,
    );

    await Promise.all([
      filePowers.makePath(workerStatePath),
      filePowers.makePath(workerEphemeralStatePath),
    ]);

    const logPath = filePowers.joinPath(workerStatePath, 'worker.log');
    const pidPath = filePowers.joinPath(workerEphemeralStatePath, 'worker.pid');

    const useShims = trustedShims && trustedShims.length > 0;
    const workerPath = useShims ? endoWorkerWithShimsPath : endoWorkerPath;
    const workerArgs = useShims ? [JSON.stringify(trustedShims)] : [];

    const log = fs.openSync(logPath, 'a');
    const child = popen.fork(workerPath, workerArgs, {
      stdio: ['ignore', log, log, 'pipe', 'pipe', 'ipc'],
      // @ts-ignore Stale Node.js type definition.
      windowsHide: true,
    });
    const workerPid = child.pid;
    const nodeWriter = /** @type {import('stream').Writable} */ (
      child.stdio[3]
    );
    const nodeReader = /** @type {import('stream').Readable} */ (
      child.stdio[4]
    );
    assert(nodeWriter);
    assert(nodeReader);
    const reader = makeNodeReader(nodeReader);
    const writer = makeNodeWriter(nodeWriter);

    const workerClosed = new Promise(resolve => {
      child.on('exit', () => {
        console.log(
          `Endo worker exited for PID ${workerPid} with unique identifier ${workerId}`,
        );
        resolve(undefined);
      });
    });

    await filePowers.writeFileText(pidPath, `${child.pid}\n`);

    const metaPath = filePowers.joinPath(workerStatePath, 'worker.meta.json');
    const meta = JSON.stringify({
      createdAt: new Date().toISOString(),
      label,
    });
    await filePowers.writeFileText(metaPath, `${meta}\n`);

    workerClosed.then(() => filePowers.removePath(pidPath).catch(() => {}));

    cancelled.catch(() => {
      child.kill();
    });

    forceCancelled.catch(() => {
      child.kill('SIGKILL');
    });

    console.log(
      `Endo worker started PID ${workerPid} unique identifier ${workerId}`,
    );

    const { getBootstrap, closed: capTpClosed } = makeNetstringCapTP(
      `Worker ${workerId}`,
      writer,
      reader,
      cancelled,
      daemonWorkerFacet,
      { marshalLoadError },
      capTpConnectionRegistrar,
    );

    capTpClosed.finally(() => {
      console.log(
        `Endo worker connection closed for PID ${workerPid} with unique identifier ${workerId}`,
      );
    });

    const workerTerminated = Promise.race([workerClosed, capTpClosed]);

    /** @type {ERef<WorkerDaemonFacet>} */
    const workerDaemonFacet = getBootstrap();

    return { workerTerminated, workerDaemonFacet };
  };

  return harden({
    makeWorker,
  });
};

/**
 * @param {object} opts
 * @param {Config} opts.config
 * @param {Promise<never>} opts.cancelled
 * @param {typeof import('fs')} opts.fs
 * @param {typeof import('child_process')} opts.popen
 * @param {typeof import('url')} opts.url
 * @param {FilePowers} opts.filePowers
 * @param {CryptoPowers} opts.cryptoPowers
 * @param {Parameters<typeof makeRegistryNodePowers>[0]} opts.registryPowers
 * @returns {Promise<DaemonicPowers>}
 */
export const makeDaemonicPowers = async ({
  config,
  cancelled,
  fs,
  popen,
  url,
  filePowers,
  cryptoPowers,
  registryPowers,
}) => {
  const { fileURLToPath } = url;

  // Ensure state directory exists before opening database.
  await filePowers.makePath(config.statePath);

  const daemonDb = makeDaemonDatabase(config);
  cancelled.catch(() => daemonDb.close());

  const petStorePowers = makePetStoreMaker(daemonDb);
  const daemonicPersistencePowers = makeDaemonicPersistencePowers(
    daemonDb,
    filePowers,
    cryptoPowers,
    config,
  );
  const daemonicControlPowers = makeDaemonicControlPowers(
    config,
    fileURLToPath,
    filePowers,
    fs,
    popen,
  );

  return harden({
    crypto: cryptoPowers,
    petStore: petStorePowers,
    persistence: daemonicPersistencePowers,
    control: daemonicControlPowers,
    filePowers,
    registry: makeRegistryNodePowers({
      ...registryPowers,
      registryUrl: config.registryUrl,
    }),
    hostTools: makeNodeHostToolPowers(),
  });
};
