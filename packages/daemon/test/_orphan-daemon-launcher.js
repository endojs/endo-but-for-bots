// @ts-nocheck

// Test fixture (not a test file): launch a daemon and then exit WITHOUT
// tearing it down, to simulate a launcher (an ava worker) dying mid-test. The
// daemon is spawned detached and unref'd by `start()`, so once this launcher
// exits the daemon is reparented to init — orphaned. A daemon launched with
// ENDO_EXIT_WHEN_ORPHANED=1 must then shut itself down rather than linger and
// keep respawning workers. See daemon-teardown.test.js.

// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init';

import fs from 'fs';

import { start } from '../index.js';

const config = JSON.parse(process.argv[2]);
config.pets = new Map();
config.values = new Map();

await start(config);

// Stay alive until the parent test has observed the daemon's pid. The parent
// then terminates this launcher, orphaning the detached daemon without racing
// the daemon's removal of its pid file.
const terminated = new Promise(resolve => {
  const keepAlive = setInterval(() => {}, 1000);
  process.once('SIGTERM', () => {
    clearInterval(keepAlive);
    resolve(undefined);
  });
});
await fs.promises.writeFile(process.argv[3], `${process.pid}\n`);
await terminated;
// Intentionally do not stop().
