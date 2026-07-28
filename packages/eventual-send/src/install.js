// @ts-check

/* This module provides the install path shared by
 * `@endo/eventual-send/shim.js` (eager) and `@endo/eventual-send` (lazy).
 *
 * The package installs a peer bank of functions onto the realm-shared
 * `Promise` constructor, each at its own registered-symbol slot:
 *
 *   Promise[Symbol.for('delegate')]              - delegate(handler)
 *   Promise[Symbol.for('applyMethod')]           - applyMethod
 *   Promise[Symbol.for('applyMethodSendOnly')]   - applyMethodSendOnly
 *   Promise[Symbol.for('applyFunction')]         - applyFunction
 *   Promise[Symbol.for('applyFunctionSendOnly')] - applyFunctionSendOnly
 *   Promise[Symbol.for('get')]                   - get
 *   Promise[Symbol.for('getSendOnly')]           - getSendOnly
 *   Promise[Symbol.for('resolve')]               - resolve (HandledPromise.resolve)
 *
 * `installOrAdoptOne(name)` reads `Promise[Symbol.for(name)]` and either
 * adopts the previously-installed peer or races to install a fresh one
 * via `Object.defineProperty(... configurable:false, writable:false)`.
 * The first writer wins per slot; subsequent readers from any module
 * instance or compartment of the same realm read the slot and adopt.
 *
 * `installOrAdoptAll()` walks every name in the bank and installs each
 * in turn, returning the resulting realm-shared bank.
 *
 * The `delegate` slot has a forward-compatibility hook: if
 * `Promise.delegate` (the expected TC39 standard slot) is already a
 * function, the install path returns it without touching the registry
 * symbol slot.
 *
 * The two surfaces (eager shim and lazy main) differ only in WHEN they
 * call `installOrAdoptAll()` / `installOrAdoptOne()`:
 *
 * - `shim.js` calls `installOrAdoptAll()` at module load (eagerly), as
 *   a side effect of import.
 * - the main entry calls `installOrAdoptOne(name)` lazily on first use
 *   of the corresponding lexical ponyfill thunk.
 *
 * Both surfaces converge on the same realm-shared peers via the
 * registered-symbol slots, regardless of import order vs lockdown.
 */

import { make } from './make.js';

/** @import { Bank } from './make.js' */

/** @typedef {keyof Bank} BankName */

/**
 * @type {readonly BankName[]}
 */
const bankNames = Object.freeze([
  'delegate',
  'applyFunction',
  'applyFunctionSendOnly',
  'applyMethod',
  'applyMethodSendOnly',
  'get',
  'getSendOnly',
  'resolve',
  'HandledPromise',
]);

/** @type {Record<BankName, symbol>} */
const slotSymbols = /** @type {any} */ ({});
for (const name of bankNames) {
  slotSymbols[name] = Symbol.for(name);
}
Object.freeze(slotSymbols);

/**
 * Module-local cache of the realm-shared bank. Once any peer is
 * resolved, all peers are read together so that subsequent calls
 * short-circuit on the cache and converge on a single value per name.
 *
 * @type {Partial<Bank>}
 */
const cached = {};

/**
 * Build a fresh bank lazily on first use, so that pure-read paths
 * (where every slot is already populated) do not allocate one.
 *
 * @type {Bank | undefined}
 */
let lazyFresh;
const ensureFresh = () => {
  if (!lazyFresh) {
    lazyFresh = make();
  }
  return lazyFresh;
};

/**
 * Read `Promise[Symbol.for(name)]` for the named peer, install on
 * demand if absent, recover from a lost race. Returns the realm-shared
 * function regardless of who installed it.
 *
 * For the `delegate` peer, additionally consults `Promise.delegate`
 * (the expected TC39 standard slot) before the registry symbol.
 *
 * Subsequent calls within the same module instance for the same name
 * short-circuit on a module-local cache. Calls from a different module
 * instance hit the registered-symbol slot directly and converge on the
 * same value.
 *
 * @template {BankName} N
 * @param {N} name
 * @returns {Bank[N]}
 */
export const installOrAdoptOne = name => {
  const hit = cached[name];
  if (hit !== undefined) return /** @type {Bank[N]} */ (hit);

  // Forward-compatibility hook for the standard `Promise.delegate`.
  // If a future host or shim provides a standard delegate function,
  // adopt it directly without consulting the registered-symbol slot.
  if (name === 'delegate') {
    const standardDelegate = /** @type {any} */ (Promise).delegate;
    if (typeof standardDelegate === 'function') {
      cached[name] = standardDelegate;
      return /** @type {Bank[N]} */ (standardDelegate);
    }
  }

  const slot = slotSymbols[name];
  // Adopt a previously-installed peer from the registered-symbol slot
  // if any prior writer (this package's shim, this package's main entry
  // from a different module instance, or another library following the
  // same convention) installed one.
  // Every peer in the bank (including HandledPromise) is callable, so
  // a non-function value in the slot is a foreign use of the symbol.
  const present = /** @type {any} */ (Promise)[slot];
  if (typeof present === 'function') {
    cached[name] = present;
    return /** @type {Bank[N]} */ (present);
  }
  if (present !== undefined) {
    throw new TypeError(
      `@endo/eventual-send: Promise[Symbol.for(${JSON.stringify(name)})] must be a function`,
    );
  }

  // The slot is empty. Build (or reuse) a fresh bank and race to
  // install this peer.
  const fresh = ensureFresh();
  const value = fresh[name];
  try {
    Object.defineProperty(Promise, slot, {
      value,
      configurable: false,
      writable: false,
      enumerable: false,
    });
    cached[name] = value;
    return /** @type {Bank[N]} */ (value);
  } catch (err) {
    const winner = /** @type {any} */ (Promise)[slot];
    if (winner !== undefined && typeof winner === 'function') {
      cached[name] = winner;
      return /** @type {Bank[N]} */ (winner);
    }
    if (winner === undefined) {
      throw new TypeError(
        `Cannot install @endo/eventual-send: Promise is frozen and Promise[Symbol.for(${JSON.stringify(name)})] was not pre-installed before lockdown. Import @endo/eventual-send/shim.js (or @endo/init) before calling lockdown().`,
      );
    }
    throw /** @type {Error} */ (err);
  }
};
Object.freeze(installOrAdoptOne);

/**
 * Install or adopt every peer in the bank, in declaration order.
 * Returns the realm-shared bank as a frozen record.
 *
 * The eager shim calls this at module load. The lazy main entry does
 * not call it directly; each lexical ponyfill thunk calls
 * `installOrAdoptOne(name)` for its own peer on first use.
 *
 * @returns {Bank}
 */
export const installOrAdoptAll = () => {
  /** @type {Partial<Bank>} */
  const result = {};
  for (const name of bankNames) {
    /** @type {any} */ (result)[name] = installOrAdoptOne(name);
  }
  return /** @type {Bank} */ (Object.freeze(result));
};
Object.freeze(installOrAdoptAll);

// Single-level `freeze` rather than `harden`: this module is imported
// by `shim.js` which loads before `lockdown()` in the standard
// `@endo/init` flow. Importing `@endo/harden` here would install
// `Object[Symbol.for('harden')]` pre-lockdown and force lockdown to
// fail with the "harden already installed" diagnostic. The exported
// closures and their module-local `cached` are part of the intrinsic
// graph that `lockdown()` traverses and freezes when it runs; until
// then, `Object.freeze` is sufficient.
// This mirrors the discipline in `packages/harden/make-selector.js`'s
// `Object.freeze(harden)` call.
