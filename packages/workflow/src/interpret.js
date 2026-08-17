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
  'child.finished',
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

  // Compile every guard, reducer, and spawn-input expression once, at
  // interpreter construction.
  /** @type {Map<TransitionDeclaration, { guard?: (input: unknown) => unknown, assign?: (input: unknown) => unknown }>} */
  const compiled = new Map();
  /** @type {Map<EffectDeclaration, (input: unknown) => unknown>} */
  const compiledInputs = new Map();
  for (const state of Object.values(definition.states)) {
    for (const effect of state.entry ?? []) {
      if (effect.input !== undefined) {
        compiledInputs.set(effect, compileExpression(effect.input));
      }
    }
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

  // A call arg that is exactly one placeholder resolves to the raw
  // context value; any other string is template-substituted (delimited
  // JSON data); non-strings pass through.
  const wholePlaceholder = /^\$\{context\.([\w.]+)\}$/u;
  /**
   * @param {unknown} arg
   * @param {Record<string, unknown>} context
   */
  const resolveArg = (arg, context) => {
    if (typeof arg !== 'string') {
      return arg;
    }
    const match = wholePlaceholder.exec(arg);
    if (match === null) {
      return substituteTemplate(arg, context);
    }
    /** @type {unknown} */
    let value = context;
    for (const segment of match[1].split('.')) {
      if (typeof value !== 'object' || value === null) {
        return undefined;
      }
      value = /** @type {Record<string, unknown>} */ (value)[segment];
    }
    return value;
  };

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
      if (effect.effect === 'emit') {
        // Emit completes at issue: it is journaled and published, never
        // pending.
        events.push(
          harden({
            type: 'emit',
            as: effect.as,
            ...(effect.description === undefined
              ? {}
              : {
                  description: substituteTemplate(effect.description, context),
                }),
          }),
        );
        // eslint-disable-next-line no-continue
        continue;
      }
      const inputExpression = compiledInputs.get(effect);
      events.push(
        harden({
          type: 'effect.issued',
          as: effect.as,
          effect: effect.effect,
          ...(effect.to === undefined ? {} : { to: effect.to }),
          ...(effect.method === undefined ? {} : { method: effect.method }),
          ...(effect.args === undefined
            ? {}
            : { args: effect.args.map(arg => resolveArg(arg, context)) }),
          ...(effect.attach === undefined ? {} : { attach: effect.attach }),
          ...(effect.join === undefined ? {} : { join: effect.join }),
          ...(effect.retry === undefined ? {} : { retry: effect.retry }),
          ...(effect.idempotent === undefined
            ? {}
            : { idempotent: effect.idempotent }),
          ...(effect.fields === undefined ? {} : { fields: effect.fields }),
          ...(effect.workflow === undefined
            ? {}
            : { workflow: effect.workflow }),
          ...(effect.participants === undefined
            ? {}
            : { participants: effect.participants }),
          ...(inputExpression === undefined
            ? {}
            : {
                childInput: evaluateExpression(inputExpression, { context }),
              }),
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

    /**
     * Fire a transition to `target` with the given resulting context.
     *
     * @param {string} target
     * @param {number} guardIndex
     * @param {Record<string, unknown>} context
     */
    const fire = (target, guardIndex, context) =>
      harden([
        harden({ ...event }),
        harden({
          type: 'transition.fired',
          from: runState.state,
          to: target,
          on: type,
          guardIndex,
          context,
        }),
        ...enterState(target, context),
      ]);

    /**
     * Drive the run to the implicit `failed` final state, journaling the
     * triggering event and a reason. Returning failure events (rather
     * than throwing out of `handle`) is essential: a throw would be
     * swallowed by the engine's serial-queue error handler, leaving the
     * settlement un-journaled and the run wedged.
     *
     * @param {string} reason
     */
    const fail = reason =>
      harden([
        harden({ ...event }),
        harden({ type: 'run.finished', final: 'failed', reason }),
      ]);

    for (const [guardIndex, transition] of candidates.entries()) {
      if (!whenMatches(transition.when, event)) {
        // eslint-disable-next-line no-continue
        continue;
      }
      const { guard, assign } =
        /** @type {NonNullable<ReturnType<typeof compiled.get>>} */ (
          compiled.get(transition) ?? {}
        );
      let context = runState.context;
      try {
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
        if (assign !== undefined) {
          const next = evaluateExpression(assign, {
            context: runState.context,
            event,
          });
          if (typeof next !== 'object' || next === null) {
            return fail(
              `assign for state ${runState.state} on ${type} returned a non-object`,
            );
          }
          context = /** @type {Record<string, unknown>} */ (next);
        }
      } catch (error) {
        // A guard or reducer that throws is a definition bug; fail the
        // run with a diagnostic rather than skipping the candidate and
        // wedging (or throwing and being swallowed).
        return fail(
          `expression error in state ${runState.state} on ${type}: ${
            /** @type {Error} */ (error).message
          }`,
        );
      }
      return fire(transition.target, guardIndex, context);
    }

    // No transition matched. A settlement clears its pending effect in
    // the fold, so leaving the run here would strand it with no pending
    // effect, no transition, and no timer — a silent wedge. Route to
    // onError if declared, else fail the run. (Non-settlement events —
    // signals, injected audit events — are genuinely inert.)
    if (SETTLEMENT_TYPES.includes(type)) {
      if (state.onError !== undefined) {
        return fire(state.onError, -1, runState.context);
      }
      const asSuffix = typeof event.as === 'string' ? ` for ${event.as}` : '';
      return fail(
        `no transition handles ${type}${asSuffix} in state ${runState.state}`,
      );
    }
    // Inert: journaled for the audit log, no state change.
    return harden([harden({ ...event })]);
  };

  /** @type {WorkflowInterpreter['enter']} */
  const enter = (stateName, context) => harden(enterState(stateName, context));

  /** @type {WorkflowInterpreter['outputOf']} */
  const outputOf = (stateName, context) => {
    const state = definition.states[stateName];
    if (state === undefined || state.output === undefined) {
      return undefined;
    }
    return evaluateExpression(compileExpression(state.output), { context });
  };

  return harden({ begin, handle, enter, outputOf, definition });
};
harden(makeInterpreter);
