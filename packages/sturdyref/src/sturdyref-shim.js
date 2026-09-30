/* This module provides the first-wins mechanism that races to install the
 * `SturdyRef` constructor at `globalThis.SturdyRef`.
 *
 * A SturdyRef is constructed the way a `Proxy` or `HandledPromise` is, with a
 * handler: `new SturdyRef(handler)`. The handler's `enliven` hook defines both
 * what the ref captures (whatever the handler closes over) and how the ref is
 * revived. `SturdyRef.enliven(ref)` sends `enliven` to the ref, dispatching to
 * its handler's hook in a later turn. `SturdyRef.isSturdyRef(value)` is a brand
 * check that confers no authority.
 *
 * The point of first-wins is convergence: many independently evaluated
 * copies (eval twins) of a ponyfill, ocapn, or captp that share a realm all
 * race to install this constructor, but only the first installation takes;
 * every later importer senses the existing global and adopts it. The realm
 * then shares ONE `SturdyRef` constructor, and therefore ONE closely held
 * WeakMap from a ref to its handler, so a ref minted by one twin is recognized
 * and enlivened by any other twin.
 *
 * The global confers no authority: construction only wraps a handler the
 * caller already has, the brand check reveals nothing, and `enliven` only runs
 * the hook of a ref the caller already holds. The shim therefore takes no
 * position on whether child compartments see it; that is SES's decision.
 *
 * The constructor, its prototype, and every ref are hardened by
 * `@endo/harden`. Because hardening must happen after `lockdown` when
 * `lockdown` will be called, installation is LAZY: nothing is installed or
 * hardened at import time. The first call to `provideSturdyRef()` performs
 * the race-to-install. The eager `@endo/sturdyref/shim.js` entry, meant to be
 * imported in a lockdown bootstrap AFTER `lockdown()`, simply forces that
 * first call.
 */

import harden from '@endo/harden';

const { defineProperty, freeze } = Object;
const { apply } = Reflect;

/**
 * An opaque, frozen object with no own properties. What it captures is
 * defined entirely by the handler it was constructed with, which is never
 * reachable from the ref.
 *
 * @typedef {Readonly<Record<never, never>>} SturdyRef
 */

/**
 * @typedef {object} SturdyRefHandler
 * @property {(ref: SturdyRef) => unknown} enliven Revive the ref into a live
 *   reference (or a promise for one). Called with the handler as `this` and
 *   the ref as its argument.
 */

/**
 * @typedef {object} SturdyRefStatics
 * @property {(ref: SturdyRef) => Promise<unknown>} enliven Send `enliven` to
 *   the ref: in a later turn, invoke its handler's hook and settle with the
 *   result. Rejects for a non-SturdyRef.
 * @property {(value: unknown) => value is SturdyRef} isSturdyRef Brand check.
 */

/**
 * @typedef {(new (handler: SturdyRefHandler) => SturdyRef) &
 *   SturdyRefStatics} SturdyRefConstructor
 */

/**
 * Make a fresh `SturdyRef` constructor closing over its own private WeakMap
 * from ref to handler. Only the first constructor to reach `globalThis` (see
 * `selectSturdyRef`) is retained by the realm; the rest are discarded.
 * Exported for tests that need an un-installed control instance.
 *
 * @returns {SturdyRefConstructor}
 */
export const makeSturdyRefConstructor = () => {
  /**
   * From each ref to the handler and the `enliven` hook read from it at
   * construction. Never reachable from a ref.
   *
   * @type {WeakMap<SturdyRef, { handler: SturdyRefHandler, enliven: (ref: SturdyRef) => unknown }>}
   */
  const handlers = new WeakMap();

  class SturdyRef {
    /**
     * @param {SturdyRefHandler} handler
     */
    constructor(handler) {
      if (
        handler === null ||
        (typeof handler !== 'object' && typeof handler !== 'function')
      ) {
        throw TypeError('SturdyRef handler must be an object');
      }
      // Read once, at construction, so later mutation of the handler cannot
      // redirect enlivening.
      const { enliven } = handler;
      if (typeof enliven !== 'function') {
        throw TypeError('SturdyRef handler must have an enliven method');
      }
      freeze(this);
      // Safe because this WeakMap owns its set method.
      handlers.set(this, { handler, enliven });
    }

    /**
     * @param {unknown} value
     * @returns {value is SturdyRef}
     */
    static isSturdyRef(value) {
      // Safe because this WeakMap owns its has method.
      return handlers.has(/** @type {SturdyRef} */ (value));
    }

    /**
     * @param {SturdyRef} ref
     * @returns {Promise<unknown>}
     */
    static enliven(ref) {
      return Promise.resolve().then(() => {
        // Safe because this WeakMap owns its get method.
        const entry = handlers.get(ref);
        if (entry === undefined) {
          throw TypeError('SturdyRef.enliven expects a SturdyRef');
        }
        return apply(entry.enliven, entry.handler, [ref]);
      });
    }
  }

  defineProperty(SturdyRef.prototype, Symbol.toStringTag, {
    value: 'SturdyRef',
    writable: false,
    enumerable: false,
    configurable: false,
  });

  return /** @type {SturdyRefConstructor} */ (
    /** @type {unknown} */ (harden(SturdyRef))
  );
};

/**
 * @param {unknown} candidate
 * @returns {candidate is SturdyRefConstructor}
 */
const isSturdyRefConstructor = candidate => {
  if (typeof candidate !== 'function') {
    return false;
  }
  const { enliven, isSturdyRef } =
    /** @type {{ enliven?: unknown, isSturdyRef?: unknown }} */ (
      /** @type {unknown} */ (candidate)
    );
  return typeof enliven === 'function' && typeof isSturdyRef === 'function';
};

/**
 * Race to install the `SturdyRef` constructor at `globalThis.SturdyRef`,
 * first-wins. If a valid constructor is already installed (an eval twin got
 * there first), adopt it unchanged. Otherwise make, harden, and install ours
 * non-configurably and non-writably so that no later code, twin or attacker,
 * can replace the realm's shared constructor.
 *
 * @returns {SturdyRefConstructor}
 */
export const selectSturdyRef = () => {
  const { SturdyRef: existing } = /** @type {any} */ (globalThis);
  if (existing !== undefined) {
    if (!isSturdyRefConstructor(existing)) {
      throw TypeError(
        '@endo/sturdyref expected globalThis.SturdyRef to be a constructor with enliven and isSturdyRef statics',
      );
    }
    return existing;
  }

  const SturdyRef = makeSturdyRefConstructor();
  defineProperty(globalThis, 'SturdyRef', {
    value: SturdyRef,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return SturdyRef;
};

/** @type {SturdyRefConstructor | undefined} */
let selected;

/**
 * Lazily and idempotently obtain the realm's shared `SturdyRef` constructor,
 * installing it first-wins on the first call. Safe to import before
 * `lockdown` because it does nothing until called.
 *
 * @returns {SturdyRefConstructor}
 */
export const provideSturdyRef = () => {
  if (selected === undefined) {
    selected = selectSturdyRef();
  }
  return selected;
};
