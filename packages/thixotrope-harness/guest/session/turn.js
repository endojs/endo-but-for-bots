// @ts-check
/**
 * The session's turn side (M1a W1a.4; architecture 4.1-4.3;
 * `designs/m1a-interfaces.md` sections 3.1, 4, 5 and 6).
 *
 * One turn at a time. A turn is claimed atomically (crank A: `TurnStarted`
 * appended, the queue entry removed, `Backend.open` sent), gets its ports
 * (crank B: publish, lease, round 0), is dispatched (crank C), and runs
 * rounds (crank D per `roundFinal`, one crank per tool result) until a round
 * without tool calls, the round limit, a failure, cancel, or recovery
 * settles it. The loop body is `runAgenticTurn` (guest/lib/turn-engine.js):
 * its callbacks are this module's crank steps, and each `await` that waits
 * for the adapter spans a delivery.
 *
 * Crank structure (the reason for most of the shape of this module):
 * - Intent before effect: every record is appended in the crank that sends
 *   the message it precedes, before the send (`ToolIntents` before any
 *   `execute`, `TurnStarted` before `open`).
 * - One publish per crank: events of a crank are collected in an outbox and
 *   published once, at the point where the crank's work ends. A delivery
 *   handler that hands control to the engine (a valid `roundFinal`, the last
 *   tool result of a round) does not publish; the engine's next stop does
 *   (`startRound`, a wait for tool results, or the settle). Every other
 *   handler publishes at its end. Inside a turn the publish is `sendOnly`
 *   through the turn's publisher; outside a turn it is answered (live.js).
 * - The lease: `E(endpoint).holdTurn(turn)` is answered only by
 *   `releaseTurn`; a retired break from it is the restart signal and runs
 *   `recoverAfterRestart` (W1a.5). So is a retired break from an adapter
 *   tool (never recorded as a tool failure).
 *
 * Data-keyed state lives in `Map`s (rule 12.10); records and events use the
 * closed shapes of `guest/lib/interfaces.js`.
 */
import { interfaces, shapes, texts, textOf } from '../lib/interfaces.js';
import { limits } from '../lib/limits.js';
import { runAgenticTurn } from '../lib/turn-engine.js';
import {
  boundToolOutput,
  fitsFrame,
  utf8Bytes,
  previewText,
} from '../lib/bounded.js';
import { inCallOrder } from './records.js';
import { toolSetFor, toolTable } from './tool-table.js';
import { turnHooks } from './turn-hooks.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { RecordLog } from './records.js' */
/** @import { LivePublishing } from './live.js' */
const { E, Fail, defineExoClass, makePromiseKit, matches } =
  /** @type {GuestGlobals} */ (globalThis);

/** Rejection reason of an engine wait whose turn settled meanwhile. */
const SETTLED = harden(Error('turn settled'));

/**
 * Result of a call the turn never ran because it was cancelled first
 * (harness text, not a spec text; the model sees it on the next turn).
 */
export const CANCELLED_BEFORE_RUN =
  'the turn was cancelled before this call ran';

/** Bytes kept free in a history page for its wrapper. */
const PAGE_SLACK = 512;
/** Bytes one ToolIntents record may take in a preview. */
const PREVIEW_INTENTS_BYTES = 6144;

/** @param {unknown} error */
const messageOf = error => {
  if (typeof error === 'object' && error !== null) {
    try {
      const { message } = /** @type {{ message?: unknown }} */ (error);
      if (typeof message === 'string') return message;
    } catch {
      // fall through
    }
  }
  return `${error}`;
};

/**
 * Exact UTF-8 bytes of the strings (keys included) of a plain record tree:
 * records, arrays, strings, numbers, booleans. Cheaper than `messageBytes`,
 * which asks `passStyleOf` about every node; for the vat's own records,
 * which hold no remotables.
 * @param {unknown} value
 * @returns {number}
 */
const plainBytes = value => {
  if (typeof value === 'string') return utf8Bytes(value);
  if (typeof value !== 'object' || value === null) return 0;
  let total = 0;
  if (Array.isArray(value)) {
    for (const item of value) total += plainBytes(item);
    return total;
  }
  for (const key of Object.keys(value)) {
    total += key.length + plainBytes(/** @type {any} */ (value)[key]);
  }
  return total;
};

/** @param {string} text */
const reason = text => previewText(text, limits.reasonUnits);

const zeroUsage = () => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
});
const COUNT_KEYS = harden([
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'reasoningOutputTokens',
]);

/**
 * @typedef {object} TurnInfo kept for the session's life (history pages)
 * @property {any} turn the Turn exo
 * @property {string} turnId
 * @property {string} input
 * @property {number} at
 * @property {string} state
 * @property {number} round
 * @property {string} [error]
 * @property {string} [resolution]
 * @property {any} [finished] promise kit while the turn is live
 */

