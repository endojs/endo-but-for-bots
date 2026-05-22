// @ts-check
/* global process */

// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import baseTest from 'ava';
import { runMultiplayerSuite, ocapnNetwork } from './_multiplayer-suite.js';

// Run the shared multiplayer suite — invite, accept, value exchange,
// partition, restart, three-party, sub-invitation chain, and the
// agent-ring GC case — against the OCapN-Noise transport at
// `@nets/ocapn`. The OCapN edge is the new external connectivity
// layer per `designs/daemon-ocapn-external-connectivity.md`, and it
// is unique enough — Noise-authenticated peer identity, session
// cache dedupe by location, OCapN sturdyrefs instead of raw `endo://`
// query strings — that running the full daemon-level multiplayer
// flow over it is the only way to catch regressions that the
// in-process `networks-ocapn.test.js` cannot reach.

// Multi-daemon retention tests rely on a network module that is
// loaded via makeUnconfined (a Node-only path). Skip the whole suite
// on the bare Rust supervisor (test:rust without
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

runMultiplayerSuite({ test, network: ocapnNetwork });
