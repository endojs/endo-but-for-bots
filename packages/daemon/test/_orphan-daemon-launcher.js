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

import { start } from '../index.js';

const config = JSON.parse(process.argv[2]);
config.pets = new Map();
config.values = new Map();

await start(config);
// Intentionally do not stop(): return and let this process exit, orphaning the
// daemon.