/**
 * @typedef {object} RoundCalls the tool calls of one round
 * @property {any[]} waiting intents not issued yet, in call order
 * @property {number} inFlight
 * @property {number} unsettled calls without a recorded result
 * @property {boolean} frameLimited
 * @property {any} kit resolves when every call has a result
 */

/**
 * @typedef {object} ActiveTurn the current turn (vat-internal, mutable)
 * @property {any} turn
 * @property {any} sink
 * @property {string} turnId
 * @property {number} generation
 * @property {string} state 'running' | 'cancelling', then the settled status
 * @property {number} round
 * @property {boolean} dispatched
 * @property {any} ports TurnPorts, or undefined before crank B or after recovery
 * @property {() => any[]} openIntents intents of the current round without a result
 * @property {() => void} dropPorts forget the ports (recovery: they are tombstones)
 * @property {TurnInfo} info
 * @property {any} tools the tool set for these ports
 * @property {RoundCalls | undefined} calls
 * @property {any} roundKit pending until the round's roundFinal
 * @property {number} sentUpTo records before this index were sent to the adapter
 * @property {any} usage summed counts, or undefined before any round reported
 */

/**
 * @param {object} options
 * @param {any} options.config SessionConfig
 * @param {{ backend: any, host: any }} options.services
 * @param {any} options.rowReporter
 * @param {RecordLog} options.records
 * @param {LivePublishing} options.live
 * @param {(core: any, active: ActiveTurn) => boolean} options.recoverAfterRestart
 * @param {(error: unknown) => boolean} options.isRestartSignal
 * @param {typeof turnHooks} [options.hooks]
 * @param {readonly any[]} [options.table] tool table
 * @param {number} [options.maxToolRounds]
 */
