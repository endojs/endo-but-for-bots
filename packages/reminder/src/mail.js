// @ts-check

/**
 * The reminder package-message encoding and its mailbox projection.
 *
 * A reminder fires by sending ORDINARY guest package mail addressed to `@self`:
 * a single capability-free JSON string and no attached values, delivered
 * through the tenant guest's existing `send` method. The ephemeral one-shot
 * `ReminderResponse` the scheduler core carries on each in-memory message NEVER
 * enters the mailbox - only the `minion-reminder/v1` fields below are
 * serialized.
 *
 * The consumer reconstructs a reminder event inbox as a filtered, deduplicated
 * PROJECTION of that mailbox (design decision 2), not a new durable store.
 * `projectReminderEvents` keys each event by `{ reminderId, messageNumber }`,
 * so a retry after an ambiguous send outcome - the message may have landed in
 * the mailbox before the send promise rejected - yields exactly one projected
 * event even though two identical package messages are present.
 */

/** @import { ReminderMessage, ReminderEvent } from './types.js' */

/** The schema tag every reminder package message carries. */
export const REMINDER_MESSAGE_SCHEMA = 'minion-reminder/v1';

/**
 * Serialize a scheduler-core reminder message to the capability-free JSON
 * string delivered as ordinary package mail. Drops the ephemeral
 * `reminderResponse` capability and the internal `type` discriminator, keeping
 * only the fields of the `minion-reminder/v1` schema.
 *
 * @param {ReminderMessage} message
 * @returns {string}
 */
export const encodeReminderMessage = message => {
  const {
    reminderId,
    label,
    periodMs,
    messageNumber,
    scheduledAt,
    actualAt,
    missedMessages,
    annotation,
  } = message;
  return JSON.stringify({
    schema: REMINDER_MESSAGE_SCHEMA,
    reminderId,
    label,
    periodMs,
    messageNumber,
    scheduledAt,
    actualAt,
    missedMessages,
    annotation,
  });
};
harden(encodeReminderMessage);

/**
 * Decode one mailbox package message into a reminder event, or `undefined` if
 * it is not a well-formed, capability-free `minion-reminder/v1` package. Rejects
 * any message that carries attached values (`ids`/`names`), so a
 * capability-bearing or otherwise spoofed message can never be projected as a
 * reminder event.
 *
 * @param {any} message - a mailbox `package` message `{ strings, names, ids }`.
 * @returns {ReminderEvent | undefined}
 */
export const decodeReminderPackage = message => {
  if (message === null || typeof message !== 'object') {
    return undefined;
  }
  const { strings, names, ids } = message;
  // A reminder package is exactly one string and carries no attached values.
  if (!Array.isArray(strings) || strings.length !== 1) {
    return undefined;
  }
  if (
    (Array.isArray(ids) && ids.length !== 0) ||
    (Array.isArray(names) && names.length !== 0)
  ) {
    return undefined;
  }
  let parsed;
  try {
    parsed = JSON.parse(strings[0]);
  } catch {
    return undefined;
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    parsed.schema !== REMINDER_MESSAGE_SCHEMA ||
    typeof parsed.reminderId !== 'string' ||
    typeof parsed.messageNumber !== 'number'
  ) {
    return undefined;
  }
  return harden(parsed);
};
harden(decodeReminderPackage);

/**
 * The event identity `{ reminderId, messageNumber }` collapsed to a string key.
 * A NUL joiner keeps ids with embedded separators from colliding.
 *
 * @param {{ reminderId: string, messageNumber: number }} event
 */
const eventKey = event => `${event.reminderId}\u0000${event.messageNumber}`;

/**
 * Project a mailbox into a deduplicated list of reminder events, in first-seen
 * order. The event identity is `{ reminderId, messageNumber }`, so an
 * ambiguous-send retry that leaves two copies of the same firing in the mailbox
 * projects to a single event. Non-reminder and malformed messages are ignored.
 *
 * @param {Iterable<any>} messages - mailbox messages.
 * @returns {ReminderEvent[]}
 */
export const projectReminderEvents = messages => {
  const seen = new Set();
  const events = [];
  for (const message of messages) {
    const event = decodeReminderPackage(message);
    if (event !== undefined) {
      const key = eventKey(event);
      if (!seen.has(key)) {
        seen.add(key);
        events.push(event);
      }
    }
  }
  return harden(events);
};
harden(projectReminderEvents);
