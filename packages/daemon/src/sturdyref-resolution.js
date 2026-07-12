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
 * The rejection for a SturdyRef this daemon cannot resolve by any tier: not a
 * local #541 mint, not revealable by the OCapN capability (a self-mint or a
 * wire/URI-materialized foreign ref), so either a forged look-alike or a mint
 * from an instance this daemon never talked to. Secret-free by construction.
 *
 * @returns {Error}
 */
const unresolvableError = () =>
  makeError(
    X`SturdyRef is not resolvable by this daemon: it was not minted here, this daemon's OCapN capability cannot reveal it (so it was not materialized from a peer session or an ocapn:// URI either), or it is a forged look-alike with no local binding`,
  );

/**
 * Resolve a SturdyRef to a local formula identifier at the facet boundary,
 * LOCAL TIER ONLY (PR #541's closely-held off-band binding).
 *
 * Resolution is the daemon reading its **closely-held** off-band binding —
 * never the SturdyRef's readable `location`, and never a swiss number (a
 * swiss number is never a property of a SturdyRef). Because resolution is
 * gated on the off-band binding rather than on the SturdyRef's structure, a
 * forged look-alike SturdyRef (structurally valid but never minted here)
 * has no binding and is rejected: the capability is unforgeable.
 *
 * A SturdyRef minted by another authority — an OCapN peer's CapTP session
 * manager — has no local binding and rejects here. The foreign tier
 * (`resolveSturdyRefToIdWith`, cut 5) resolves such a SturdyRef through the
 * closely-held OCapN capability; this function is the synchronous local-only
 * predecessor kept for callers (and the module test) that never touch the
 * foreign path.
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
    throw unresolvableError();
  }
  return id;
};
harden(resolveSturdyRefToId);

/**
 * Resolve a SturdyRef to a local formula identifier at the facet boundary,
 * LOCAL TIER then FOREIGN FALLBACK (design cut 5, the facet-seam fallback
 * replacing #541's rejection).
 *
 * The local off-band binding is tried first, exactly as
 * {@link resolveSturdyRefToId}. On a miss, the injected `internalizeForeign`
 * fallback — the daemon's foreign-SturdyRef internalizer, closely held — gets
 * a chance to resolve the SturdyRef through the OCapN capability (a self-mint
 * that arrived back over the wire, or a foreign peer's SturdyRef materialized
 * from a session or an `ocapn://` URI). Only when neither tier answers does
 * this reject as forged — the unforgeability guarantee is unchanged, now
 * spanning both tiers.
 *
 * The fallback is optional so a facet with no OCapN capability in reach (or a
 * daemon with no netlayer armed) degrades to exactly the local-only behavior.
 *
 * @param {unknown} sturdyRef - a value for which `isSturdyRef` is true.
 * @param {((sturdyRef: unknown) => Promise<FormulaIdentifier | undefined>)} [internalizeForeign]
 * @returns {Promise<FormulaIdentifier>}
 */
export const resolveSturdyRefToIdWith = async (
  sturdyRef,
  internalizeForeign,
) => {
  await null;
  if (!isSturdyRef(sturdyRef)) {
    throw makeError(X`Not a SturdyRef: ${sturdyRef}`);
  }
  const id = sturdyRefToId.get(/** @type {object} */ (sturdyRef));
  if (id !== undefined) {
    return id;
  }
  if (internalizeForeign !== undefined) {
    const foreignId = await internalizeForeign(sturdyRef);
    if (foreignId !== undefined) {
      return foreignId;
    }
  }
  throw unresolvableError();
};
harden(resolveSturdyRefToIdWith);
