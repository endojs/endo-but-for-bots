// @ts-check

/**
 * @typedef {object} InboxMessage
 * @property {string} type
 * @property {string} from
 * @property {bigint} [number]
 * @property {string} [messageId]
 * @property {string} [replyTo]
 * @property {boolean} [done]
 * @property {string[]} [strings]
 * @property {string[]} [names]
 * @property {string[]} [ids]
 */

/**
 * @param {string[] | undefined} left
 * @param {string[] | undefined} right
 */
const sameStrings = (left, right) => {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
};

/**
 * Replay changes message identity and date, but not the sender, reply key,
 * completion state, or package bytes available to the reader.
 *
 * @param {InboxMessage} left
 * @param {InboxMessage} right
 */
const isSameRepublishedReply = (left, right) =>
  left.type === 'package' &&
  right.type === 'package' &&
  typeof left.replyTo === 'string' &&
  left.from === right.from &&
  left.replyTo === right.replyTo &&
  left.done === right.done &&
  sameStrings(left.strings, right.strings) &&
  sameStrings(left.names, right.names) &&
  sameStrings(left.ids, right.ids);

/**
 * Make a stateful predicate for a mailbox stream. The first publication is
 * admitted and byte-identical republications are hidden.
 *
 * @returns {(message: InboxMessage) => boolean}
 */
export const makeReplyCollapseFilter = () => {
  /** @type {Map<string, Map<string, InboxMessage[]>>} */
  const visibleReplies = new Map();
  return message => {
    if (message.type !== 'package' || typeof message.replyTo !== 'string') {
      return true;
    }
    let repliesByKey = visibleReplies.get(message.from);
    if (repliesByKey === undefined) {
      repliesByKey = new Map();
      visibleReplies.set(message.from, repliesByKey);
    }
    let variants = repliesByKey.get(message.replyTo);
    if (variants === undefined) {
      variants = [];
      repliesByKey.set(message.replyTo, variants);
    }
    if (variants.some(visible => isSameRepublishedReply(visible, message))) {
      return false;
    }
    variants.push(message);
    return true;
  };
};
harden(makeReplyCollapseFilter);

/**
 * Collapse replayed reply publications in a mailbox snapshot while retaining
 * its original order and the first message's identity.
 *
 * @template {InboxMessage} T
 * @param {T[]} messages
 * @returns {T[]}
 */
export const collapseRepublishedReplies = messages =>
  harden(messages.filter(makeReplyCollapseFilter()));
harden(collapseRepublishedReplies);
