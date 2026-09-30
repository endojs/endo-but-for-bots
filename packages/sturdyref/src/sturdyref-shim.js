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
 * Installation may happen before or after `lockdown`, like the
 * `HandledPromise` shim. The constructor must never call `@endo/harden` before
 * `lockdown`: doing so installs `Object[@harden]`, after which `lockdown`
 * refuses to run. So the constructor is hardened with `@endo/harden` only
 * when a harden is already present (`lockdown` has run, or another library
 * already installed one). Otherwise the constructor, its prototype, and its
 * statics are merely frozen, and `lockdown` hardens them later along with
 * every other intrinsic. Installing before `lockdown` is what lets SES admit
 * `SturdyRef` at `repairIntrinsics` time and share it with child
 * compartments. Every ref is frozen at construction either way.
 *
 * Installation is still LAZY: nothing is installed at import time. The first
 * call to `provideSturdyRef()` performs the race-to-install. The eager
 * `@endo/sturdyref/shim.js` entry simply forces that first call.
 */

import harden from '@endo/harden';

const { defineProperty, freeze, getOwnPropertyDescriptor } = Object;
const { apply } = Reflect;

// Captured at module load, so that later mutation of `WeakMap.prototype` in a
// realm that has not (yet) been locked down cannot observe or redirect the
// closely held ref-to-handler map.
const { get: weakMapGet, set: weakMapSet, has: weakMapHas } = WeakMap.prototype;

const symbolForHarden = Symbol.for('harden');

/**
 * Whether a harden implementation is already installed, which is the case
 * after `lockdown` (or once any `@endo/harden` has been used). Only then is it
 * safe to call `@endo/harden`; before `lockdown`, calling it would install a
 * harden of its own and make `lockdown` throw.
 */
const isHardenInstalled = () =>
  /** @type {any} */ (Object)[symbolForHarden] !== undefined ||
  /** @type {any} */ (globalThis).harden !== undefined;

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
      // Reject subclassing and `Reflect.construct` with a foreign `new.target`,
      // either of which would mint a branded ref whose prototype, and thus
      // behavior (a `then`, a `toString`), is chosen by the caller.
      if (new.target !== SturdyRef) {
        throw TypeError('SturdyRef cannot be subclassed');
      }
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
      apply(weakMapSet, handlers, [this, freeze({ handler, enliven })]);
    }

    /**
     * @param {unknown} value
     * @returns {value is SturdyRef}
     */
    static isSturdyRef(value) {
      return apply(weakMapHas, handlers, [value]);
    }

    /**
     * @param {SturdyRef} ref
     * @returns {Promise<unknown>}
     */
    static enliven(ref) {
      return Promise.resolve().then(() => {
        const entry = apply(weakMapGet, handlers, [ref]);
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

  if (isHardenInstalled()) {
    harden(SturdyRef);
  } else {
    // Before lockdown: freeze everything reachable that is ours, and leave
    // hardening (including the shared intrinsics above these) to lockdown.
    freeze(SturdyRef.enliven);
    freeze(SturdyRef.isSturdyRef);
    freeze(SturdyRef.prototype);
    freeze(SturdyRef);
  }

  return /** @type {SturdyRefConstructor} */ (
    /** @type {unknown} */ (SturdyRef)
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
 * there first), adopt it, locking the global binding (non-writable,
 * non-configurable) if it was not already locked, so that no later twin can
 * adopt a different constructor. Otherwise make and install ours
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
    const desc = getOwnPropertyDescriptor(globalThis, 'SturdyRef');
    if (
      desc === undefined ||
      desc.configurable ||
      !('value' in desc) ||
      desc.writable
    ) {
      // Throws if the binding is a non-configurable accessor, which cannot
      // be locked to one constructor.
      defineProperty(globalThis, 'SturdyRef', {
        value: existing,
        enumerable: false,
        writable: false,
        configurable: false,
      });
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
 * installing it first-wins on the first call. Safe to import, and to call,
 * before `lockdown`.
 *
 * @returns {SturdyRefConstructor}
 */
export const provideSturdyRef = () => {
  if (selected === undefined) {
    selected = selectSturdyRef();
  }
  return selected;
};
