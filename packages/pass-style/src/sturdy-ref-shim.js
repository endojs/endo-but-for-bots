/* global globalThis */
import harden from '@endo/harden';
import { Fail } from '@endo/errors';
import { makeSturdyRef } from './sturdyref.js';

/**
 * @import {SturdyRef, SturdyRefNamespace} from './types.js';
 */

const { defineProperty } = Object;

/**
 * Build a fresh `SturdyRef` namespace: `fromLocation` mints an opaque SturdyRef
 * bound to a locator **object**, `toLocation` reveals it. The mapping lives in
 * a realm-global, retained `WeakMap` closed over by the namespace — which is
 * itself installed on `globalThis` — so it survives for the life of the realm
 * and every eval twin of OCapN or CapTP that converges on the same namespace
 * shares one mapping.
 *
 * The namespace is a distinct, closely-held authority: it is not a SES
 * intrinsic (there is no permit for it) and must never be endowed to a child
 * compartment. A confined guest that cannot reach `SturdyRef.toLocation`
 * therefore holds only opaque SturdyRefs, never their locators.
 *
 * Locators are required to be objects — the API is deliberately **not** coupled
 * to a URL or URN string representation. `@endo/pass-style` knows nothing of a
 * locator's shape; only the closely-held holder of the namespace (and each
 * CapTP instance) interprets it.
 *
 * @returns {SturdyRefNamespace}
 */
const makeSturdyRefNamespace = () => {
  /** @type {WeakMap<SturdyRef, object>} */
  const sturdyRefToLocator = new WeakMap();

  /**
   * @param {object} locator
   * @returns {SturdyRef}
   */
  const fromLocation = locator => {
    (typeof locator === 'object' && locator !== null) ||
      Fail`SturdyRef.fromLocation requires an object locator, not a URL or URN: ${locator}`;
    const sturdyRef = makeSturdyRef();
    sturdyRefToLocator.set(sturdyRef, locator);
    return sturdyRef;
  };
  harden(fromLocation);

  /**
   * @param {SturdyRef} sturdyRef
   * @returns {object | undefined}
   */
  const toLocation = sturdyRef => sturdyRefToLocator.get(sturdyRef);
  harden(toLocation);

  return harden({ fromLocation, toLocation });
};

/**
 * First-wins install of the realm-global `SturdyRef` namespace. Races to be the
 * first to define `globalThis.SturdyRef`; a twin that loses the race falls
 * through to the already-installed namespace, so all twins in one realm
 * converge on a single mapping.
 *
 * The namespace is hardened by `@endo/harden`, so **when `lockdown` is used the
 * shim must be initialised after `lockdown`** — calling this before `harden` is
 * armed would install a namespace that is not deeply frozen. It is idempotent:
 * once installed, every subsequent call returns the same namespace.
 *
 * @returns {SturdyRefNamespace}
 */
export const installSturdyRefShim = () => {
  const existing = /** @type {SturdyRefNamespace | undefined} */ (
    globalThis.SturdyRef
  );
  if (existing !== undefined) {
    return existing;
  }
  const namespace = makeSturdyRefNamespace();
  try {
    // Non-configurable and non-writable: the first installer wins and no twin
    // can later replace the namespace. A twin that lost the race lands in the
    // catch and reads the installed one below.
    defineProperty(globalThis, 'SturdyRef', {
      value: namespace,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  } catch {
    // Lost the first-wins race: another eval twin installed the namespace
    // between our read and our define. Fall through to the installed one.
  }
  return /** @type {SturdyRefNamespace} */ (globalThis.SturdyRef);
};
harden(installSturdyRefShim);
