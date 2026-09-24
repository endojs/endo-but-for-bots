// @ts-check

/**
 * Transcript records as the turns opencode's import route takes, and back.
 *
 * The route (`POST /session/:id/message/import`, in the pinned fork) records
 * each turn without provoking a prompt. A compaction becomes synthetic user
 * text, not a native compaction boundary. The adapter must select the active
 * context before importing it. The translation lives here so the
 * round-trip conformance can judge it without a bridge.
 *
 * @module
 */

import { Fail, q } from '@endo/errors';
import {
  assertTranscriptRecord,
  pairToolCalls,
  selectActiveTranscript,
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
 * The pinned fork's HTTP route writes the legacy MessageTable/PartTable,
 * not the parallel core history store. It does not filter superseded records.
 * Import only the last summary and its active span; Floot retains the full
 * transcript. Pair only that span so a result cannot cross the boundary.
 *
 * @param {readonly TranscriptRecord[]} records
 * @returns {ImportedTurn[]}
 */
export const importedTurnsFor = records => {
  const { active } = selectActiveTranscript(records);
  active.every(record => record.kind !== 'native-context') ||
    Fail`OpenCode cannot restore this backend-specific native context`;
  const { pairs } = pairToolCalls(active, { perTurn: true });
  const resultFor = new Map(pairs.map(pair => [pair.call, pair.result]));
  /** @type {ImportedTurn[]} */
  const turns = [];
  for (const record of active) {
    if (record.kind === 'message') {
      turns.push({ kind: record.role, text: record.content });
    } else if (record.kind === 'compaction') {
      turns.push({ kind: 'compaction', text: record.summary });
    } else if (record.kind === 'tool-call') {
      const result = resultFor.get(record);
      /** @type {Record<string, unknown>} */
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
 * Decode the submitted import payload for adapter round-trip conformance.
 *
 * This is not native database read-back: a compaction payload is represented
 * here as a canonical record, though the route stores synthetic user text.
 * Nothing is filtered here; otherwise the test could hide an adapter that
 * sends superseded context. A turn kind the route does not define is refused,
 * since a kind this module did not write is a kind the route would not accept.
 *
 * @param {readonly any[]} turns
 * @returns {readonly TranscriptRecord[]}
 */
export const readImportedTurns = turns => {
  Array.isArray(turns) || Fail`imported turns must be an array`;
  const records = [];
  for (const turn of turns) {
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
