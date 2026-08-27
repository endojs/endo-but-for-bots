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

// The run facet's `status()` flattens `kind` to the top level, but the space
// renders from the CLIENT-SIDE FOLD, which stores the raw effect record with
// the kind nested under `effect`. Matching only the flat shape is why the
// approval panel never appeared in the workflow space.
const NESTED_ASK = {
  effectId: '8-0',
  path: ['await-approval'],
  correlation: ASK.correlation,
  effect: { kind: 'ask', target: 'operator' },
};
const NESTED_TIMER = {
  effectId: '8-1',
  path: ['await-approval'],
  correlation: { deadline: 1788396096769 },
  effect: { kind: 'after' },
};

test('the fold shape is recognised, not just the status projection', t => {
  t.deepEqual(formAsks([NESTED_ASK, NESTED_TIMER]), [NESTED_ASK]);
});

test('both shapes are found together', t => {
  t.is(formAsks([ASK, NESTED_ASK, TIMER, NESTED_TIMER]).length, 2);
});

test('a pending record with no kind at all still counts', t => {
  // Better to offer the form than to vanish because a projection changed
  // shape again.
  const kindless = { effectId: '9-0', correlation: ASK.correlation };
  t.deepEqual(formAsks([kindless]), [kindless]);
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
