// @ts-check

/**
 * Define-time fragment inlining.
 *
 * A fragment is a definition of kind `fragment`: a reusable group of
 * states with declared participant slots and declared boundary events
 * (how control leaves the fragment). A definition inlines one with
 * `use`; inlining happens at `define()` time, so the flattened result is
 * what gets content-addressed and a run never knows fragments existed.
 *
 * Fragment shape:
 *
 * ```js
 * {
 *   kind: 'fragment',
 *   name: 'approval-gate',
 *   version: 1,
 *   participants: { approver: { description: '...' } },
 *   initial: 'asking',
 *   states: {
 *     asking: { entry: [...], on: {...} },
 *     approved: { boundary: 'approved' },
 *     declined: { boundary: 'declined' },
 *   },
 * }
 * ```
 *
 * A `boundary` pseudo-state marks an exit: transitions targeting it are
 * rewritten to the using state's `use.on[<event>].target` in the outer
 * machine. The using state's name becomes the fragment's initial state;
 * every other fragment state is namespaced `<state>.<name>`.
 */

import harden from '@endo/harden';
import { makeError, q, X } from '@endo/errors';

/** @import { StateDeclaration, TransitionDeclaration, WorkflowDefinition } from './types.js' */

/**
 * @param {string} reference a `slot` or `slot:attenuator` reference
 * @param {Record<string, string>} bind fragment slot -> outer reference
 * @param {string} where diagnostic location
 * @returns {string}
 */
const rebindReference = (reference, bind, where) => {
  const [slot, attenuator] = reference.split(':');
  const bound = bind[slot];
  if (bound === undefined) {
    throw makeError(X`Fragment ${q(where)} references unbound slot ${q(slot)}`);
  }
  if (attenuator === undefined) {
    return bound;
  }
  if (bound.includes(':')) {
    throw makeError(
      X`Fragment ${q(where)} would stack attenuators on ${q(bound)}`,
    );
  }
  return `${bound}:${attenuator}`;
};

/**
 * Inline every `use` state of a definition, resolving fragments by name.
 *
 * @param {WorkflowDefinition} definition
 * @param {Record<string, unknown>} fragmentsByName
 * @returns {WorkflowDefinition} the flattened definition
 */
export const inlineFragments = (definition, fragmentsByName) => {
  const usingStates = Object.entries(definition.states ?? {}).filter(
    ([, state]) => /** @type {{ use?: unknown }} */ (state).use !== undefined,
  );
  if (usingStates.length === 0) {
    return definition;
  }

  /** @type {Record<string, StateDeclaration>} */
  const states = {};
  for (const [name, state] of Object.entries(definition.states)) {
    if (/** @type {{ use?: unknown }} */ (state).use === undefined) {
      states[name] = state;
    }
  }

  for (const [useName, useState] of usingStates) {
    const use =
      /** @type {{ fragment: string, bind?: Record<string, string>, on?: Record<string, TransitionDeclaration> }} */ (
        /** @type {{ use: unknown }} */ (useState).use
      );
    const fragment = /** @type {WorkflowDefinition & { kind?: string }} */ (
      fragmentsByName[use.fragment]
    );
    if (fragment === undefined || fragment.kind !== 'fragment') {
      throw makeError(
        X`State ${q(useName)} uses unknown fragment ${q(use.fragment)}`,
      );
    }
    const bind = use.bind ?? {};
    for (const slot of Object.keys(fragment.participants ?? {})) {
      if (bind[slot] === undefined) {
        throw makeError(
          X`State ${q(useName)} leaves fragment slot ${q(slot)} unbound`,
        );
      }
    }

    /** @param {string} stateName */
    const rename = stateName =>
      stateName === fragment.initial ? useName : `${useName}.${stateName}`;

    /** @type {Record<string, string>} boundary state name -> outer target */
    const boundaryTargets = {};
    for (const [stateName, state] of Object.entries(fragment.states)) {
      const boundary = /** @type {{ boundary?: string }} */ (state).boundary;
      if (boundary !== undefined) {
        const outer = use.on?.[boundary];
        if (outer === undefined) {
          throw makeError(
            X`State ${q(useName)} does not map fragment boundary ${q(boundary)}`,
          );
        }
        boundaryTargets[stateName] = outer.target;
      }
    }

    /** @param {string} target */
    const retarget = target =>
      Object.hasOwn(boundaryTargets, target)
        ? boundaryTargets[target]
        : rename(target);

    for (const [stateName, state] of Object.entries(fragment.states)) {
      if (/** @type {{ boundary?: string }} */ (state).boundary !== undefined) {
        // eslint-disable-next-line no-continue
        continue;
      }
      /** @type {StateDeclaration} */
      const inlined = { ...state };
      if (state.entry !== undefined) {
        inlined.entry = state.entry.map(effect =>
          harden({
            ...effect,
            ...(effect.to === undefined
              ? {}
              : {
                  to: rebindReference(
                    effect.to,
                    bind,
                    `${use.fragment}.${stateName}`,
                  ),
                }),
            ...(effect.attach === undefined
              ? {}
              : {
                  attach: effect.attach.map(reference =>
                    rebindReference(
                      reference,
                      bind,
                      `${use.fragment}.${stateName}`,
                    ),
                  ),
                }),
          }),
        );
      }
      if (state.on !== undefined) {
        /** @type {NonNullable<StateDeclaration['on']>} */
        const on = {};
        for (const [type, candidates] of Object.entries(state.on)) {
          const list = Array.isArray(candidates) ? candidates : [candidates];
          on[type] = list.map(transition =>
            harden({ ...transition, target: retarget(transition.target) }),
          );
        }
        inlined.on = harden(on);
      }
      if (state.after !== undefined) {
        inlined.after = harden({
          ...state.after,
          target: retarget(state.after.target),
        });
      }
      if (state.onError !== undefined) {
        inlined.onError = retarget(state.onError);
      }
      const inlinedName = rename(stateName);
      if (Object.hasOwn(states, inlinedName)) {
        throw makeError(
          X`Fragment inlining collides on state name ${q(inlinedName)}`,
        );
      }
      states[inlinedName] = harden(inlined);
    }
  }

  return harden({ ...definition, states: harden(states) });
};
harden(inlineFragments);
