// @ts-check

/**
 * Transcript records as the turns opencode's import route takes, and back.
 *
 * The route (`POST /session/:id/messages/import`, in the pinned fork) records
 * each turn as its own message: a user turn as a `synthetic` message so it
 * describes a turn without provoking one, an assistant turn as text, a tool
 * turn as a tool message carrying both the call and its result, and a
 * compaction as the boundary message opencode's own history assembly selects
 * from. The translation lives here rather than in the client so the
 * round-trip conformance can judge it without a bridge.
 *
 * @module
 */

import { Fail, q } from '@endo/errors';
import {
  assertTranscriptRecord,
  pairToolCalls,
} from '@endo/hosted-agent/transcript-records.js';

/** @typedef {import('@endo/hosted-agent/transcript-records.js').TranscriptRecord} TranscriptRecord */

/**
 * @typedef {{ kind: 'user' | 'assistant', text: string }
 *   | { kind: 'compaction', text: string }
 *   | { kind: 'tool', callID: string, name: string, input: Record<string, unknown>, output: string, failed?: true }} ImportedTurn
 */

/**
 * Transcript records as the turns opencode's import route takes.
 *
 * A tool call and its result become one imported turn, because that is what
 * they are: the route records a tool message carrying both, and splitting them
 * would produce a call the store shows as never having returned. A call the
 * turn never settled still gets an output saying so, so an interrupted turn
 * restores as interrupted rather than as a message that never returned.
 *
 * Every record is sent, including the span before a compaction: opencode keeps
 * the whole history and assembles the model's context from the latest
 * compaction message onward (`packages/core/src/session/history.ts`), so the
 * boundary is restored as the row the CLI selects on rather than by the stack
 * trimming what it sends.
 *
 * @param {readonly TranscriptRecord[]} records
 * @returns {ImportedTurn[]}
 */
export const importedTurnsFor = records => {
  const { pairs } = pairToolCalls(records);
  const resultFor = new Map(pairs.map(pair => [pair.call, pair.result]));
  /** @type {ImportedTurn[]} */
  const turns = [];
  for (const record of records) {
    if (record.kind === 'message') {
      turns.push({ kind: record.role, text: record.content });
    } else if (record.kind === 'compaction') {
      turns.push({ kind: 'compaction', text: record.summary });
    } else if (record.kind === 'tool-call') {
      const result = resultFor.get(record);
      let input = {};
      try {
        const parsed = JSON.parse(record.args);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          input = parsed;
        } else {
          input = { value: parsed };
        }
      } catch {
        input = { value: record.args };
      }
      turns.push({
        kind: 'tool',
        callID: record.id,
        name: record.name,
        input,
        output: result ? result.content : 'Tool call did not complete.',
        ...(result?.failed ? { failed: true } : {}),
      });
    }
    // A `tool-result` was folded into its call above.
  }
  return turns;
};
harden(importedTurnsFor);

/**
 * Read imported turns back as the records opencode would carry as the
 * session's active context: the inverse of `importedTurnsFor`, for the
 * round-trip conformance.
 *
 * This reads the turns the way opencode's history assembly does — everything
 * from the latest compaction onward — because that is what the model is shown
 * after a revival, and it is the property the compaction round trip has to
 * judge. A turn kind the route does not define is refused rather than skipped,
 * since a kind this module did not write is a kind the route would not accept.
 *
 * @param {readonly any[]} turns
 * @returns {readonly TranscriptRecord[]}
 */
export const readImportedTurns = turns => {
  Array.isArray(turns) || Fail`imported turns must be an array`;
  let boundary = -1;
  for (const [index, turn] of turns.entries()) {
    if (turn?.kind === 'compaction') boundary = index;
  }
  const records = [];
  for (const turn of turns.slice(boundary < 0 ? 0 : boundary)) {
    if (turn?.kind === 'user' || turn?.kind === 'assistant') {
      records.push({ kind: 'message', role: turn.kind, content: turn.text });
    } else if (turn?.kind === 'compaction') {
      records.push({ kind: 'compaction', summary: turn.text });
    } else if (turn?.kind === 'tool') {
      // The input is what the CLI holds. An argument string that was not a
      // JSON object went in wrapped as `{ value }`, and that is what comes
      // back: the read-back reports the store, it does not guess at the
      // record that produced it.
      records.push({
        kind: 'tool-call',
        id: turn.callID,
        name: turn.name,
        args: JSON.stringify(turn.input),
      });
      records.push({
        kind: 'tool-result',
        id: turn.callID,
        content: turn.output,
        ...(turn.failed ? { failed: true } : {}),
      });
    } else {
      throw Fail`imported turn kind ${q(turn?.kind)} is not one the import route defines`;
    }
  }
  return harden(records.map(assertTranscriptRecord));
};
harden(readImportedTurns);
