// @ts-check

/**
 * Project Floot's own tree into the stack's transcript record stream.
 *
 * Floot stores a conversation in chat-completions shape: `user`, `assistant`
 * and `tool` messages, with an assistant's `tool_calls` carrying ids and each
 * `tool` message answering one of them by `tool_call_id`. That shape is
 * faithful. What was lossy is the next step: `projectHistory` flattens a call
 * and its result into one pseudo-message for the UI, and the old
 * `makeHostedContinuityOptions` serialized that flattening into a prompt. A
 * conversation restored from either reads as prose describing tool use rather
 * than as tool use.
 *
 * This projection keeps the ids, so a restored tool call is a tool call with
 * its result — the property the UI projection was never trying to preserve
 * and an adapter cannot reconstruct afterwards.
 *
 * The system prompt is deliberately dropped. It is the harness's, supplied
 * fresh for the incarnation that is about to run, so replaying a stale one
 * would restore a conversation the session is no longer having.
 *
 * @module
 */

import { assertTranscriptRecord } from '@endo/hosted-agent/transcript-records.js';

/** @typedef {import('@endo/hosted-agent/transcript-records.js').TranscriptRecord} TranscriptRecord */

/**
 * A tool call's arguments as the provider produced them. Providers send them
 * as a JSON string; a provider that sent a structure instead is re-encoded
 * rather than dropped, because the CLI being restored into needs the same
 * argument text the CLI that made the call emitted.
 *
 * @param {unknown} args
 */
const argumentText = args =>
  typeof args === 'string' ? args : JSON.stringify(args ?? {});

/**
 * @param {Iterable<any>} path A linear message path from Floot's tree.
 * @returns {readonly TranscriptRecord[]}
 */
export const projectTranscript = path => {
  /** @type {TranscriptRecord[]} */
  const records = [];
  // Which call ids this path has actually made. A `tool` message answering an
  // id no call announced is dropped rather than emitted: the record stream
  // refuses a result that answers no call, and a tree that somehow holds one
  // should not be able to make a whole conversation unrestorable.
  const announced = new Set();
  /** @param {any} message */
  const project = message => {
    const role = message?.role;
    const content =
      typeof message?.content === 'string' ? message.content : undefined;
    if (role === 'tool') {
      const id = message.tool_call_id;
      if (typeof id === 'string' && announced.has(id)) {
        records.push(
          assertTranscriptRecord({
            kind: 'tool-result',
            id,
            content: content ?? '',
          }),
        );
      }
      return;
    }
    if (role === 'compaction') {
      records.push(
        assertTranscriptRecord({ kind: 'compaction', summary: content ?? '' }),
      );
      return;
    }
    // `system` is the harness's and is not replayed; anything else is not
    // dialogue this stream knows how to carry.
    if (role !== 'user' && role !== 'assistant') return;
    if (content !== undefined && content.trim() !== '') {
      records.push(assertTranscriptRecord({ kind: 'message', role, content }));
    }
    if (role !== 'assistant' || !Array.isArray(message.tool_calls)) return;
    const calls = message.tool_calls.filter(
      (/** @type {any} */ call) =>
        typeof call?.id === 'string' && call.id !== '',
    );
    for (const call of calls) {
      announced.add(call.id);
      records.push(
        assertTranscriptRecord({
          kind: 'tool-call',
          id: call.id,
          name: call.function?.name || 'tool',
          args: argumentText(call.function?.arguments),
        }),
      );
    }
  };
  for (const message of path) project(message);
  return harden(records);
};
harden(projectTranscript);
