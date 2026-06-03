// @ts-nocheck
/* global process, setInterval, clearInterval */

/**
 * @file Node entry script for the Endo Gateway daemon.
 *
 * This file is the runnable analogue of `packages/daemon/src/daemon-node.js`
 * for the gateway. The CLI's `endo gateway start` / `endo gateway run`
 * subcommands spawn this script under `process.execPath`; a systemd
 * unit, launchd plist, or container ENTRYPOINT runs it directly.
 *
 * Today's responsibilities:
 *
 *   1. Establish the SES perimeter (`@endo/init`).
 *   2. Read the gateway paths from the environment variables the CLI
 *      (or the supervisor) populates.
 *   3. Write a pid file under `${ENDO_GATEWAY_RUNTIME_DIR}/gateway.pid`
 *      so the CLI's `endo gateway stop` knows what to signal.
 *   4. Construct a `makeGateway({ ... })` exo, `start()` it, and wait
 *      for `SIGTERM` / `SIGINT`. On signal, `stop()` the gateway, unlink
 *      the pid file, and exit.
 *
 * The HTTP listener that the design's Feature 1-8 require is not
 * wired yet (per `designs/gateway-package.md` § Status and
 * `packages/gateway/README.md` § Status: phase-9 lands the
 * `Familiar-bundled publisher` and the listener is a follow-on
 * phase). Today's `start()` is a no-op at the network layer; this
 * script's value is the lifecycle plumbing (paths, pid file, signal
 * handling, supervisor handshake) the listener will plug into.
 */

import '@endo/init';

import fs from 'fs';
import path from 'path';

import { makeGateway } from '../index.js';
import { makeNodeCryptoPowers } from './node-crypto-powers.js';

const env = process.env;

const requireEnv = name => {
  const value = env[name];
  if (typeof value !== 'string' || value === '') {
    throw Error(
      `Missing required env var ${name}; the gateway is supposed to be started via 'endo gateway start' or a systemd unit that sets the ENDO_GATEWAY_* vars`,
    );
  }
  return value;
};

const runtimeDir = requireEnv('ENDO_GATEWAY_RUNTIME_DIR');
const pidFile =
  env.ENDO_GATEWAY_PID_FILE || path.join(runtimeDir, 'gateway.pid');

await fs.promises.mkdir(runtimeDir, { recursive: true });
await fs.promises.writeFile(pidFile, `${process.pid}\n`);

const cleanupPidFile = () => {
  try {
    fs.unlinkSync(pidFile);
  } catch {
    // already gone
  }
};

// Construct the gateway exo with the Node-backed crypto and clock
// adapters so the bootstrap registrar's default feature toggles
// (sockBootstrap + ocapnWebSocket) can wire up. The phase-9 design
// status notes that the network listener itself lands in a follow-on
// phase; today's wiring exercises the path resolution, the pid file,
// the supervisor signaling, and the gateway exo's `start` / `stop`
// lifecycle ahead of that listener.
const crypto = makeNodeCryptoPowers();
const clock = harden({ now: () => Date.now() });

// Disable feature toggles whose backing powers are not yet wired
// up. The gateway's design names ten feature subsystems; the phase-9
// skeleton has the data-model implementations of most of them, but
// the embedder-supplied integration points (serveRepo for Feature 3,
// appsFormulaStore for Feature 2's daemon-backed mode,
// familiarPublish for Feature 5) require host-side wiring that the
// stand-alone `endo gateway` daemon does not have yet. Today's
// runnable shape exercises sockBootstrap, adminDaemon, and
// ocapnWebSocket; the others land via per-deployment configuration
// once the integration points exist. An operator who wants to flip a
// toggle on early sets `ENDO_GATEWAY_FEATURE_<NAME>=true` in the
// EnvironmentFile.
const enableFeatures = {
  gitHttp: env.ENDO_GATEWAY_FEATURE_GIT_HTTP === 'true',
  familiarBundled: env.ENDO_GATEWAY_FEATURE_FAMILIAR_BUNDLED === 'true',
  captpRelay: env.ENDO_GATEWAY_FEATURE_CAPTP_RELAY === 'true',
};

const gateway = makeGateway({
  powers: { env, crypto, clock },
  config: { enableFeatures },
});

const stopped = (async () => {
  try {
    await gateway.start();
    process.stderr.write(
      `endo-gateway: started (pid=${process.pid}, runtime=${runtimeDir})\n`,
    );
    // Notify systemd if we're running under Type=notify. The protocol
    // is simple: write `READY=1\n` to the socket whose path is in
    // NOTIFY_SOCKET. We avoid pulling in a dependency for the one
    // line of work.
    const notifySocket = env.NOTIFY_SOCKET;
    if (notifySocket !== undefined && notifySocket !== '') {
      try {
        const net = await import('net');
        const sock = net.createConnection(notifySocket);
        sock.on('error', () => {
          // Best-effort; do not crash the daemon over a notify failure.
        });
        await new Promise(resolve => sock.write('READY=1\n', resolve));
        sock.end();
      } catch {
        // Best-effort.
      }
    }
  } catch (e) {
    process.stderr.write(`endo-gateway: start failed: ${e.message}\n`);
    cleanupPidFile();
    process.exit(1);
  }

  // Keep the event loop alive while we wait for SIGTERM / SIGINT.
  // Once the network listener (a follow-on phase) is wired, the open
  // listener will hold the loop; until then, a refcounted interval
  // is the simplest portable way to wait for a signal without busy-
  // waiting. The interval is cleared on shutdown.
  await new Promise(resolve => {
    const keepalive = setInterval(() => {}, 60_000);
    const shutdown = signal => {
      process.stderr.write(`endo-gateway: received ${signal}; stopping\n`);
      clearInterval(keepalive);
      gateway
        .stop()
        .catch(err => {
          process.stderr.write(`endo-gateway: stop error: ${err.message}\n`);
        })
        .finally(() => {
          cleanupPidFile();
          resolve(undefined);
        });
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  });
})();

await stopped;
process.stderr.write('endo-gateway: stopped\n');
