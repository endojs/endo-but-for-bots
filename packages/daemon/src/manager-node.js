// @ts-check
/* eslint-disable no-await-in-loop */
/* global process, setInterval, clearInterval */

// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init';

import crypto from 'crypto';
import net from 'net';
import fs from 'fs';
import path from 'path';
import popen from 'child_process';
import url from 'url';

import { E } from '@endo/eventual-send';
import { makeCancelKit } from '@endo/cancel';
import { makeDaemon } from './manager.js';
import {
  makeFilePowers,
  makeNetworkPowers,
  makeDaemonicPowers,
  makeCryptoPowers,
  gunzip,
} from './manager-node-powers.js';
import { startWsGateway } from './ws-gateway.js';
import { runExtraSetups } from './extra-setups.js';

const fsp = { access: fs.promises.access };
/** @import { Config } from './types.js' */

const args = process.argv.slice(2);
if (args.length < 4) {
  throw new Error(
    `daemon.js requires arguments [sockPath] [statePath] [ephemeralStatePath] [cachePath], got ${process.argv.join(
      ', ',
    )}`,
  );
}

const [sockPath, statePath, ephemeralStatePath, cachePath] = args;

const gcEnabled = process.env.ENDO_GC === '1';

/** @type {Config} */
const config = {
  sockPath,
  statePath,
  ephemeralStatePath,
  cachePath,
  registryUrl: process.env.ENDO_REGISTRY_URL || 'https://registry.npmjs.org',
};

const { pid, kill } = process;

const { cancelled, cancel } = makeCancelKit();

// Orphan watchdog. The daemon is spawned detached and unref'd (see
// `runEndo` in ../index.js) so it deliberately outlives the short-lived
// `endo start` invocation — correct for a real daemon, but it means a
// daemon started by a test leaks as a background process whenever the test
// runner is killed (an ava timeout, a CI/host reaper's SIGKILL, an OOM)
// before its `afterEach`/`finally` teardown can run `endo stop`/`endo
// purge`. A harness opts in by setting ENDO_DAEMON_OWNER_PID to its own
// process id; we then poll that process and shut down gracefully — exactly
// as if SIGTERM'd — once it is gone, so no per-test daemon survives its
// owner even when no teardown hook runs. Left unset in production, this is
// inert.
const ownerPid = Number(process.env.ENDO_DAEMON_OWNER_PID);
if (Number.isInteger(ownerPid) && ownerPid > 0) {
  const ownerWatch = setInterval(() => {
    try {
      // Signal 0 only probes for the process's existence; it delivers no
      // signal. A throw means the owner is gone.
      kill(ownerPid, 0);
    } catch {
      clearInterval(ownerWatch);
      cancel(new Error(`Endo daemon owner process ${ownerPid} exited`));
    }
  }, 1000);
  // Never keep the daemon's event loop alive solely for the watchdog.
  ownerWatch.unref();
  cancelled.catch(() => clearInterval(ownerWatch));
}

const networkPowers = makeNetworkPowers({ net, fsp });
const filePowers = makeFilePowers({ fs, path });
const cryptoPowers = makeCryptoPowers(crypto);
const registryPowers = {
  fetch: globalThis.fetch,
  gunzip,
  createHash: crypto.createHash,
};

/**
 * @param {string} [gatewayAddress]
 */
const informParentWhenReady = gatewayAddress => {
  if (process.send) {
    process.send({ type: 'ready', gatewayAddress });
  }
};

const reportErrorToParent = message => {
  if (process.send) {
    process.send({ type: 'error', message });
  }
};

const updateRecordedPid = async () => {
  const pidPath = filePowers.joinPath(ephemeralStatePath, 'endo.pid');

  await filePowers
    .readFileText(pidPath)
    .then(pidText => {
      const oldPid = Number(pidText);
      kill(oldPid);
    })
    .catch(() => {});

  await filePowers.writeFileText(pidPath, `${pid}\n`);
};

const killStaleWorkers = async () => {
  const workerDir = filePowers.joinPath(ephemeralStatePath, 'worker');
  /** @type {string[]} */
  let workerIds;
  try {
    workerIds = await filePowers.readDirectory(workerDir);
  } catch {
    return;
  }
  await Promise.all(
    workerIds.map(async workerId => {
      const pidPath = filePowers.joinPath(workerDir, workerId, 'worker.pid');
      try {
        const pidText = await filePowers.readFileText(pidPath);
        const workerPid = Number(pidText);
        if (Number.isFinite(workerPid) && workerPid > 0) {
          try {
            kill(workerPid, 'SIGKILL');
          } catch {
            /* already gone */
          }
        }
        await fs.promises.rm(pidPath, { force: true });
      } catch {
        /* no pid file */
      }
    }),
  );
};

