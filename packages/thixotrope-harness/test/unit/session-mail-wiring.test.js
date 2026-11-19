// @ts-check
// The session's mail wiring (designs/m9-interfaces.md 3.2, seams S1, S3, S5):
// a session from `makeSession` with the `inbox` and `subagents` parts
// receives `SessionInternal.deliverMail` and claims the mail turn in the
// same crank; a re-drive starts nothing; a queue held `restart` lets mail
// through while `stopped` does not; a deleting session refuses; `cancelMail`
// dismisses a waiting message or cancels the turn handling it; a runtime
// without the part refuses as before. The packages counter's `reserve` and
// numbered `open` (S3) are checked on the real table.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { texts } from '../../guest/lib/guards/session.js';
import { interfaces as factoryInterfaces } from '../../guest/lib/guards/factory.js';
import { holdTexts } from '../../guest/session/holds.js';
import { makePackages } from '../../guest/session/packages.js';
import { makeQueue as realMakeQueue } from '../../guest/session/queue.js';
import { runtimeParts } from '../../guest/session/runtime-parts.js';
/* eslint-enable import/no-relative-packages */
import { AT, drain, makeQueueSession } from './_m2-queue-session.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { makeExo } = /** @type {GuestGlobals} */ (globalThis);

const sender = makeExo('MailAddress', factoryInterfaces.MailAddress, {
  describe: () => harden({ title: 'Bea', kind: 'session' }),
});

/**
 * @param {number} seq
 * @param {Record<string, any>} [fields]
 */
const envelope = (seq, fields = {}) =>
  harden({
    seq,
    postmark: 100 + seq,
    type: 'package',
    from: sender,
    fromTitle: 'Bea',
    body: `mail ${seq}`,
    attachments: harden([]),
    at: AT + seq,
    ...fields,
  });

/** A mail session whose queue the test can hold. */
const makeMailSession = async () => {
  /** @type {any} */
  let queue;
  const s = await makeQueueSession({
    withEnvironment: true,
    parts: runtimeParts,
    makeQueue: options => {
      queue = realMakeQueue(options);
      return queue;
    },
  });
  return { ...s, queue: () => queue };
};

test('a delivery to an idle session claims its turn in the same crank', async t => {
  const s = await makeMailSession();
  const answer = s.internal.deliverMail(envelope(1));
  t.deepEqual(answer, { number: 1 });
  // Same crank: the turn is current before any later delivery runs.
  t.is(s.internal.rowSnapshot().activity, 'working');
  await drain();
  t.deepEqual(s.sent(), ['mail 1']);
  // A re-drive is answered from the ring and starts nothing.
  t.deepEqual(s.internal.deliverMail(envelope(1)), {
    number: 1,
    duplicate: true,
  });
  await s.finish();
  await drain();
  t.deepEqual(s.sent(), ['mail 1']);
  t.is(s.internal.rowSnapshot().activity, 'passive');
});

test('mail waits while a turn runs and starts when it settles', async t => {
  const s = await makeMailSession();
  await s.submit('user first');
  t.deepEqual(s.internal.deliverMail(envelope(1)), { number: 1 });
  await drain();
  t.deepEqual(s.sent(), ['user first']);
  await s.finish();
  t.deepEqual(s.sent(), ['user first', 'mail 1']);
});

/**
 * An idle session whose queue holds one entry for `reason`.
 * @param {'restart' | 'stopped'} reason
 */
const heldSession = async reason => {
  const s = await makeMailSession();
  await s.submit('first');
  await s.submit('waiting');
  if (reason === 'stopped') {
    await s.session.emergencyStop();
  } else {
    s.queue().hold(reason, holdTexts[reason]());
    await s.finish();
  }
  return s;
};

test('a queue held `restart` lets mail through', async t => {
  const s = await heldSession('restart');
  t.deepEqual(s.sent(), ['first'], 'the held entry waits');
  t.is(s.hold()?.reason, 'restart');
  t.deepEqual(s.internal.deliverMail(envelope(1)), { number: 1 });
  await drain();
  t.deepEqual(s.sent(), ['first', 'mail 1']);
});

test('a queue held `stopped` holds mail too', async t => {
  const s = await heldSession('stopped');
  t.is(s.hold()?.reason, 'stopped');
  t.deepEqual(s.internal.deliverMail(envelope(1)), { number: 1 });
  await drain();
  t.deepEqual(s.sent(), ['first']);
  t.is(s.internal.rowSnapshot().activity, 'passive');
});

test('a deleting session refuses a delivery', async t => {
  const s = await makeMailSession();
  s.internal.deleteSelf();
  t.deepEqual(s.internal.deliverMail(envelope(1)), {
    refused: texts.sessionDeleting,
  });
  await drain();
  t.deepEqual(s.sent(), []);
});

test('cancelMail dismisses a waiting message and cancels a handling one', async t => {
  const s = await makeMailSession();
  await s.submit('busy');
  s.internal.deliverMail(envelope(1));
  s.internal.cancelMail(101);
  await s.finish();
  t.deepEqual(s.sent(), ['busy'], 'the dismissed message never starts');

  s.internal.deliverMail(envelope(2));
  await drain();
  t.deepEqual(s.sent(), ['busy', 'mail 2']);
  t.is(s.internal.rowSnapshot().activity, 'working');
  s.internal.cancelMail(102);
  await drain();
  t.is(s.internal.rowSnapshot().activity, 'passive', 'its turn was cancelled');
  // An unknown postmark changes nothing.
  s.internal.cancelMail(999);
  t.is(s.internal.rowSnapshot().activity, 'passive');
});

test('packages: reserve raises the counter; open keeps a reserved number', t => {
  const table = makePackages();
  t.is(table.reserve(), 1);
  t.is(table.reserve(7), 8, 'above an imported number');
  const values = new Map([['doc', harden({})]]);
  t.is(table.open({ number: 1, labels: ['doc'], values, turnId: 't1' }), 1);
  t.is(table.take(1, 'doc', 't1'), values.get('doc'));
  t.is(
    table.open({ labels: [], values: new Map(), turnId: 't2' }),
    9,
    'an unnumbered open takes the next number',
  );
  table.closeTurn('t1');
  t.is(table.size(), 1);
});
