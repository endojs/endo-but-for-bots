// @ts-check
/* global process, setTimeout */

/**
 * The listener half of the daemon's private-path service.
 *
 * `serve-private-path.js` keeps the CapTP wiring; everything a listener needs
 * in order to exist — binding, an awaited close, recovery of a pathname left
 * by a dead owner, and an ownership-safe unlink — lives here, so a second
 * consumer can have the same lifecycle without also inheriting a CapTP
 * session. The sandbox endpoint projection is that second consumer: it serves
 * one Unix socket per projection and needs exactly this create/close/reclaim
 * discipline, and nothing above it.
 */

import harden from '@endo/harden';
import { makeError, q, X } from '@endo/errors';
import { makePromiseKit } from '@endo/promise-kit';
import { makePipe } from '@endo/stream';
import { makeNodeReader, makeNodeWriter } from '@endo/stream-node';
import { lstat, rm } from 'node:fs/promises';

import {
  claimSocketLock,
  releaseSocketLock,
  socketLockPath,
} from './socket-lock.js';

/** @import { Reader, Writer } from '@endo/stream' */

/**
 * How long a closing server waits for its accepted connections to end before
 * hanging up on them.
 */
export const SERVER_CLOSE_GRACE_MS = 1000;
harden(SERVER_CLOSE_GRACE_MS);

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
export const probeSocket = (net, path) =>
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
harden(probeSocket);

/**
 * Make a Unix socket pathname available to bind, removing a socket left by a
 * dead owner. Removal needs both a refused connection and the same inode as
 * before the probe, leaving live sockets and racing replacements alone.
 *
 * @param {typeof import('net')} net
 * @param {string} path
 * @returns {Promise<boolean>} whether the pathname is free to bind
 */
export const reclaimSocketPath = async (net, path) => {
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
harden(reclaimSocketPath);

/** @param {import('ses').Details} details */
export const addressInUse = details =>
  makeError(details, undefined, { code: 'EADDRINUSE' });
harden(addressInUse);

/**
 * Serve a listener whose bind, close, and cancellation are sequenced against
 * one another, and expose its accepted connections as a stream of
 * reader/writer pairs.
 *
 * @param {object} args
 * @param {typeof import('net')} args.net
 * @param {<TPort extends number | void>(server: import('net').Server, erred: Promise<never>) => Promise<TPort>} args.listen
 *   receives `erred`, which rejects on a server error, so that it can abandon
 *   a bind that will never call back.
 * @param {Promise<never>} args.cancelled
 * @param {() => Promise<void>} [args.afterClose] runs once the server is
 *   closed, whether it closed because listening failed or because it was
 *   cancelled or closed on request.
 */
export const serveSocketListener = async ({
  net,
  listen,
  cancelled,
  afterClose = undefined,
}) => {
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

  /** @type {Promise<void> | undefined} */
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
        }, SERVER_CLOSE_GRACE_MS);
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
    /**
     * Release the pathname (or port) and hang up on stragglers after the
     * grace period. Idempotent, and settles only once the close has run, so a
     * caller that revokes reachability can await the absence of the listener
     * rather than assume it.
     */
    close: () => closeServer(),
  });
};
harden(serveSocketListener);

/**
 * Bind `server` to a Unix socket pathname, first taking the pathname's marker
 * lock and reclaiming a socket left behind by a dead owner. Returns the
 * lock's release, which the caller must hand to `serveSocketListener` as
 * `afterClose` so the marker outlives neither the listener nor a failed bind.
 *
 * On a platform without filesystem pathnames for sockets (Windows named
 * pipes) neither the lock nor the recovery applies, and the release is
 * `undefined`.
 *
 * @param {object} args
 * @param {typeof import('net')} args.net
 * @param {Pick<typeof import('fs/promises'), 'access'>['access']} args.access
 * @param {string} args.path
 * @returns {{
 *   bind: (server: import('net').Server, erred: Promise<never>) => Promise<void>,
 *   release: (() => Promise<void>) | undefined,
 * }}
 */
export const makeSocketPathBinder = ({ net, access, path }) => {
  const guarded = process.platform !== 'win32';
  const lockPath = socketLockPath(path);
  const release = guarded ? () => releaseSocketLock(lockPath) : undefined;
  const socketIsLive = async () => (await probeSocket(net, path)) === 'live';

  /**
   * @param {import('net').Server} server
   * @param {Promise<never>} erred
   */
  const bind = async (server, erred) => {
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
    await Promise.race([
      new Promise(resolve => server.listen({ path }, () => resolve(undefined))),
      erred,
    ]);

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
  };

  return harden({ bind, release });
};
harden(makeSocketPathBinder);
