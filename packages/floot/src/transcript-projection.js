// @ts-check

/**
 * Convert direct-provider messages and recover canonical journal transcripts.
 * Keep tool calls and their results structured: the UI's combined tool rows
 * are presentation, not a source from which to rebuild model context.
 *
 * The system prompt is deliberately dropped. It is the harness's, supplied
 * fresh for the incarnation that is about to run, so replaying a stale one
 * would restore a conversation the session is no longer having.
 *
 * @module
 */

import { Fail } from '@endo/errors';
import {
  assertTranscriptRecord,
  pairToolCalls,
  splitAtLastCompaction,
} from '@endo/hosted-agent/transcript-records.js';

import { assertCompactionCheckpoint } from './compaction-checkpoint.js';
import {
  encodeJournalTranscript,
  transcriptIndex,
} from './journal-transcript.js';
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
 * @param {Iterable<any>} path Direct-provider messages in conversation order.
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
 * Supplement a settled turn's journal transcript with durable execution
 * evidence. The stream may fail before reporting an executed tool. Keep that
 * evidence distinct from backend observations, and never claim it ran twice.
 * Full journal content is required: a preview is not executable JSON.
 *
 * @param {Iterable<any>} messages
 * @param {any} turn
 * @param {(ref: any) => Promise<string>} readContent
 * @param {{ startOrdinal?: number, evidenceAfter?: string }} [selection]
 */
