// @ts-check

/**
 * The conversation messages a hosted turn commits, from what the backend
 * reported: the segments of text, thinking, compaction and tool rounds in the
 * order they happened, or, for a backend that reports none, one tool round
 * and the reply. One converter serves the completed turn and the turn
 * mirrored after a stop or a failure; they differ only in whether a turn that
 * said nothing still records an empty answer.
 *
 * @module
 */

import { UNSETTLED_TOOL_RESULT } from './hosted-turn.js';

/** @import { HostedTurnSegment } from './hosted-turn.js' */

/**
 * @typedef {{ id: string, name: string, args: string, result: string | null }} HostedToolCall
 */

/**
 * A tool round as the tree records it: one assistant message carrying the
 * calls, then one tool message per call.
 *
 * @param {readonly HostedToolCall[]} calls
 */
const toolRoundMessages = calls => [
  {
    role: 'assistant',
    content: '',
    tool_calls: calls.map(call => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.args },
    })),
  },
  ...calls.map(call => ({
    role: 'tool',
    tool_call_id: call.id,
    // A call the turn ended before settling: say so, rather than record an
    // empty result that reads as a tool still running.
    content: call.result ?? UNSETTLED_TOOL_RESULT,
  })),
];

/**
 * @param {object} turn
 * @param {string} turn.replyText
 * @param {readonly HostedToolCall[]} [turn.toolCalls] The calls of a backend
 *   that reports no segments, as one round before the reply.
 * @param {readonly HostedTurnSegment[]} [turn.segments] What the backend
 *   reported in order. Grouping every call into one assistant message and
 *   concatenating every text run made the transcript read as one long answer
 *   with all tools at the end (and joined split sentences like "Let me write
 *   the review.REVIEW-COMPLETE").
 * @param {boolean} [turn.recordEmptyReply] Whether a turn that said nothing
 *   still commits an empty assistant message: a completed turn does, so its
 *   answer is on record; a mirrored stopped or failed turn does not.
 * @returns {any[]}
 */
export const hostedTurnMessages = ({
  replyText,
  toolCalls = [],
  segments,
  recordEmptyReply = false,
}) => {
  /** @type {any[]} */
  const messages = [];
  if (segments && segments.length > 0) {
    for (const segment of segments) {
      if (segment.type === 'text') {
        if (segment.text) {
          messages.push({ role: 'assistant', content: segment.text });
        }
      } else if (segment.type === 'thinking') {
        messages.push({
          role: 'thinking',
          content: segment.text,
          thinking: {
            startedAt: segment.startedAt,
            endedAt: segment.endedAt,
            truncated: segment.truncated,
          },
        });
      } else if (segment.type === 'compaction') {
        // The boundary the backend drew, kept in place. `projectTranscript`
        // carries it into the record stream, where its position is what
        // tells a restored session which span is still live context.
        messages.push({ role: 'compaction', content: segment.summary || '' });
      } else {
        messages.push(...toolRoundMessages(segment.calls));
      }
    }
    return messages;
  }
  if (toolCalls.length > 0) messages.push(...toolRoundMessages(toolCalls));
  if (replyText || recordEmptyReply) {
    messages.push({ role: 'assistant', content: replyText });
  }
  return messages;
};
harden(hostedTurnMessages);
