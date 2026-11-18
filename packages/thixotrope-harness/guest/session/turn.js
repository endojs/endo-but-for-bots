// @ts-check
/**
 * The session's turn side (M1a W1a.4; architecture 4.1-4.3;
 * `designs/m1a-interfaces.md` sections 3.1, 4, 5 and 6).
 *
 * One turn at a time. The session holds the `TurnPorts` of the current
 * adapter incarnation across turns (opened once when the session is made,
 * and again only after a retired break showed that incarnation gone;
 * J-9151). A turn is claimed atomically and, with ports held, started in the
 * same crank (crank A: `TurnStarted` appended, the queue entry removed,
 * publish, lease, round 0); without ports the claim sends `Backend.open` and
 * the answer starts it (crank B). It is dispatched (crank C), and runs
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
 * - The lease: `E(endpoint).holdTurn(turn)`, one per turn and incarnation,
 *   is answered only by `releaseTurn`; a retired break from it is the
 *   restart signal. After `Dispatched` it runs `recoverAfterRestart` (W1a.5)
 *   at once. Before `Dispatched` the session cannot tell a turn that was in
 *   flight when the adapter died from one it claimed on ports that were
 *   already dead (a session idle across a restart is never told): it opens
 *   fresh ports and compares the turn's claim time with their `since`
 *   (contract section 7). A retired break from an adapter tool is a restart
 *   too (never recorded as a tool failure).
 * - Settled turns are records (`TurnInfo` in `turns`, the record log), not
 *   objects: a Turn is minted from its record when a page or a receipt hands
 *   it out, and only the most recent `retainedTurnHandles` are kept (C-7,
 *   J-0251, J-9152).
 *
 * - M2 (D-M2-1, W2.5): settled turns' records leave the vat in segments of
 *   the record archive (archive.js): a seal starts in the settle crank and
 *   the records are dropped when its durable answer arrives; turn infos of
 *   sealed turns go with them. History pages (history.js) and the
 *   ContextSource (context-source.js) start at the archive's `sealedTo`;
 *   RoundRequests carry `base.archive`.
 *
 * Data-keyed state lives in `Map`s (rule 12.10); records and events use the
 * closed shapes of `guest/lib/interfaces.js`.
 */
import { interfaces, shapes, texts, textOf } from '../lib/guards/session.js';
import { limits } from '../lib/limits.js';
import { runAgenticTurn } from '../lib/turn-engine.js';
import { checkSubmission } from '../lib/pending-queue.js';
import {
  boundToolOutput,
  fitsFrame,
  previewText,
  utf8Bytes,
  messageOf,
} from '../lib/bounded.js';
import { makeHistory } from './history.js';
import { inCallOrder } from './records.js';
import { isStaged, submissionField } from './staging.js';
import { toolSetFor, toolSources, toolTable } from './tool-table.js';
import { makeOutbox } from './outbox.js';
import { makeTurnImport } from './turn-import.js';
import { makeTurnIndex } from './turn-index.js';
import { makeUsage } from './usage.js';
// The result of a call the turn never ran because it was cancelled first
// (one text with the exec tool's; tools/exec.js never imports this module).
import { NOT_RUN_TEXT } from './tools/exec.js';
import { turnHooks } from './turn-hooks.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { RecordLog } from './records.js' */
/** @import { LivePublishing } from './live.js' */
/** @import { ActiveTurn, TurnInfo, RoundCalls } from './turn-types.js' */
const { E, Fail, defineExoClass, makePromiseKit, matches } =
  /** @type {GuestGlobals} */ (globalThis);

/** Rejection reason of an engine wait whose turn settled meanwhile. */
const SETTLED = harden(Error('turn settled'));

/** @param {string} text */
const reason = text => previewText(text, limits.reasonUnits);

