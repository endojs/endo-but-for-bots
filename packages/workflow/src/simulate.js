// @ts-check

/**
 * A pure, synchronous simulator for workflow charts: the kernel plus the
 * journal fold, minus the world. Effects are recorded, never performed;
 * the caller plays the world by settling them. The simulator mirrors the
 * engine's policies — one atomic event entry per step, `emit` effects
 * and internal events cascade immediately, terminal states complete the
 * run, and an unhandled ask/invoke/spawn settlement fails it — so a
 * chart exercised here behaves identically under the service.
 *
 * ```js
 * const sim = makeSimulator(chart, { params });
 * const [ask] = sim.pending();
 * sim.settle(ask.effectId, 'fulfilled', { approved: true });
 * sim.status().done; // true
 * ```
 */

import { Fail, q } from '@endo/errors';
import { assertChart, initialStep, transition } from './machine.js';
import { applyEntry, initialFoldState, effectRecordsFor } from './journal.js';

const MAX_CASCADE_DEPTH = 64;

/**
 * @param {any} chart
 * @param {{ params?: Record<string, any> }} [options]
 */
export const makeSimulator = (chart, { params = harden({}) } = {}) => {
  assertChart(chart);
  const fold = initialFoldState();
  /** @type {any[]} */
  const log = [];
  let tick = 0;

  const append = fields => {
    const entry = harden({ seq: fold.nextSeq, at: `t${tick}`, ...fields });
    tick += 1;
    applyEntry(fold, entry);
    log.push(entry);
    return entry;
  };

  /** @type {{ envelope: any, depth: number }[]} */
  const queue = [];

  const settleTerminal = () => {
    // Nothing to tear down in a simulation; the fold already cleared
    // pending and queued events.
  };

  /**
   * @param {any} envelope
   * @param {number} depth
   */
  const stepEnvelope = (envelope, depth) => {
    if (fold.done) {
      return;
    }
    if (depth > MAX_CASCADE_DEPTH) {
      append({
        kind: 'failed',
        by: 'engine',
        reason: `internal event cascade exceeded ${MAX_CASCADE_DEPTH}`,
      });
      return;
    }
    const machineState = {
      configuration: fold.configuration,
      context: fold.context,
      params: fold.params,
    };
    const result = transition(chart, machineState, envelope);
    if (!result.fired) {
      append({ kind: 'event', by: envelope.by, event: envelope });
      const { by } = envelope;
      const settlement =
        envelope.effectId !== undefined &&
        envelope.compensation !== true &&
        typeof by === 'string' &&
        (by.startsWith('ask:') || by.startsWith('invoke:') || by === 'spawn');
      if (settlement) {
        append({
          kind: 'failed',
          by: 'engine',
          reason: `unhandled '${envelope.type}' settlement of effect ${envelope.effectId}`,
        });
        settleTerminal();
      }
      return;
    }
    const effects = effectRecordsFor(fold.nextSeq, result.effects);
    append({
      kind: 'event',
      by: envelope.by,
      event: envelope,
      fired: harden({
        configuration: result.configuration,
        context: result.context,
        exited: result.exited,
        effects,
      }),
    });
    for (const record of effects) {
      if (record.effect.kind === 'emit') {
        queue.push({
          envelope: harden({
            ...record.effect.event,
            by: 'engine',
            at: `t${tick}`,
            path: record.path,
          }),
          depth: depth + 1,
        });
      }
    }
    for (const internal of result.internalEvents) {
      queue.push({
        envelope: harden({ ...internal, by: 'engine' }),
        depth: depth + 1,
      });
    }
    if (result.terminal !== undefined && !fold.done) {
      append({
        kind: 'completed',
        by: 'engine',
        ...(result.terminal.output !== undefined
          ? { output: result.terminal.output }
          : {}),
      });
      settleTerminal();
    }
  };

  const drain = () => {
    while (queue.length > 0 && !fold.done) {
      const { envelope, depth } = /** @type {any} */ (queue.shift());
      stepEnvelope(envelope, depth);
    }
    queue.length = 0;
  };

  // Start: mirror engine.start.
  {
    const result = initialStep(chart, { params });
    const effects = effectRecordsFor(fold.nextSeq, result.effects);
    append({
      kind: 'started',
      by: 'control',
      chartName: chart.name,
      chartVersion: chart.version,
      params,
      endowmentNames: harden([]),
      configuration: result.configuration,
      context: result.context,
      effects,
    });
    for (const record of effects) {
      if (record.effect.kind === 'emit') {
        queue.push({
          envelope: harden({
            ...record.effect.event,
            by: 'engine',
            at: `t${tick}`,
            path: record.path,
          }),
          depth: 1,
        });
      }
    }
    for (const internal of result.internalEvents) {
      queue.push({ envelope: harden({ ...internal, by: 'engine' }), depth: 1 });
    }
    if (result.terminal !== undefined && !fold.done) {
      append({
        kind: 'completed',
        by: 'engine',
        ...(result.terminal.output !== undefined
          ? { output: result.terminal.output }
          : {}),
      });
    }
    drain();
  }

  const requirePending = effectId =>
    fold.pending.get(effectId) ??
    Fail`no pending effect ${q(effectId)} (pending: ${q([...fold.pending.keys()])})`;

  const status = () =>
    harden({
      chartName: chart.name,
      chartVersion: chart.version,
      state:
        fold.configuration === undefined ? undefined : fold.configuration.state,
      configuration: fold.configuration,
      context: fold.context,
      seq: fold.nextSeq,
      paused: fold.paused,
      done: fold.done,
      ...(fold.outcome !== undefined ? { outcome: fold.outcome } : {}),
      ...(fold.output !== undefined ? { output: fold.output } : {}),
      ...(fold.reason !== undefined ? { reason: fold.reason } : {}),
    });

  return harden({
    /**
     * Inject an external event, as a control signal would.
     *
     * @param {any} event
     */
    inject: event => {
      stepEnvelope(harden({ by: 'sim', ...event, at: `t${tick}` }), 0);
      drain();
      return status();
    },
    /**
     * Settle a pending ask / invoke / spawn effect. A spawn settles with
     * a child-outcome record `{ status, output? }`, like the engine's.
     *
     * @param {string} effectId
     * @param {'fulfilled' | 'failed'} [outcome]
     * @param {any} [value]
     */
    settle: (effectId, outcome = 'fulfilled', value = undefined) => {
      const record = requirePending(effectId);
      append({
        kind: 'effect-settled',
        by: 'engine',
        effectId,
        status: outcome,
        ...(outcome === 'fulfilled' ? { value } : { reason: value }),
      });
      const { effect } = record;
      const type =
        outcome === 'fulfilled'
          ? effect.outcome
          : (effect.failure ?? 'effect-failed');
      const by =
        effect.kind === 'ask'
          ? `ask:${effect.to}`
          : effect.kind === 'invoke'
            ? `invoke:${effect.target}`
            : effect.kind === 'spawn'
              ? 'spawn'
              : 'engine';
      stepEnvelope(
        harden({
          type,
          value: outcome === 'fulfilled' ? value : harden({ reason: value }),
          by,
          at: `t${tick}`,
          path: record.path,
          effectId,
          ...(record.exit === true ? { compensation: true } : {}),
        }),
        0,
      );
      drain();
      return status();
    },
    /**
     * Fire a pending `after` timer as though its deadline elapsed.
     *
     * @param {string} effectId
     */
    fireTimer: effectId => {
      const record = requirePending(effectId);
      record.effect.kind === 'after' ||
        Fail`effect ${q(effectId)} is a ${q(record.effect.kind)}, not an after`;
      append({
        kind: 'effect-settled',
        by: 'engine',
        effectId,
        status: 'fulfilled',
      });
      stepEnvelope(
        harden({
          ...record.effect.emit,
          by: 'engine',
          at: `t${tick}`,
          path: record.path,
          effectId,
        }),
        0,
      );
      drain();
      return status();
    },
    /** The pending effect records, in insertion order. */
    pending: () => harden([...fold.pending.values()]),
    /** The simulated journal so far. */
    journal: () => harden([...log]),
    status,
  });
};
harden(makeSimulator);
