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
   * Mirror the engine's atomic composite entries: settlement, step
   * result (with id'd internal obligations), and terminal outcome all
   * ride one entry.
   *
   * @param {any} envelope
   * @param {number} depth
   * @param {{ settles?: any }} [options]
   */
  const stepEnvelope = (envelope, depth, options = {}) => {
    const { settles } = options;
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
    const base = harden({
      kind: 'event',
      by: envelope.by,
      event: envelope,
      ...(settles !== undefined ? { settles } : {}),
    });
    const machineState = {
      configuration: fold.configuration,
      context: fold.context,
      params: fold.params,
    };
    const result = transition(chart, machineState, envelope);
    if (!result.fired) {
      const { by } = envelope;
      const settlement =
        envelope.effectId !== undefined &&
        envelope.compensation !== true &&
        typeof by === 'string' &&
        (by.startsWith('ask:') ||
          by.startsWith('invoke:') ||
          by === 'spawn' ||
          by === 'timer');
      if (settlement) {
        append({
          ...base,
          terminal: harden({
            outcome: 'failed',
            reason: `unhandled '${envelope.type}' settlement of effect ${envelope.effectId}`,
          }),
        });
        settleTerminal();
      } else {
        append(base);
      }
      return;
    }
    const effects = effectRecordsFor(fold.nextSeq, result.effects);
    const internals = harden(
      result.internalEvents.map((internal, index) => ({
        internalId: `${fold.nextSeq}-i${index}`,
        envelope: harden({ ...internal, by: 'engine' }),
      })),
    );
    append({
      ...base,
      fired: harden({
        configuration: result.configuration,
        context: result.context,
        exited: result.exited,
        effects,
        ...(internals.length > 0 ? { internals } : {}),
      }),
      ...(result.terminal !== undefined
        ? {
            terminal: harden({
              outcome: 'completed',
              ...(result.terminal.output !== undefined
                ? { output: result.terminal.output }
                : {}),
            }),
          }
        : {}),
    });
    if (result.terminal !== undefined) {
      settleTerminal();
      return;
    }
    for (const record of effects) {
      if (record.effect.kind === 'emit') {
        queue.push({
          envelope: harden({
            ...record.effect.event,
            by: 'engine',
            at: `t${tick}`,
            path: record.path,
            delivers: record.effectId,
          }),
          depth: depth + 1,
        });
      }
    }
    for (const { internalId, envelope: internalEnvelope } of internals) {
      queue.push({
        envelope: harden({
          ...internalEnvelope,
          at: `t${tick}`,
          delivers: internalId,
        }),
        depth: depth + 1,
      });
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
    const internals = harden(
      result.internalEvents.map((internal, index) => ({
        internalId: `${fold.nextSeq}-i${index}`,
        envelope: harden({ ...internal, by: 'engine' }),
      })),
    );
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
      ...(internals.length > 0 ? { internals } : {}),
      ...(result.terminal !== undefined
        ? {
            terminal: harden({
              outcome: 'completed',
              ...(result.terminal.output !== undefined
                ? { output: result.terminal.output }
                : {}),
            }),
          }
        : {}),
    });
    if (result.terminal === undefined) {
      for (const record of effects) {
        if (record.effect.kind === 'emit') {
          queue.push({
            envelope: harden({
              ...record.effect.event,
              by: 'engine',
              at: `t${tick}`,
              path: record.path,
              delivers: record.effectId,
            }),
            depth: 1,
          });
        }
      }
      for (const { internalId, envelope } of internals) {
        queue.push({
          envelope: harden({
            ...envelope,
            at: `t${tick}`,
            delivers: internalId,
          }),
          depth: 1,
        });
      }
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
      const settles = harden({
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
              : effect.kind === 'after'
                ? 'timer'
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
        { settles },
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
      stepEnvelope(
        harden({
          ...record.effect.emit,
          by: 'engine',
          at: `t${tick}`,
          path: record.path,
          effectId,
        }),
        0,
        { settles: harden({ effectId, status: 'fulfilled' }) },
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
