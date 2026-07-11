// @ts-nocheck

// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import { WebSocket } from 'ws';
import { Far } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';

import { startWsGateway } from '../src/ws-gateway.js';

/** @import { AddressChecker } from '../src/types.js' */

// A minimal daemon bootstrap. The gateway calls `gateway()` once at startup
// and `provide(token)` only inside a client's `fetch(token)`, which the
// address-gating tests never reach.
const makeStubBootstrap = () =>
  Far('EndoBootstrap', {
    gateway: () =>
      Far('Gateway', {
        provide: async token => token,
      }),
  });

/**
 * Start a gateway on an OS-assigned localhost port, run `body` with its
 * `ws://` address, and tear it down.
 *
 * @param {AddressChecker} addressChecker
 * @param {(webSocketAddress: string) => Promise<void>} body
 */
const withGateway = async (addressChecker, body) => {
  const { promise: cancelled, reject: cancel } = makePromiseKit();
  cancelled.catch(() => {});
  const gateway = startWsGateway({
    endoBootstrap: makeStubBootstrap(),
    host: '127.0.0.1',
    port: 0,
    cancelled,
    addressChecker,
  });
  const httpAddress = await gateway.started;
  const webSocketAddress = httpAddress.replace(/^http:/, 'ws:');
  try {
    await body(webSocketAddress);
  } finally {
    cancel(new Error('test complete'));
    await gateway.stopped;
  }
};

/**
 * Open a client WebSocket and resolve with the first lifecycle event: a
 * received frame means the gateway admitted the connection and began the CapTP
 * handshake; a close (without a frame) means it rejected the connection.
 *
 * @param {string} webSocketAddress
 */
const firstConnectionOutcome = webSocketAddress =>
  new Promise(resolve => {
    const socket = new WebSocket(webSocketAddress);
    const settle = outcome => () => {
      socket.close();
      resolve(outcome);
    };
    socket.on('message', settle('admitted'));
    socket.on('close', settle('rejected'));
    socket.on('error', settle('rejected'));
  });

test('gateway rejects a connection its address checker denies', async t => {
  await withGateway(
    () => false,
    async webSocketAddress => {
      const outcome = await firstConnectionOutcome(webSocketAddress);
      t.is(outcome, 'rejected');
    },
  );
});

test('gateway admits a connection its address checker allows', async t => {
  await withGateway(
    () => true,
    async webSocketAddress => {
      const outcome = await firstConnectionOutcome(webSocketAddress);
      t.is(outcome, 'admitted');
    },
  );
});

test('gateway defaults to admitting localhost', async t => {
  // No addressChecker passed: the default admits localhost, so a client on
  // 127.0.0.1 reaches the CapTP handshake.
  const { promise: cancelled, reject: cancel } = makePromiseKit();
  cancelled.catch(() => {});
  const gateway = startWsGateway({
    endoBootstrap: makeStubBootstrap(),
    host: '127.0.0.1',
    port: 0,
    cancelled,
  });
  const httpAddress = await gateway.started;
  const webSocketAddress = httpAddress.replace(/^http:/, 'ws:');
  try {
    t.is(await firstConnectionOutcome(webSocketAddress), 'admitted');
  } finally {
    cancel(new Error('test complete'));
    await gateway.stopped;
  }
});
