// @ts-check

/**
 * The daemon-free simulator: the engine's own reducer under a scripted
 * event source, with effects recorded rather than executed.
 *
 * This is the unit-test surface for definition authors — plain ava, no
 * daemon, milliseconds — and the substrate `forkSimulation` reuses for
 * live-run debugging. Injected events are trusted by construction
 * (simulation has no provenance to verify beyond correlation, which the
 * interpreter checks).
 */

import harden from '@endo/harden';
import { makeError, q, X } from '@endo/errors';

import { makeInterpreter } from './interpret.js';
import { applyEvent } from './fold.js';

/** @import { JournalRecord, PendingEffect, RunState, WorkflowDefinition, WorkflowSimulation } from './types.js' */

/**
 * @param {WorkflowDefinition} definition
 * @param {object} [options]
 * @param {string} [options.runId]
 * @param {Record<string, unknown>} [options.input]
 * @param {Record<string, unknown>} [options.participants]
 * @param {JournalRecord[]} [options.priorRecords] replay a journal prefix
 *   (fork-to-sandbox) instead of beginning a fresh run
 * @returns {WorkflowSimulation}
 */
export const simulateRun = (definition, options = {}) => {
  const {
    runId = 'sim',
    input = {},
    participants = {},
    priorRecords,
  } = options;
  const interpreter = makeInterpreter(definition);

  /** @type {JournalRecord[]} */
  const journal = [];
  /** @type {RunState | undefined} */
  let runState;
  let lastSeq = 0;

  /** @param {import('./types.js').JournalEventInput[]} events */
  const applyAll = events => {
    /** @type {JournalRecord[]} */
    const appended = [];
    for (const event of events) {
      lastSeq += 1;
      /** @type {JournalRecord} */
      const record = harden({
        ...event,
        ...(event.type === 'effect.issued'
          ? { idempotencyKey: `${runId}:${lastSeq}:${event.as}` }
          : {}),
        seq: lastSeq,
        at: lastSeq,
        prev: '',
      });
      journal.push(record);
      appended.push(record);
      runState = applyEvent(runState, record);
    }
    return harden(appended);
  };

  if (priorRecords === undefined) {
    applyAll(interpreter.begin({ runId, input, participants }));
  } else {
    for (const record of priorRecords) {
      journal.push(record);
      runState = applyEvent(runState, record);
      lastSeq = record.seq;
    }
  }

  const requireState = () => {
    if (runState === undefined) {
      throw makeError(X`Simulation has no run state yet`);
    }
    return runState;
  };

  /** @type {WorkflowSimulation['inject']} */
  const inject = (type, payload = {}) => {
    return applyAll(
      interpreter.handle(requireState(), harden({ type, ...payload })),
    );
  };

  /** @type {WorkflowSimulation['expectEffect']} */
  const expectEffect = (effect, partial = {}) => {
    const found = Object.values(requireState().pending).find(
      pending =>
        pending.effect === effect &&
        Object.entries(partial).every(
          ([key, value]) =>
            /** @type {Record<string, unknown>} */ (pending)[key] === value,
        ),
    );
    if (found === undefined) {
      throw makeError(
        X`Expected a pending ${q(effect)} effect matching ${q(partial)}; pending: ${q(
          Object.keys(requireState().pending),
        )}`,
      );
    }
    return found;
  };

  return harden({
    get state() {
      return requireState().state;
    },
    get context() {
      return requireState().context;
    },
    get pending() {
      return requireState().pending;
    },
    get final() {
      return requireState().final;
    },
    get journal() {
      return harden([...journal]);
    },
    inject,
    expectEffect,
  });
};
harden(simulateRun);
