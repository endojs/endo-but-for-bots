// @ts-check

/** @import { CapTPRejectionContext } from '../src/captp.js' */

import harden from '@endo/harden';
import test from '@endo/ses-ava/test.js';

import { makeCapTP } from '../src/captp.js';

test('promise rejection observation preserves caller reason identity', async t => {
  /** @type {Array<{ error: any, context: CapTPRejectionContext }>} */
  const observed = [];
  const connection = makeCapTP('alice', () => {}, undefined, {
    onReject: (error, context) => observed.push({ error, context }),
  });
  const bootstrapP = connection.getBootstrap();
  const sentReason = Error('remote application failure');

  t.true(
    connection.dispatch({
      type: 'CTP_RETURN',
      epoch: 0,
      answerID: 'q-1',
      exception: connection.serialize(sentReason),
    }),
  );

  const receivedReason = await t.throwsAsync(bootstrapP, {
    message: 'remote application failure',
  });
  await null;
  t.is(observed.length, 1);
  t.is(observed[0].error, receivedReason);
  t.deepEqual(observed[0].context, { kind: 'promise' });
});

test('disconnect observation does not fan out through outstanding promises', async t => {
  /** @type {Array<{ error: any, context: CapTPRejectionContext }>} */
  const observed = [];
  const connection = makeCapTP('alice', () => {}, undefined, {
    onReject: (error, context) => observed.push({ error, context }),
  });
  const outstanding = [connection.getBootstrap(), connection.getBootstrap()];
  const caught = outstanding.map(promise => t.throwsAsync(promise));
  const reason = Error('transport lost');

  connection.abort(reason);

  const received = await Promise.all(caught);
  t.deepEqual(received, [reason, reason]);
  t.deepEqual(observed, [
    {
      error: reason,
      context: { kind: 'disconnect' },
    },
  ]);
});

test('malformed dispatch is observed as a protocol failure', t => {
  /** @type {Array<{ error: any, context: CapTPRejectionContext }>} */
  const observed = [];
  /** @type {Record<string, any>[]} */
  const sent = [];
  const connection = makeCapTP(
    'alice',
    message => sent.push(message),
    undefined,
    {
      onReject: (error, context) => observed.push({ error, context }),
    },
  );

  t.false(
    connection.dispatch({
      type: 'CTP_CALL',
      epoch: 0,
      questionID: 'q-1',
      target: 'o+1',
      method: connection.serialize(harden([])),
    }),
  );
  t.is(observed.length, 1);
  t.regex(observed[0].error.message, /invalid method/);
  t.deepEqual(observed[0].context, { kind: 'protocol' });
  t.is(sent.at(-1)?.type, 'CTP_DISCONNECT');
});
