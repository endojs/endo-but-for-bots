// @ts-check

/**
 * One reconciliation of a turn's three views of its tool calls.
 *
 * A turn's tool calls are recorded up to three times: mirrored into the
 * conversation tree as the provider sent them, journaled as what the backend
 * reported it did (guest activity, observed after the fact), and journaled
 * as what Endo itself executed (host tools, written before execution). The
 * history a view renders and the transcript a restored session is given
 * both need one row per call, however many records describe it, without
 * inventing an execution the host did not perform or dropping one it did.
 *
 * The rules are the restoration path's, the stricter of the two this used
 * to be written as:
 *
 * - A backend observation shares the tree's native id and matches a
 *   mirrored call by that id alone. A look-alike call with another id is
 *   never substituted, even when its arguments are identical.
 * - A host execution has an id of its own and matches a call by name and
 *   arguments: the call whose settled result it reproduces, else a call
 *   still waiting for a result, else, when the execution itself never
 *   settled, any call it could be. Executions that settled are matched
 *   before those that did not, so the order the journal started them in
 *   cannot let an execution that hung take the call its retry answered.
 *   Claude's named Endo MCP bridge qualifies the tool name, and only that
 *   exact alias is the same tool.
 * - Every match is one to one, so repeated identical executions stay
 *   visible as repeats.
 * - A match settles a call's result where the call had none, or only a
 *   placeholder for one.
 * - What matches nothing is evidence of its own: an observation under its
 *   native id, an execution under a recovered id namespaced to the turn so
 *   it cannot alias a native one.
 *
 * Texts are compared through the shared comparators, which know a journal
 * preview from a whole; how a journal entry's text is read is the caller's,
 * so the history reader compares previews and the restoration path hydrates
 * whole content first.
 *
 * @module
 */

import { Fail, q } from '@endo/errors';

import { UNSETTLED_TOOL_RESULT } from './hosted-turn.js';
import {
  sameExecutedToolName,
  sameToolArgs,
  sameToolResult,
} from './tool-evidence.js';

/** What a host that cannot say an outcome shows in place of one. */
export const UNKNOWN_TOOL_OUTCOME =
  'Tool outcome unknown; do not automatically retry.';
harden(UNKNOWN_TOOL_OUTCOME);

/**
 * Both placeholders mean "no result was reported"; a record carrying one is
 * unanswered for matching and may be settled by evidence.
 *
 * @param {unknown} result
 */
export const isUnansweredResult = result =>
  result === undefined ||
  result === null ||
  result === UNSETTLED_TOOL_RESULT ||
  result === UNKNOWN_TOOL_OUTCOME;
harden(isUnansweredResult);

/**
 * @typedef {{ args?: boolean, result?: boolean }} TextCuts Which texts are
 *   journal previews rather than wholes.
 */

/**
 * One row of a turn's reconciled tool evidence.
 *
 * @typedef {object} EvidenceRow
 * @property {'tree' | 'guest' | 'host'} source Where the row came from: the
 *   mirrored tree, an unmatched backend observation, or an unmatched host
 *   execution.
 * @property {string} id The id the row is known by: the tree's native id, the
 *   observation's native id, or a recovered id for an execution.
 * @property {string} name
 * @property {string} args
 * @property {string | undefined} result The result text: what settled the
 *   call, or what the tree recorded, which may be a placeholder that
 *   `settled` says is not a result.
 * @property {boolean} settled
 * @property {TextCuts} cut
 * @property {'guest' | 'host' | undefined} settledBy What settled the row's
 *   result when evidence did: a backend observation or a host execution,
 *   of a mirrored call or of an observation the tree never mirrored.
 * @property {boolean} observed Whether a backend observation matched this
 *   row.
 * @property {boolean} executed Whether a host execution matched this row.
 * @property {string} [sequence] Journal position of unmatched evidence.
 * @property {string} [resultSequence] Journal position of a recovered result.
 */

/**
 * @param {object} turn
 * @param {string} turn.turnId
 * @param {ReadonlyArray<{ id: string, name: string, args: string, result?: string | null, cut?: TextCuts }>} turn.known
 *   The calls the tree mirrors, in order.
 * @param {readonly any[]} [turn.activity] What the backend reported, as the
 *   turn journal records it: `callId`, `name`, `settled`, and `args` and
 *   `result` whole or as previews beside `argsRef` and `resultRef`.
 * @param {readonly any[]} [turn.tools] What Endo executed, recorded alike.
 * @param {(tool: any) => Promise<{ args: string, result?: string, cut?: TextCuts }> | { args: string, result?: string, cut?: TextCuts }} turn.read
 *   A journal entry's texts, as the caller reads them: previews with their
 *   cuts, or whole content.
 * @returns {Promise<EvidenceRow[]>}
 */
