// @ts-check

/**
 * The decision layer: given a validated definition, turn one external
 * event plus the current run state into the list of journal events to
 * append.
 *
 * The interpreter is pure — it evaluates guards and reducers (in the
 * powerless compartment) and *describes* effects as `effect.issued`
 * events; executing effects and appending records belong to the caller
 * (the engine in Phase 2, the simulator here). The journal records the
 * interpreter's decisions, so the fold never re-runs them.
 */

import harden from '@endo/harden';
import { makeError, q, X } from '@endo/errors';

import { assertValidDefinition, normalizeHandlers } from './definition.js';
import {
  compileExpression,
  evaluateExpression,
  substituteTemplate,
} from './expression.js';

/** @import { EffectDeclaration, JournalEventInput, RunState, StateDeclaration, TransitionDeclaration, WorkflowDefinition, WorkflowInterpreter } from './types.js' */

// Event types that settle a pending effect and therefore require a
// matching issued `as` — anything else journals as unauthorized.
const SETTLEMENT_TYPES = harden([
  'effect.settled',
  'effect.rejected',
  'fanout.joined',
  'form.value',
]);

/**
 * @param {Record<string, unknown> | undefined} when
 * @param {JournalEventInput} event
 * @returns {boolean}
 */
const whenMatches = (when, event) => {
  if (when === undefined) {
    return true;
  }
  return Object.entries(when).every(([key, value]) => event[key] === value);
};

/**
 * @param {WorkflowDefinition} allegedDefinition
 * @returns {WorkflowInterpreter}
 */
export const makeInterpreter = allegedDefinition => {
  const definition = assertValidDefinition(allegedDefinition);

  // Compile every guard and reducer once, at interpreter construction.
  /** @type {Map<TransitionDeclaration, { guard?: (input: unknown) => unknown, assign?: (input: unknown) => unknown }>} */
  const compiled = new Map();
  for (const state of Object.values(definition.states)) {
    for (const [, candidates] of normalizeHandlers(state.on)) {
      for (const transition of candidates) {
        compiled.set(transition, {
          guard:
            transition.guard === undefined
              ? undefined
              : compileExpression(transition.guard),
          assign:
            transition.assign === undefined
              ? undefined
              : compileExpression(transition.assign),
        });
      }
    }
  }

  /**
   * Entry events for a state: its `effect.issued` records, plus
   * `run.finished` when the state is final.
   *
   * @param {string} stateName
   * @param {Record<string, unknown>} context
   * @returns {JournalEventInput[]}
   */
  const enterState = (stateName, context) => {
    const state = definition.states[stateName];
    /** @type {JournalEventInput[]} */
    const events = [];
    for (const effect of state.entry ?? []) {
      events.push(
        harden({
          type: 'effect.issued',
          as: effect.as,
          effect: effect.effect,
          to: effect.to,
          ...(effect.method === undefined ? {} : { method: effect.method }),
          ...(effect.attach === undefined ? {} : { attach: effect.attach }),
          ...(effect.join === undefined ? {} : { join: effect.join }),
          ...(effect.description === undefined
            ? {}
            : { description: substituteTemplate(effect.description, context) }),
        }),
      );
    }
    if (state.final !== undefined) {
      events.push(harden({ type: 'run.finished', final: state.final }));
    }
    return events;
  };

  /**
   * Transition candidates of a state for an event type, with `after`
   * synthesized as a `timeout` handler.
   *
   * @param {StateDeclaration} state
   * @param {string} type
   * @returns {TransitionDeclaration[]}
   */
  const candidatesFor = (state, type) => {
    /** @type {TransitionDeclaration[]} */
    const candidates = [];
    for (const [handledType, handled] of normalizeHandlers(state.on)) {
      if (handledType === type) {
        candidates.push(...handled);
      }
    }
    if (type === 'timeout' && state.after !== undefined) {
      candidates.push(harden({ target: state.after.target }));
    }
    return candidates;
  };

  /** @type {WorkflowInterpreter['begin']} */
  const begin = ({ runId, input = {}, participants = {} }) => {
    for (const key of Object.keys(definition.input ?? {})) {
      if (!Object.hasOwn(input, key)) {
        throw makeError(X`Missing input ${q(key)} for ${q(definition.name)}`);
      }
    }
    for (const slot of Object.keys(definition.participants)) {
      if (!Object.hasOwn(participants, slot)) {
        throw makeError(
          X`Missing participant ${q(slot)} for ${q(definition.name)}`,
        );
      }
    }
    const context = harden({ ...input });
    return harden([
      harden({
        type: 'run.started',
        runId,
        definition: harden({
          name: definition.name,
          version: definition.version,
        }),
        state: definition.initial,
        input: context,
        participants: harden(Object.keys(definition.participants)),
      }),
      ...enterState(definition.initial, context),
    ]);
  };

  /** @type {WorkflowInterpreter['handle']} */
  const handle = (runState, event) => {
    const { type } = event;

    // A finished run accepts nothing further; journal the attempt.
    if (runState.final !== undefined) {
      return harden([
        harden({
          type: 'event.unauthorized',
          eventType: type,
          reason: 'run already finished',
        }),
      ]);
    }

    // Settlement provenance: a settlement must correlate to a pending
    // effect. (Sender attribution is the engine's concern in Phase 2;
    // correlation is checkable purely.)
    if (SETTLEMENT_TYPES.includes(type)) {
      const as = /** @type {string | undefined} */ (event.as);
      if (as === undefined || !Object.hasOwn(runState.pending, as)) {
        return harden([
          harden({
            type: 'event.unauthorized',
            eventType: type,
            as,
            reason: 'no pending effect with this correlation',
          }),
        ]);
      }
    }

    const state = definition.states[runState.state];
    const candidates = candidatesFor(state, type);
    for (const [guardIndex, transition] of candidates.entries()) {
      if (!whenMatches(transition.when, event)) {
        // eslint-disable-next-line no-continue
        continue;
      }
      const { guard, assign } =
        /** @type {NonNullable<ReturnType<typeof compiled.get>>} */ (
          compiled.get(transition) ?? {}
        );
      if (guard !== undefined) {
        const verdict = evaluateExpression(guard, {
          context: runState.context,
          event,
        });
        if (verdict !== true) {
          // eslint-disable-next-line no-continue
          continue;
        }
      }
      let context = runState.context;
      if (assign !== undefined) {
        const next = evaluateExpression(assign, {
          context: runState.context,
          event,
        });
        if (typeof next !== 'object' || next === null) {
          throw makeError(
            X`assign for ${q(runState.state)} on ${q(type)} must return an object`,
          );
        }
        context = /** @type {Record<string, unknown>} */ (next);
      }
      return harden([
        harden({ ...event }),
        harden({
          type: 'transition.fired',
          from: runState.state,
          to: transition.target,
          on: type,
          guardIndex,
          context,
        }),
        ...enterState(transition.target, context),
      ]);
    }

    // No transition matched.
    if (type === 'effect.rejected') {
      if (state.onError !== undefined) {
        return harden([
          harden({ ...event }),
          harden({
            type: 'transition.fired',
            from: runState.state,
            to: state.onError,
            on: type,
            guardIndex: -1,
            context: runState.context,
          }),
          ...enterState(state.onError, runState.context),
        ]);
      }
      // An unhandled rejection fails the run.
      return harden([
        harden({ ...event }),
        harden({ type: 'run.finished', final: 'failed' }),
      ]);
    }
    // Inert: journaled for the audit log, no state change.
    return harden([harden({ ...event })]);
  };

  return harden({ begin, handle });
};
harden(makeInterpreter);
