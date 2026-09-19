// @ts-nocheck

// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import url from 'url';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fork } from 'child_process';
import { E } from '@endo/eventual-send';
import { makeCancelKit } from '@endo/cancel';
import { start, stop, purge, makeEndoClient } from '../index.js';

// Regression coverage for the daemon test-suite process leak: a run that spawns
// Endo daemons must not leave them (or their workers) alive after teardown, and
// a running daemon must honor SIGTERM without an operator escalating to SIGKILL.
// Each test asserts on the specific pids it spawned (scoped by its own config
// directory), so it is robust regardless of what else ran.

const dirname = url.fileURLToPath(new URL('..', import.meta.url)).toString();

const { raw } = String;

const makeConfig = (...root) => ({
  statePath: path.join(dirname, ...root, 'state'),
  ephemeralStatePath: path.join(dirname, ...root, 'run'),
  cachePath: path.join(dirname, ...root, 'cache'),
  // Keep the Unix-domain socket path short (sun_path caps at ~104-108 bytes),
  // independent of how deep the checkout lives — the leaked-process assertions
  // below only need a daemon to come up.
  sockPath:
    process.platform === 'win32'
      ? raw`\\?\pipe\endo-${root.join('-')}-test.sock`
      : path.join(
          os.tmpdir(),
          `endo-td-${process.pid}-${root.join('-')}.sock`,
        ),
  address: '127.0.0.1:0',
  pets: new Map(),
  values: new Map(),
});

/** @param {number} pid */
const isAlive = pid => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** @param {string} pidPath */
const readPid = async pidPath => {
  try {
    const text = await fs.promises.readFile(pidPath, 'utf-8');
    const pid = Number(text.trim());
    return Number.isFinite(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
};

/** @param {string} ephemeralStatePath */
const listWorkerPids = async ephemeralStatePath => {
  const workerDir = path.join(ephemeralStatePath, 'worker');
  let ids;
  try {
    ids = await fs.promises.readdir(workerDir);
  } catch {
    return [];
  }
  const pids = [];
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    const pid = await readPid(path.join(workerDir, id, 'worker.pid'));
    if (pid) pids.push(pid);
  }
  return pids;
};

/**
 * @param {number[]} pids
 * @param {number} timeoutMs
 */
const waitAllDead = async (pids, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pids.every(pid => !isAlive(pid))) return true;
    if (Date.now() >= deadline) return false;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => {
      setTimeout(resolve, 100);
    });
  }
};

const spawnDaemonWithWorker = async config => {
  await purge(config);
  await start(config);
  const { cancelled, cancel } = makeCancelKit();
  const { getBootstrap, closed } = await makeEndoClient(
    'client',
    config.sockPath,
    cancelled,
  );
  // Teardown-induced connection closure must not surface as an unhandled
  // rejection.
  closed.catch(() => {});
  const host = E(getBootstrap()).host();
  // Force a worker process to exist.
  await E(host).provideWorker(['w']);
  const daemonPid = await readPid(
    path.join(config.ephemeralStatePath, 'endo.pid'),
  );
  const workerPids = await listWorkerPids(config.ephemeralStatePath);
  return { daemonPid, workerPids, cancel };
};

test.serial('stop() terminates the daemon and its workers', async t => {
  const config = makeConfig('tmp', 'teardown-stop');
  const { daemonPid, workerPids, cancel } =
    await spawnDaemonWithWorker(config);

  t.true(daemonPid > 0, 'daemon recorded its pid');
  t.true(workerPids.length > 0, 'at least one worker was spawned');
  t.true(isAlive(daemonPid), 'daemon is running before stop()');

  cancel(Error('teardown'));
  await stop(config);

  t.true(
    await waitAllDead([daemonPid, ...workerPids], 15_000),
    `daemon ${daemonPid} and workers ${workerPids} all exited after stop()`,
  );

  await purge(config);
});

test.serial(
  'SIGTERM shuts the daemon (and its workers) down without SIGKILL',
  async t => {
    const config = makeConfig('tmp', 'teardown-sigterm');
    const { daemonPid, workerPids, cancel } =
      await spawnDaemonWithWorker(config);

    t.true(daemonPid > 0, 'daemon recorded its pid');
    t.true(workerPids.length > 0, 'at least one worker was spawned');

    // A single SIGTERM must be sufficient: a daemon that ignores TERM cannot be
    // managed by systemd, a supervisor, or an operator, and forces SIGKILL.
    process.kill(daemonPid, 'SIGTERM');

    t.true(
      await waitAllDead([daemonPid], 12_000),
      `daemon ${daemonPid} exited on SIGTERM alone`,
    );
    t.true(
      await waitAllDead(workerPids, 12_000),
      `workers ${workerPids} exited with the daemon (no orphans)`,
    );

    cancel(Error('teardown'));
    await purge(config);
  },
);

test.serial(
  'an orphaned daemon shuts itself down instead of lingering',
  async t => {
    const config = makeConfig('tmp', 'teardown-orphan');
    await purge(config);

    const launcherPath = url.fileURLToPath(
      new URL('_orphan-daemon-launcher.js', import.meta.url),
    );

    // Launch the daemon from a short-lived child process, then let that child
    // exit — orphaning the (detached) daemon.
    await new Promise((resolve, reject) => {
      const launcher = fork(launcherPath, [JSON.stringify(config)], {
        env: { ...process.env, ENDO_EXIT_WHEN_ORPHANED: '1' },
        stdio: 'ignore',
      });
      launcher.once('error', reject);
      launcher.once('exit', code =>
        code === 0
          ? resolve(undefined)
          : reject(Error(`launcher exited with code ${code}`)),
      );
    });

    const daemonPid = await readPid(
      path.join(config.ephemeralStatePath, 'endo.pid'),
    );
    t.true(daemonPid > 0, 'daemon recorded its pid before its launcher exited');

    // The orphan watch polls ~1s, then a graceful cancel with a bounded
    // force-exit; give generous headroom. Without the orphan-exit fix the
    // daemon would linger indefinitely (and keep respawning workers), so this
    // assertion is the regression guard.
    t.true(
      await waitAllDead([daemonPid], 20_000),
      `orphaned daemon ${daemonPid} shut itself down`,
    );

    await purge(config);
  },
);
