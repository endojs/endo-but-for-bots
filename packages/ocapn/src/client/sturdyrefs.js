// @ts-check

/**
 * @import { OcapnLocation } from '../codecs/components.js'
 * @import { InternalSession } from './types.js'
 * @import { SturdyRef } from '@endo/pass-style'
 */

import harden from '@endo/harden';
import { E } from '@endo/eventual-send';
import { isSturdyRef } from '@endo/pass-style';
import { fromLocation, toLocation } from '@endo/sturdyref';
import { encodeSwissnum, swissnumFromBytes } from './util.js';

export { isSturdyRef };

/**
 * The off-band locator a SturdyRef points at: the parsed `location`, the
 * `secret` (swiss number) needed to re-acquire the capability, and an optional
 * advisory `type` hint. This is the **object locator** the realm-global
 * `SturdyRef` shim retains, keyed by SturdyRef identity — it is never a URL or
 * URN string, and it is never a property on the opaque SturdyRef itself.
 *
 * @typedef {object} SturdyRefLocator
 * @property {OcapnLocation} location
 * @property {string | Uint8Array} secret
 * @property {string} [type]
 */

/**
 * Reveal a SturdyRef's off-band locator through the closely-held realm-global
 * mapping, or `undefined` when `sturdyRef` is not a SturdyRef or has no locator
 * registered in this realm. This is the only path that yields the secret; it is
 * reachable only by holders of the closely-held `SturdyRef` namespace, never
 * through the opaque SturdyRef object.
 *
 * @param {SturdyRef} sturdyRef
 * @returns {SturdyRefLocator | undefined}
 */
export const getSturdyRefLocator = sturdyRef =>
  isSturdyRef(sturdyRef)
    ? /** @type {SturdyRefLocator | undefined} */ (toLocation(sturdyRef))
    : undefined;
harden(getSturdyRefLocator);

/**
 * Per-client cache from a SturdyRef to its in-flight or settled
 * enlivenment. A SturdyRef is an inert opaque data box, so enlivening it
 * to a live presence is a side-effecting step worth memoizing: repeated
 * `enlivenSturdyRef` calls on the same SturdyRef reuse the same
 * enlivenment rather than re-dialing the peer or re-reading the locator.
 *
 * The cache deliberately lives here in `@endo/ocapn`, not in
 * `@endo/eventual-send`: SturdyRefs are not `E()`-dispatch targets, so the
 * eventual-send layer needs no knowledge of them. A rejected enlivenment
 * is evicted so a later call can retry.
 *
 * @type {WeakMap<SturdyRef, Promise<any>>}
 */
const sturdyRefToEnlivened = new WeakMap();

/**
 * The actual resolution, factored out of `enlivenSturdyRef` so the
 * memoization wrapper stays synchronous up to the point it caches the
 * resulting promise.
 *
 * @param {SturdyRefLocator} locator
 * @param {(location: OcapnLocation) => Promise<InternalSession>} provideSession
 * @param {(location: OcapnLocation) => boolean} isSelfLocation
 * @param {{ get(secret: string | Uint8Array): unknown | Promise<unknown> }} localLocator
 */
const resolveSturdyRef = async (
  locator,
  provideSession,
  isSelfLocation,
  localLocator,
) => {
  const { location, secret } = locator;

  if (isSelfLocation(location)) {
    const value = await localLocator.get(secret);
    if (value === undefined) {
      // Intentionally do NOT include `secret` in the message: this
      // error rides up into rejection chains that may be serialized
      // into peer-visible op:abort or logs, and `secret` is the
      // long-lived authority granting access to the capability.
      throw Error('ocapn: locator has no capability for sturdyref secret');
    }
    return value;
  }

  const { ocapn } = await provideSession(location);
  // String secrets get ASCII-encoded into LocatorSecret bytes; raw
  // bytes are forwarded verbatim so non-ASCII swissnums (e.g. the
  // 24-byte randoms Spritely Goblins mints) flow through unchanged.
  const wireSecret =
    typeof secret === 'string'
      ? encodeSwissnum(secret)
      : swissnumFromBytes(secret);
  return E(/** @type {any} */ (ocapn.getRemoteBootstrap())).fetch(wireSecret);
};

/**
 * Resolve a `SturdyRef` to an actual reference: local values come from the
 * injected `localLocator`; remote values are fetched from the peer's bootstrap
 * over a session. The result is memoized per SturdyRef.
 *
 * This enlivener is closely held by each CapTP instance (it is never endowed to
 * a child compartment or exposed through the opaque SturdyRef). It resolves a
 * SturdyRef's locator through the realm-global mapping, so a SturdyRef minted by
 * an eval twin in the same realm can be enlivened here.
 *
 * @param {SturdyRef} sturdyRef
 * @param {(location: OcapnLocation) => Promise<InternalSession>} provideSession
 * @param {(location: OcapnLocation) => boolean} isSelfLocation
 * @param {{ get(secret: string | Uint8Array): unknown | Promise<unknown> }} localLocator
 */
