// @ts-check
/* global process */

/**
 * The slice-facing half of a single-endpoint projection.
 *
 * This module runs as its own process, inside the network namespace the slice
 * will share and *outside* the slice's own confinement. It binds one TCP
 * listener on the namespace's loopback, dials the daemon-side Unix socket once
 * per accepted connection, and copies bytes in both directions. Then it spawns
 * the slice and lives exactly as long as it does.
 *
 * Three properties follow from that placement, and they are the whole point:
 *
 *   - The slice reaches a real TCP endpoint. Native `git` and package managers
 *     will not dial a Unix socket, so a socket alone does not satisfy the
 *     contract; the namespace-local TCP listener is what they see.
 *   - The slice reaches nothing else. The namespace is fresh, so the only
 *     listener in it is this one; there is no route out and no host loopback
 *     to reach.
 *   - The slice cannot reach *this* process. It runs under its own PID and
 *     mount namespaces, so the forwarder is neither visible nor signallable
 *     from inside, and the daemon-side socket is not bound into the slice's
 *     filesystem.
 *
 * The only authority this process holds beyond the namespace is the one Unix
 * socket pathname it was given. It runs as a plain Node program, without
 * lockdown: it is a byte pump, not a vat.
 */

import harden from '@endo/harden';

import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { pathToFileURL } from 'node:url';

/** Exit status for a projection that could not be established. */
export const PROJECTION_SETUP_FAILURE = 78;
harden(PROJECTION_SETUP_FAILURE);

/**
 * Pump one accepted slice connection against one freshly dialed daemon-side
 * connection. Either side ending or failing destroys the other, so a revoked
 * projection (the daemon closed its listener) shows up inside the slice as a
 * refused or reset connection rather than as a hang.
 *
 * @param {import('node:net').Socket} inbound
 * @param {string} socketPath
 */
const bridgeConnection = (inbound, socketPath) => {
  const upstream = connect(socketPath);
  const teardown = () => {
    inbound.destroy();
    upstream.destroy();
  };
  upstream.on('error', teardown);
  inbound.on('error', teardown);
  upstream.on('close', () => inbound.destroy());
  inbound.on('close', () => upstream.destroy());
  inbound.pipe(upstream);
  upstream.pipe(inbound);
};

/**
 * @param {object} options
 * @param {string} options.socketPath
 * @param {string} options.host
 * @param {number} options.port
 * @returns {Promise<{ close: () => void, connections: () => Set<import('node:net').Socket> }>}
 */
export const listenForProjection = async ({ socketPath, host, port }) => {
  await null;
  /** @type {Set<import('node:net').Socket>} */
  const live = new Set();
  const server = createServer(conn => {
    live.add(conn);
    conn.on('close', () => live.delete(conn));
    bridgeConnection(conn, socketPath);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(undefined));
  });
  return {
    close: () => {
      server.close();
      for (const conn of live) {
        conn.destroy();
      }
      live.clear();
    },
    connections: () => live,
  };
};
harden(listenForProjection);

/**
 * @param {string[]} argv
 * @returns {{ socketPath: string, host: string, port: number, command: string[] }}
 */
export const parseForwarderArgv = argv => {
  let socketPath;
  let host = '127.0.0.1';
  let port;
  /** @type {string[]} */
  let command = [];
  let index = 0;
  while (index < argv.length) {
    const flag = argv[index];
    if (flag === '--') {
      command = argv.slice(index + 1);
      break;
    }
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`forward-endpoint: ${flag} requires a value`);
    }
    if (flag === '--socket') {
      socketPath = value;
    } else if (flag === '--host') {
      host = value;
    } else if (flag === '--port') {
      port = Number(value);
    } else {
      throw new Error(`forward-endpoint: unknown flag ${flag}`);
    }
    index += 2;
  }
  if (socketPath === undefined) {
    throw new Error('forward-endpoint: --socket is required');
  }
  if (port === undefined || !Number.isInteger(port) || port <= 0) {
    throw new Error('forward-endpoint: --port must be a positive integer');
  }
  if (command.length === 0) {
    throw new Error('forward-endpoint: a command must follow --');
  }
  return harden({ socketPath, host, port, command });
};
harden(parseForwarderArgv);

/**
 * Establish the projection, then run the slice under it.
 *
 * The listener is bound before the slice is spawned, and a bind failure exits
 * without spawning anything: a slice must never come up believing it has an
 * endpoint that is not there.
 *
 * @param {string[]} argv
 * @returns {Promise<number>} the exit status to leave with
 */
export const runForwarder = async argv => {
  await null;
  const { socketPath, host, port, command } = parseForwarderArgv(argv);

  let projection;
  try {
    projection = await listenForProjection({ socketPath, host, port });
  } catch (error) {
    console.error(
      `forward-endpoint: could not bind ${host}:${port}: ${/** @type {Error} */ (error).message}`,
    );
    return PROJECTION_SETUP_FAILURE;
  }

  const [program, ...args] = command;
  const child = spawn(program, args, { stdio: 'inherit' });

  return new Promise(resolve => {
    child.once('error', error => {
      console.error(
        `forward-endpoint: could not spawn ${program}: ${/** @type {Error} */ (error).message}`,
      );
      projection.close();
      resolve(PROJECTION_SETUP_FAILURE);
    });
    child.once('exit', (code, signal) => {
      projection.close();
      // A signalled child has no exit code; report the conventional
      // 128 + signal number so the supervisor sees a nonzero status.
      resolve(code ?? (signal === null ? 1 : 128));
    });
  });
};
harden(runForwarder);

// Start a forwarder only when this module *is* the program, so importing it
// for a unit test does not bind a listener.
if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  runForwarder(process.argv.slice(2)).then(
    status => {
      process.exitCode = status;
    },
    error => {
      console.error(`forward-endpoint: ${error.message}`);
      process.exitCode = PROJECTION_SETUP_FAILURE;
    },
  );
}
