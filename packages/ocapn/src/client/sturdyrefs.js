// @ts-check

/**
 * @import { OcapnLocation } from '../codecs/components.js'
 * @import { InternalSession } from './types.js'
 * @import { SturdyRef as PassStyleSturdyRef } from '@endo/pass-style'
 */

import harden from '@endo/harden';
import { E } from '@endo/eventual-send';
import { PASS_STYLE, passStyleOf } from '@endo/pass-style';
import { encodeSwissnum, swissnumFromBytes } from './util.js';

const { create, prototype: objectPrototype } = Object;

/**
 * @typedef {PassStyleSturdyRef} SturdyRef
 * A `SturdyRef` addresses a capability by `(location, secret)`. It is a
 * first-class `@endo/pass-style` value: `passStyleOf` returns
 * `'sturdyref'`. Its `location` is a **readable** property (the raw
 * SturdyRef is the trusted/wire tier and carries a readable locator by
 * design); the `secret` (swiss number) it needs to re-acquire the live
 * capability is **never** a property. The CapTP session manager (this
 * module) holds the closely-held `(location, secret)` tuple off-band,
 * keyed by the SturdyRef's identity in `sturdyRefDetails`. It does not
 * cross the wire in this JavaScript form: on the wire OCapN uses the
 * `'ocapn-sturdyref'` spec tag.
 *
 * The `secret` may be a printable ASCII string (the friendly form for
 * locators keyed by name) or raw bytes (Uint8Array) for arbitrary-byte
 * sturdyrefs minted by other implementations such as Spritely Goblins,
 * whose 24-byte random secrets generally aren't valid ASCII.
 *
 * @typedef {object} SturdyRefDetails
 * @property {OcapnLocation} location
 * @property {string | Uint8Array} secret
 * @property {string} [type]
 */

/**
 * The closely-held, module-private map from a constructed SturdyRef to its
 * off-band `(location, secret)` tuple (plus the optional advisory `type`
 * hint). This is the CapTP session manager's own state: `@endo/pass-style`
 * defines the `'sturdyref'` shape but constructs nothing and holds no
 * locator map. The secret lives only here — never as a property on the
 * SturdyRef — so it cannot leak through pass-style introspection. Keyed by
 * SturdyRef identity, per-instance; a SturdyRef this session manager did not
 * construct simply has no entry, so it cannot be enlivened here (which is by
 * design: pass-style identity is scoped to one OCapN instance).
 *
 * @type {WeakMap<SturdyRef, SturdyRefDetails>}
 */
const sturdyRefDetails = new WeakMap();

/**
 * Construct a SturdyRef instance satisfying `@endo/pass-style`'s
 * `'sturdyref'` shape: an object with no own properties whose tag-record
 * prototype carries `[PASS_STYLE]`, `[Symbol.toStringTag]`, a get-only
 * `location` accessor returning the deep-frozen locator, and — when a hint
 * is supplied — a get-only `type` accessor. The secret is never placed on
 * the object; it is kept in `sturdyRefDetails` off-band.
 *
 * @param {OcapnLocation} location
 * @param {string} [type]
 * @returns {SturdyRef}
 */
const makeSturdyRefInstance = (location, type) => {
  const frozenLocation = harden(location);
  /** @type {PropertyDescriptorMap} */
  const descriptors = {
    [PASS_STYLE]: { value: 'sturdyref', enumerable: false },
    [Symbol.toStringTag]: { value: 'SturdyRef', enumerable: false },
    location: { get: () => frozenLocation, enumerable: false },
  };
  if (type !== undefined) {
    const hint = type;
    descriptors.type = { get: () => hint, enumerable: false };
  }
  const proto = harden(create(objectPrototype, descriptors));
  return /** @type {SturdyRef} */ (harden(create(proto)));
};