export const recoverTurnTranscript = async (
  messages,
  turn,
  readContent,
  selection = {},
) => {
  const ordered =
    turn.transcript !== undefined || turn.transcriptComplete === true;
  /** @type {TranscriptRecord[]} */
  const records = ordered ? [] : [...projectTranscript(messages)];
  /** @type {Map<TranscriptRecord, bigint>} */
  const positions = new Map();
  /** @param {TranscriptRecord} record */
  const recordedPosition = record => {
    const position = positions.get(record);
    if (position === undefined) throw Fail`Missing recovered record position`;
    return position;
  };
  const positionOf = sequence => {
    (typeof sequence === 'string' && /^[1-9][0-9]*$/.test(sequence)) ||
      Fail`Recovered transcript evidence has no journal position`;
    return BigInt(sequence);
  };
  const add = (record, sequence) => {
    records.push(record);
    if (ordered) positions.set(record, positionOf(sequence));
  };
  if (ordered) {
    let previous = positionOf(turn.turnId);
    /** @type {any[]} */
    const transcript = turn.transcript ?? [];
    for (const [index, entry] of transcript.entries()) {
      transcriptIndex(entry.ordinal, index) === index ||
        Fail`Invalid recovered transcript ordinal`;
      const sequence = positionOf(entry.sequence);
      sequence > previous || Fail`Invalid recovered transcript order`;
      previous = sequence;
      if (
        (selection.evidenceAfter !== undefined ||
          index < (selection.startOrdinal ?? 0)) &&
        !['tool-call', 'tool-result'].includes(entry.kind)
      ) {
        // Selection uses journal-validated kind metadata. Keep tool payloads
        // for exact reconciliation, but do not hydrate superseded prose.
        // eslint-disable-next-line no-continue
        continue;
      }
      // Full immutable content, never its UI preview; works for archived turns too.
      const payload = entry.payloadRef
        ? // eslint-disable-next-line no-await-in-loop
          await readContent(entry.payloadRef)
        : entry.payload;
      const record = JSON.parse(payload);
      encodeJournalTranscript(record) === payload ||
        Fail`Invalid recovered transcript payload`;
      add(assertTranscriptRecord(record), entry.sequence);
    }
  }
  const text = async (value, ref) =>
    ref ? readContent(ref) : argumentText(value);
  if (
    selection.evidenceAfter === undefined &&
    selection.startOrdinal === undefined &&
    !records.some(record => record.kind === 'message' && record.role === 'user')
  ) {
    const input = assertTranscriptRecord({
      kind: 'message',
      role: 'user',
      content: await text(turn.input, turn.inputRef),
    });
    records.unshift(input);
    if (ordered) positions.set(input, positionOf(turn.turnId));
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
  if (selection.evidenceAfter !== undefined) {
    const after = positionOf(selection.evidenceAfter);
    const evidence = [];
    for (const [index, row] of rows.entries()) {
      const canonicalResult = pairs[index]?.result;
      const lateResult =
        (row.resultSequence !== undefined &&
          positionOf(row.resultSequence) > after) ||
        (canonicalResult !== undefined &&
          recordedPosition(canonicalResult) > after);
      if (
        row.source !== 'tree' ||
        !row.settled ||
        row.settledBy === 'host' ||
        lateResult
      ) {
        const id = `recovered-context:${turn.turnId}:${index}`;
        evidence.push(
          assertTranscriptRecord({
            kind: 'tool-call',
            id,
            name: row.name,
            args: row.args,
          }),
          assertTranscriptRecord({
            kind: 'tool-result',
            id,
            content: row.result ?? UNKNOWN_TOOL_OUTCOME,
          }),
        );
      }
    }
    return harden(
      evidence.length
        ? [
            assertTranscriptRecord({
              kind: 'message',
              role: 'assistant',
              content: RECOVERY_NOTICE,
            }),
            ...evidence,
          ]
        : [],
    );
  }
  /** @type {TranscriptRecord[]} */
  const supplemental = [];
  const knownIds = new Set(pairs.map(pair => pair.call.id));
  const boundary = ordered
    ? records.filter(record => record.kind === 'compaction').at(-1)
    : undefined;
  const boundaryPosition = boundary ? recordedPosition(boundary) : undefined;
  const supplement = (row, recoveredResult = false) => {
    if (!supplemental.length)
      supplemental.push(
        assertTranscriptRecord({
          kind: 'message',
          role: 'assistant',
          content: RECOVERY_NOTICE,
        }),
      );
    let id = recoveredResult
      ? `recovered-result:${turn.turnId}:${row.id}`
      : row.id;
    while (knownIds.has(id)) id = `recovered:${id}`;
    knownIds.add(id);
    supplemental.push(
      assertTranscriptRecord({
        kind: 'tool-call',
        id,
        name: row.name,
        args: row.args,
      }),
    );
    if (row.settled)
      supplemental.push(
        assertTranscriptRecord({
          kind: 'tool-result',
          id,
          content: row.result,
        }),
      );
  };
  let recoveryNotice = false;
  for (const [position, row] of rows.entries()) {
    if (row.source === 'tree') {
      if (
        !row.settled &&
        boundaryPosition !== undefined &&
        recordedPosition(pairs[position].call) < boundaryPosition
      ) {
        supplement(row);
      }
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
        const crossesBoundary =
          ordered &&
          boundaryPosition !== undefined &&
          recordedPosition(pairs[position].call) < boundaryPosition &&
          (row.settledBy === 'host' ||
            positionOf(row.resultSequence) > boundaryPosition);
        if (crossesBoundary) supplement(row, true);
        if (index >= 0) {
          records[index] = result;
          if (ordered && previous)
            positions.set(result, recordedPosition(previous));
        } else {
          add(
            result,
            crossesBoundary
              ? `${recordedPosition(pairs[position].call)}`
              : row.resultSequence,
          );
          if (ordered) {
            // Host completion may precede the backend's delayed call report.
            // Never put a result before its known call.
            const callPosition = recordedPosition(pairs[position].call);
            if (recordedPosition(result) < callPosition)
              positions.set(result, callPosition);
          }
        }
      }
      // eslint-disable-next-line no-continue
      continue;
    }
    if (ordered) {
      // Journal chronology is not proof that a native summary covered these
      // effects. Keep unmatched evidence visible after the active context.
      supplement(row);
      // eslint-disable-next-line no-continue
      continue;
    }
    if (!recoveryNotice) {
      add(
        assertTranscriptRecord({
          kind: 'message',
          role: 'assistant',
          content: RECOVERY_NOTICE,
        }),
        row.sequence,
      );
      recoveryNotice = true;
    }
    add(
      assertTranscriptRecord({
        kind: 'tool-call',
        id: row.id,
        name: row.name,
        args: row.args,
      }),
      row.sequence,
    );
    if (row.settled) {
      add(
        assertTranscriptRecord({
          kind: 'tool-result',
          id: row.id,
          content: row.result,
        }),
        row.resultSequence,
      );
    }
  }
  if (ordered) {
    records.sort((left, right) => {
      const a = recordedPosition(left);
      const b = recordedPosition(right);
      return a === b ? 0 : a < b ? -1 : 1;
    });
    records.push(...supplemental);
    if (!turn.transcriptComplete) {
      records.push(
        assertTranscriptRecord({
          kind: 'message',
          role: 'assistant',
          content:
            '[Recovered a durable transcript prefix. The remaining streamed text or events may be missing; do not assume the turn completed.]',
        }),
      );
    }
  }
  if (
    !ordered &&
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
