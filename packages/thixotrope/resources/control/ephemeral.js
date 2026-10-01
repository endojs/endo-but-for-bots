// @ts-check
import { E } from '@endo/far';
import harden from '@endo/harden';

import * as crypto from 'node:crypto';
import { chmod, rm } from 'node:fs/promises';
import * as net from 'node:net';
import { stderr } from 'node:process';

import { makeAdapter } from '../../native-adapter.js';
import { makeLocalControl } from '../../src/control/local-control.js';
import { makeLogPowers } from '../../src/platform/logging.js';
import { makeRandomPowers } from '../../src/platform/random.js';
import { makeSocketPowers } from '../../src/platform/node/sockets.js';

/** @import { ControlSpec } from './durable.js' */

/**
 * The control socket's listener, in a disposable process of its own: it
 * accepts each client's OCapN session on the Unix socket and starts it from
 * a facet the host's administration makes for that connection, through the
 * same framing and session the client speaks, so a client's reference goes
 * client, this process, hub, host. The connection's facet ends with the
 * connection; if this process dies, its transient session is swept and the
 * facets it held become unreachable, and the manager rebuilds it.
 */
export const make = () => {
  // Only what listening takes, composed here rather than through the
  // host's composition root, which reaches builtins a bundle cannot carry.
  const sockets = makeSocketPowers({ net, chmod });
  const random = makeRandomPowers({
    randomBytes: length => new Uint8Array(crypto.randomBytes(length)),
  });
  const log = makeLogPowers({
    log: line => stderr.write(`${line}\n`),
    info: () => {},
    error: line => stderr.write(`${line}\n`),
  }).sub('thixotrope', 'control');
  return makeAdapter({
    label: 'Control socket',
    /**
     * @param {ControlSpec} existing
     * @param {ControlSpec} wanted
     */
    same: (existing, wanted) =>
      existing.path === wanted.path && existing.admin === wanted.admin,
    replaces: () => true,
    /**
     * @param {unknown} path
     * @param {ControlSpec} spec
     */
    bind: async (path, spec) => {
      if (typeof path !== 'string') throw Error('Expected a socket path');
      /** @type {Set<import('../../src/platform/sockets.js').SocketConnection>} */
      const connections = new Set();
      const listen = () =>
        sockets.listenPath({
          path,
          mode: 0o600,
          onConnection: connection => {
            connections.add(connection);
            void connection.closed.then(() => connections.delete(connection));
            void (async () => {
              const facet = await E(spec.admin).connect();
              try {
                const session = await makeLocalControl(
                  { sockets, random },
                  connection,
                  'worker',
                  facet,
                );
                await session.closed;
              } finally {
                await E(facet)
                  .close()
                  .catch(() => {});
              }
            })().catch((/** @type {Error} */ error) => {
              void connection.writer.throw(error).catch(() => {});
            });
          },
          onError: error => log.error('control listener failed:', error),
        });
      /** @type {Awaited<ReturnType<typeof listen>>} */
      let listener;
      try {
        listener = await listen();
      } catch (error) {
        // A socket file is there: a live listener's, the host's own or an
        // earlier incarnation's, which is not this one's to take, or a dead
        // supervisor's, which the lease holder's adapter reclaims.
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EADDRINUSE')
          throw error;
        if (await sockets.probePath(path))
          throw Error(`Another listener serves ${path}`);
        await rm(path, { force: true });
        listener = await listen();
      }
      return harden({
        close: async () => {
          listener.close();
          for (const connection of connections)
            void connection.writer.return(undefined).catch(() => {});
          await listener.closed;
        },
      });
    },
    /** @param {{ close: () => Promise<void> }} listener */
    unbind: listener => listener.close(),
  });
};
harden(make);
