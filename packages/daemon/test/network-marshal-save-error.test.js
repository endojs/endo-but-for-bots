// @ts-check

// Establish a perimeter:
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import { Far } from '@endo/far';

import { makeNetworkMarshalSaveError } from '../src/networks/network-marshal-save-error.js';

/**
 * Build a fake host whose `reportTrace` records the most recent
 * record into a closure-held variable.
 */
const makeFakeHost = () => {
  /** @type {unknown} */
  let captured;
  /** @type {Promise<void>} */
  let settled = Promise.resolve();
  const host = Far('FakeHost', {
    /** @param {unknown} record */
    reportTrace(record) {
      captured = record;
      return undefined;
    },
  });
  // Drain microtasks via the same channel E.sendOnly uses.
  const drain = async () => {
    settled = Promise.resolve(settled).then(() => Promise.resolve());
    await settled;
    await Promise.resolve();
    await Promise.resolve();
  };
  return { host, drain, getCaptured: () => captured };
};

test('forwards a TraceRecord to powers.reportTrace', async t => {
  const { host, drain, getCaptured } = makeFakeHost();
  const marshalSaveError = makeNetworkMarshalSaveError(host, 'libp2p-inbound');
  const before = Date.now();
  marshalSaveError(new TypeError('boom'), 'error:Endo#42');
  await drain();
  const record = /** @type {any} */ (getCaptured());
  t.truthy(record, 'expected a record to be reported');
  t.is(record.errorId, 'error:Endo#42');
  t.is(record.site, 'libp2p-inbound');
  t.is(record.name, 'TypeError');
  t.is(record.message, 'boom');
  t.is(record.workerId, '', 'caller-side workerId is empty; daemon stamps it');
  t.true(Array.isArray(record.annotations));
  t.true(Array.isArray(record.causes));
  t.is(typeof record.t, 'number');
  t.true(/** @type {number} */ (record.t) >= before);
  t.is(typeof record.stack, 'string');
});

test('skips when errorId is undefined', async t => {
  const { host, drain, getCaptured } = makeFakeHost();
  const marshalSaveError = makeNetworkMarshalSaveError(
    host,
    'ws-relay-inbound',
  );
  marshalSaveError(new Error('nope'), undefined);
  await drain();
  t.is(getCaptured(), undefined, 'no record should be reported');
});

test('survives a rejected reportTrace without throwing', async t => {
  const host = Far('RejectingHost', {
    /** @param {unknown} _record */
    reportTrace(_record) {
      throw new Error('reportTrace rejected');
    },
  });
  const marshalSaveError = makeNetworkMarshalSaveError(host, 'libp2p-outbound');
  // E.sendOnly swallows synchronous failures inside the receiver, so
  // this should not throw.
  t.notThrows(() => marshalSaveError(new Error('boom'), 'error:Endo#1'));
});
