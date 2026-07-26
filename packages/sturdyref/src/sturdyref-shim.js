/* This module provides the first-wins mechanism that races to install the
 * `SturdyRef` namespace — `SturdyRef`, `SturdyRef.fromLocation`, and
 * `SturdyRef.toLocation` — at `globalThis.SturdyRef`.
 *
 * The point of first-wins is convergence: many independently evaluated
 * copies (eval twins) of a ponyfill, ocapn, or captp that share a realm all
 * race to install this namespace, but only the first installation takes; every
 * later importer senses the existing global and adopts it. Because the whole
 * realm then shares ONE `SturdyRef` namespace — and therefore ONE closely-held
 * WeakMap from a sturdyref to its locator record — a sturdyref minted by one
 * twin resolves to the same locator through any other twin.
 *
 * The installed globals deliberately have NO SES permits, so `lockdown` does
 * not know about them and a child `Compartment` never receives them: the
 * `SturdyRef` namespace is withheld from confined guests by construction (a
 * child compartment's global is built from permits and endowments, never from
 * this — the parent's — global object).
 *
 * The namespace and every sturdyref it mints are hardened by `@endo/harden`.
 * Because hardening must happen after `lockdown` when `lockdown` will be
 * called, installation is LAZY: nothing is installed or hardened at import
 * time. The first call to `provideSturdyRef()` (typically the first time
 * something mints or resolves a sturdyref, well after `lockdown`) performs the
 * race-to-install. The eager `@endo/sturdyref/shim.js` entry, meant to be
 * imported in a lockdown bootstrap AFTER `lockdown()`, simply forces that first
 * call.
 */

/* global globalThis */

import harden from '@endo/harden';
import { makeSturdyRef } from '@endo/pass-style';

/** @import { SturdyRef } from '@endo/pass-style' */

const { defineProperty } = Object;

/**
 * A locator record is an opaque OBJECT (never a string, never coupled to any
 * URL/URN scheme) that names where a capability may be enlivened. The shim
 * treats it opaquely: it only stores and returns it.
 *
 * @typedef {Record<PropertyKey, unknown>} Locator
 */

/**
 * A SturdyRef is an opaque, passable object with no own properties leaking the
 * locator. Its locator lives only behind the closely-held, globally-retained
 * WeakMap of the shared `SturdyRef` namespace. Guests that hold a sturdyref but
 * not the namespace can neither read its locator (no location) nor correlate
 * two sturdyrefs of the same locator (no identification — each mint is fresh).
 *
 * @typedef {object} SturdyRefNamespace
 * @property {(locator: Locator) => SturdyRef} fromLocation Mint a fresh opaque
 *   sturdyref for a locator record, retaining the mapping in the shared,
 *   globally-retained WeakMap.
 * @property {(sturdyRef: SturdyRef) => Locator} toLocation Recover the locator
 *   record a sturdyref was minted for. Throws if the sturdyref is unknown to
 *   this realm's shared mapping.
 */

/**
 * Construct a fresh `SturdyRef` namespace closing over its own private WeakMap
 * from sturdyref to locator record. Only the first namespace to reach
 * `globalThis` (see `selectSturdyRef`) is retained by the realm; the rest are
 * discarded. Exported for tests that need an un-installed control instance.
 *
 * @returns {SturdyRefNamespace}
 */
export const makeSturdyRefNamespace = () => {
  /**
   * The mapping the shim exists to provide: from an opaque sturdyref to its
   * locator record. Retained by the namespace, which is retained by
   * `globalThis`, hence retained globally for the life of the realm.
   *
   * @type {WeakMap<SturdyRef, Locator>}
   */
  const locators = new WeakMap();

  /** @type {(locator: Locator) => SturdyRef} */
  const fromLocation = locator => {
    if (
      locator === null ||
      (typeof locator !== 'object' && typeof locator !== 'function')
    ) {
      throw TypeError(
        'SturdyRef.fromLocation expects a locator record (an object), not a primitive',
      );
    }
    // The locator record is closely held; harden it so the value behind the
    // WeakMap cannot be mutated by a later holder of the same record.
    harden(locator);
    // A fresh opaque pass-by-copy SturdyRef: no own property carries the
    // locator, and two sturdyrefs of the same locator are distinct (no
    // identification). It never crosses the wire in this form.
    const sturdyRef = makeSturdyRef();
    // Safe because this WeakMap owns its set method.
    // eslint-disable-next-line @endo/no-polymorphic-call
    locators.set(sturdyRef, locator);
    return sturdyRef;
  };

  /** @type {(sturdyRef: SturdyRef) => Locator} */
  const toLocation = sturdyRef => {
    // Safe because this WeakMap owns its get method.
    // eslint-disable-next-line @endo/no-polymorphic-call
    const locator = locators.get(sturdyRef);
    if (locator === undefined) {
      throw TypeError(
        'Not a SturdyRef known to this realm, or its locator is not retained here',
      );
    }
    return locator;
  };

  return harden({ fromLocation, toLocation });
};

/**
 * @param {unknown} candidate
 * @returns {candidate is SturdyRefNamespace}
 */
const isSturdyRefNamespace = candidate => {
  if (
    (typeof candidate !== 'object' && typeof candidate !== 'function') ||
    candidate === null
  ) {
    return false;
  }
  const { fromLocation, toLocation } =
    /** @type {{ fromLocation?: unknown, toLocation?: unknown }} */ (candidate);
  return typeof fromLocation === 'function' && typeof toLocation === 'function';
};

/**
 * Race to install the `SturdyRef` namespace at `globalThis.SturdyRef`,
 * first-wins. If a valid namespace is already installed (an eval twin got there
 * first), adopt it unchanged. Otherwise mint, harden, and install ours
 * non-configurably and non-writably so that no later code — twin or attacker —
 * can replace the realm's shared mapping.
 *
 * @returns {SturdyRefNamespace}
 */
export const selectSturdyRef = () => {
  // Read through a cast rather than the ambient `shim.types.d.ts` global
  // declaration: a dependent package's program (as typedoc builds one per
  // package) compiles this source without that ambient file in scope.
  const { SturdyRef: existing } =
    // eslint-disable-next-line no-restricted-globals
    /** @type {{ SturdyRef?: SturdyRefNamespace }} */ (
      /** @type {unknown} */ (globalThis)
    );
  if (existing !== undefined) {
    if (!isSturdyRefNamespace(existing)) {
      throw new Error(
        '@endo/sturdyref expected globalThis.SturdyRef to be a { fromLocation, toLocation } namespace',
      );
    }
    return existing;
  }

  const namespace = makeSturdyRefNamespace();
  // No SES permit corresponds to this global, so `lockdown` does not propagate
  // it to child compartments. Non-enumerable, non-writable, non-configurable so
  // the realm's shared mapping is stable and closely held.
  defineProperty(globalThis, 'SturdyRef', {
    value: namespace,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return namespace;
};

let selected;

/**
 * Lazily and idempotently obtain the realm's shared `SturdyRef` namespace,
 * installing it first-wins on the first call. Safe to import before `lockdown`
 * because it does nothing until called; ponyfills, ocapn, and captp call it
 * only when they actually mint or resolve a sturdyref, which is after
 * `lockdown`.
 *
 * @returns {SturdyRefNamespace}
 */
export const provideSturdyRef = () => {
  if (selected === undefined) {
    selected = selectSturdyRef();
  }
  return selected;
};
