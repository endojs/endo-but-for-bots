// @ts-check
/* global process */

// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init';

import fs from 'fs';
import url from 'url';

import { makeCancelKit } from '@endo/cancel';
import { main } from './worker.js';
import { makePowers } from './worker-node-powers.js';
import { installShutdownSignals } from './shutdown-signals.js';

const powers = makePowers({ fs, url });

const { cancelled, cancel } = makeCancelKit();

// Handle SIGTERM as well as SIGINT so a supervisor or operator can stop a
// worker without escalating to SIGKILL, and force-exit if the graceful cancel
// fails to drain within the grace period. Exit too if orphaned by a dead
// manager (under ENDO_EXIT_WHEN_ORPHANED).
installShutdownSignals({
  cancel,
  graceMs: Number(process.env.ENDO_WORKER_SHUTDOWN_GRACE_MS) || 3000,
  exitWhenOrphaned: process.env.ENDO_EXIT_WHEN_ORPHANED === '1',
});

// @ts-ignore Yes, we can assign to exitCode, typedoc.
process.exitCode = 1;
main(powers, process.pid, cancel, cancelled).then(
  () => {
    process.exitCode = 0;
  },
  error => {
    console.error(error);
  },
);