export const makeTurnRunner = ({
  config,
  services,
  rowReporter,
  records,
  live,
  recoverAfterRestart,
  isRestartSignal,
  hooks = turnHooks,
  table = toolTable,
  maxToolRounds = limits.maxToolRounds,
}) => {
  /** @type {any} */
  let queue;
  /** @type {any} */
  let core;

  let lastKnownTime = /** @type {number} */ (config.createdAt);
  /** @param {unknown} at */
  const see = at => {
    if (typeof at === 'number' && at > lastKnownTime) lastKnownTime = at;
  };

  let turnCounter = 0;
  let generation = 0;
  /** @type {ActiveTurn | undefined} */
  let current;
  /**
   * turn id -> info
   * @type {Map<string, TurnInfo>}
   */
  const turns = new Map();
  /** activity of the row when no turn is current */
  let restActivity = 'passive';

  const totals = {
    ...zeroUsage(),
    context: { usedTokens: 0, windowTokens: 0 },
    turns: 0,
    incompleteTurns: 0,
  };
  const usageTotals = () =>
    harden({ ...totals, context: harden({ ...totals.context }) });

  // ------------------------------------------------------------ the outbox

  /**
   * events of this crank, in order
   * @type {any[]}
   */
  let outbox = [];
  /** a `pending` event is owed (added last, with the queue's view at flush) */
  let pendingOwed = false;
  /**
   * the merged row patch of this crank
   * @type {Record<string, any> | undefined}
   */
  let rowPatch;
  let flushScheduled = false;

  /** @param {any} event */
  const emit = event => {
    outbox.push(harden(event));
  };

  const takeEvents = () => {
    const events = outbox;
    outbox = [];
    if (pendingOwed) {
      pendingOwed = false;
      events.push(harden({ type: 'pending', pending: queue.view() }));
    }
    return events;
  };

  const flushRow = () => {
    if (rowPatch === undefined) return;
    const patch = harden({ ...rowPatch });
    rowPatch = undefined;
    E.sendOnly(rowReporter).changed(patch);
  };

  /**
   * Publish the outbox to these ports (sendOnly) or, without ports, outside
   * a turn (answered); send the row patch.
   * @param {any} ports
   */
  const flushTo = ports => {
    flushRow();
    const events = takeEvents();
    if (events.length === 0) return;
    if (ports !== undefined) {
      live.inTurn(ports, events);
    } else {
      void live.outside(events);
    }
  };

  /**
   * End of a crank's work: publish to the current turn's ports; keep the
   * events for crank B when the current turn has none yet; publish outside
   * when idle.
   */
  const flush = () => {
    if (current !== undefined && current.ports === undefined) {
      flushRow();
      return;
    }
    flushTo(current?.ports);
  };

  /** A flush at the end of this crank's synchronous work, for callers outside this module. */
  const scheduleFlush = () => {
    if (flushScheduled) return;
    flushScheduled = true;
    void Promise.resolve().then(() => {
      flushScheduled = false;
      flush();
    });
  };

  /** @param {Record<string, any>} patch RowPatch fields */
  const report = patch => {
    rowPatch = { ...(rowPatch ?? {}), ...patch };
  };

  // ------------------------------------------------------------ status

  /** @param {TurnInfo} info */
  const statusOf = info => {
    /** @type {Record<string, any>} */
    const status = {
      turnId: info.turnId,
      state: info.state,
      round: info.round,
      at: info.at,
    };
    if (info.error !== undefined) status.error = info.error;
    if (info.resolution !== undefined) status.resolution = info.resolution;
    return harden(status);
  };

  const isLive = (/** @type {string} */ state) =>
    state === 'running' || state === 'cancelling';

  // ------------------------------------------------------------ settle

  /**
   * Section 6.3: end the turn in this crank. Idempotent: a turn that is not
   * current is left alone (returns false).
   *
   * @param {ActiveTurn} active
   * @param {{ status: string, error?: string, final?: string }} outcome
   */
  const settle = (active, { status, error, final }) => {
    if (current !== active) return false;
    current = undefined;
    const { info } = active;
    active.state = status;
    info.state = status;
    if (error !== undefined) info.error = reason(error);
    // Unwind the engine's waits; their late answers are ignored.
    active.roundKit?.reject(SETTLED);
    active.roundKit = undefined;
    active.calls?.kit.reject(SETTLED);
    active.calls = undefined;

    /** @type {Record<string, any>} */
    const settled = {
      kind: 'turn-settled',
      turnId: active.turnId,
      status,
      at: lastKnownTime,
    };
    if (error !== undefined) settled.error = reason(error);
    if (final !== undefined) settled.final = final;
    if (active.usage !== undefined) settled.usage = harden({ ...active.usage });
    records.append(settled);

    totals.turns += 1;
    if (status !== 'completed') totals.incompleteTurns += 1;

    if (status === 'completed' && final !== undefined) {
      emit({ type: 'final', turnId: active.turnId, text: final });
    }
    emit({ type: 'usage', turnId: active.turnId, ...usageTotals() });
    if (status === 'failed') {
      emit({
        type: 'abort',
        turnId: active.turnId,
        reason: settled.error ?? 'failed',
      });
    } else {
      emit({ type: 'end', turnId: active.turnId, status });
    }
    for (const hook of hooks.onSettle) {
      hook({ core, active, round: active.round });
    }
    restActivity = status === 'failed' ? 'error' : 'passive';
    report({
      activity: restActivity,
      messageCount: records.messageCount(),
      queuedCount: queue.size(),
    });
    info.finished?.resolve(statusOf(info));
    info.finished = undefined;

    const { ports } = active;
    claimNext();
    flushTo(ports);
    if (ports !== undefined) {
      E.sendOnly(ports.endpoint).releaseTurn(active.turn);
    }
    return true;
  };

  // ------------------------------------------------------------ tool calls

  /**
   * @param {ActiveTurn} active
   * @param {any} intent
   * @param {string} result
   * @param {boolean} failed
   */
  const recordResult = (active, intent, result, failed) => {
    records.append({
      kind: 'tool-result',
      turnId: active.turnId,
      opId: intent.opId,
      name: intent.name,
      result,
      failed,
    });
    emit({
      type: 'tool_result',
      turnId: active.turnId,
      id: intent.opId,
      name: intent.name,
      result,
      failed,
    });
  };

  /**
   * @param {ActiveTurn} active
   * @param {RoundCalls} calls
   * @param {any} intent
   */
  const issue = (active, calls, intent) => {
    const entry = active.tools.byName.get(intent.name);
    calls.inFlight += 1;
    /** @type {Promise<any>} */
    let answer;
    try {
      answer = Promise.resolve(
        entry.execute(
          harden({
            opId: intent.opId,
            args: intent.args,
            turnId: active.turnId,
          }),
          active.ports,
        ),
      );
    } catch (error) {
      answer = Promise.reject(error);
    }
    answer.then(
      outcome => onToolOutcome(active, calls, intent, outcome),
      error => onToolError(active, calls, intent, entry, error),
    );
  };

  /**
   * @param {ActiveTurn} active
   * @param {RoundCalls} calls
   */
  const issueWaiting = (active, calls) => {
    while (
      active.state === 'running' &&
      calls.inFlight < limits.callWindow &&
      calls.waiting.length > 0
    ) {
      issue(active, calls, calls.waiting.shift());
    }
  };

  /**
   * A result was recorded: issue the next waiting call, or end the round's
   * tool phase. The last result of a running round hands control back to
   * the engine (which publishes at its next stop).
   * @param {ActiveTurn} active
   * @param {RoundCalls} calls
   */
  const afterResult = (active, calls) => {
    calls.inFlight -= 1;
    calls.unsettled -= 1;
    issueWaiting(active, calls);
    if (calls.inFlight > 0) {
      flush();
      return;
    }
    if (active.state === 'cancelling') {
      // Cancel waited for the running calls; the waiting ones never ran.
      for (const intent of calls.waiting) {
        recordResult(
          active,
          intent,
          textOf.errorResult(CANCELLED_BEFORE_RUN),
          true,
        );
      }
      calls.waiting = [];
      settle(active, { status: 'cancelled' });
      return;
    }
    if (calls.unsettled > 0) {
      flush();
      return;
    }
    active.calls = undefined;
    if (calls.frameLimited) {
      calls.kit.reject(SETTLED);
      settle(active, { status: 'failed', error: texts.frameLimit });
      return;
    }
    calls.kit.resolve(undefined);
  };

  /**
   * @param {ActiveTurn} active
   * @param {RoundCalls} calls
   */
  const stillOurs = (active, calls) =>
    current === active && active.calls === calls;

  /**
   * @param {ActiveTurn} active
   * @param {RoundCalls} calls
   * @param {any} intent
   * @param {any} outcome
   */
  const onToolOutcome = (active, calls, intent, outcome) => {
    if (!stillOurs(active, calls)) return;
    if (!matches(outcome, shapes.ToolOutcome)) {
      recordResult(
        active,
        intent,
        textOf.errorResult('the tool returned an invalid outcome'),
        true,
      );
    } else if (outcome.status === 'ok') {
      recordResult(active, intent, boundToolOutput(outcome.text), false);
    } else if (outcome.status === 'failed') {
      recordResult(
        active,
        intent,
        boundToolOutput(textOf.errorResult(outcome.text)),
        true,
      );
    } else {
      calls.frameLimited = true;
      recordResult(active, intent, texts.frameLimit, true);
    }
    afterResult(active, calls);
  };

  /**
   * @param {ActiveTurn} active
   * @param {RoundCalls} calls
   * @param {any} intent
   * @param {any} entry
   * @param {unknown} error
   */
  const onToolError = (active, calls, intent, entry, error) => {
    if (!stillOurs(active, calls)) return;
    if ((entry.site ?? 'adapter') === 'adapter' && isRestartSignal(error)) {
      // A restart, never a tool failure (section 7).
      recoverAfterRestart(core, active);
      flush();
      return;
    }
    recordResult(
      active,
      intent,
      boundToolOutput(textOf.errorResult(messageOf(error))),
      true,
    );
    afterResult(active, calls);
  };

  /**
   * Crank D with tool calls: record every intent, refuse locally what cannot
   * run, issue the first `callWindow`.
   * @param {ActiveTurn} active
   * @param {readonly any[]} toolCalls
   * @param {number} round
   */
  const runTools = (active, toolCalls, round) => {
    const intents = toolCalls.map((call, ordinal) =>
      harden({
        opId: textOf.opId(active.turnId, round, ordinal),
        callId: call.callId,
        name: call.name,
        args: call.args,
      }),
    );
    records.append({
      kind: 'tool-intents',
      turnId: active.turnId,
      round,
      intents: harden(intents),
    });
    emit({ type: 'phase', turnId: active.turnId, phase: 'using tools' });
    for (const intent of intents) {
      emit({
        type: 'tool_call',
        turnId: active.turnId,
        id: intent.opId,
        name: intent.name,
        args: intent.args,
      });
    }
    /** @type {RoundCalls} */
    const calls = {
      waiting: [],
      inFlight: 0,
      unsettled: 0,
      frameLimited: false,
      kit: makePromiseKit(),
    };
    const available = active.tools.descriptions.map(
      (/** @type {any} */ d) => d.name,
    );
    intents.forEach((intent, ordinal) => {
      if (ordinal >= limits.maxCallsPerRound) {
        recordResult(
          active,
          intent,
          textOf.tooManyCalls(intents.length, limits.maxCallsPerRound),
          true,
        );
      } else if (!active.tools.byName.has(intent.name)) {
        recordResult(
          active,
          intent,
          boundToolOutput(
            textOf.errorResult(textOf.unknownTool(intent.name, available)),
          ),
          true,
        );
      } else {
        calls.waiting.push(intent);
        calls.unsettled += 1;
      }
    });
    if (calls.unsettled === 0) {
      // Nothing to wait for: the engine goes on in this crank.
      return Promise.resolve(undefined);
    }
    active.calls = calls;
    issueWaiting(active, calls);
    flush();
    return calls.kit.promise;
  };

  // ------------------------------------------------------------ rounds

  /**
   * The round request: records appended since the previous `startRound` of
   * this turn (results in call order), or none when they do not fit.
   * @param {ActiveTurn} active
   * @param {number} round
   */
  const roundRequest = (active, round) => {
    const from = active.sentUpTo;
    const to = records.count();
    active.sentUpTo = to;
    /** @type {Record<string, any>} */
    const options = { modelId: config.modelId };
    if (config.reasoningEffort !== undefined) {
      options.reasoningEffort = config.reasoningEffort;
    }
    const make = (/** @type {number} */ count, /** @type {any[]} */ append) =>
      harden({
        turn: active.turn,
        sink: active.sink,
        turnId: active.turnId,
        round,
        base: harden({ count, epoch: 0 }),
        append: harden(append),
        tools: active.tools.descriptions,
        options: harden(options),
      });
    const append = inCallOrder(records.since(from));
    if (append.length <= limits.maxAppendRecords) {
      const request = make(from, append);
      if (fitsFrame(request)) return request;
    }
    // M1a adapters do not read past records; M1b pulls through `context`.
    return make(to, []);
  };

  /**
   * The engine's `invoke`: publish the crank's events, send the round, wait
   * for its `roundFinal`.
   * @param {ActiveTurn} active
   * @param {number} round
   */
  const invoke = (active, round) => {
    active.round = round;
    active.info.round = round;
    if (active.ports === undefined) throw SETTLED;
    for (const hook of hooks.beforeRound) hook({ core, active, round });
    if (round > 0) {
      emit({ type: 'phase', turnId: active.turnId, phase: 'thinking' });
    }
    const request = roundRequest(active, round);
    flushTo(active.ports);
    E.sendOnly(active.ports.endpoint).startRound(request);
    const kit = makePromiseKit();
    active.roundKit = kit;
    return kit.promise;
  };

  /**
   * @param {ActiveTurn} active
   * @param {unknown} error
   */
  const engineFailed = (active, error) => {
    if (current !== active) return;
    if (active.state === 'cancelling') {
      settle(active, { status: 'cancelled' });
    } else {
      settle(active, { status: 'failed', error: messageOf(error) });
    }
  };

  /** @param {ActiveTurn} active */
  const startEngine = active => {
    const signal = harden({
      throwIfAborted: () => {
        if (current !== active || active.state !== 'running') throw SETTLED;
      },
    });
    runAgenticTurn({
      cursor: '',
      maxRounds: maxToolRounds,
      signal,
      getTools: async () => active.tools,
      getContext: async cursor => harden({ cursor, messages: [] }),
      invoke: async (_messages, _tools, round) => invoke(active, round),
      getToolCalls: message => message.toolCalls,
      runTools: async (calls, _tools, round) => runTools(active, calls, round),
      commitStep: async cursor => cursor,
      commitFinal: async (cursor, message) => {
        settle(active, { status: 'completed', final: message.text });
        return cursor;
      },
    }).then(
      outcome => {
        if (outcome.exhausted && current === active) {
          // R4-47: the round limit ends the turn normally.
          settle(active, { status: 'completed', final: texts.roundLimit });
        }
      },
      error => engineFailed(active, error),
    );
  };

  /**
   * @param {ActiveTurn} active
   * @param {any} usage
   */
  const addUsage = (active, usage) => {
    if (usage === undefined) return;
    const sum = active.usage ?? zeroUsage();
    for (const key of COUNT_KEYS) {
      sum[key] += usage[key];
      totals[key] += usage[key];
    }
    if (usage.context !== undefined) {
      sum.context = harden({ ...usage.context });
      totals.context = { ...usage.context };
    }
    active.usage = sum;
  };

  // ------------------------------------------------------------ the sink

  /**
   * One TurnSink per turn; the class is defined once per session (vat):
   * `makeExo` would define a class per object (J-0251).
   */
  const makeSink = defineExoClass(
    'TurnSink',
    interfaces.TurnSink,
    (/** @type {ActiveTurn} */ active) => ({ active }),
    {
      /** @param {number} round */
      dispatching(round) {
        const { active } = /** @type {any} */ (this).state;
        if (current !== active || active.state !== 'running') return false;
        if (round !== active.round) return false;
        if (!active.dispatched) {
          records.append({ kind: 'dispatched', turnId: active.turnId, round });
          active.dispatched = true;
        }
        return true;
      },
      /** @param {any} result */
      roundFinal(result) {
        const { active } = /** @type {any} */ (this).state;
        if (current !== active || active.state !== 'running') return;
        if (result.round !== active.round || active.roundKit === undefined) {
          return;
        }
        see(result.at);
        const kit = active.roundKit;
        active.roundKit = undefined;
        // R4-42, decided before ToolIntents is written.
        /** @type {string | undefined} */
        let failure;
        const seen = new Set();
        const toolCalls = result.toolCalls.map(
          (/** @type {any} */ call, /** @type {number} */ index) => {
            if (call.name === '') failure ??= texts.invalidToolCall;
            const callId =
              call.callId === ''
                ? textOf.synthesizedCallId(result.round, index)
                : call.callId;
            if (seen.has(callId)) failure ??= texts.duplicateToolCallId;
            seen.add(callId);
            return harden({ callId, name: call.name, args: call.args });
          },
        );
        /** @type {Record<string, any>} */
        const settled = {
          kind: 'round-settled',
          turnId: active.turnId,
          round: result.round,
          text: result.text,
          callCount: toolCalls.length,
          usage: result.usage,
          at: result.at,
        };
        if (result.servedBy !== undefined) settled.servedBy = result.servedBy;
        records.append(settled);
        addUsage(active, result.usage);
        if (failure !== undefined) {
          kit.reject(SETTLED);
          settle(active, { status: 'failed', error: failure });
          return;
        }
        kit.resolve(
          harden({ message: harden({ text: result.text, toolCalls }) }),
        );
      },
      /** @param {any} failure */
      roundFailed(failure) {
        const { active } = /** @type {any} */ (this).state;
        if (current !== active || active.state !== 'running') return;
        if (failure.round !== active.round) return;
        see(failure.at);
        if (failure.partial !== undefined && failure.partial !== '') {
          records.append({
            kind: 'partial',
            turnId: active.turnId,
            round: failure.round,
            text: failure.partial,
          });
        }
        addUsage(active, failure.usage);
        settle(active, { status: 'failed', error: failure.reason });
      },
      deadline(_request) {
        // M1a arms no deadline; an unknown op id is ignored.
      },
    },
  );

  // ------------------------------------------------------------ ports

  /**
   * Crank B: the open answered.
   * @param {ActiveTurn} active
   * @param {any} ports
   */
  const onPorts = (active, ports) => {
    if (current !== active || active.state !== 'running') return;
    active.ports = ports;
    active.tools = toolSetFor(ports, table);
    const { info } = active;
    // The turn's first events go before any held `pending`.
    outbox.unshift(
      harden({
        type: 'turn-start',
        turnId: active.turnId,
        input: info.input,
        at: info.at,
      }),
      harden({ type: 'phase', turnId: active.turnId, phase: 'thinking' }),
    );
    flushTo(ports);
    E(ports.endpoint)
      .holdTurn(active.turn)
      .then(
        () => {
          // The lease settles at releaseTurn: nothing to do.
        },
        error => {
          if (isRestartSignal(error)) {
            recoverAfterRestart(core, active);
            flush();
          } else if (current === active) {
            settle(active, { status: 'failed', error: messageOf(error) });
          }
        },
      );
    startEngine(active);
  };

  /** @param {ActiveTurn} active */
  const open = active => {
    E(services.backend)
      .open(services.host)
      .then(
        ports => onPorts(active, ports),
        error => {
          if (current !== active) return;
          // The manager is a guest vat: never a restart signal.
          settle(active, {
            status: 'failed',
            error: textOf.openFailed(messageOf(error)),
          });
        },
      );
  };

  // ------------------------------------------------------------ claim

  /**
   * Crank A: claim a turn for this input: append `TurnStarted`, make the
   * Turn, send `open`. The caller removes the queue entry in the same crank.
   * @param {string} input
   * @param {number} at
   */
  const claim = (input, at) => {
    current === undefined || Fail`a turn is current`;
    turnCounter += 1;
    generation += 1;
    const turnId = `t${turnCounter}`;
    const index = records.append({
      kind: 'turn-started',
      turnId,
      input,
      at,
    });
    /** @type {TurnInfo} */
    const info = {
      turn: undefined,
      turnId,
      input,
      at,
      state: 'running',
      round: 0,
      finished: makePromiseKit(),
    };
    /** @type {ActiveTurn} */
    const active = {
      turn: undefined,
      sink: undefined,
      turnId,
      generation,
      state: 'running',
      round: 0,
      dispatched: false,
      ports: undefined,
      openIntents: () => {
        return openIntentsOf(active);
      },
      dropPorts: () => {
        if (active.ports !== undefined) live.forget(active.ports.publisher);
        active.ports = undefined;
      },
      info,
      tools: undefined,
      calls: undefined,
      roundKit: undefined,
      sentUpTo: index,
      usage: undefined,
    };
    const turn = makeTurn(info);
    info.turn = turn;
    active.turn = turn;
    active.sink = makeSink(active);
    turns.set(turnId, info);
    current = active;
    report({ activity: 'working' });
    open(active);
    return active;
  };

  /**
   * Claim the first waiting entry (or a turn source's turn) if idle and the
   * queue is not held.
   * @returns {ActiveTurn | undefined}
   */
  const claimNext = () => {
    if (current !== undefined) return undefined;
    const item = queue.first();
    if (item !== undefined) {
      const active = claim(item.submission.text, lastKnownTime);
      queue.claim(item, active.turn);
      return active;
    }
    for (const source of hooks.turnSources) {
      const next = source(core);
      if (next !== undefined) return claim(next.text, next.at);
    }
    return undefined;
  };

  /**
   * Intents of the active turn's current round without a ToolResult.
   * @param {ActiveTurn} active
   */
  const openIntentsOf = active => {
    const own = records.ofTurn(active.turnId);
    /** @type {any} */
    let intents;
    const done = new Set();
    for (const record of own) {
      if (record.kind === 'tool-intents' && record.round === active.round) {
        intents = record;
      } else if (record.kind === 'tool-result') {
        done.add(record.opId);
      }
    }
    if (intents === undefined) return [];
    return intents.intents.filter(
      (/** @type {any} */ intent) => !done.has(intent.opId),
    );
  };

  // ------------------------------------------------------------ cancel

  /** @param {TurnInfo} info */
  const cancel = info => {
    const active = current;
    if (active === undefined || active.info !== info) return;
    if (active.state !== 'running') return;
    active.state = 'cancelling';
    info.state = 'cancelling';
    emit({ type: 'phase', turnId: active.turnId, phase: 'cancelling' });
    if (active.ports !== undefined) {
      E.sendOnly(active.ports.endpoint).cancelRound(active.turn);
    }
    for (const hook of hooks.onCancel) {
      hook({ core, active, round: active.round });
    }
    if (active.calls === undefined || active.calls.inFlight === 0) {
      settle(active, { status: 'cancelled' });
    } else {
      // R4-49: running calls are not interrupted; settle after the last.
      flush();
    }
  };

  // ------------------------------------------------------------ the Turn

  /** One Turn per turn, kept for the session's life; one class per session. */
  const makeTurn = defineExoClass(
    'Turn',
    interfaces.Turn,
    (/** @type {TurnInfo} */ info) => ({ info }),
    {
      getStatus() {
        const { info } = /** @type {any} */ (this).state;
        return statusOf(info);
      },
      cancel() {
        const { info } = /** @type {any} */ (this).state;
        cancel(info);
      },
      async whenFinished() {
        const { info } = /** @type {any} */ (this).state;
        const { finished } = info;
        if (finished === undefined) return statusOf(info);
        await finished.promise;
        return statusOf(info);
      },
      /** @param {string} note */
      resolve(note) {
        const { info } = /** @type {any} */ (this).state;
        if (current !== undefined) throw Error(texts.activeTurn);
        if (info.state !== 'outcome-unknown') {
          throw Error(texts.resolveNotUnknown);
        }
        records.append({
          kind: 'turn-resolved',
          turnId: info.turnId,
          note,
          at: lastKnownTime,
        });
        info.resolution = note;
      },
    },
  );

  // ------------------------------------------------------------ previews

  /**
   * Previews of records, by record (records are immutable): a page that
   * shows a turn again costs a lookup per record. Records whose text needs no
   * cut are their own preview.
   * @type {WeakMap<object, { record: any, cut: boolean, bytes: number }>}
   */
  const previews = new WeakMap();

  /**
   * A record with its text fields cut to previews, and its exact string
   * bytes (keys included, as `messageBytes` counts them).
   * @param {any} record
   * @returns {{ record: any, cut: boolean, bytes: number }}
   */
  const previewRecord = record => {
    const known = previews.get(record);
    if (known !== undefined) return known;
    const message = (/** @type {string} */ t) =>
      previewText(t, limits.messagePreviewUnits);
    const tool = (/** @type {string} */ t) =>
      previewText(t, limits.toolPreviewUnits);
    /** @type {any} */
    let shown = record;
    let cut = false;
    switch (record.kind) {
      case 'turn-started': {
        const input = message(record.input);
        if (input !== record.input) shown = harden({ ...record, input });
        break;
      }
      case 'partial':
      case 'round-settled': {
        const t = message(record.text);
        if (t !== record.text) shown = harden({ ...record, text: t });
        break;
      }
      case 'turn-settled': {
        if (record.final === undefined) break;
        const final = message(record.final);
        if (final !== record.final) shown = harden({ ...record, final });
        break;
      }
      case 'tool-result': {
        const result = tool(record.result);
        if (result !== record.result) shown = harden({ ...record, result });
        break;
      }
      case 'tool-intents': {
        let bytes = 0;
        let changed = false;
        /** @type {any[]} */
        const intents = [];
        for (const intent of record.intents) {
          const args = tool(intent.args);
          const one =
            args === intent.args ? intent : harden({ ...intent, args });
          if (one !== intent) changed = true;
          bytes += plainBytes(one);
          if (bytes > PREVIEW_INTENTS_BYTES && intents.length > 0) {
            changed = true;
            break;
          }
          intents.push(one);
        }
        if (changed) shown = harden({ ...record, intents: harden(intents) });
        break;
      }
      default:
        break;
    }
    cut = shown !== record;
    const preview = harden({ record: shown, cut, bytes: plainBytes(shown) });
    previews.set(record, preview);
    return preview;
  };

  /** Bytes of a TurnPreview besides its records (keys, ids, state). */
  const TURN_PREVIEW_KEYS_BYTES = 64;

  /**
   * One turn as a history page shows it: records in call order, previews,
   * at most `historyTurnRecords` records, and at most `budget` bytes (a
   * longer turn shows its first records and is marked cut).
   * @param {string} turnId
   * @param {number} [budget]
   * @returns {{ preview: any, bytes: number }}
   */
  const previewTurn = (turnId, budget = Infinity) => {
    const info = /** @type {TurnInfo} */ (turns.get(turnId));
    const ordered = inCallOrder(records.ofTurn(turnId));
    let cut = ordered.length > limits.historyTurnRecords;
    let bytes = TURN_PREVIEW_KEYS_BYTES + turnId.length + info.state.length;
    /** @type {any[]} */
    const shown = [];
    for (const record of ordered.slice(0, limits.historyTurnRecords)) {
      const preview = previewRecord(record);
      if (bytes + preview.bytes > budget) {
        cut = true;
        break;
      }
      if (preview.cut) cut = true;
      shown.push(preview.record);
      bytes += preview.bytes;
    }
    /** @type {Record<string, any>} */
    const preview = {
      turn: info.turn,
      turnId,
      state: info.state,
      at: info.at,
      records: harden(shown),
    };
    if (cut) preview.cut = true;
    return { preview: harden(preview), bytes };
  };

  /**
   * Section 3.1: newest turn first, at most `historyPageTurns` turns and
   * `frameBytes`. The cursor `h<n>` means "the turns before the n-th".
   * @param {string} [cursor]
   */
  const historyPage = cursor => {
    const ids = records.turnIds();
    let end = ids.length;
    if (cursor !== undefined) {
      const match = /^h([1-9][0-9]*)$/.exec(cursor);
      const n = match === null ? NaN : Number(match[1]);
      if (!(Number.isSafeInteger(n) && n <= ids.length)) {
        throw Error(texts.badCursor);
      }
      end = n;
    }
    const budget = limits.frameBytes - PAGE_SLACK;
    /** @type {any[]} */
    const page = [];
    let used = 0;
    let index = end - 1;
    while (index >= 0 && page.length < limits.historyPageTurns) {
      const whole = previewTurn(ids[index]);
      if (used + whole.bytes > budget) {
        if (page.length > 0) break;
        // The newest turn alone is over the page: show its first records.
        page.push(previewTurn(ids[index], budget).preview);
        index -= 1;
        break;
      }
      page.push(whole.preview);
      used += whole.bytes;
      index -= 1;
    }
    /** @type {Record<string, any>} */
    const result = { turns: harden(page) };
    if (index >= 0) result.next = `h${index + 1}`;
    return harden(result);
  };

  // ------------------------------------------------------------ the runner

  return harden({
    /**
     * Late wiring (the queue's onChange needs the runner first).
     * @param {{ queue: any, core: any }} wiring
     */
    attach: wiring => {
      queue = wiring.queue;
      core = wiring.core;
    },
    current: () => current,
    settle,
    report,
    claimNext,
    flush,
    /** @param {readonly any[]} events */
    publishOutside: events => live.outside(harden([...events])),
    lastKnownTime: () => lastKnownTime,
    see,
    /** The queue changed (Queue onChange): owe a `pending` event and the count. */
    queueChanged: () => {
      pendingOwed = true;
      report({ queuedCount: queue.size() });
      scheduleFlush();
    },
    /**
     * Section 6.1 direct start; refused while a turn is current (R4-10).
     * @param {string} input
     * @param {number} at
     */
    startTurn: (input, at) => {
      if (current !== undefined) throw Error(texts.activeTurn);
      const active = claim(input, at);
      flush();
      return active.turn;
    },
    currentStatus: () =>
      current === undefined ? undefined : statusOf(current.info),
    currentTurn: () => {
      if (current === undefined) return undefined;
      return harden({
        input: current.info.input,
        turn: current.turn,
        history: previewTurn(current.turnId, limits.frameBytes - PAGE_SLACK)
          .preview,
      });
    },
    historyPage,
    usage: usageTotals,
    activity: () => (current === undefined ? restActivity : 'working'),
    isLive,
  });
};
harden(makeTurnRunner);