/**
 * @param {object} options
 * @param {any} options.config SessionConfig
 * @param {{ backend: any, host: any }} options.services
 * @param {any} options.rowReporter
 * @param {RecordLog} options.records
 * @param {LivePublishing} options.live
 * @param {any} options.archive the session's archive (`archive.js`), made
 *   in session.js with its seal callbacks bound to this runner's
 *   `onSealed` and `onNotSealed`
 * @param {any} options.contextSource the session's ContextSource
 *   (`context-source.js`) over that archive
 * @param {{ closed: () => boolean }} options.fence the session's delete
 *   fence (7.1): no claim, no direct start once closed
 * @param {(core: any, active: ActiveTurn) => boolean} options.recoverAfterRestart
 * @param {(error: unknown) => boolean} options.isRestartSignal
 * @param {typeof turnHooks} [options.hooks]
 * @param {readonly any[]} [options.table] tool table
 * @param {number} [options.maxToolRounds]
 * @param {readonly any[]} [options.sources] M5 S1: dynamic tool sources
 * @param {() => any} [options.getRuntime] M5 S4: the session's runtime
 *   (`runtime-parts.js`), for the tool set and `ToolContext.runtime`
 */
export const makeTurnRunner = ({
  config,
  services,
  rowReporter,
  records,
  live,
  archive,
  contextSource,
  fence,
  recoverAfterRestart,
  isRestartSignal,
  hooks = turnHooks,
  table = toolTable,
  maxToolRounds = limits.maxToolRounds,
  sources = toolSources,
  getRuntime = () => undefined,
}) => {
  /**
   * Records before this index went out in a RoundRequest (W1b.2): per
   * session, not per turn, so a round 0 also carries what the previous turn
   * recorded after its last round and the adapter's cache stays in step
   * without a page pull.
   */
  let sentUpTo = 0;
  /** @type {any} */
  let queue;
  /** @type {any} */
  let core;

  let lastKnownTime = /** @type {number} */ (config.createdAt);
  /** M2 seam 4: the turn deadline (0 or absent: off). */
  const turnDeadlineMs = /** @type {number} */ (config.turnDeadlineMs ?? 0);
  /** @param {unknown} at */
  const see = at => {
    if (typeof at === 'number' && at > lastKnownTime) lastKnownTime = at;
  };

  let generation = 0;
  /** @type {ActiveTurn | undefined} */
  let current;
  // Settled turns are records; Turns are minted from them (turn-index.js).
  const index = makeTurnIndex({
    limits,
    archive,
    mint: info => makeTurn(info),
    live: () => current,
  });

  const history = makeHistory({
    records,
    turnInfo: index.info,
    turnHandle: index.handle,
    archive,
  });

  /**
   * The ports of the current adapter incarnation and their tool set, held
   * across turns (contract 6.1, J-9151); undefined until the first open
   * answers and after a retired break showed them dead.
   * @type {{ ports: any, tools: any } | undefined}
   */
  let held;
  /** an open is in flight */
  let opening = false;
  /** opens asked for since the last break (bounded; see onOpened) */
  let reopens = 0;
  /**
   * The latest `since` of ports whose lease broke: an open answered with
   * ports no newer than that came from the dead incarnation.
   */
  let brokenSince = -1;
  /** activity of the row when no turn is current */
  let restActivity = 'passive';

  const usage = makeUsage({ contextLength: config.contextLength });

  // ------------------------------------------------------------ the outbox

  const outbox = makeOutbox({
    live,
    rowReporter,
    pendingView: () => queue.view(),
  });
  const { emit, report, flushRow, flushTo } = outbox;

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

  // ------------------------------------------------------------ settle

  /**
   * A round that ends without roundFinal leaves its latest checkpoint as one
   * Partial record (contract 3.2); the checkpoint is then gone.
   * @param {ActiveTurn} active
   */
  const keepCheckpoint = active => {
    const kept = active.checkpoint;
    active.checkpoint = undefined;
    if (kept === undefined || kept.round !== active.round) return;
    records.append({
      kind: 'partial',
      turnId: active.turnId,
      round: kept.round,
      text: kept.partial,
    });
  };

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
    keepCheckpoint(active);

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

    usage.settled(status);

    if (status === 'completed' && final !== undefined) {
      emit({ type: 'final', turnId: active.turnId, text: final });
    }
    emit({ type: 'usage', turnId: active.turnId, ...usage.totals() });
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
    // The settled turn is a record now; its Turn stays only as a recent handle.
    index.remember(active.turnId, active.turn);
    // M2 (m2-interfaces.md 4.3): seal before the next entry is claimed, so
    // the range holds only turns settled before this crank.
    try {
      archive.maybeSeal({
        ports: active.ports ?? held?.ports,
        context: contextSource,
      });
    } catch {
      // Not sealed; the records stay and a later settle tries again.
    }

    // Claim the next entry in this crank, so the batch carries the queue
    // after the claim (section 6.3), but a claim that throws must lose
    // neither the settle batch nor the lease release (QC advisory 1): its
    // error is rethrown only after both went out.
    const { ports } = active;
    /** @type {{ error: unknown } | undefined} */
    let claimFailure;
    try {
      claimNext();
    } catch (claimError) {
      claimFailure = { error: claimError };
    }
    flushTo(ports);
    if (ports !== undefined) {
      E.sendOnly(ports.endpoint).releaseTurn(active.turn);
    }
    if (claimFailure !== undefined) throw claimFailure.error;
    return true;
  };

  /**
   * How a cancelled turn settles: `cancelled`, or `failed` with the turn
   * deadline's text when the deadline cancelled it (M2 seam 4).
   * @param {ActiveTurn} active
   */
  const cancelledOutcome = active =>
    active.deadlineMs === undefined
      ? { status: 'cancelled' }
      : { status: 'failed', error: textOf.turnDeadline(active.deadlineMs) };

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
    // Contract 2.3: the third argument of execute (M1a entries ignore it).
    const context = harden({
      turn: active.turn,
      turnId: active.turnId,
      generation: active.generation,
      round: active.round,
      services,
      endpoint: active.ports?.endpoint,
      // M5 S4: the session's runtime parts (labels, powers, inspector, ...).
      runtime: getRuntime(),
    });
    calls.running.set(intent.opId, { entry, context });
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
          context,
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
      calls.issued < calls.waiting.length
    ) {
      const intent = calls.waiting[calls.issued];
      calls.issued += 1;
      issue(active, calls, intent);
    }
  };

  /**
   * A result was recorded: issue the next waiting call, or end the round's
   * tool phase. The last result of a running round hands control back to
   * the engine (which publishes at its next stop).
   * @param {ActiveTurn} active
   * @param {RoundCalls} calls
   * @param {string} opId
   */
  const afterResult = (active, calls, opId) => {
    calls.running.delete(opId);
    calls.inFlight -= 1;
    calls.unsettled -= 1;
    issueWaiting(active, calls);
    if (calls.inFlight > 0) {
      flush();
      return;
    }
    if (active.state === 'cancelling') {
      // Cancel waited for the running calls; the waiting ones never ran.
      for (const intent of calls.waiting.slice(calls.issued)) {
        recordResult(active, intent, textOf.errorResult(NOT_RUN_TEXT), true);
      }
      calls.waiting = [];
      calls.issued = 0;
      settle(active, cancelledOutcome(active));
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
    } else if (outcome.status !== 'frame-limit' && isStaged(outcome.text)) {
      // Staged by the callee, already cut (contract 2.3 item 5, 5.3).
      recordResult(active, intent, outcome.text, outcome.status === 'failed');
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
    afterResult(active, calls, intent.opId);
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
    // M5 S5: a `'session'` entry is as `'guest'` here (it cannot meet one).
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
    afterResult(active, calls, intent.opId);
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
      issued: 0,
      inFlight: 0,
      unsettled: 0,
      frameLimited: false,
      kit: makePromiseKit(),
      running: new Map(),
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
   * M5 S2: the round's system prompt: the stored prompt alone, or with the
   * turn's note. Inline: one text joined with a blank line when it stays
   * within `inlineBytes`; otherwise (a staged prompt, or a joined text over
   * `inlineBytes`) the two-part list `[prompt, note]`, which the adapter's
   * `systemTextOf` joins the same way.
   * @param {ActiveTurn} active
   */
  const systemFor = active => {
    const prompt = config.systemPrompt;
    const note = active.systemNote;
    if (note === undefined) return prompt;
    if (prompt === undefined) return note;
    if (typeof prompt === 'string') {
      const joined = `${prompt}\n\n${note}`;
      if (utf8Bytes(joined) <= limits.inlineBytes) return joined;
    }
    return harden([prompt, note]);
  };

  /**
   * The round request: records appended since the previous `startRound`
   * (results in call order), or none when they do not fit (the adapter then
   * pulls them through `context`, contract 9).
   * @param {ActiveTurn} active
   * @param {number} round
   */
  const roundRequest = (active, round) => {
    // Records below the archive's `sealedTo` are in segments (M2, 4.8).
    const from = Math.max(sentUpTo, records.base());
    const to = records.count();
    sentUpTo = to;
    /** @type {Record<string, any>} */
    const options = { modelId: config.modelId };
    if (config.reasoningEffort !== undefined) {
      options.reasoningEffort = config.reasoningEffort;
    }
    // M2 seam 2 (R4-92).
    if (config.maxOutputTokens !== undefined) {
      options.maxOutputTokens = config.maxOutputTokens;
    }
    const archived = archive.any() ? { archive: archive.state() } : {};
    const system = systemFor(active);
    const make = (/** @type {number} */ count, /** @type {any[]} */ append) =>
      harden({
        turn: active.turn,
        sink: active.sink,
        turnId: active.turnId,
        round,
        base: harden({ count, epoch: 0, ...archived }),
        append: harden(append),
        tools: active.tools.descriptions,
        options: harden(options),
        context: contextSource,
        // M2 seam 1: the composed prompt, inline or staged; M5 S2 with
        // the turn's note.
        ...(system === undefined ? {} : { system }),
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
    // M5 S1: the tool set is read again at the start of every round (R3-6).
    active.tools = toolSetFor(
      active.ports,
      table,
      services,
      sources,
      getRuntime(),
    );
    if (round > 0) {
      emit({ type: 'phase', turnId: active.turnId, phase: 'thinking' });
    }
    const request = roundRequest(active, round);
    active.request = request;
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
      settle(active, cancelledOutcome(active));
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
        active.checkpoint = undefined;
        // R4-42, decided before ToolIntents is written.
        /** @type {string | undefined} */
        let failure;
        const seen = new Set();
        const toolCalls = result.toolCalls.map(
          (/** @type {any} */ call, /** @type {number} */ ordinal) => {
            if (call.name === '') failure ??= texts.invalidToolCall;
            const callId =
              call.callId === ''
                ? textOf.synthesizedCallId(result.round, ordinal)
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
        if (result.nativeContext !== undefined) {
          settled.nativeContext = result.nativeContext;
        }
        records.append(settled);
        usage.addRound(active, result.usage);
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
          active.checkpoint = {
            round: failure.round,
            partial: failure.partial,
          };
        }
        usage.addRound(active, failure.usage);
        settle(active, { status: 'failed', error: failure.reason });
      },
      /** @param {{ opId: string }} request */
      deadline({ opId }) {
        // Contract 2.3 item 3: to the entry of an issued, unsettled call.
        const { active } = /** @type {any} */ (this).state;
        if (current !== active) return;
        // M2 seam 4: the turn deadline does what Turn.cancel() does and
        // settles the turn failed (R4-49: running calls finish first).
        if (opId === textOf.turnDeadlineOpId(active.turnId)) {
          if (!(turnDeadlineMs > 0) || active.state !== 'running') return;
          active.deadlineMs = turnDeadlineMs;
          cancel(active.info);
          return;
        }
        const call = active.calls?.running.get(opId);
        call?.entry.deadline?.(harden({ opId }), call.context);
      },
      /**
       * W1b.1: replaces the kept checkpoint. True when kept (M1b QC, J-0393):
       * the previous checkpoint is then no longer held here.
       * @param {any} progress
       */
      progress({ round, partial, at }) {
        const { active } = /** @type {any} */ (this).state;
        if (current !== active || active.state !== 'running') return false;
        if (round !== active.round || active.roundKit === undefined) {
          return false;
        }
        see(at);
        active.checkpoint = { round, partial };
        return true;
      },
    },
  );

  // ------------------------------------------------------------ ports

  /**
   * Ports whose incarnation is gone: stop holding them.
   * @param {any} ports
   */
  const dropHeld = ports => {
    if (held !== undefined && held.ports === ports) held = undefined;
    live.forget(ports.publisher);
  };

  /**
   * Start the turn on these ports (crank A with held ports, crank B after an
   * open, or the crank of fresh ports after stale ones): publish its first
   * events, take the lease, run round 0. `again`: round 0 was sent once to
   * ports that turned out dead; send the same request to these.
   * @param {ActiveTurn} active
   * @param {{ ports: any, tools: any }} set
   * @param {boolean} again
   */
  const attachPorts = (active, set, again) => {
    if (current !== active || active.state !== 'running') return;
    const { info } = active;
    const { ports } = set;
    // Appended: in a settle crank the previous turn's final/usage/end come
    // first; a held `pending` is added after them all (takeEvents).
    emit({
      type: 'turn-start',
      turnId: active.turnId,
      input: info.input,
      at: info.at,
    });
    emit({ type: 'phase', turnId: active.turnId, phase: 'thinking' });
    active.ports = ports;
    active.tools = set.tools;
    flushTo(ports);
    E(ports.endpoint)
      .holdTurn(active.turn)
      .then(
        () => {
          // The lease settles at releaseTurn: nothing to do.
        },
        error => onLeaseBroken(active, ports, error),
      );
    // M2 seam 4: the turn deadline, armed when the turn starts on ports
    // (the endpoint's releaseTurn at the settle disarms it).
    if (turnDeadlineMs > 0) {
      E.sendOnly(ports.endpoint).armDeadline(
        harden({
          turn: active.turn,
          opId: textOf.turnDeadlineOpId(active.turnId),
          ms: turnDeadlineMs,
        }),
      );
    }
    if (again && active.request !== undefined) {
      E.sendOnly(ports.endpoint).startRound(active.request);
    } else if (!active.engineStarted) {
      active.engineStarted = true;
      startEngine(active);
    }
  };

  /** Ask the manager for this incarnation's ports (one open at a time). */
  const openPorts = () => {
    if (opening) return;
    opening = true;
    reopens += 1;
    E(services.backend)
      .open(services.host)
      .then(
        ports => {
          opening = false;
          onOpened(ports);
          flush();
        },
        error => {
          opening = false;
          onOpenFailed(error);
          flush();
        },
      );
  };

  /** @param {any} ports */
  const onOpened = ports => {
    const since = /** @type {number} */ (ports.since);
    if (since <= brokenSince) {
      // Answered from the incarnation whose lease broke (the open was sent
      // before the break): ask again, a bounded number of times.
      if (reopens < 3) {
        openPorts();
        return;
      }
      onOpenFailed(Error('the backend answered with ports that are gone'));
      return;
    }
    reopens = 0;
    held = harden({
      ports,
      tools: toolSetFor(ports, table, services, sources, getRuntime()),
    });
    const active = current;
    if (active === undefined || active.ports !== undefined) return;
    if (active.state !== 'running') return;
    if (active.reopening) {
      active.reopening = false;
      if (active.claimAt < since) {
        // Claimed before this incarnation started: the turn was in flight
        // when the adapter went (R4-66); never sent again.
        recoverAfterRestart(core, active);
        return;
      }
      // Claimed on ports that were already dead: nothing reached a backend;
      // the same round 0 goes to the fresh ports.
      attachPorts(active, held, true);
      return;
    }
    attachPorts(active, held, false);
  };

  /** @param {unknown} error */
  const onOpenFailed = error => {
    reopens = 0;
    const active = current;
    if (active === undefined || active.ports !== undefined) return;
    if (active.reopening) {
      // The adapter went and no fresh ports came: nothing was dispatched.
      active.reopening = false;
      recoverAfterRestart(core, active);
      return;
    }
    // The manager is a guest vat: never a restart signal.
    settle(active, {
      status: 'failed',
      error: textOf.openFailed(messageOf(error)),
    });
  };

  /**
   * The lease of `active` on `ports` was rejected.
   * @param {ActiveTurn} active
   * @param {any} ports
   * @param {unknown} error
   */
  const onLeaseBroken = (active, ports, error) => {
    const restart = isRestartSignal(error);
    if (restart) dropHeld(ports);
    if (current !== active || active.ports !== ports) {
      // A settled turn's lease, or ports this turn already gave up: only the
      // generation's recovery may act on it (it does nothing).
      if (restart) recoverAfterRestart(core, active);
      flush();
      return;
    }
    if (!restart) {
      settle(active, { status: 'failed', error: messageOf(error) });
      flush();
      return;
    }
    if (active.dispatched) {
      recoverAfterRestart(core, active);
      flush();
      return;
    }
    // Before Dispatched: fresh ports tell whether the turn was in flight.
    const since = /** @type {number} */ (ports.since);
    if (since > brokenSince) brokenSince = since;
    active.ports = undefined;
    active.reopening = true;
    reopens = 0;
    openPorts();
    flush();
  };

  // ------------------------------------------------------------ claim

  /**
   * Crank A: claim a turn for this input: make the Turn, let `take(info)`
   * remove the queue entry, then append `TurnStarted` and start the turn on
   * the held ports, or send `open` when none are held. Intent before effect
   * (QC advisory 1, J-0271): `take` runs before any record or send, so a
   * `take` that throws leaves no turn, no record and no send behind, and the
   * entry stays waiting.
   * @param {any} input a string or a StagedText
   * @param {number} at
   * @param {(info: TurnInfo) => void} [take]
   * @param {any} [item] the queue entry (M5 S3: `onClaim` hooks and the
   *   attachments' labels); undefined for a direct start or a turn source
   */
  const claim = (input, at, take = () => {}, item = undefined) => {
    current === undefined || Fail`a turn is current`;
    const turnId = index.nextId();
    /** @type {TurnInfo} */
    const info = {
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
      generation: generation + 1,
      state: 'running',
      round: 0,
      dispatched: false,
      ports: undefined,
      claimAt: at,
      reopening: false,
      engineStarted: false,
      request: undefined,
      openIntents: () => {
        return openIntentsOf(active);
      },
      dropPorts: () => {
        if (active.ports !== undefined) dropHeld(active.ports);
        active.ports = undefined;
      },
      info,
      tools: undefined,
      calls: undefined,
      roundKit: undefined,
      usage: undefined,
      checkpoint: undefined,
      systemNote: undefined,
    };
    const turn = makeTurn(info);
    take(info);
    index.claimed();
    generation += 1;
    /** @type {Record<string, any>} */
    const started = { kind: 'turn-started', turnId, input, at };
    // M5 S3: the labels of the entry's attachments (never the objects).
    const attachments = /** @type {any[] | undefined} */ (item?.attachments);
    if (attachments !== undefined && attachments.length > 0) {
      started.attachments = harden(
        attachments.map((/** @type {any} */ a) => a.label),
      );
    }
    records.append(started);
    active.turn = turn;
    active.sink = makeSink(active);
    index.add(info);
    current = active;
    // M5 S3: after TurnStarted (hooks need the turn id), before the first
    // round request is built.
    for (const hook of hooks.onClaim ?? []) hook({ core, active, item });
    report({ activity: 'working' });
    if (held !== undefined) {
      attachPorts(active, held, false);
    } else {
      openPorts();
    }
    return active;
  };

  /**
   * Claim the first waiting entry (or a turn source's turn) if idle and the
   * queue is not held. A held queue holds turn sources too (J-9150); M9's
   * inbox must revisit this for the `restart` hold (R4-65: agents are not
   * dormant after restart).
   * @returns {ActiveTurn | undefined}
   */
  const claimNext = () => {
    if (current !== undefined || fence.closed()) return undefined;
    const item = queue.first();
    if (item !== undefined) {
      // The receipt keeps the turn id, not the turn (m2-interfaces.md 5.3).
      return claim(
        submissionField(item.submission),
        lastKnownTime,
        info => queue.claim(item, info.turnId),
        item,
      );
    }
    if (queue.holdReason() !== undefined) return undefined;
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
      settle(active, cancelledOutcome(active));
    } else {
      // R4-49: running calls are not interrupted; settle after the last.
      flush();
    }
  };

  // ------------------------------------------------------------ the Turn

  /**
   * The Turn class, defined once per session (`makeExo` would define a class
   * per object, J-0251). A Turn's state is its turn's record, so a Turn
   * minted again for a settled turn behaves as the first one.
   */
  const makeTurn = defineExoClass(
    'Turn',
    interfaces.Turn,
    (/** @type {TurnInfo} */ info) => ({ info }),
    {
      /** @param {string} [cursor] W1b.1: the turn's records in full */
      getContent(cursor) {
        const { info } = /** @type {any} */ (this).state;
        // An archived turn is read through the agent host's History (4.9).
        if (info.sealed) throw Error(texts.turnSealed);
        return history.content(info.turnId, cursor);
      },
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
        if (info.resolution !== undefined) {
          throw Error(texts.turnAlreadyResolved);
        }
        if (info.sealed && archive.unresolvedInfo(info.turnId) !== info) {
          throw Error(texts.turnArchivedUnresolvable);
        }
        records.append({
          kind: 'turn-resolved',
          turnId: info.turnId,
          note,
          at: lastKnownTime,
        });
        info.resolution = note;
        archive.resolve(info.turnId);
      },
    },
  );

  // ------------------------------------------------------------ imported records

  const { importTurns, importEnd } = makeTurnImport({
    records,
    index,
    archive,
    usage,
    see,
    lastKnownTime: () => lastKnownTime,
    idle: () => current === undefined,
    seal: () => {
      archive.maybeSeal({ ports: held?.ports, context: contextSource });
    },
  });

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
    /** Cancel the running turn, if any (R6-44 send-now; as Turn.cancel). */
    cancelCurrent: () => {
      if (current !== undefined) cancel(current.info);
    },
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
      outbox.owePending();
      report({ queuedCount: queue.size() });
      outbox.schedule(flush);
    },
    /** Open this incarnation's ports (at creation; contract 6.1). */
    openPorts: () => {
      if (held === undefined) openPorts();
    },
    turnById: index.byId,
    findTurn: index.find,
    /**
     * The archive's crank Z (m2-interfaces.md 4.4): the sealed turns' infos
     * go; an archived outcome-unknown turn not yet resolved stays
     * resolvable (4.6).
     * @param {string[]} dropped
     */
    onSealed: index.archived,
    /**
     * A seal was rejected or broke. A retired break: the adapter restarted;
     * its ports are tombstones unless the current turn learns that from its
     * own lease (4.4).
     * @param {unknown} error
     * @param {any} ports
     */
    onNotSealed: (error, ports) => {
      if (isRestartSignal(error) && current?.ports !== ports) {
        dropHeld(ports);
      }
    },
    /**
     * `SessionInternal.deleteSelf` after the session's fence closed (7.1):
     * the current turn is cancelled without waiting for its tool calls.
     */
    beginDelete: () => {
      const active = current;
      if (active !== undefined) {
        cancel(active.info);
        if (current === active) settle(active, { status: 'cancelled' });
      }
      flush();
    },
    importTurns,
    importEnd,
    /** @param {any} imported UsageTotals of an imported session */
    importUsage: usage.replace,
    /**
     * An outside publish broke with the retired text: the adapter
     * restarted; ports with this publisher are dead. A turn using them
     * learns it from its lease.
     * @param {any} publisher
     */
    publisherBroke: publisher => {
      if (held === undefined || held.ports.publisher !== publisher) return;
      if (current?.ports === held.ports) return;
      held = undefined;
    },
    /**
     * Section 6.1 direct start; refused while a turn is current (R4-10).
     * @param {any} input a string or a StagedText
     * @param {number} at
     */
    startTurn: (input, at) => {
      if (fence.closed()) throw Error(texts.sessionDeleting);
      // Blank and over-inlineBytes text are refused as enqueueOnce refuses
      // them; the frame rule rests on the session (J-9150, J-9369).
      checkSubmission(isStaged(input) ? input : { text: input });
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
        history: history.preview(current.turnId).preview,
      });
    },
    historyPage: history.page,
    usage: usage.totals,
    activity: () => (current === undefined ? restActivity : 'working'),
  });
};
harden(makeTurnRunner);