export const reconcileTurnEvidence = async ({
  turnId,
  known,
  activity = [],
  tools = [],
  read,
}) => {
  /** @type {EvidenceRow[]} */
  const rows = known.map(call => ({
    source: 'tree',
    id: call.id,
    name: call.name,
    args: call.args,
    result: call.result ?? undefined,
    settled: !isUnansweredResult(call.result),
    cut: call.cut ?? {},
    settledBy: undefined,
    observed: false,
    executed: false,
  }));
  const ids = new Set(rows.map(row => row.id));
  // Observations and executions are two views of the same operations. Each
  // source is matched one to one against everything known before it, so an
  // execution can answer an observation the tree never mirrored.
  for (const [source, observed] of /** @type {const} */ ([
    [activity, true],
    [tools, false],
  ])) {
    const unmatched = [...rows];
    /** @type {Array<{ callId: string, name: string, settled: boolean, args: string, result: string | undefined, cut: TextCuts, sequence?: string, resultSequence?: string }>} */
    const entries = [];
    for (const raw of source) {
      // Journal reads are serialized; retain source order for matching.
      // eslint-disable-next-line no-await-in-loop
      const texts = await read(raw);
      const { callId, name } = raw;
      (typeof callId === 'string' && callId !== '') ||
        Fail`journal tool call id must be a non-empty string, not ${q(callId)}`;
      typeof name === 'string' ||
        Fail`journal tool name must be a string, not ${q(name)}`;
      entries.push({
        callId,
        name,
        settled: Boolean(raw.settled),
        args: texts.args,
        result: raw.settled ? texts.result : undefined,
        cut: texts.cut ?? {},
        ...(raw.sequence === undefined ? {} : { sequence: raw.sequence }),
        ...(raw.resultSequence === undefined
          ? {}
          : { resultSequence: raw.resultSequence }),
      });
    }
    /** @typedef {(typeof entries)[number]} Entry */
    /** @type {(row: EvidenceRow, tool: Entry) => boolean} */
    const sameCall = (row, tool) =>
      sameExecutedToolName(row.name, tool.name) &&
      sameToolArgs(
        { text: row.args, cut: row.cut.args },
        { text: tool.args, cut: tool.cut.args },
      );
    /** @type {(row: EvidenceRow, tool: Entry) => boolean} */
    const sameResult = (row, tool) =>
      sameToolResult(
        { text: row.result, cut: row.cut.result },
        { text: tool.result, cut: tool.cut.result },
      );
    /**
     * Match a journal entry to the first unmatched row the predicate
     * accepts, marking and, where the entry settled a call the row had no
     * result for, settling it.
     *
     * @type {(tool: Entry, accepts: (row: EvidenceRow) => boolean) => boolean}
     */
    const take = (tool, accepts) => {
      const at = unmatched.findIndex(accepts);
      if (at < 0) return false;
      const row = unmatched[at];
      if (observed) row.observed = true;
      else row.executed = true;
      if (tool.settled && isUnansweredResult(row.result)) {
        row.result = tool.result;
        row.settled = true;
        row.cut = { ...row.cut, result: tool.cut.result };
        row.settledBy = observed ? 'guest' : 'host';
        if (tool.resultSequence !== undefined)
          row.resultSequence = tool.resultSequence;
      }
      unmatched.splice(at, 1);
      return true;
    };
    /** @type {Array<[number, Entry]>} */
    const unplaced = [];
    if (observed) {
      entries.forEach((tool, index) => {
        take(tool, row => row.id === tool.callId) ||
          unplaced.push([index, tool]);
      });
    } else {
      // Settled executions first: the call whose settled result the
      // execution reproduces, else a call still waiting for a result.
      /** @type {Array<[number, Entry]>} */
      const unsettled = [];
      entries.forEach((tool, index) => {
        if (!tool.settled) unsettled.push([index, tool]);
        else
          take(tool, row => sameCall(row, tool) && sameResult(row, tool)) ||
            take(
              tool,
              row => sameCall(row, tool) && isUnansweredResult(row.result),
            ) ||
            unplaced.push([index, tool]);
      });
      // Then the executions the journal never saw settle: a call still
      // waiting for a result, else any call it could be, since it is one of
      // the calls made whichever way its result went, and that call stays
      // one row.
      for (const [index, tool] of unsettled) {
        take(
          tool,
          row => sameCall(row, tool) && isUnansweredResult(row.result),
        ) ||
          take(tool, row => sameCall(row, tool)) ||
          unplaced.push([index, tool]);
      }
    }
    // What matched nothing is evidence of its own, in the journal's order.
    unplaced.sort(([a], [b]) => a - b);
    for (const [, tool] of unplaced) {
      let id = observed ? tool.callId : `recovered:${turnId}:${tool.callId}`;
      while (ids.has(id)) id = `recovered:${id}`;
      ids.add(id);
      rows.push({
        source: observed ? 'guest' : 'host',
        id,
        name: tool.name,
        args: tool.args,
        result: tool.settled ? tool.result : undefined,
        settled: tool.settled,
        cut: tool.cut,
        settledBy: undefined,
        observed,
        executed: !observed,
        ...(tool.sequence === undefined ? {} : { sequence: tool.sequence }),
        ...(tool.resultSequence === undefined
          ? {}
          : { resultSequence: tool.resultSequence }),
      });
    }
  }
  return rows;
};
harden(reconcileTurnEvidence);