/**
 * True when `value` is a SturdyRef: a first-class `@endo/pass-style` value
 * whose `passStyleOf` is `'sturdyref'`. Recognition is structural (no
 * mint-gating): a value the session manager did not construct but that
 * satisfies the shape is still a SturdyRef, though it has no off-band
 * details here and so cannot be enlivened by this instance.
 *
 * @param {any} value
 * @returns {boolean}
 */
export const isSturdyRef = value => {
  try {
    return passStyleOf(value) === 'sturdyref';
  } catch {
    return false;
  }
};
harden(isSturdyRef);

/**
 * Reveal a SturdyRef's off-band `(location, secret)` details, or
 * `undefined` when `sturdyRef` is not a SturdyRef this session manager
 * constructed. This is the closely-held reveal side; it is the only path
 * that yields the secret.
 *
 * @param {SturdyRef} sturdyRef
 * @returns {SturdyRefDetails | undefined}
 */
export const getSturdyRefDetails = sturdyRef =>
  isSturdyRef(sturdyRef) ? sturdyRefDetails.get(sturdyRef) : undefined;
harden(getSturdyRefDetails);

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
 * @param {SturdyRefDetails} details
 * @param {(location: OcapnLocation) => Promise<InternalSession>} provideSession
 * @param {(location: OcapnLocation) => boolean} isSelfLocation
 * @param {{ get(secret: string | Uint8Array): unknown | Promise<unknown> }} locator
 */
const resolveSturdyRef = async (
  details,
  provideSession,
  isSelfLocation,
  locator,
) => {
  const { location, secret } = details;

  if (isSelfLocation(location)) {
    const value = await locator.get(secret);
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
 * injected `locator`; remote values are fetched from the peer's bootstrap
 * over a session. The result is memoized per SturdyRef.
 *
 * @param {SturdyRef} sturdyRef
 * @param {(location: OcapnLocation) => Promise<InternalSession>} provideSession
 * @param {(location: OcapnLocation) => boolean} isSelfLocation
 * @param {{ get(secret: string | Uint8Array): unknown | Promise<unknown> }} locator
 */
export const enlivenSturdyRef = (
  sturdyRef,
  provideSession,
  isSelfLocation,
  locator,
) => {
  const cached = sturdyRefToEnlivened.get(sturdyRef);
  if (cached !== undefined) {
    return cached;
  }

  // The off-band details live in this session manager's closely-held map;
  // a SturdyRef with no entry (not constructed here) cannot be enlivened by
  // this instance, which is by design.
  const details = sturdyRefDetails.get(sturdyRef);
  if (details === undefined) {
    throw Error(
      'ocapn: cannot enliven a sturdyref not minted by this instance',
    );
  }

  const enlivened = resolveSturdyRef(
    details,
    provideSession,
    isSelfLocation,
    locator,
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
 * @property {(secretBytes: ArrayBufferLike) => Promise<any | undefined>} lookup
 *   Async look up a locally-held capability by the on-wire secret
 *   bytes. Calls through to the injected locator with either the
 *   ASCII-decoded string (for printable secrets) or the raw bytes (for
 *   non-printable secrets like Spritely Goblins' 24-byte randoms).
 */

/**
 * @param {{ get(secret: string | Uint8Array): unknown | Promise<unknown> }} locator
 * @returns {SturdyRefTracker}
 */
export const makeSturdyRefTracker = locator => {
  const textDecoder = new TextDecoder('ascii', { fatal: true });
  return harden({
    makeSturdyRef: (location, secret, type = undefined) => {
      // Construct an instance satisfying the pass-style `'sturdyref'` shape
      // (a readable `location`, optional advisory `type` hint), and keep the
      // `(location, secret)` tuple off-band in this session manager's map so
      // the secret is never a property on the SturdyRef.
      const sturdyRef = makeSturdyRefInstance(location, type);
      sturdyRefDetails.set(sturdyRef, harden({ location, secret, type }));
      return sturdyRef;
    },
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
        return locator.get(secret);
      } catch {
        return locator.get(view);
      }
    },
  });
};
harden(makeSturdyRefTracker);
