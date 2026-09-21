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
import {
  sameExecutedToolName,
  sameToolArgs,
  sameToolResult,
} from './tool-evidence.js';
import { UNSETTLED_TOOL_RESULT } from './hosted-turn.js';

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

/**
 * Render full transcript records for a direct chat-completions provider.
 * Pair calls before projecting so repeated native IDs in different turns do
 * not alias, and each replayed call has a result even after an interrupted turn.
 * Thinking remains display-only; this provider has no native compaction store.
 *
 * @param {readonly TranscriptRecord[]} records
 */
export const transcriptToProviderMessages = records => {
  const calls = new Map();
  const pending = new Map();
  for (const [index, record] of records.entries()) {
    if (record.kind === 'message' && record.role === 'user') {
      // Native IDs are only meaningful within a turn. An unanswered call
      // stays unanswered when a later turn reuses its ID.
      pending.clear();
    } else if (record.kind === 'tool-call') {
      const call = { record, id: `floot-history-${index}`, result: undefined };
      calls.set(index, call);
      const queue = pending.get(record.id) || [];
      queue.push(call);
      pending.set(record.id, queue);
    } else if (record.kind === 'tool-result') {
      const call = pending.get(record.id)?.shift();
      if (call) call.result = record.content;
    }
  }
  const messages = [];
  for (const [index, record] of records.entries()) {
    if (record.kind === 'message') {
      messages.push({ role: record.role, content: record.content });
    } else if (record.kind === 'tool-call') {
      const call = calls.get(index);
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: call.id,
            type: 'function',
            function: { name: record.name, arguments: record.args },
          },
        ],
      });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content:
          call.result ?? 'Tool outcome unknown; do not automatically retry.',
      });
    }
  }
  return harden(messages);
};
harden(transcriptToProviderMessages);

/**
 * Supplement a settled turn's mirrored transcript with durable execution
 * evidence. The stream may fail before reporting an executed tool. Keep that
 * evidence distinct from backend observations, and never claim it ran twice.
 * Full journal content is required: a preview is not executable JSON.
 *
 * @param {Iterable<any>} messages
 * @param {any} turn
 * @param {(ref: any) => Promise<string>} readContent
 */
export const recoverTurnTranscript = async (messages, turn, readContent) => {
  const records = [...projectTranscript(messages)];
  const text = async (value, ref) =>
    ref ? readContent(ref) : argumentText(value);
  if (
    !records.some(record => record.kind === 'message' && record.role === 'user')
  ) {
    records.unshift(
      assertTranscriptRecord({
        kind: 'message',
        role: 'user',
        content: await text(turn.input, turn.inputRef),
      }),
    );
  }
  /** @type {Array<{ id: string, name: string, args: string, result: string | undefined }>} */
  const known = [];
  for (const record of records) {
    if (record.kind === 'tool-call')
      known.push({ ...record, result: undefined });
    if (record.kind === 'tool-result') {
      const call = known.findLast(item => item.id === record.id);
      if (call) call.result = record.content;
    }
  }
  const ids = new Set(known.map(call => call.id));
  let recoveryNotice = false;
  const addEvidence = (tool, observed) => {
    if (!recoveryNotice) {
      records.push(
        assertTranscriptRecord({
          kind: 'message',
          role: 'assistant',
          content:
            '[Recovered durable tool evidence. Its position relative to the streamed text is unknown; it does not imply another execution. Verify uncertain outcomes before retrying.]',
        }),
      );
      recoveryNotice = true;
    }
    let id = observed ? tool.callId : `recovered:${turn.turnId}:${tool.callId}`;
    while (ids.has(id)) id = `recovered:${id}`;
    ids.add(id);
    records.push(
      assertTranscriptRecord({
        kind: 'tool-call',
        id,
        name: tool.name,
        args: tool.args,
      }),
    );
    if (tool.settled)
      records.push(
        assertTranscriptRecord({
          kind: 'tool-result',
          id,
          content: tool.result,
        }),
      );
    return id;
  };
  // Observations and executor records are two views of the same operations.
  // Match one-to-one so repeated identical executions remain visible.
  for (const [source, observed] of [
    [turn.activity || [], true],
    [turn.tools || [], false],
  ]) {
    const unmatched = [...known];
    for (const raw of source) {
      const tool = {
        ...raw,
        // Journal reads are serialized; retain source order for matching.
        // eslint-disable-next-line no-await-in-loop
        args: await text(raw.args, raw.argsRef),
        // eslint-disable-next-line no-await-in-loop
        result: raw.settled ? await text(raw.result, raw.resultRef) : undefined,
      };
      const sameCall = call =>
        sameExecutedToolName(call.name, tool.name) &&
        sameToolArgs({ text: call.args }, { text: tool.args });
      // Backend observations share the tree's native ID. Never substitute a
      // look-alike call with another ID, even when its arguments are identical.
      // Executor IDs are independent: prefer an exact settled result before
      // considering an unanswered call with the same arguments.
      const exact = unmatched.findIndex(call =>
        observed
          ? call.id === tool.callId
          : sameCall(call) &&
            tool.settled &&
            sameToolResult({ text: call.result }, { text: tool.result }),
      );
      const match =
        exact >= 0 || observed
          ? exact
          : unmatched.findIndex(
              call =>
                sameCall(call) &&
                (!tool.settled ||
                  call.result === undefined ||
                  call.result === UNSETTLED_TOOL_RESULT ||
                  sameToolResult({ text: call.result }, { text: tool.result })),
            );
      if (match >= 0) {
        const call = unmatched[match];
        if (
          tool.settled &&
          (call.result === undefined || call.result === UNSETTLED_TOOL_RESULT)
        ) {
          const result = assertTranscriptRecord({
            kind: 'tool-result',
            id: call.id,
            content: tool.result,
          });
          const index = records.findIndex(
            record => record.kind === 'tool-result' && record.id === call.id,
          );
          if (index >= 0) records[index] = result;
          else records.push(result);
          call.result = tool.result;
        }
        unmatched.splice(match, 1);
      } else {
        const id = addEvidence(tool, observed);
        known.push({
          id,
          name: tool.name,
          args: tool.args,
          result: tool.result,
        });
      }
    }
  }
  if (
    turn.output &&
    !records.some(
      record =>
        record.kind === 'message' &&
        record.role === 'assistant' &&
        !record.content.startsWith('[Recovered durable tool evidence.'),
    )
  ) {
    records.push(
      assertTranscriptRecord({
        kind: 'message',
        role: 'assistant',
        content: await text(turn.output, turn.outputRef),
      }),
    );
  }
  if (turn.state !== 'completed') {
    const error = turn.errorRef ? await readContent(turn.errorRef) : turn.error;
    records.push(
      assertTranscriptRecord({
        kind: 'message',
        role: 'assistant',
        content: `[Floot turn ${turn.state}${error ? `: ${error}` : '.'}]`,
      }),
    );
  }
  return harden(records);
};
harden(recoverTurnTranscript);
