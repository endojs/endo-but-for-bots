// @ts-nocheck

// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import url from 'url';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { spawn } from 'child_process';
import { E } from '@endo/eventual-send';
import { makeCancelKit } from '@endo/cancel';
import { start, stop, purge, makeEndoClient } from '../index.js';

// Phase 1 of designs/daemon-lifecycle-idempotency.md: `start` leaves a live or
// booting daemon alone, and a second daemon against the same state directory
// declines before it touches the first daemon's workers or database.

const dirname = url.fileURLToPath(new URL('..', import.meta.url)).toString();
const indexPath = url.fileURLToPath(new URL('../index.js', import.meta.url));

const makeConfig = (...root) => ({
  statePath: path.join(dirname, ...root, 'state'),
  ephemeralStatePath: path.join(dirname, ...root, 'run'),
  cachePath: path.join(dirname, ...root, 'cache'),
  sockPath: path.join(
    os.tmpdir(),
    `endo-li-${process.pid}-${root.join('-')}.sock`,
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

/** @param {object} config */
const readDaemonPid = config =>
  readPid(path.join(config.ephemeralStatePath, 'endo.pid'));

/** @param {object} config */
const listWorkerPids = async config => {
  const workerDir = path.join(config.ephemeralStatePath, 'worker');
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
 * The managers running against this configuration's state, found by their
 * command lines, so that a second daemon that should not exist is counted.
 *
 * @param {object} config
 */
const listManagerPids = async config => {
  const pids = [];
  for (const entry of await fs.promises.readdir('/proc').catch(() => [])) {
    if (/^\d+$/.test(entry)) {
      // eslint-disable-next-line no-await-in-loop
      const cmdline = await fs.promises
        .readFile(`/proc/${entry}/cmdline`, 'utf-8')
        .catch(() => '');
      const args = cmdline.split('\0');
      if (
        args.some(arg => arg.endsWith('manager-node.js')) &&
        args.includes(config.ephemeralStatePath)
      ) {
        pids.push(Number(entry));
      }
    }
  }
  return pids;
};

/** @param {object} config */
const ping = async config => {
  const { cancelled, cancel } = makeCancelKit();
  const { getBootstrap, closed } = await makeEndoClient(
    'client',
    config.sockPath,
    cancelled,
  );
  closed.catch(() => {});
  const host = E(getBootstrap()).host();
  return { host, cancel };
};

/** @param {() => boolean | Promise<boolean>} predicate */
const waitFor = async (predicate, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => {
      setTimeout(resolve, 10);
    });
  }
  return false;
};

const unixOnly = process.platform === 'win32' ? test.skip : test.serial;

unixOnly('start twice leaves one daemon', async t => {
  const config = makeConfig('tmp', 'lifecycle-start-twice');
  await purge(config);
  t.teardown(() => stop(config));

  await start(config);
  const first = await readDaemonPid(config);
  t.true(isAlive(first));

  await start(config);
  t.is(await readDaemonPid(config), first, 'second start keeps the daemon');
  t.true(isAlive(first));

  const { host, cancel } = await ping(config);
  t.truthy(await E(host).identify('@agent'), 'daemon still serves its socket');
  cancel();

  if (process.platform === 'linux') {
    t.deepEqual(await listManagerPids(config), [first]);
  }
});

unixOnly('start while the daemon is booting waits for it', async t => {
  const config = makeConfig('tmp', 'lifecycle-start-booting');
  await purge(config);
  t.teardown(() => stop(config));

  const firstStart = start(config);
  // The daemon records its pid as soon as it owns the state, well before it
  // serves, so this start lands while the first daemon is booting.
  t.true(await waitFor(async () => (await readDaemonPid(config)) > 0));
  const booting = await readDaemonPid(config);
  await Promise.all([firstStart, start(config)]);

  t.is(await readDaemonPid(config), booting);
  t.true(isAlive(booting));
  if (process.platform === 'linux') {
    t.deepEqual(await listManagerPids(config), [booting]);
  }
});

unixOnly('concurrent starts leave one daemon', async t => {
  const config = makeConfig('tmp', 'lifecycle-start-race');
  await purge(config);
  t.teardown(() => stop(config));

  await Promise.all([start(config), start(config), start(config)]);

  const pid = await readDaemonPid(config);
  t.true(isAlive(pid));
  if (process.platform === 'linux') {
    t.deepEqual(await listManagerPids(config), [pid]);
  }
});

unixOnly(
  'a second run-daemon against the same state exits 69 and spares the first daemon',
  async t => {
    const config = makeConfig('tmp', 'lifecycle-second-run-daemon');
    await purge(config);
    t.teardown(() => stop(config));

    await start(config);
    const daemonPid = await readDaemonPid(config);
    const { host, cancel } = await ping(config);
    await E(host).provideWorker(['w']);
    cancel();
    const workerPids = await listWorkerPids(config);
    t.true(workerPids.length > 0, 'a worker is running');

    // `endo run-daemon`, with the same state but its own socket, so that only
    // the state lock can keep it out.
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `await import('@endo/init'); (await import(${JSON.stringify(indexPath)})).main([]);`,
      ],
      {
        env: {
          ...process.env,
          ENDO_STATE_PATH: config.statePath,
          ENDO_EPHEMERAL_STATE_PATH: config.ephemeralStatePath,
          ENDO_CACHE_PATH: config.cachePath,
          ENDO_SOCK_PATH: `${config.sockPath}.second`,
          ENDO_ADDR: '127.0.0.1:0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    const code = await new Promise(resolve => child.on('exit', resolve));

    t.is(code, 69, stderr);
    t.regex(
      stderr,
      new RegExp(`another Endo daemon \\(pid ${daemonPid}\\) owns`),
    );
    t.is(await readDaemonPid(config), daemonPid, 'endo.pid is untouched');
    t.true(isAlive(daemonPid), 'the first daemon survives');
    for (const workerPid of workerPids) {
      t.true(isAlive(workerPid), `worker ${workerPid} survives`);
    }
  },
);
