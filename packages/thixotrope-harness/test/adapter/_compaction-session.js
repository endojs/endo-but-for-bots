// @ts-check
// Test helpers for the adapter's compaction step (resources/agent-host/impl/
// providers/compaction-round.js) and the context cache's rebase: a session
// side built from the real record log (its guards check every record), the
// real context window (guest/session/compaction.js) and the real
// ContextSource, RoundRequests built as turn.js builds them (append = every
// record since the previous request), and a TurnSink built with the real
// guard whose `compacted` answers as the compaction part and the runner do
// (contract 4.2: the boundary checked, `compaction` or `compaction-skipped`
// recorded, the next `{ base, append }` answered). Import after the guest
// prelude.
/* eslint-disable import/no-relative-packages */
import { interfaces } from '../../guest/lib/interfaces.js';
import {
  compactionTexts,
  contextLimits,
} from '../../guest/lib/guards/context.js';
import { inCallOrder, makeRecordLog } from '../../guest/session/records.js';
import { makeContextSource } from '../../guest/session/context-source.js';
import { makeContextWindow } from '../../guest/session/compaction.js';
/* eslint-enable import/no-relative-packages */
import { USAGE } from './_m1b-context.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, makeExo } = /** @type {GuestGlobals} */ (globalThis);

const AT = 1_700_000_000_000;

/**
 * @typedef {object} SinkFaults
 * @property {(result: any) => 'refuse' | 'break' | undefined} [beforeCompacted]
 *   K4: `refuse` answers `go: false` (the lease broke first and recovery
 *   ran), `break` rejects (the session is lost)
 * @property {(result: any) => void} [afterCompacted] K4: runs after the
 *   record (the frame was journaled first), before the answer
 */

