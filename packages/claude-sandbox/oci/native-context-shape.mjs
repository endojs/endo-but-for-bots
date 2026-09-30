// @ts-check
// The one description of the native-context shape that the in-image capture
// helper (`capture-compaction.mjs`), the in-image restorer's projection
// (`native-context-projection.mjs`) and the trusted host validator
// (`src/claude-context-coverage.js`) all agree on. It runs inside the sandbox
// image as well as in the daemon, so it depends on nothing but the language.
// Native transcript data is not authority: the host re-checks every record
// against this same shape instead of trusting the helper's acceptance.

/** Bytes: the most native context one capture or restoration may carry. */
export const NATIVE_CONTEXT_LIMIT = 16 * 1024 * 1024;

/**
 * The pinned CLI's lowercase hyphenated record identity.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
export const isUuid = value =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);

/**
 * The pinned CLI parents each parallel result to its own assistant tool block.
 * Its loader rejoins those siblings through the assistant API message ID.
 * This one exception is not permission to import an arbitrary earlier branch.
 *
 * @param {any} row Candidate result row.
 * @param {any} parent An already retained native row.
 * @param {string|undefined} messageId The current assistant API message group.
 * @returns {boolean}
 */
export const isNativeToolResultParent = (row, parent, messageId) =>
  typeof messageId === 'string' &&
  messageId.length > 0 &&
  row?.type === 'user' &&
  row.message?.role === 'user' &&
  isUuid(row.parentUuid) &&
  row.sourceToolAssistantUUID === row.parentUuid &&
  parent?.type === 'assistant' &&
  parent.uuid === row.parentUuid &&
  parent.message?.role === 'assistant' &&
  parent.message.id === messageId &&
  Array.isArray(parent.message.content) &&
  parent.message.content.length === 1 &&
  parent.message.content[0]?.type === 'tool_use' &&
  typeof parent.message.content[0].id === 'string' &&
  parent.message.content[0].id.length > 0 &&
  Array.isArray(row.message.content) &&
  row.message.content.length === 1 &&
  row.message.content[0]?.type === 'tool_result' &&
  row.message.content[0].tool_use_id === parent.message.content[0].id;
if (typeof harden === 'function') harden(isNativeToolResultParent);

/** @param {unknown} value */
const strings = value =>
  Array.isArray(value) && value.every(item => typeof item === 'string');

/**
 * @param {object} value
 * @param {readonly string[]} expected
 */
const exactKeys = (value, expected) =>
  Object.keys(value).length === expected.length &&
  expected.every(key => Object.hasOwn(value, key));

/**
 * Loader-generated context the pinned CLI writes to its transcript but not to
 * its public stream. Capture and restoration keep each one byte for byte and
 * in order; none of them is dialogue or evidence that a host effect happened,
 * and the guest may alter its own context. Every accepted shape is closed:
 * exact key sets where the CLI's shape is known, so a message or tool payload
 * cannot ride along inside an "inert" attachment.
 *
 * @param {any} attachment the `attachment` field of a transcript row whose
 * `type` is `'attachment'`
 * @returns {boolean}
 */
export const isNativeAttachment = attachment =>
  attachment?.type === 'total_tokens_reminder' ||
  (attachment?.type === 'max_turns_reached' &&
    Number.isInteger(attachment.maxTurns) &&
    attachment.maxTurns > 0 &&
    Number.isInteger(attachment.turnCount) &&
    attachment.turnCount > 0) ||
  (attachment?.type === 'agent_listing_delta' &&
    exactKeys(attachment, [
      'type',
      'addedTypes',
      'addedLines',
      'removedTypes',
      'isInitial',
      'showConcurrencyNote',
    ]) &&
    strings(attachment.addedTypes) &&
    strings(attachment.addedLines) &&
    strings(attachment.removedTypes) &&
    typeof attachment.isInitial === 'boolean' &&
    typeof attachment.showConcurrencyNote === 'boolean') ||
  (attachment?.type === 'task_reminder' &&
    exactKeys(attachment, ['type', 'content', 'itemCount']) &&
    Array.isArray(attachment.content) &&
    attachment.content.every(
      item => item !== null && typeof item === 'object' && !Array.isArray(item),
    ) &&
    Number.isSafeInteger(attachment.itemCount) &&
    attachment.itemCount >= 0) ||
  (attachment?.type === 'skill_listing' &&
    exactKeys(attachment, [
      'type',
      'content',
      'skillCount',
      'isInitial',
      'names',
    ]) &&
    typeof attachment.content === 'string' &&
    strings(attachment.names) &&
    typeof attachment.skillCount === 'number' &&
    typeof attachment.isInitial === 'boolean');
