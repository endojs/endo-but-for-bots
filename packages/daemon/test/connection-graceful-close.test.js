// @ts-check
// A deliberate cancellation of a daemon connection is lifecycle, not an
// exception. The client's `cancelled` promise closes the connection through
// CapTP's graceful shutdown, so neither the cancelling side nor the peer
// reports the cancellation reason through `onReject` (which by default
// writes a `CapTP <name> exception:` diagnostic to stderr). Pending
// operations still reject with the informative cancellation reason, and a
// non-graceful close still reports on both sides.
//
// Regression context: exiting the Pi code-mode extension cancelled its
// daemon client with `Error('Code-mode provisioning session closed')` and
// printed that deliberate reason as a full CapTP exception stack on every
// clean exit.

import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/eventual-send';
import { Far } from '@endo/marshal';
import { makePromiseKit } from '@endo/promise-kit';
import { makePipe } from '@endo/stream';

import { makeMessageCapTP } from '../src/connection.js';

const makeConnectedPair = () => {
  const [aToB, bFromA] = makePipe();
  const [bToA, aFromB] = makePipe();
  const { promise: aCancelled, reject: cancelA } = makePromiseKit();
  /** @type {Promise<void>} */
  const bCancelled = new Promise(() => {});
  /** @type {unknown[]} */
  const aRejections = [];
  /** @type {unknown[]} */
  const bRejections = [];
  const bootstrap = Far('bootstrap', {
    hello: () => 'hi',
    hang: () => new Promise(() => {}),
  });
  const a = makeMessageCapTP('client', aToB, aFromB, aCancelled, undefined, {
    onReject: error => aRejections.push(error),
  });
  const b = makeMessageCapTP('server', bToA, bFromA, bCancelled, bootstrap, {
    onReject: error => bRejections.push(error),
  });
  return { a, b, cancelA, aRejections, bRejections };
};

test('deliberate cancellation closes both sides without a CapTP exception', async t => {
  await null;
  const { a, b, cancelA, aRejections, bRejections } = makeConnectedPair();
  const bs = a.getBootstrap();
  t.is(await E(bs).hello(), 'hi');
  const hanging = E(bs).hang();

  const reason = Error('Code-mode provisioning session closed');
  cancelA(reason);

  await t.throwsAsync(
    hanging,
    { message: 'Code-mode provisioning session closed' },
    'pending operations still reject with the cancellation reason',
  );
  await a.closed;
  await b.closed;
  t.deepEqual(aRejections, [], 'the cancelling side reports no exception');
  t.deepEqual(bRejections, [], 'the peer reports no exception');
});

test('non-graceful close still reports the reason on both sides', async t => {
  await null;
  const { a, b, aRejections, bRejections } = makeConnectedPair();
  const bs = a.getBootstrap();
  t.is(await E(bs).hello(), 'hi');

  const reason = Error('boom');
  a.close(reason);

  await a.closed;
  await b.closed;
  t.deepEqual(aRejections, [reason], 'the closing side reports the reason');
  t.is(bRejections.length, 1, 'the peer reports the reason');
  t.is(
    /** @type {{ message: string }} */ (bRejections[0]).message,
    'boom',
    'the peer sees the original message across the wire',
  );
});
