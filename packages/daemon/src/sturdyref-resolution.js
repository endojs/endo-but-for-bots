// @ts-check

/** @import { FormulaIdentifier } from './types.js' */

import { makeError, X } from '@endo/errors';
import { passStyleOf } from '@endo/pass-style';
import { fromLocation } from '@endo/sturdyref';

/**
 * The daemon's **closely-held** off-band binding from a SturdyRef it minted
 * to the formula identifier that SturdyRef resolves to.
 *
 * This mirrors the CapTP session manager's `sturdyRefDetails` WeakMap in
 * `@endo/ocapn`: `@endo/pass-style` defines the `'sturdyRef'` **shape** and
 * holds no binding; the trusted holder that minted a SturdyRef is the one
 * that holds its off-band resolution. Here that holder is the daemon.
 *
 * The map is module-private, so it is the daemon realm's authority alone. A
 * worker (or a confined guest) runs in a separate compartment that never
 * imports this module, so it can never read the binding: the resolution
 * capability stays daemon-side, satisfying the design's binding invariant
 * that "resolution happens only via the closely-held capability, which is
 * never handed to a guest" (designs/sturdy-refs-ocapn-enlivenment.md
 * § "Distributed confinement (binding invariants)").
 *
 * The formula identifier is the daemon-side secret analog of a swiss number:
 * it is never a property on the SturdyRef and never crosses the
 * daemon↔worker boundary — a facet resolves the SturdyRef to the id on the
 * daemon side and dispatches, so only the resolved value (never the id, and
 * never a locator secret) reaches the worker.
 *
 * @type {WeakMap<object, FormulaIdentifier>}
 */
const sturdyRefToId = new WeakMap();

/**
 * True when `value` is a first-class `'sturdyRef'` pass-style value.
 * Recognition is structural (per the realigned shape-only design, #521):
 * a value satisfies the shape whether or not this daemon minted it. A
 * SturdyRef this daemon did not mint is still a SturdyRef, but has no local
 * binding and so cannot be resolved here (see `resolveSturdyRefToId`).
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export const isSturdyRef = value => {
  try {
    return passStyleOf(/** @type {any} */ (value)) === 'sturdyRef';
  } catch {
    return false;
  }
};
harden(isSturdyRef);

/**
 * Mint a SturdyRef bound — off-band, in the closely-held `sturdyRefToId`
 * map — to a local formula identifier.
 *
 * This is the daemon-side minting half of the closely-held resolution
 * capability. The opaque token comes from the shared `@endo/sturdyref`
 * first-wins shim. The formula identifier remains only in this module's
 * private map and never appears on the token or its locator.
 *
 * @param {FormulaIdentifier} id - the local formula identifier the minted
 *   SturdyRef resolves to.
 * @returns {object} a first-class `'sturdyRef'` pass-style value.
 */
export const mintSturdyRef = id => {
  // The shim requires an object locator but does not expose it to token
  // holders. Resolution uses the daemon-private WeakMap below, not this
  // deliberately empty locator.
  const sturdyRef = fromLocation(harden({}));
  sturdyRefToId.set(sturdyRef, id);
  return sturdyRef;
};
harden(mintSturdyRef);

/**
 * Resolve a SturdyRef to a local formula identifier at the facet boundary.
 *
 * Resolution is the daemon reading its **closely-held** off-band binding —
 * never the SturdyRef's readable `location`, and never a swiss number (a
 * swiss number is never a property of a SturdyRef). Because resolution is
 * gated on the off-band binding rather than on the SturdyRef's structure, a
 * forged look-alike SturdyRef (structurally valid but never minted here)
 * has no binding and is rejected: the capability is unforgeable.
 *
 * A SturdyRef minted by another authority — an OCapN peer's CapTP session
 * manager — likewise has no local binding. Enlivening or resolving such a
 * SturdyRef requires the closely-held OCapN network capability
 * (`getSturdyRefLocator` / `enlivenSturdyRef` in `@endo/ocapn`) bridged to
 * the daemon's `internalizeLocator` flow; that bridge is a tracked
 * follow-up (design § "Enlivenment is on demand" and the #539 dependency).
 * Until it lands, a non-locally-minted SturdyRef rejects cleanly rather than
 * mis-resolving.
 *
 * @param {unknown} sturdyRef - a value for which `isSturdyRef` is true.
 * @returns {FormulaIdentifier}
 */
export const resolveSturdyRefToId = sturdyRef => {
  if (!isSturdyRef(sturdyRef)) {
    throw makeError(X`Not a SturdyRef: ${sturdyRef}`);
  }
  const id = sturdyRefToId.get(/** @type {object} */ (sturdyRef));
  if (id === undefined) {
    throw makeError(
      X`SturdyRef is not resolvable by this daemon: it was not minted here (remote SturdyRef resolution via the closely-held OCapN network capability is not yet implemented), or it is a forged look-alike with no local binding`,
    );
  }
  return id;
};
harden(resolveSturdyRefToId);
