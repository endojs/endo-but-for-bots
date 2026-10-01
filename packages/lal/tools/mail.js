// @ts-check
/**
 * Mail / inbox tools: enumerating messages and responding to them via
 * resolve, reject, dismiss, request, send, reply, editMessage, and
 * messageHistory.
 *
 * (Note: `adopt` is mail-triggered but petname-shaped in effect and lives
 * in petnames.js with the other directory mutators.)
 *
 * @import { Pattern } from '@endo/patterns'
 */

import { M } from '@endo/patterns';
import { NamePathArgumentShape } from '@endo/daemon/type-guards.js';

/** @import { LalToolDef } from './index.js' */

const MessageNumberShape = M.or(M.bigint(), M.number());

/** @type {LalToolDef[]} */
export const mailToolDefs = harden([
  // --- Mail operations ---
  {
    name: 'listMessages',
    summary:
      'List all messages in your inbox. Returns an array of message objects ' +
      'with number, date, from, type, and content. No arguments.',
    params: M.splitRecord({}),
  },
  {
    name: 'resolve',
    summary:
      'Respond to a request message by providing a named value. ' +
      'Arguments: messageNumber (BigInt encoded as "+N", e.g. "+5"), petNamePath.',
    params: M.splitRecord({
      messageNumber: MessageNumberShape,
      petNamePath: NamePathArgumentShape,
    }),
  },
  {
    name: 'reject',
    summary:
      'Decline a request message. The requester receives an error. ' +
      'Arguments: messageNumber (BigInt encoded as "+N", e.g. "+5"), optional reason (string).',
    params: M.splitRecord(
      { messageNumber: MessageNumberShape },
      { reason: M.string() },
    ),
  },
  {
    name: 'dismiss',
    summary:
      'Remove a message from your inbox. Use after you have processed a message. ' +
      'Argument: messageNumber (BigInt encoded as "+N", e.g. "+5").',
    params: M.splitRecord({ messageNumber: MessageNumberShape }),
  },
  {
    name: 'request',
    summary:
      'Send a request to another agent asking for a capability. ' +
      'Arguments: recipientNamePath, description (string), optional responseNamePath.',
    params: M.splitRecord(
      { recipientNamePath: NamePathArgumentShape, description: M.string() },
      { responseNamePath: NamePathArgumentShape },
    ),
  },
  {
    name: 'send',
    summary:
      'Send a package message with values to another agent. ' +
      'Arguments: recipientNamePath, strings (string[]), edgeNames (string[]), petNamePaths. ' +
      'For text-only messages: send(["@host"], ["text"], [], []).',
    params: M.splitRecord({
      recipientNamePath: NamePathArgumentShape,
      strings: M.arrayOf(M.string()),
      edgeNames: M.arrayOf(M.string()),
      petNamePaths: M.arrayOf(NamePathArgumentShape),
    }),
  },
  {
    name: 'reply',
    summary:
      'Reply to a message in your inbox, threading the response to the original message. ' +
      'Use this instead of send() when responding to a received message. ' +
      'Arguments: messageNumber (BigInt encoded as "+N", e.g. "+3"), strings (string[]), edgeNames (string[]), petNamePaths.',
    params: M.splitRecord({
      messageNumber: MessageNumberShape,
      strings: M.arrayOf(M.string()),
      edgeNames: M.arrayOf(M.string()),
      petNamePaths: M.arrayOf(NamePathArgumentShape),
    }),
  },

  {
    name: 'editMessage',
    summary: `\
Replace the interior of a message you previously sent.

Use to correct a prior reply, settle a "Thinking..." placeholder into a
final answer, or amend a settled message. Only the original sender may
edit. The message keeps its number and reply-linkage; the prior revision
is preserved in messageHistory.

Pairs with the daemon editMessage capability.
Pass done: false to mark a partial submission (recipient should show a
progress indicator); pass done: true (or omit) once the message has
settled.`,
    parameters: {
      type: 'object',
      properties: {
        messageNumber: {
          type: 'string',
          description:
            'The outbound message number (BigInt) to edit. Use SmallCaps format: "+5" for message 5.',
        },
        strings: {
          type: 'array',
          items: { type: 'string' },
          description:
            'New text fragments. Length should be edgeNames.length + 1.',
        },
        edgeNames: {
          type: 'array',
          items: { type: 'string' },
          description: 'Labels for the values being sent.',
        },
        petNamePaths: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' }, minItems: 1 },
          description:
            'Pet-name paths of the values to include (same length as edgeNames). ' +
            'Each is an array of path segments, e.g. ["counter"] or ["dir", "counter"].',
        },
        done: {
          type: 'boolean',
          description:
            'Defaults to true. Pass false to mark this revision as a partial submission.',
        },
      },
      required: ['messageNumber', 'strings', 'edgeNames', 'petNamePaths'],
    },
  },

  {
    name: 'messageHistory',
    summary: `\
Return the ordered revision history of a message in your inbox or
outbox.  Useful when an inbound message was edited after you began
work and you need to know what the earlier text said.  Returns an
array of revisions, oldest first; the last entry is the current
message.

Pairs with the daemon messageHistory capability.`,
    parameters: {
      type: 'object',
      properties: {
        messageNumber: {
          type: 'string',
          description:
            'The message number (BigInt) to inspect. Use SmallCaps format: "+5" for message 5.',
        },
      },
      required: ['messageNumber'],
    },
  },
]);