export const enlivenSturdyRef = (
  sturdyRef,
  provideSession,
  isSelfLocation,
  localLocator,
) => {
  const cached = sturdyRefToEnlivened.get(sturdyRef);
  if (cached !== undefined) {
    return cached;
  }

  // The off-band locator lives in the realm-global mapping; a SturdyRef with no
  // entry (never minted in this realm) cannot be enlivened.
  const locator = getSturdyRefLocator(sturdyRef);
  if (locator === undefined) {
    throw Error(
      'ocapn: cannot enliven a sturdyref with no locator in this realm',
    );
  }

  const enlivened = resolveSturdyRef(
    locator,
    provideSession,
    isSelfLocation,
    localLocator,
  );
  sturdyRefToEnlivened.set(sturdyRef, enlivened);
  // Evict a failed enlivenment so a later call can retry rather than
  // replaying a stale rejection forever.
  enlivened.catch(() => sturdyRefToEnlivened.delete(sturdyRef));
  return enlivened;
};
harden(enlivenSturdyRef);

/**
 * @typedef {object} SturdyRefTracker
 * @property {(location: OcapnLocation, secret: string | Uint8Array, type?: string) => SturdyRef} makeSturdyRef
 * @property {(sturdyRef: SturdyRef) => SturdyRefLocator | undefined} reveal
 *   Reveal the off-band `(location, secret[, type])` locator of a
 *   SturdyRef **this tracker** constructed — one it minted or
 *   materialized from the wire — or `undefined` for anything else (a
 *   forged look-alike, or a SturdyRef minted by a foreign instance).
 *   Unlike the module-level {@link getSturdyRefLocator}, recognition is
 *   scoped to this session manager, so `reveal` never answers for a
 *   sibling instance's mints even when both share this realm's
 *   `@endo/sturdyref` shim locator map. This is the closely-held reveal
 *   side; it is the only path that yields the secret.
 * @property {(secretBytes: ArrayBufferLike) => Promise<any | undefined>} lookup
 *   Async look up a locally-held capability by the on-wire secret
 *   bytes. Calls through to the injected locator with either the
 *   ASCII-decoded string (for printable secrets) or the raw bytes (for
 *   non-printable secrets like Spritely Goblins' 24-byte randoms).
 */

/**
 * @param {{ get(secret: string | Uint8Array): unknown | Promise<unknown> }} localLocator
 * @returns {SturdyRefTracker}
 */
export const makeSturdyRefTracker = localLocator => {
  const textDecoder = new TextDecoder('ascii', { fatal: true });
  // The set of SturdyRefs THIS tracker constructed (minted locally or
  // materialized from the wire). Scopes `reveal` to this session
  // manager so a sibling instance's mints — which share the realm-wide
  // `@endo/sturdyref` shim locator map — are not revealed here.
  // Per-instance ownership, not a second copy of the locator, so the
  // shim's realm-global retention is unaffected.
  /** @type {WeakSet<SturdyRef>} */
  const ownRefs = new WeakSet();
  return harden({
    makeSturdyRef: (location, secret, type = undefined) => {
      // Mint an opaque SturdyRef through the realm-global shim and retain its
      // `(location, secret, type)` locator off-band, keyed by the SturdyRef's
      // identity. The secret is never a property on the SturdyRef, and the
      // locator is reachable only through the closely-held namespace. Record
      // it as own so `reveal` is scoped to this session manager.
      const sturdyRef = fromLocation(harden({ location, secret, type }));
      ownRefs.add(sturdyRef);
      return sturdyRef;
    },
    reveal: sturdyRef =>
      ownRefs.has(sturdyRef) ? getSturdyRefLocator(sturdyRef) : undefined,
    lookup: async secretBytes => {
      const view =
        secretBytes instanceof Uint8Array
          ? secretBytes
          : new Uint8Array(/** @type {ArrayBuffer} */ (secretBytes.slice()));
      // Try ASCII decoding first so locators keyed by friendly string
      // names continue to match. If the bytes aren't valid ASCII (e.g.
      // a Spritely-style random 24-byte secret), fall back to passing
      // the raw bytes through; locators that index by bytes can match
      // those, locators that don't will simply return undefined.
      try {
        const secret = textDecoder.decode(view);
        return localLocator.get(secret);
      } catch {
        return localLocator.get(view);
      }
    },
  });
};
harden(makeSturdyRefTracker);
