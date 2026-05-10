// @ts-check

/* This module provides the bi-modal ponyfill for `HandledPromise`,
 * modeled on `@endo/harden`'s race-to-install pattern at
 * `Object[Symbol.for('harden')]`.
 *
 * The slot is `Promise[Symbol.for('delegate')]`, anticipating the
 * TC39 `Promise.delegate` proposal. The first writer wins via
 * `Object.defineProperty(..., {configurable: false, writable: false})`;
 * subsequent callers (in any module instance, in any compartment of
 * the same realm) read the slot and adopt the winner.
 *
 * `getHandledPromise()` is the only export. It returns the registered
 * `HandledPromise` constructor regardless of who installed it. Calls
 * after the first short-circuit on a module-local cache.
 */

/* global globalThis */

import { makeHandledPromise } from './src/handled-promise.js';

/** @import { HandledPromiseConstructor } from './src/handled-promise.js' */

const symbolForDelegate = Symbol.for('delegate');

/** @type {HandledPromiseConstructor | undefined} */
let cached;

/**
 * Internal helper: read the slot, install if absent, recover from a
 * lost race. Returns the realm-shared `HandledPromise` constructor.
 *
 * @returns {HandledPromiseConstructor}
 */
const selectHandledPromise = () => {
  // Forward-compatibility hook for the standard `Promise.delegate`.
  // If a future host or shim provides a standard delegate function,
  // adopt it directly without consulting the registered-symbol slot.
  const standardDelegate = /** @type {any} */ (Promise).delegate;
  if (typeof standardDelegate === 'function') {
    return standardDelegate;
  }
  if (standardDelegate !== undefined) {
    throw new TypeError(
      '@endo/eventual-send expected Promise.delegate to be a function',
    );
  }

  const installed = /** @type {any} */ (Promise)[symbolForDelegate];
  if (typeof installed === 'function') {
    return installed;
  }
  if (installed !== undefined) {
    throw new TypeError(
      '@endo/eventual-send expected Promise[@delegate] to be a function',
    );
  }

  // Legacy back-compat: a prior import of `@endo/eventual-send/shim.js`
  // (or another library following the same convention) may have written
  // `globalThis.HandledPromise`. Adopt it without re-installing into the
  // registered-symbol slot. This keeps the existing `@endo/init`
  // workflow (shim.js writes the global, then lockdown freezes the
  // realm) working under the ponyfill: the ponyfill sees no slot value,
  // sees a global, adopts it. Future stages migrate the shim to write
  // the slot directly.
  const legacyGlobal = /** @type {any} */ (globalThis).HandledPromise;
  if (typeof legacyGlobal === 'function') {
    return legacyGlobal;
  }
  if (legacyGlobal !== undefined) {
    throw new TypeError(
      '@endo/eventual-send expected globalThis.HandledPromise to be a function',
    );
  }

  const fresh = makeHandledPromise();

  // Race to install. `defineProperty` with `configurable: false` will
  // throw if a competing library wrote between our read and our write
  // (or if `Promise` is frozen because lockdown has already run); the
  // catch path then re-reads the slot and adopts the winner if there
  // is one, otherwise re-throws with a diagnostic.
  try {
    Object.defineProperty(Promise, symbolForDelegate, {
      value: fresh,
      configurable: false,
      writable: false,
      enumerable: false,
    });
    return fresh;
  } catch (err) {
    const winner = /** @type {any} */ (Promise)[symbolForDelegate];
    if (typeof winner === 'function') {
      return winner;
    }
    // Slot is still empty (or non-function) and we could not install.
    // The most likely cause is that `Promise` was frozen by `lockdown()`
    // before any library installed the delegate. Re-throw with a
    // diagnostic that points at the loading-order constraint.
    if (winner === undefined) {
      throw new TypeError(
        'Cannot install @endo/eventual-send: Promise is frozen and ' +
          'Promise[@delegate] was not pre-installed before lockdown. ' +
          'Import @endo/eventual-send (or @endo/init) before calling ' +
          'lockdown(), or use a SES build that installs a default ' +
          'delegate.',
      );
    }
    throw /** @type {Error} */ (err);
  }
};

/**
 * Returns the realm-shared `HandledPromise` constructor. If
 * `Promise.delegate` (the eventual standard) is present, it wins.
 * Otherwise the registered-symbol slot `Promise[Symbol.for('delegate')]`
 * is read; on hit, that value wins. Otherwise a legacy
 * `globalThis.HandledPromise` (per the older `@endo/eventual-send/shim.js`
 * convention) wins. Otherwise this call races to install a fresh
 * implementation at the registered-symbol slot. Subsequent calls return
 * the cached value without re-reading any slot.
 *
 * @returns {HandledPromiseConstructor}
 */
export const getHandledPromise = () => {
  if (!cached) {
    cached = selectHandledPromise();
  }
  return cached;
};
// We intentionally avoid `harden()` at module load: this module is
// imported by `shim.js` which may run before `lockdown()`. The export
// is a closure over a private `let cached`, both of which are frozen
// by lockdown via SES's intrinsic-graph traversal once it runs, and
// `Object.freeze` is sufficient as the shallow guarantee until then.
// This mirrors the discipline in `@endo/harden`'s `make-selector.js`.
Object.freeze(getHandledPromise);
