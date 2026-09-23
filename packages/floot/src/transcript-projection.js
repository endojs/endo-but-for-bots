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

import {
  assertTranscriptRecord,
  pairToolCalls,
  splitAtLastCompaction,
} from '@endo/hosted-agent/transcript-records.js';

import { assertCompactionCheckpoint } from './compaction-checkpoint.js';
import {
  UNKNOWN_TOOL_OUTCOME,
  reconcileTurnEvidence,
} from './turn-evidence.js';

/**
 * What a restored transcript says before recovered evidence: its position
 * relative to the streamed text is unknown, and it does not imply another
 * execution. The restoration path also recognizes it, so a recovered turn
 * still gets its joined output when that is all the assistant said.
 */
export const RECOVERY_NOTICE =
  '[Recovered durable tool evidence. Its position relative to the streamed text is unknown; it does not imply another execution. Verify uncertain outcomes before retrying.]';
harden(RECOVERY_NOTICE);

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
  // How many calls of each id this turn has made and not yet answered. A
  // `tool` message answering no open call is dropped rather than emitted,
  // whether its id was never announced, was already answered, or belongs to
  // an earlier turn: the record stream pairs each result with the earliest
  // unanswered call of its id and refuses one that answers no call, and a
  // tree that somehow holds one should not be able to make a whole
  // conversation unrestorable. Native ids are only meaningful within a turn,
  // so a user message starts the pairing afresh, as the replay's does.
  /** @type {Map<string, number>} */
  const open = new Map();
  /** @param {any} message */
  const project = message => {
    const role = message?.role;
    const content =
      typeof message?.content === 'string' ? message.content : undefined;
    if (role === 'tool') {
      const id = message.tool_call_id;
      const count = typeof id === 'string' ? (open.get(id) ?? 0) : 0;
      if (count > 0) {
        open.set(id, count - 1);
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
        assertCompactionCheckpoint({
          kind: 'compaction',
          summary: content ?? '',
          ...(Object.hasOwn(message, 'retainedTail')
            ? { retainedTail: message.retainedTail }
            : {}),
        }),
      );
      return;
    }
    // `system` is the harness's and is not replayed; anything else is not
    // dialogue this stream knows how to carry.
    if (role !== 'user' && role !== 'assistant') return;
    if (content !== undefined && content.trim() !== '') {
      records.push(assertTranscriptRecord({ kind: 'message', role, content }));
      if (role === 'user') open.clear();
    }
    if (role !== 'assistant' || !Array.isArray(message.tool_calls)) return;
    const calls = message.tool_calls.filter(
      (/** @type {any} */ call) =>
        typeof call?.id === 'string' && call.id !== '',
    );
    for (const call of calls) {
      open.set(call.id, (open.get(call.id) ?? 0) + 1);
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
 * Thinking remains display-only. The latest recorded compaction supplies the
 * opening summary; superseded history must not become active context again.
 *
 * @param {readonly TranscriptRecord[]} records
 */
export const transcriptToProviderMessages = records => {
  const { active } = splitAtLastCompaction(records);
  // Pair within each turn: an unanswered call stays unanswered when a later
  // turn reuses its native id.
  const { pairs } = pairToolCalls(active, { perTurn: true });
  const resultOf = new Map(pairs.map(pair => [pair.call, pair.result]));
  const messages = [];
  for (const [index, record] of active.entries()) {
    if (record.kind === 'message') {
      messages.push({ role: record.role, content: record.content });
    } else if (record.kind === 'compaction') {
      // Model-authored context, never elevated to a harness/system instruction.
      messages.push({ role: 'assistant', content: record.summary });
    } else if (record.kind === 'tool-call') {
      const id = `floot-history-${index}`;
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id,
            type: 'function',
            function: { name: record.name, arguments: record.args },
          },
        ],
      });
      messages.push({
        role: 'tool',
        tool_call_id: id,
        content: resultOf.get(record)?.content ?? UNKNOWN_TOOL_OUTCOME,
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
  // One turn's records pair as a whole: a turn's node sequence carries its
  // user message first and its tool traffic after, never a user message
  // between a call and its result, so pairing here and the per-turn pairing
  // of the replay place the same results.
  const { pairs } = pairToolCalls(records);
  const rows = await reconcileTurnEvidence({
    turnId: turn.turnId,
    known: pairs.map(({ call, result }) => ({
      id: call.id,
      name: call.name,
      args: call.args,
      result: result?.content,
    })),
    activity: turn.activity,
    tools: turn.tools,
    // Full journal content is required: a preview is not executable JSON.
    read: async raw => ({
      args: await text(raw.args, raw.argsRef),
      result: raw.settled ? await text(raw.result, raw.resultRef) : undefined,
    }),
  });
  let recoveryNotice = false;
  for (const [position, row] of rows.entries()) {
    if (row.source === 'tree') {
      if (row.settledBy) {
        // The rows the tree contributed come first, in the pairs' order, so
        // the settled result replaces the record its own pair holds (a
        // placeholder), or answers the call when the pair holds none; a
        // repeated id in the turn keeps its other answers.
        const result = assertTranscriptRecord({
          kind: 'tool-result',
          id: row.id,
          content: row.result,
        });
        const previous = pairs[position].result;
        const index = previous ? records.indexOf(previous) : -1;
        if (index >= 0) records[index] = result;
        else records.push(result);
      }
      // eslint-disable-next-line no-continue
      continue;
    }
    if (!recoveryNotice) {
      records.push(
        assertTranscriptRecord({
          kind: 'message',
          role: 'assistant',
          content: RECOVERY_NOTICE,
        }),
      );
      recoveryNotice = true;
    }
    records.push(
      assertTranscriptRecord({
        kind: 'tool-call',
        id: row.id,
        name: row.name,
        args: row.args,
      }),
    );
    if (row.settled) {
      records.push(
        assertTranscriptRecord({
          kind: 'tool-result',
          id: row.id,
          content: row.result,
        }),
      );
    }
  }
  if (
    turn.output &&
    !records.some(
      record =>
        record.kind === 'message' &&
        record.role === 'assistant' &&
        record.content !== RECOVERY_NOTICE,
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