const main = async () => {
  const daemonLabel = `daemon on PID ${pid}`;
  console.log(`Endo daemon starting on PID ${pid}`);
  cancelled.catch(err => {
    console.log(`Endo daemon stopping on PID ${pid} (caught: ${err})`);
  });

  // Initializing daemonic powers must happen inside main() rather than at
  // module scope so that bundlers targeting CJS (which does not support
  // top-level await) can include this module in their dependency graph.
  // The Familiar Electron shell bundles this file with esbuild's `cjs`
  // format, which requires the only `await` in this file to live inside
  // an async function.
  const powers = await makeDaemonicPowers({
    config,
    cancelled,
    fs,
    popen,
    url,
    filePowers,
    cryptoPowers,
    registryPowers,
  });
  const { persistence: daemonicPersistencePowers } = powers;

  await daemonicPersistencePowers.initializePersistence();
  await killStaleWorkers();

  const {
    endoBootstrap,
    cancelGracePeriod,
    capTpConnectionRegistrar,
    marshalSaveError,
  } = await makeDaemon(
    powers,
    daemonLabel,
    cancel,
    cancelled,
    {},
    { gcEnabled },
  );

  /** @param {Error} error */
  const exitWithError = error => {
    cancel(error);
    cancelGracePeriod(error);
  };

  // Start network services
  const privatePathService = networkPowers.makePrivatePathService(
    endoBootstrap,
    sockPath,
    cancelled,
    exitWithError,
    capTpConnectionRegistrar,
    marshalSaveError,
  );
  // Start WebSocket gateway for browser clients (Chat app).
  const addrUrl = new URL(
    `http://${process.env.ENDO_ADDR || '127.0.0.1:8920'}`,
  );
  const gatewayHost = addrUrl.hostname;
  const gatewayPort = addrUrl.port !== '' ? Number(addrUrl.port) : 8920;
  const wsGateway = startWsGateway({
    endoBootstrap,
    host: gatewayHost,
    port: gatewayPort,
    cancelled,
    marshalSaveError,
  });

  const services = [privatePathService, wsGateway];

  // INVARIANT: The ready signal must not be sent until all services are fully
  // operational — including the CapTP socket, the host, and the APPS gateway.
  // Callers of start() depend on this: a resolved start() means the daemon is
  // completely ready to serve. If any service fails to start, the error must
  // propagate to the parent via reportErrorToParent so start() rejects.
  try {
    const serviceResults = await Promise.all(
      services.map(({ started }) => started),
    );

    // wsGateway.started resolves to the bound address (e.g. "http://127.0.0.1:8920").
    // It is the second service in the array.
    const gatewayAddress = /** @type {string} */ (serviceResults[1]);

    // Persist gateway address so Familiar (and other tools) can discover it.
    const gatewayPath = filePowers.joinPath(statePath, 'gateway');
    await filePowers.writeFileText(gatewayPath, `${gatewayAddress}\n`);

    const host = await E(endoBootstrap).host();
    const agentId = /** @type {string} */ (await E(host).identify('@agent'));
    const agentIdPath = filePowers.joinPath(statePath, 'root');
    await filePowers.writeFileText(agentIdPath, `${agentId}\n`);

    informParentWhenReady(gatewayAddress);

    // Run ENDO_EXTRA bootstrap scripts (e.g., lal/fae setup for dev mode).
    const extraSpecifiers = (process.env.ENDO_EXTRA || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const extraOutcomes = await runExtraSetups({
      specifiers: extraSpecifiers,
      host,
      importModule: specifier => import(specifier),
      now: () => new Date().toISOString(),
      log: (message, error) =>
        error === undefined
          ? console.log(message)
          : console.error(message, error),
    });
    // Best-effort: a record we cannot write must not fail a daemon that
    // otherwise came up. It lands beside `gateway` and `root` in the state
    // directory, which is already 0700.
    try {
      const extrasPath = filePowers.joinPath(statePath, 'extras.json');
      await filePowers.writeFileText(
        extrasPath,
        `${JSON.stringify(extraOutcomes, null, 2)}\n`,
      );
    } catch (error) {
      console.error('Could not record ENDO_EXTRA outcomes:', error);
    }
  } catch (error) {
    reportErrorToParent(/** @type {Error} */ (error).message);
    throw error;
  }

  const servicesStopped = Promise.all(services.map(({ stopped }) => stopped));

  // Record self as official daemon process
  await updateRecordedPid();

  // Wait for services to end normally
  await servicesStopped;
  cancel(new Error('Terminated normally'));
  cancelGracePeriod(new Error('Terminated normally'));
};

process.once('SIGINT', () => cancel(new Error('SIGINT')));
process.once('SIGTERM', () => cancel(new Error('SIGTERM')));

// @ts-ignore Yes, we can assign to exitCode, typedoc.
process.exitCode = 1;
main().then(
  () => {
    process.exitCode = 0;
  },
  error => {
    console.error(error);
  },
);
