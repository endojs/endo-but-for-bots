// @ts-check

/**
 * Workflow-definition validation with structured diagnostics.
 *
 * `validateDefinition` returns every problem it can find — dangling
 * targets, unreachable states, undeclared participants, unmatched `as`
 * correlations, expression budget/parse failures — as
 * `{ severity, path, message }` records rather than a bare verdict, so
 * authors (human and agent) fix a definition in one round trip.
 *
 * Validation runs at `define()` time, before a definition is ever
 * runnable; expression parsing here is what makes guard syntax errors a
 * define-time failure instead of a first-transition surprise.
 */

import harden from '@endo/harden';
import { makeError, q, X } from '@endo/errors';

import { expressionBudgetProblem, compileExpression } from './expression.js';

/** @import { EffectDeclaration, StateDeclaration, TransitionDeclaration, ValidationResult, WorkflowDefinition, WorkflowDiagnostic } from './types.js' */

export const FINAL_OUTCOMES = harden([
  'succeeded',
  'failed',
  'abandoned',
  'aborted',
]);

export const EFFECT_KINDS = harden([
  'request',
  'form',
  'call',
  'fanout',
  'spawn',
  'emit',
]);

/**
 * @param {Record<string, TransitionDeclaration | TransitionDeclaration[]> | undefined} on
 * @returns {Array<[string, TransitionDeclaration[]]>}
 */
export const normalizeHandlers = on => {
  if (on === undefined) {
    return [];
  }
  return Object.entries(on).map(([type, candidates]) => [
    type,
    Array.isArray(candidates) ? candidates : [candidates],
  ]);
};
harden(normalizeHandlers);

/**
 * @param {unknown} allegedDefinition
 * @returns {ValidationResult}
 */
