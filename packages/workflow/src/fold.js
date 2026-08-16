// @ts-check

/**
 * The pure journal fold: current run state is `applyEvent` over a prefix
 * of journal records, nothing else.
 *
 * The journal records *decisions* — `transition.fired` carries the
 * resulting context — so folding never re-evaluates guards or reducers
 * and never issues effects. That property is what makes replay exact,
 * time travel (`stateAt`) a prefix fold, and this module safe to import
 * in a browser: it is authority-free by construction.
 *
 * Observers fold the redacted event stream; their state reproduces the
 * engine's exactly up to the alias substitution.
 */

import harden from '@endo/harden';
import { makeError, q, X } from '@endo/errors';

/** @import { JournalRecord, PendingEffect, RunState } from './types.js' */

/**
 * @param {RunState | undefined} runState
 * @param {JournalRecord} record
 * @returns {RunState}
 */
export const applyEvent = (runState, record) => {
  const { seq, type } = record;
  if (runState === undefined) {
    if (type !== 'run.started') {
      throw makeError(
        X`First journal record must be run.started, got ${q(type)}`,
      );
    }
    // No undefined-valued properties anywhere in run state: state must
    // survive a JSON round trip (snapshots) byte-for-byte.
    return harden({
      runId: /** @type {string} */ (record.runId),
      definition: /** @type {RunState['definition']} */ (record.definition),
      state: /** @type {string} */ (record.state),
      context: /** @type {Record<string, unknown>} */ (record.input ?? {}),
      pending: {},
      paused: false,
      throughSeq: seq,
    });
  }

  /** @param {Partial<RunState>} patch */
  const advance = patch => harden({ ...runState, ...patch, throughSeq: seq });

  /** @param {string} as */
  const withoutPending = as => {
    const pending = { ...runState.pending };
    delete pending[as];
    return pending;
  };

  switch (type) {
    case 'effect.issued': {
      const as = /** @type {string} */ (record.as);
      return advance({
        pending: {
          ...runState.pending,
          [as]: harden({
            as,
            effect: /** @type {PendingEffect['effect']} */ (record.effect),
            ...(record.to === undefined ? {} : { to: record.to }),
            seq,
            ...(record.idempotencyKey === undefined
              ? {}
              : { idempotencyKey: record.idempotencyKey }),
          }),
        },
      });
    }
    case 'effect.settled':
    case 'effect.rejected':
    case 'fanout.joined':
    case 'form.value': {
      return advance({
        pending: withoutPending(/** @type {string} */ (record.as)),
      });
    }
    case 'transition.fired': {
      return advance({
        state: /** @type {string} */ (record.to),
        context: /** @type {Record<string, unknown>} */ (record.context),
      });
    }
    case 'run.finished': {
      return advance({
        final: /** @type {RunState['final']} */ (record.final),
      });
    }
    case 'admin.forced': {
      const action = /** @type {string} */ (record.action);
      if (action === 'pause') {
        return advance({ paused: true });
      }
      if (action === 'resume') {
        return advance({ paused: false });
      }
      if (action === 'forceTransition') {
        return advance({ state: /** @type {string} */ (record.to) });
      }
      return advance({});
    }
    // Journaled for the audit log; no state change.
    case 'event.unauthorized':
    case 'signal.injected':
    case 'guard.evaluated':
    case 'recovery.completed':
    case 'emit':
    default: {
      return advance({});
    }
  }
};
harden(applyEvent);

/**
 * Fold a journal prefix into a run state.
 *
 * @param {JournalRecord[]} records
 * @param {number} [throughSeq] fold only records with seq <= throughSeq
 * @returns {RunState | undefined}
 */
export const foldRecords = (records, throughSeq = Infinity) => {
  /** @type {RunState | undefined} */
  let runState;
  for (const record of records) {
    if (record.seq > throughSeq) {
      break;
    }
    runState = applyEvent(runState, record);
  }
  return runState;
};
harden(foldRecords);
