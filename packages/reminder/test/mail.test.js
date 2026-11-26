// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import {
  REMINDER_MESSAGE_SCHEMA,
  encodeReminderMessage,
  decodeReminderPackage,
  projectReminderEvents,
} from '../src/mail.js';

/** @import { ReminderMessage } from '../src/types.js' */

/**
 * A scheduler-core in-memory message, complete with the ephemeral response.
 *
 * @param {Record<string, any>} [overrides]
 * @returns {ReminderMessage}
 */
const coreMessage = (overrides = {}) =>
  harden({
    type: 'reminder-message',
    reminderId: 'abc123',
    label: 'heartbeat',
    periodMs: 30_000,
    messageNumber: 1,
    scheduledAt: 1000,
    actualAt: 1005,
    missedMessages: 0,
    annotation: { kind: 'count', count: 1 },
    // A live one-shot response; it must never be serialized.
    reminderResponse: harden({ resolve() {}, reschedule() {} }),
    ...overrides,
  });

/**
 * A mailbox package message wrapping a payload string, capability-free.
 *
 * @param {string} payload
 * @param {Record<string, any>} [overrides]
 */
const packageMessage = (payload, overrides = {}) =>
  harden({
    type: 'package',
    strings: [payload],
    names: [],
    ids: [],
    ...overrides,
  });

test('encodeReminderMessage emits the capability-free v1 schema', t => {
  const json = encodeReminderMessage(coreMessage());
  const parsed = JSON.parse(json);
  t.deepEqual(parsed, {
    schema: REMINDER_MESSAGE_SCHEMA,
    reminderId: 'abc123',
    label: 'heartbeat',
    periodMs: 30_000,
    messageNumber: 1,
    scheduledAt: 1000,
    actualAt: 1005,
    missedMessages: 0,
    annotation: { kind: 'count', count: 1 },
  });
  t.false(json.includes('reminderResponse'), 'the response is dropped');
  t.false(json.includes('reminder-message'), 'the internal type is dropped');
});

test('encode -> decode round-trips a reminder event', t => {
  const json = encodeReminderMessage(
    coreMessage({
      missedMessages: 3,
      annotation: { kind: 'timestamps', scheduledTimes: [1, 2, 3, 4] },
    }),
  );
  const event = decodeReminderPackage(packageMessage(json));
  if (event === undefined) {
    t.fail('expected a decoded reminder event');
    return;
  }
  t.is(event.schema, REMINDER_MESSAGE_SCHEMA);
  t.is(event.missedMessages, 3);
  t.deepEqual(event.annotation, {
    kind: 'timestamps',
    scheduledTimes: [1, 2, 3, 4],
  });
});

test('decodeReminderPackage rejects non-reminder and malformed mail', t => {
  const good = encodeReminderMessage(coreMessage());
  // A plain chat message.
  t.is(decodeReminderPackage(packageMessage('hello there')), undefined);
  // Not JSON.
  t.is(decodeReminderPackage(packageMessage('{not json')), undefined);
  // Wrong schema tag.
  t.is(
    decodeReminderPackage(packageMessage(JSON.stringify({ schema: 'other' }))),
    undefined,
  );
  // More than one string.
  t.is(
    decodeReminderPackage(
      harden({ strings: [good, good], names: [], ids: [] }),
    ),
    undefined,
  );
  // Missing required fields.
  t.is(
    decodeReminderPackage(
      packageMessage(JSON.stringify({ schema: REMINDER_MESSAGE_SCHEMA })),
    ),
    undefined,
  );
  // Not a message object at all.
  t.is(decodeReminderPackage(undefined), undefined);
  t.is(decodeReminderPackage('nope'), undefined);
});

test('decodeReminderPackage rejects a capability-bearing message', t => {
  const good = encodeReminderMessage(coreMessage());
  // Even with a valid payload string, an attached value disqualifies it: a
  // genuine reminder package carries none.
  t.is(
    decodeReminderPackage(packageMessage(good, { ids: ['id:some-cap'] })),
    undefined,
  );
  t.is(
    decodeReminderPackage(packageMessage(good, { names: ['gift'] })),
    undefined,
  );
  // The capability-free form still decodes.
  t.truthy(decodeReminderPackage(packageMessage(good)));
});

test('projectReminderEvents dedupes by {reminderId, messageNumber}', t => {
  const one = encodeReminderMessage(coreMessage({ messageNumber: 1 }));
  const twoSameReminder = encodeReminderMessage(
    coreMessage({ messageNumber: 2 }),
  );
  const oneOtherReminder = encodeReminderMessage(
    coreMessage({ reminderId: 'zzz999', messageNumber: 1 }),
  );

  const mailbox = [
    packageMessage(one), // firing 1
    packageMessage('a chat message'), // ignored
    packageMessage(one), // ambiguous-send duplicate of firing 1
    packageMessage(twoSameReminder), // firing 2
    packageMessage(oneOtherReminder), // a different reminder, message 1
  ];

  const events = projectReminderEvents(mailbox);
  t.is(events.length, 3, 'the duplicate collapses; distinct firings survive');
  t.deepEqual(
    events.map(e => [e.reminderId, e.messageNumber]),
    [
      ['abc123', 1],
      ['abc123', 2],
      ['zzz999', 1],
    ],
    'first-seen order preserved',
  );
});

test('projectReminderEvents on an empty / all-noise mailbox yields nothing', t => {
  t.deepEqual(projectReminderEvents([]), []);
  t.deepEqual(
    projectReminderEvents([packageMessage('hi'), packageMessage('{bad')]),
    [],
  );
});
