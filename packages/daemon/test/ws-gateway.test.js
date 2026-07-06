// @ts-nocheck
/* global setTimeout, clearTimeout */

// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import { WebSocket } from 'ws';
import { makePromiseKit } from '@endo/promise-kit';

import { startWsGateway } from '../src/ws-gateway.js';

// A minimal EndoBootstrap stand-in. startWsGateway only reaches `.gateway()` at
// construction and `.provide(token)` on a client `fetch()`. These tests exercise
// the pre-CapTP admission gate, so no request reaches `provide()`; the stub just
// keeps gateway construction honest.
const makeStubBootstrap = () =>
  harden({
    gateway: () =>
      harden({
        provide: async () => harden({}),
      }),
  });

/**
 * Start a gateway on an OS-assigned port, forcing the address checker to see a
 * synthetic client IP, then open a raw WebSocket and report how the server
 * treated the connection. An admitted connection is either proactively pinged
 * by the gateway's CapTP (a binary frame arrives) or simply held open; a
 * refused connection is closed immediately with a policy-violation code.
 *
 * @param {object} opts
 * @param {string} opts.clientAddress - the IP the address checker sees
 * @param {boolean} [opts.allowRemote]
 * @param {string} [opts.allowedCIDRs]
 */
const probeConnection = async ({
  clientAddress,
  allowRemote,
  allowedCIDRs,
}) => {
  const { promise: cancelled, reject: cancel } = makePromiseKit();
  cancelled.catch(() => {});
  const { started, stopped } = startWsGateway({
    endoBootstrap: makeStubBootstrap(),
    host: '127.0.0.1',
    port: 0,
    cancelled,
    allowRemote,
    allowedCIDRs,
    getRemoteAddress: () => clientAddress,
  });

  const address = await started; // http://127.0.0.1:<port>
  const socket = new WebSocket(address.replace(/^http/u, 'ws'));

  const result = await new Promise(resolve => {
    const admittedTimer = setTimeout(() => resolve({ admitted: true }), 500);
    socket.on('message', () => {
      clearTimeout(admittedTimer);
      resolve({ admitted: true });
    });
    socket.on('close', (code, reasonBuffer) => {
      clearTimeout(admittedTimer);
      resolve({ admitted: false, code, reason: reasonBuffer.toString() });
    });
    // A refused upgrade can surface as a socket error before close; let close
    // settle the result.
    socket.on('error', () => {});
  });

  socket.close();
  cancel(new Error('test complete'));
  await stopped.catch(() => {});
  return result;
};

test('local mode refuses a non-localhost client with the documented reason', async t => {
  const result = await probeConnection({ clientAddress: '203.0.113.7' });
  t.false(result.admitted);
  t.is(result.code, 1008);
  t.is(result.reason, 'Only local connections allowed');
});

test('local mode admits a localhost client', async t => {
  const result = await probeConnection({ clientAddress: '127.0.0.1' });
  t.true(result.admitted);
});

test('local mode admits an IPv4-mapped IPv6 localhost client', async t => {
  const result = await probeConnection({ clientAddress: '::ffff:127.0.0.1' });
  t.true(result.admitted);
});

test('remote mode admits a non-localhost client', async t => {
  const result = await probeConnection({
    clientAddress: '203.0.113.7',
    allowRemote: true,
  });
  t.true(result.admitted);
});

test('CIDR allowlist admits a listed range but still refuses addresses outside it', async t => {
  const inside = await probeConnection({
    clientAddress: '10.1.2.3',
    allowedCIDRs: '10.0.0.0/8',
  });
  t.true(inside.admitted);

  const outside = await probeConnection({
    clientAddress: '11.0.0.1',
    allowedCIDRs: '10.0.0.0/8',
  });
  t.false(outside.admitted);
  t.is(outside.reason, 'Only local connections allowed');
});
