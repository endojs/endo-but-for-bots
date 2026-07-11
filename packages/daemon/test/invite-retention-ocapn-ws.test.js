// @ts-check
/* global process */

// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import baseTest from 'ava';
import { runMultiplayerSuite, ocapnWsNetwork } from './_multiplayer-suite.js';

// Run the shared multiplayer suite — invite, accept, value exchange,
// partition, restart, three-party, sub-invitation chain, and the
// agent-ring GC case — against the OCapN-Noise transport at
// `@nets/ocapn`, but over WebSocket+Noise+CBOR rather than TCP. The
// target deployment host (minion.town) exposes only 443/WS, so
// proving the full daemon-level multiplayer flow over `ocapn+noise+ws`
// is what the `_multiplayer-suite.js` companion `invite-retention-ocapn.test.js`
// does for `ocapn+noise+tcp`. Both share one Noise+CBOR session layer
// and differ only in the byte-stream transport underneath, so a green
// run here alongside the TCP run is the in-process proof that the WS
// wiring serves and dials with no protocol regression.

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

runMultiplayerSuite({ test, network: ocapnWsNetwork });
