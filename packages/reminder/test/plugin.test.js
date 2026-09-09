// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';
import { makeInMemoryFilesystem } from '@endo/platform/fs/extended';

import { make } from '../src/index.js';
import {
  REMINDER_MESSAGE_SCHEMA,
  decodeReminderPackage,
  projectReminderEvents,
} from '../src/mail.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Poll `predicate` until it holds or the timeout elapses. Delivery rides real
 * timers and eventual-sends, so tests wait on a predicate rather than a fixed
 * sleep.
 *
 * @param {() => boolean} predicate
 * @param {{ timeoutMs?: number, stepMs?: number }} [opts]
 */
const waitUntil = async (predicate, { timeoutMs = 2000, stepMs = 10 } = {}) => {
  await null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    // eslint-disable-next-line no-await-in-loop
    await delay(stepMs);
  }
  return predicate();
};

/**
 * Build agent-shaped `powers`: an in-memory VFS store directory and a `send`
 * method that records self-addressed package mail into a mailbox. There is no
 * `reminder-recipient`; delivery rides the guest's ordinary `send` method.
 *
 * `sendBehavior(attempt)` decides each send's fate: `'ok'` fulfills, `'fail'`
 * rejects and lands nothing, `'ambiguous'` records the message in the mailbox
 * AND rejects (the message landed but the send outcome is unknown to the
 * caller).
 *
 * @param {(attempt: number) => 'ok' | 'fail' | 'ambiguous'} [sendBehavior]
 */
const makePowers = async (sendBehavior = () => 'ok') => {
  const fs = makeInMemoryFilesystem();
  const root = await E(fs).root();
  const storeRoot = await E(root).makeDirectory('reminder-store');

  /** @type {any[]} */
  const mailbox = [];
  let attempts = 0;

  const powers = Far('Powers', {
    /** @param {string} name */
    lookup(name) {
      if (name === 'reminder-store') {
        return storeRoot;
      }
      throw Error(`unknown power ${name}`);
    },
    /**
     * @param {string} to
     * @param {string[]} strings
     * @param {string[]} edgeNames
     * @param {string[]} petNames
     */
    async send(to, strings, edgeNames, petNames) {
      attempts += 1;
      const fate = sendBehavior(attempts);
      const message = harden({
        type: 'package',
        to,
        strings: [...strings],
        names: [...edgeNames],
        ids: [...petNames],
      });
      if (fate === 'ok' || fate === 'ambiguous') {
        mailbox.push(message);
      }
      if (fate === 'fail' || fate === 'ambiguous') {
        throw Error('send failed');
      }
    },
  });

  return { powers, storeRoot, mailbox, attemptCount: () => attempts };
};

const noCancelContext = () =>
  Far('Context', {
    // Never cancels during the test; whenCancelled just stays pending.
    whenCancelled: () => new Promise(() => {}),
  });

const fastBackoff = {
  initialMs: 30,
  maxMs: 30,
  multiplier: 1,
  jitterFraction: 0,
};

test('a firing delivers a capability-free package message to @self', async t => {
  const { powers, mailbox } = await makePowers(() => 'ok');
  const service = await make(powers, noCancelContext(), {
    env: { maxActive: '5', minPeriodMs: '1000' },
  });
  const scheduler = await E(service).scheduler();
  const control = await E(service).control();

  // Immediate first message, long period, so exactly one lands in the window.
  await E(scheduler).makeReminder('heartbeat', 30_000, { firstDelayMs: 0 });
  t.true(await waitUntil(() => mailbox.length >= 1), 'one message delivered');
  t.is(mailbox.length, 1);

  const pkg = mailbox[0];
  t.is(pkg.to, '@self', 'addressed to the guest itself');
  t.deepEqual(pkg.names, [], 'no edge names');
  t.deepEqual(pkg.ids, [], 'no attached capabilities');
  t.is(pkg.strings.length, 1, 'a single string carries the payload');
  t.false(
    pkg.strings[0].includes('reminderResponse'),
    'the ephemeral response never enters the mailbox',
  );

  const event = decodeReminderPackage(pkg);
  if (event === undefined) {
    t.fail('expected a decoded reminder event');
    return;
  }
  t.is(event.schema, REMINDER_MESSAGE_SCHEMA);
  t.is(event.reminderId.length > 0, true);
  t.is(event.label, 'heartbeat');
  t.is(event.periodMs, 30_000);
  t.is(event.messageNumber, 1);
  t.is(event.missedMessages, 0);
  t.deepEqual(event.annotation, { kind: 'count', count: 1 });

  await E(control).pause();
});

test('a send failure reschedules the same message', async t => {
  const { powers, mailbox, attemptCount } = await makePowers(() => 'fail');
  const service = await make(powers, noCancelContext(), {
    env: { minPeriodMs: '1000' },
  });
  const scheduler = await E(service).scheduler();
  const control = await E(service).control();

  await E(scheduler).makeReminder('beat', 2000, {
    firstDelayMs: 0,
    backoff: fastBackoff,
  });

  // Every send fails, so the plugin retries: more than one attempt in the window.
  t.true(
    await waitUntil(() => attemptCount() >= 2, { timeoutMs: 1500 }),
    'the plugin retried after the send failure',
  );
  t.is(mailbox.length, 0, 'a failed send lands nothing in the mailbox');

  // The reminder is still live (retrying / re-armed), not cancelled.
  const list = await E(scheduler).list();
  t.is(list.length, 1);
  t.is(list[0].status, 'active');

  await E(control).revoke();
});

