// @ts-check
/* global process */

// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import baseTest from 'ava';
import { runMultiplayerSuite, tcpNetwork } from './_multiplayer-suite.js';

// Multi-daemon retention tests rely on a network module that is
// loaded via makeUnconfined (a Node-only path).  Skip the whole
// suite on the bare Rust supervisor (test:rust without
// ENDO_NODE_WORKER_BIN).
const skipNoNodeWorker =
  process.env.ENDO_BIN && !process.env.ENDO_NODE_WORKER_BIN;
const test = skipNoNodeWorker
  ? Object.assign(baseTest.skip, {
      serial: baseTest.serial.skip,
      beforeEach: baseTest.beforeEach,
      afterEach: baseTest.afterEach,
    })
  : baseTest;

runMultiplayerSuite({ test, network: tcpNetwork });
