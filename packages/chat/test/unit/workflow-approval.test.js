// @ts-check
import '@endo/init/debug.js';

import test from 'ava';

import { formAsks, matchInboxMessage } from '@endo/space-workflow';

// Shapes taken from a real `endo-release` run waiting in `await-approval`.
const ASK = {
  effectId: '5-0',
  kind: 'ask',
  path: ['await-approval'],
  correlation: {
    messageId: 'f573528dff2be58e25b82c8f73ebb1020734a5db169b09cc7292b34b2ab5f10f',
    messageNumber: '0',
    mode: 'form',
    responseName: ['workflow', 'runs', 'r-6f886ae6d099', 'answers', '5-0'],
  },
};
const TIMER = {
  effectId: '5-1',
  kind: 'after',
  path: ['await-approval'],
  correlation: { deadline: 1788248006622 },
};

test('only form asks are offered as answerable', t => {
  t.deepEqual(formAsks([ASK, TIMER]), [ASK]);
  t.deepEqual(formAsks([TIMER]), []);
  t.deepEqual(formAsks([]), []);
  t.deepEqual(formAsks(undefined), []);
});

test('an ask in another mode is not treated as a form', t => {
  const request = { ...ASK, correlation: { ...ASK.correlation, mode: 'request' } };
  t.deepEqual(formAsks([request]), []);
});

test("the ask matches the operator's own inbox message by id", t => {
  const message = {
    number: 0n,
    type: 'form',
    messageId: ASK.correlation.messageId,
    description: 'Deploy Endo …',
    fields: [{ name: 'approved' }],
  };
  t.is(matchInboxMessage([message], ASK), message);
});

test('a viewer who is not the operator matches nothing', t => {
  // Their inbox has mail, just not this form — so the panel must offer no
  // control rather than a Submit that would fail.
  const other = {
    number: 3n,
    type: 'form',
    messageId: 'some-other-form',
    fields: [],
  };
  t.is(matchInboxMessage([other], ASK), undefined);
  t.is(matchInboxMessage([], ASK), undefined);
});

test('a non-form message with the same id is not answerable', t => {
  const impostor = {
    number: 1n,
    type: 'package',
    messageId: ASK.correlation.messageId,
  };
  t.is(matchInboxMessage([impostor], ASK), undefined);
});

test('an ask with no message id matches nothing', t => {
  const anonymous = { kind: 'ask', correlation: { mode: 'form' } };
  t.is(matchInboxMessage([{ type: 'form', messageId: 'x' }], anonymous), undefined);
});