export const validateDefinition = allegedDefinition => {
  /** @type {WorkflowDiagnostic[]} */
  const diagnostics = [];
  /**
   * @param {'error' | 'warning'} severity
   * @param {string} path
   * @param {string} message
   */
  const report = (severity, path, message) => {
    diagnostics.push(harden({ severity, path, message }));
  };
  const finish = () =>
    harden({
      ok: !diagnostics.some(({ severity }) => severity === 'error'),
      diagnostics: harden([...diagnostics]),
    });

  if (typeof allegedDefinition !== 'object' || allegedDefinition === null) {
    report('error', '', 'definition must be an object');
    return finish();
  }
  const definition = /** @type {WorkflowDefinition} */ (allegedDefinition);

  if (typeof definition.name !== 'string' || definition.name === '') {
    report('error', 'name', 'name must be a non-empty string');
  }
  if (typeof definition.version !== 'number') {
    report('error', 'version', 'version must be a number');
  }

  const participants =
    typeof definition.participants === 'object' &&
    definition.participants !== null
      ? definition.participants
      : {};
  if (definition.participants === undefined) {
    report('error', 'participants', 'participants record is required');
  }
  const attenuators = Array.isArray(definition.attenuators)
    ? definition.attenuators
    : [];

  /**
   * @param {string} path
   * @param {string} reference
   */
  const checkParticipantReference = (path, reference) => {
    const [slot, attenuator, ...rest] = reference.split(':');
    if (rest.length > 0) {
      report('error', path, `malformed participant reference ${q(reference)}`);
      return;
    }
    if (!Object.hasOwn(participants, slot)) {
      report('error', path, `undeclared participant ${q(slot)}`);
    }
    if (attenuator !== undefined && !attenuators.includes(attenuator)) {
      report(
        'error',
        path,
        `attenuator ${q(attenuator)} is not in the attenuators list`,
      );
    }
  };

  /**
   * @param {string} path
   * @param {string | undefined} source
   */
  const checkExpression = (path, source) => {
    if (source === undefined) {
      return;
    }
    const problem = expressionBudgetProblem(source);
    if (problem !== undefined) {
      report('error', path, problem);
      return;
    }
    try {
      compileExpression(source);
    } catch (cause) {
      report('error', path, /** @type {Error} */ (cause).message);
    }
  };

  const states =
    typeof definition.states === 'object' && definition.states !== null
      ? definition.states
      : {};
  const stateNames = Object.keys(states);
  if (stateNames.length === 0) {
    report('error', 'states', 'at least one state is required');
    return finish();
  }

  if (
    typeof definition.initial !== 'string' ||
    !Object.hasOwn(states, definition.initial)
  ) {
    report(
      'error',
      'initial',
      `initial must name a declared state, got ${q(definition.initial)}`,
    );
  }

  /**
   * @param {string} statePath
   * @param {string} stateName
   * @param {StateDeclaration} state
   */
  const checkState = (statePath, stateName, state) => {
    const isFinal = state.final !== undefined;
    if (isFinal) {
      if (!FINAL_OUTCOMES.includes(/** @type {string} */ (state.final))) {
        report(
          'error',
          `${statePath}.final`,
          `final must be one of ${q(FINAL_OUTCOMES)}`,
        );
      }
      if (
        state.entry !== undefined ||
        state.on !== undefined ||
        state.after !== undefined
      ) {
        report(
          'error',
          statePath,
          'a final state may not declare entry, on, or after',
        );
      }
      // A final state may declare an `output` expression over the run's
      // context; a parent run receives its value in `child.finished`.
      checkExpression(`${statePath}.output`, state.output);
      return;
    }

    /** @type {Set<string>} */
    const issuedAs = new Set();
    /** @type {EffectDeclaration[]} */
    const entries = Array.isArray(state.entry) ? state.entry : [];
    for (const [i, effect] of entries.entries()) {
      const effectPath = `${statePath}.entry[${i}]`;
      if (!EFFECT_KINDS.includes(effect.effect)) {
        report(
          'error',
          effectPath,
          `unknown effect kind ${q(effect.effect)}; expected one of ${q(EFFECT_KINDS)}`,
        );
      }
      if (typeof effect.as !== 'string' || effect.as === '') {
        report('error', effectPath, 'effect requires a non-empty as name');
      } else if (issuedAs.has(effect.as)) {
        report('error', effectPath, `duplicate as name ${q(effect.as)}`);
      } else {
        issuedAs.add(effect.as);
      }
      if (effect.effect === 'spawn') {
        if (typeof effect.workflow !== 'string' || effect.workflow === '') {
          report(
            'error',
            effectPath,
            'spawn requires a workflow definition name',
          );
        }
        for (const [childSlot, parentReference] of Object.entries(
          effect.participants ?? {},
        )) {
          checkParticipantReference(
            `${effectPath}.participants.${childSlot}`,
            parentReference,
          );
        }
        checkExpression(`${effectPath}.input`, effect.input);
      } else if (effect.effect !== 'emit') {
        if (typeof effect.to !== 'string') {
          report('error', effectPath, 'effect requires a participant in to');
        } else {
          checkParticipantReference(`${effectPath}.to`, effect.to);
        }
      }
      for (const [j, attachment] of (effect.attach ?? []).entries()) {
        checkParticipantReference(`${effectPath}.attach[${j}]`, attachment);
      }
      if (effect.effect === 'fanout' && effect.to !== undefined) {
        const slot = effect.to.split(':')[0];
        const declared = participants[slot];
        if (declared !== undefined && declared.many !== true) {
          report(
            'error',
            `${effectPath}.to`,
            `fanout requires a many participant, but ${q(slot)} is single`,
          );
        }
        if (
          effect.join === 'all' &&
          state.after === undefined &&
          state.on?.timeout === undefined
        ) {
          report(
            'warning',
            effectPath,
            'an all join with no after timeout is hostage to its least responsive member; consider a quorum or a timeout',
          );
        }
      }
    }

    let handlesRejection = state.onError !== undefined;
    if (state.onError !== undefined && !Object.hasOwn(states, state.onError)) {
      report(
        'error',
        `${statePath}.onError`,
        `dangling onError target ${q(state.onError)}`,
      );
    }
    for (const [type, candidates] of normalizeHandlers(state.on)) {
      if (type === 'effect.rejected') {
        handlesRejection = true;
      }
      for (const [i, transition] of candidates.entries()) {
        const transitionPath = `${statePath}.on[${q(type)}][${i}]`;
        if (
          typeof transition.target !== 'string' ||
          !Object.hasOwn(states, transition.target)
        ) {
          report(
            'error',
            `${transitionPath}.target`,
            `dangling transition target ${q(transition.target)}`,
          );
        }
        const whenAs = transition.when?.as;
        if (
          whenAs !== undefined &&
          !issuedAs.has(/** @type {string} */ (whenAs))
        ) {
          report(
            'error',
            `${transitionPath}.when`,
            `when.as references ${q(whenAs)}, which no effect of ${q(stateName)} issues`,
          );
        }
        checkExpression(`${transitionPath}.guard`, transition.guard);
        checkExpression(`${transitionPath}.assign`, transition.assign);
      }
    }
    if (state.after !== undefined) {
      if (
        typeof state.after.ms !== 'number' ||
        !Object.hasOwn(states, state.after.target)
      ) {
        report(
          'error',
          `${statePath}.after`,
          'after requires a numeric ms and a declared target',
        );
      }
    }
    if (issuedAs.size > 0 && !handlesRejection) {
      report(
        'warning',
        statePath,
        'state issues effects but handles no effect.rejected and declares no onError; an effect rejection here fails the run',
      );
    }
  };

  for (const [stateName, state] of Object.entries(states)) {
    checkState(`states.${stateName}`, stateName, state);
  }

  // Reachability from the initial state.
  if (typeof definition.initial === 'string' && states[definition.initial]) {
    const reached = new Set([definition.initial]);
    const queue = [definition.initial];
    while (queue.length > 0) {
      const stateName = /** @type {string} */ (queue.shift());
      const state = states[stateName];
      /** @type {string[]} */
      const targets = [];
      for (const [, candidates] of normalizeHandlers(state.on)) {
        for (const { target } of candidates) {
          targets.push(target);
        }
      }
      if (state.after !== undefined) {
        targets.push(state.after.target);
      }
      if (state.onError !== undefined) {
        targets.push(state.onError);
      }
      for (const target of targets) {
        if (Object.hasOwn(states, target) && !reached.has(target)) {
          reached.add(target);
          queue.push(target);
        }
      }
    }
    for (const stateName of stateNames) {
      if (!reached.has(stateName)) {
        report(
          'warning',
          `states.${stateName}`,
          'state is unreachable from the initial state',
        );
      }
    }
  }

  return finish();
};
harden(validateDefinition);

/**
 * @param {WorkflowDiagnostic[]} diagnostics
 * @returns {string}
 */
export const renderDiagnostics = diagnostics => {
  return diagnostics
    .map(({ severity, path, message }) =>
      path === ''
        ? `${severity}: ${message}`
        : `${severity} at ${path}: ${message}`,
    )
    .join('\n');
};
harden(renderDiagnostics);

/**
 * @param {unknown} allegedDefinition
 * @returns {WorkflowDefinition}
 */
export const assertValidDefinition = allegedDefinition => {
  const { ok, diagnostics } = validateDefinition(allegedDefinition);
  if (!ok) {
    throw makeError(
      X`Invalid workflow definition:\n${q(renderDiagnostics(diagnostics))}`,
    );
  }
  return /** @type {WorkflowDefinition} */ (allegedDefinition);
};
harden(assertValidDefinition);