export const makeCompactingSession = () => {
  const records = makeRecordLog();
  const window = makeContextWindow({ records });
  const context = makeContextSource({
    records,
    boundary: () => window.boundary(),
  });
  const session = Far('Session', {});
  let sent = 0;
  let turns = 0;
  /** @type {any} */
  let ask;
  /** @type {string | undefined} */
  let currentInput;

  /** @param {any} record */
  const append = record => records.append(harden(record));

  /** @param {number} count */
  const baseOf = count => harden({ count, ...window.baseFields() });

  /** The records since the previous request (turn.js `sendSince`). */
  const since = () => {
    const from = Math.max(sent, records.base());
    const to = records.count();
    sent = to;
    return { from, append: harden(inCallOrder(records.since(from))) };
  };

  /**
   * A completed turn of history: one round per entry of `replies`; a round
   * with `calls` records that many echo calls and their results.
   * @param {object} [options]
   * @param {string} [options.input]
   * @param {Array<{ text?: string, calls?: number, result?: string }>} [options.replies]
   * @param {string} [options.status]
   */
  const historyTurn = ({
    input,
    replies = [{ text: 'done' }],
    status = 'completed',
  } = {}) => {
    turns += 1;
    const turnId = `t${turns}`;
    const start = append({
      kind: 'turn-started',
      turnId,
      input: input ?? `input of ${turnId}`,
      at: AT,
    });
    append({ kind: 'dispatched', turnId, round: 0 });
    /** @type {number[]} */
    const settled = [];
    replies.forEach(({ text = '', calls = 0, result = 'ok' }, round) => {
      settled.push(
        append({
          kind: 'round-settled',
          turnId,
          round,
          text,
          callCount: calls,
          usage: USAGE,
          at: AT,
        }),
      );
      if (calls === 0) return;
      const intents = [];
      for (let i = 0; i < calls; i += 1) {
        intents.push(
          harden({
            opId: `${turnId}/${round}/${i}`,
            callId: '',
            name: 'echo',
            args: '{}',
          }),
        );
      }
      append({ kind: 'tool-intents', turnId, round, intents });
      for (const intent of intents) {
        append({
          kind: 'tool-result',
          turnId,
          opId: intent.opId,
          name: 'echo',
          result,
          failed: false,
        });
      }
    });
    append({ kind: 'turn-settled', turnId, status, at: AT });
    return harden({ turnId, start, settled });
  };

  /**
   * Start the current turn (its TurnStarted) and answer its id and index.
   * @param {string} [input]
   */
  const startTurn = (input = 'the current request') => {
    turns += 1;
    const turnId = `t${turns}`;
    currentInput = input;
    const start = append({ kind: 'turn-started', turnId, input, at: AT });
    return harden({ turnId, start });
  };

  /**
   * The compaction part's ask before `round` (4.1): `compaction-started`
   * recorded at `askedAt`; a reading of 80 used of a 100-token window.
   * @param {string} turnId
   * @param {number} round
   * @param {number} startIndex
   */
  const askFor = (turnId, round, startIndex) => {
    const epoch = window.epoch() + 1;
    const boundary = window.boundary();
    const askedAt = append({
      kind: 'compaction-started',
      turnId,
      round,
      epoch,
      boundary,
      usedTokens: 80,
      windowTokens: 100,
      at: AT,
    });
    ask = harden({
      epoch,
      boundary,
      askedAt,
      startIndex,
      floor: window.floor(),
      usedTokens: 80,
      windowTokens: 100,
      thresholdTokens: Math.floor(
        (100 * contextLimits.compactionThresholdPercent) / 100,
      ),
    });
    return ask;
  };

  /**
   * A RoundRequest for the provider (as turn.js `roundRequest` builds it).
   * @param {object} options
   * @param {any} options.turn
   * @param {any} options.sink
   * @param {string} options.turnId
   * @param {number} options.round
   * @param {any} [options.compaction]
   * @param {any[]} [options.tools]
   * @param {string} [options.modelId]
   */
  const request = ({
    turn,
    sink,
    turnId,
    round,
    compaction,
    tools = [],
    modelId = 'model-under-test',
  }) => {
    const { from, append: appended } = since();
    return harden({
      turn,
      sink,
      turnId,
      round,
      base: baseOf(from),
      append: appended,
      tools,
      options: { modelId },
      context,
      ...(compaction === undefined ? {} : { compaction }),
    });
  };

  /**
   * Crank Y as the runner and the compaction part answer it (4.2).
   * @param {string} turnId
   * @param {any} result
   * @returns {any} a CompactionReply
   */
  const compacted = (turnId, result) => {
    const asked = ask;
    ask = undefined;
    if (asked === undefined) return harden({ go: false });
    const { round, at } = result;
    if (result.outcome === 'done') {
      const b = Number(result.boundary);
      if (
        Number(asked.boundary) < b &&
        Number(asked.floor) <= b &&
        b <= Number(asked.askedAt) &&
        window.isCut(b)
      ) {
        append({
          kind: 'compaction',
          turnId,
          round,
          epoch: asked.epoch,
          boundary: b,
          summary: result.summary,
          at,
          ...(b > Number(asked.startIndex) ? { directive: currentInput } : {}),
        });
        window.apply({ epoch: asked.epoch, boundary: b });
      } else {
        append({
          kind: 'compaction-skipped',
          turnId,
          round,
          reason: compactionTexts.invalidBoundary,
          at,
        });
      }
    } else {
      append({
        kind: 'compaction-skipped',
        turnId,
        round,
        reason: result.reason,
        at,
      });
    }
    const { from, append: appended } = since();
    return harden({ go: true, base: baseOf(from), append: appended });
  };

  return harden({
    records,
    window,
    context,
    session,
    append,
    historyTurn,
    startTurn,
    askFor,
    request,
    compacted,
    /** Mark the records sent (a request that is not built here). */
    skipSent: () => {
      sent = records.count();
    },
  });
};

/**
 * A Turn and a TurnSink built with the real guards; `dispatching(0)`
 * records `dispatched` as the session does; `compacted` answers through
 * `session.compacted` unless a fault says otherwise.
 * @param {ReturnType<typeof makeCompactingSession>} session
 * @param {string} turnId
 * @param {SinkFaults} [faults]
 */
export const makeTurnSink = (session, turnId, faults = {}) => {
  /** @type {any[]} */
  const finals = [];
  /** @type {any[]} */
  const failures = [];
  /** @type {any[]} */
  const compactions = [];
  const status = harden({ turnId, state: 'running', round: 0, at: 0 });
  const turn = makeExo('Turn', interfaces.Turn, {
    getStatus: () => status,
    cancel: () => undefined,
    whenFinished: async () => status,
    resolve: () => undefined,
    getContent: () => harden({ records: [] }),
  });
  const sink = makeExo('TurnSink', interfaces.TurnSink, {
    dispatching: () => {
      session.append({ kind: 'dispatched', turnId, round: 0 });
      return true;
    },
    roundFinal: (/** @type {any} */ r) => {
      finals.push(r);
    },
    roundFailed: (/** @type {any} */ f) => {
      failures.push(f);
    },
    deadline: () => undefined,
    progress: () => true,
    compacted: (/** @type {any} */ result) => {
      compactions.push(result);
      const fault = faults.beforeCompacted?.(result);
      if (fault === 'break') throw Error('the session vat is lost');
      if (fault === 'refuse') return harden({ go: false });
      const reply = session.compacted(turnId, result);
      faults.afterCompacted?.(result);
      return reply;
    },
  });
  return { turn, sink, finals, failures, compactions };
};
