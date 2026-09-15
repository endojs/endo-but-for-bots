// @ts-check

import net from 'node:net';
import { chmod, unlink } from 'node:fs/promises';

import { makeError, X } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import { serveConnection } from './server.js';

const BridgeInterface = M.interface('FsBridge9p', {
  start: M.call().returns(M.promise()),
  stop: M.call().returns(M.promise()),
});

/**
 * Bridge an `@endo/platform/fs/extended` `Filesystem` capability to a 9P2000.L
 * UDS endpoint. Anyone speaking 9P over a Unix domain socket — QEMU
 * with `-chardev socket,server=off`, Linux v9fs with `mount -t 9p`,
 * `diod`, etc. — can connect and traverse the FS the cap projects.
 *
 * The bridge consumes the typed `Directory` / `File` surface of
 * endo-fs, which gives it pipelinable lookup chains (the kernel's
 * `Twalk` for an N-segment path dispatches as one batch of `lookup`
 * messages through CapTP's eventual-send queue) and stream-based
 * byte I/O via `@endo/exo-stream`'s `PassableBytesReader` /
 * `PassableBytesWriter`. Each node's `qid` is pipelined alongside
 * the `lookup` that produced its parent cap so the discovery
 * shares the walk's round-trip — `getQid()` is sync on the
 * responder but costs one RTT across CapTP if issued separately
 * (`@endo/platform/fs/extended/DESIGN.md` §4.10). `src/server.js` has the 9P
 * message → cap call mapping.
 *
 * Cancellation or stop fences input and closes the native listener immediately.
 * Completion additionally waits for admitted filesystem work and acquired handle
 * cleanup. Failed cleanup remains retained for a later stop retry.
 *
 * The caller exclusively owns this private, unique socket path and its ancestry
 * throughout the bridge lifetime. Successful stop is cached so an old owner
 * cannot unlink a successor. This bridge does not reconcile abandoned paths.
 *
 * @param {{
 *   fs: import('@endo/eventual-send').ERef<any>,
 *   socketPath: string,
 *   cancelled?: Promise<unknown>,
 *   uid?: number,
 *   gid?: number,
 * }} opts
 */
export const makeFsBridge9p = ({
  fs,
  socketPath,
  cancelled = new Promise(() => {}),
  uid = 1000,
  gid = 1000,
}) => {
  /** @type {import('node:net').Server | null} */
  let server = null;
  /** @type {Map<import('node:net').Socket, ReturnType<typeof serveConnection>>} */
  const connections = new Map();
  /** @type {Promise<void> | undefined} */
  let starting;
  /** @type {Promise<void> | undefined} */
  let listening;
  /** @type {Promise<void> | undefined} */
  let closingServer;
  /** @type {Promise<void> | undefined} */
  let stopping;
  let stopRequested = false;
  let socketOwned = false;

  const assertOpen = () => {
    if (stopRequested) throw makeError(X`9P bridge is stopped`);
  };

  const unlinkSocket = () =>
    unlink(socketPath).catch(error => {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
        throw error;
      }
    });

  const closeServer = () => {
    if (!server) return Promise.resolve();
    if (closingServer) return closingServer;
    const retainedServer = server;
    const attempt = (async () => {
      // A close before listen settles can otherwise miss a late bound handle.
      await listening?.catch(() => {});
      await new Promise((resolve, reject) => {
        retainedServer.close(error => {
          if (
            error &&
            /** @type {NodeJS.ErrnoException} */ (error).code !==
              'ERR_SERVER_NOT_RUNNING'
          ) {
            reject(error);
          } else {
            resolve(undefined);
          }
        });
      });
      server = null;
    })();
    closingServer = attempt;
    void attempt.catch(() => {
      if (closingServer === attempt) closingServer = undefined;
    });
    return attempt;
  };

  const stop = () => {
    // Fence before waiting for startup or cleanup. Connection callbacks that
    // arrive after this point cannot acquire filesystem authority.
    stopRequested = true;
    if (stopping) return stopping;
    const connectionAttempts = [...connections.values()].map(async control =>
      control.close(),
    );
    const serverAttempt = closeServer();
    const attempt = (async () => {
      const results = await Promise.allSettled([
        // Failed startup is not a cleanup failure; its retained effects are
        // handled independently by server/connection closure and path unlink.
        starting?.catch(() => {}),
        serverAttempt,
        ...connectionAttempts,
      ]);
      const failures = results
        .filter(result => result.status === 'rejected')
        .map(result => /** @type {PromiseRejectedResult} */ (result).reason);
      if (failures.length > 0) {
        throw new AggregateError(failures, '9P bridge cleanup failed');
      }
      if (socketOwned) {
        await unlinkSocket();
        socketOwned = false;
      }
    })();
    stopping = attempt;
    void attempt.catch(() => {
      // Observe background cancellation failure without discarding ownership.
      // An explicit stop retries only resources that have not been released.
      if (stopping === attempt) stopping = undefined;
    });
    return attempt;
  };

  const requestStop = () => {
    if (!stopRequested) void stop().catch(() => {});
  };
  void cancelled.then(requestStop, requestStop);

  const start = async () => {
    assertOpen();
    socketOwned = true;
    await unlinkSocket();
    assertOpen();
    const retainedServer = net.createServer(
      { allowHalfOpen: false },
      socket => {
        if (stopRequested) {
          socket.destroy();
          return;
        }
        const control = serveConnection({
          fs,
          socket,
          uid,
          gid,
          // Native socket closure alone is not proof that filesystem effects or
          // acquired handles have finished. Only successful drain releases this.
          onClose: () => connections.delete(socket),
        });
        connections.set(socket, control);
      },
    );
    server = retainedServer;
    // Runtime errors trigger retained cleanup instead of an unhandled native
    // error event. Startup errors also reject the original start call below.
    retainedServer.on('error', requestStop);
    listening = new Promise((resolve, reject) => {
      /** @param {Error} error */
      const onStartupError = error => reject(error);
      retainedServer.once('error', onStartupError);
      retainedServer.listen(socketPath, () => {
        retainedServer.removeListener('error', onStartupError);
        resolve(undefined);
      });
    });
    await listening;
    assertOpen();
    // Socket ancestry must be private: chmod follows bind, so it cannot close
    // the exposure window of a socket created in a shared directory.
    await chmod(socketPath, 0o600);
    assertOpen();
  };

  return makeExo('FsBridge9p', BridgeInterface, {
    start: () => {
      assertOpen();
      if (!starting) starting = start();
      return starting;
    },
    stop,
  });
};
harden(makeFsBridge9p);