test('an ambiguous-send retry projects to exactly one event', async t => {
  // Attempt 1: the message lands in the mailbox but the send rejects
  // (ambiguous). The retry (attempt 2) succeeds and the identical message
  // lands again, so the mailbox holds the same firing twice.
  const { powers, mailbox } = await makePowers(attempt =>
    attempt === 1 ? 'ambiguous' : 'ok',
  );
  const service = await make(powers, noCancelContext(), {
    env: { minPeriodMs: '1000' },
  });
  const scheduler = await E(service).scheduler();
  const control = await E(service).control();

  await E(scheduler).makeReminder('beat', 2000, {
    firstDelayMs: 0,
    backoff: fastBackoff,
  });

  t.true(
    await waitUntil(() => mailbox.length >= 2, { timeoutMs: 1500 }),
    'the ambiguous send is retried and re-delivered',
  );
  t.is(mailbox.length, 2, 'the same firing is in the mailbox twice');

  const [a, b] = mailbox.map(decodeReminderPackage);
  if (a === undefined || b === undefined) {
    t.fail('expected both firings to decode');
    return;
  }
  t.is(a.reminderId, b.reminderId, 'same reminder id');
  t.is(
    a.messageNumber,
    b.messageNumber,
    'same message number across the retry',
  );

  // The mailbox projection keys events by {reminderId, messageNumber}, so the
  // duplicate collapses to one event.
  const events = projectReminderEvents(mailbox);
  t.is(events.length, 1, 'the ambiguous duplicate dedupes to one event');
  t.is(events[0].messageNumber, 1);

  await E(control).revoke();
});

test('revival from the store coalesces missed messages', async t => {
  const { powers, storeRoot, mailbox } = await makePowers(() => 'ok');

  // Seed the VFS store as a prior incarnation would have left it, then let a
  // fresh make() re-incarnate over it - exactly what revivePins() drives when
  // the daemon boots and the plugin rereads its @pins-retained store.
  const remindersDirectory = await E(storeRoot).makeDirectory('reminders');
  const periodMs = 2000;
  const past = Date.now() - 5 * periodMs; // five periods overdue
  const seeded = {
    id: 'seed01',
    label: 'heartbeat',
    periodMs,
    firstDelayMs: 0,
    messageTimeoutMs: periodMs / 2,
    nextTickAt: past,
    createdAt: past,
    messageCount: 3,
    status: 'active',
    catchUpPolicy: 'coalesce',
    annotation: 'count',
    consecutiveFailures: 0,
  };
  await E(remindersDirectory).write(
    'seed01.json',
    `${JSON.stringify(seeded)}\n`,
  );
  await E(storeRoot).write(
    'config.json',
    `${JSON.stringify({ maxActive: 5, minPeriodMs: 1000, paused: false })}\n`,
  );

  const service = await make(powers, noCancelContext(), {});
  const control = await E(service).control();

  t.true(await waitUntil(() => mailbox.length >= 1), 'recovery delivered');
  t.is(mailbox.length, 1, 'missed firings coalesce into one catch-up message');

  const event = decodeReminderPackage(mailbox[0]);
  if (event === undefined) {
    t.fail('expected a decoded reminder event');
    return;
  }
  t.is(event.label, 'heartbeat');
  t.is(event.messageNumber, 4, 'one past the persisted message count');
  t.true(
    event.missedMessages >= 1,
    'the catch-up stands in for missed firings',
  );
  t.deepEqual(event.annotation, {
    kind: 'count',
    count: event.missedMessages + 1,
  });

  await E(control).pause();
});

test('revival with the skip policy delivers nothing for missed firings', async t => {
  const { powers, storeRoot, mailbox } = await makePowers(() => 'ok');

  const remindersDirectory = await E(storeRoot).makeDirectory('reminders');
  const periodMs = 2000;
  const past = Date.now() - 5 * periodMs;
  const seeded = {
    id: 'seed02',
    label: 'still-alive',
    periodMs,
    firstDelayMs: 0,
    messageTimeoutMs: periodMs / 2,
    nextTickAt: past,
    createdAt: past,
    messageCount: 3,
    status: 'active',
    catchUpPolicy: 'skip',
    annotation: 'count',
    consecutiveFailures: 0,
  };
  await E(remindersDirectory).write(
    'seed02.json',
    `${JSON.stringify(seeded)}\n`,
  );

  const service = await make(powers, noCancelContext(), {
    env: { minPeriodMs: '1000' },
  });
  const control = await E(service).control();

  // Give recovery time to run; a skip policy must not deliver a catch-up.
  await delay(200);
  t.is(mailbox.length, 0, 'skip drops the missed firings');

  // The reminder realigned to a future tick and stays active.
  const scheduler = await E(service).scheduler();
  const list = await E(scheduler).list();
  t.is(list.length, 1);
  t.is(list[0].status, 'active');
  t.true(Number(list[0].nextTickAt) > Date.now(), 'realigned to a future tick');

  await E(control).pause();
});

test('make() rejects a malformed env limit', async t => {
  const { powers } = await makePowers();
  await t.throwsAsync(
    () => make(powers, noCancelContext(), { env: { maxActive: 'lots' } }),
    { message: /maxActive must be a non-negative integer/ },
  );
});
