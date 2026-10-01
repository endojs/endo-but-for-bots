// spell-out-exempt: swissNum spells the OCapN "Swiss number" domain term used package-wide.
// @ts-check

/**
 * @import { OcapnLocation } from '../codecs/components.js'
 * @import { InternalSession } from './types.js'
 */

import harden from '@endo/harden';
import { thawedBytes } from '@endo/immutable-arraybuffer';
import { E } from '@endo/eventual-send';
import { makeSturdyRef as makeRealmSturdyRef } from '@endo/sturdyref';
import {
  decodeSwissnum,
  encodeSwissnum,
  swissnumFromBytes,
  swissnumToBytes,
} from './util.js';

/**
 * @typedef {import('@endo/pass-style').SturdyRef} SturdyRef
 * An OCapN `SturdyRef` addresses a capability by `(location, secret)`. It is
 * a realm `SturdyRef` (see `@endo/sturdyref`): opaque, passable, and revived
 * with `SturdyRef.enliven`. The handler that OCapN mints it with closes over
 * the `(location, secret)` pair and the minting client's session machinery.
 * On the wire OCapN still carries it as the spec's `'ocapn-sturdyref'`
 * record.
 */

/**
 * The `secret` may be a printable ASCII string (the friendly form for
 * locators keyed by name) or raw bytes (Uint8Array) for arbitrary-byte
 * sturdyrefs minted by other implementations such as Spritely Goblins,
 * whose 24-byte random secrets generally aren't valid ASCII.
 *
 * @typedef {object} SturdyRefDetails
 * @property {OcapnLocation} location
 * @property {string | Uint8Array} secret
 */

/**
 * @typedef {(details: SturdyRefDetails) => Promise<unknown>} EnlivenSturdyRefDetails
 */

/**
 * The `(location, secret)` pair of every SturdyRef OCapN minted. The realm
 * SturdyRef hides its handler, so this table is how the OCapN wire codec
 * reads back the pair it must write. A SturdyRef minted by anyone else has
 * no entry, and the codec refuses to write it.
 *
 * @type {WeakMap<SturdyRef, SturdyRefDetails>}
 */
const sturdyRefDetails = new WeakMap();

/**
 * Whether `value` is a SturdyRef minted by OCapN, and so one the OCapN wire
 * codec can write.
 *
 * @param {any} value
 * @returns {value is SturdyRef}
 */
export const isSturdyRef = value => sturdyRefDetails.has(value);

/** @param {SturdyRef} sturdyRef */
export const getSturdyRefDetails = sturdyRef => sturdyRefDetails.get(sturdyRef);

/**
 * The coordinates an OCapN SturdyRef is constructed from. The field names
 * follow `@endo/captp`'s `SturdyRefData`, but the shape is OCapN's own and
 * stricter: `designator` is required because every OCapN location names a
 * network, and `objectId` may be raw bytes because OCapN swiss numbers may be
 * arbitrary bytes. As in captp, every hint value is a string.
 *
 * @typedef {object} SturdyRefData
 * @property {string} peerId the peer's designator (its public key)
 * @property {string | Uint8Array} objectId the swiss number
 * @property {string} designator the network the peer is reachable on
 * @property {Record<string, string>} [hints] how to connect to the peer
 */

/**
 * @param {SturdyRefData} data
 * @returns {SturdyRefDetails}
 */
export const sturdyRefDataToDetails = data => {
  const { peerId, objectId, designator, hints = undefined, ...rest } = data;
  const extra = Object.keys(rest);
  if (extra.length !== 0) {
    throw TypeError(
      `ocapn: unexpected SturdyRef data properties ${extra.join(', ')}`,
    );
  }
  if (typeof peerId !== 'string') {
    throw TypeError('ocapn: SturdyRef peerId must be a string');
  }
  if (typeof designator !== 'string') {
    throw TypeError('ocapn: SturdyRef designator must be a string');
  }
  if (typeof objectId !== 'string' && !(objectId instanceof Uint8Array)) {
    // Intentionally do NOT include `objectId`: it is the secret.
    throw TypeError('ocapn: SturdyRef objectId must be a string or bytes');
  }
  if (
    hints !== undefined &&
    (typeof hints !== 'object' ||
      hints === null ||
      !Object.values(hints).every(hint => typeof hint === 'string'))
  ) {
    throw TypeError('ocapn: SturdyRef hints must be a record of strings');
  }
  return {
    location: harden({
      type: 'ocapn-peer',
      designator: peerId,
      transport: designator,
      hints: hints === undefined ? false : { ...hints },
    }),
    secret: objectId,
  };
};

/**
 * @param {SturdyRefDetails} details
 * @returns {SturdyRefData}
 */
export const sturdyRefDetailsToData = ({ location, secret }) =>
  harden({
    peerId: location.designator,
    objectId: secret,
    designator: location.network ?? location.transport,
    ...(location.hints ? { hints: location.hints } : {}),
  });

/** @type {EnlivenSturdyRefDetails} */
const enlivenUnbound = async () => {
  throw Error(
    'ocapn: SturdyRef was minted without an OCapN client to enliven it',
  );
};

/**
 * Mint a `SturdyRef` value for `(location, secret)`. Sturdyrefs are
 * opaque pointers: user space passes them around as plain values and
 * only the OCapN layer (via `getSturdyRefDetails`) can see inside.
 * `SturdyRef.enliven(ref)` revives it through `enlivenDetails`.
 *
 * @param {OcapnLocation} location
 * @param {string | Uint8Array} secret
 * @param {EnlivenSturdyRefDetails} [enlivenDetails]
 * @returns {SturdyRef}
 */
export const makeSturdyRef = (
  location,
  secret,
  enlivenDetails = enlivenUnbound,
) => {
  /** @type {SturdyRefDetails} */
  const details = { location, secret };
  const sturdyRef = /** @type {SturdyRef} */ (
    makeRealmSturdyRef(
      harden({
        enliven: () => enlivenDetails(details),
      }),
    )
  );
  sturdyRefDetails.set(sturdyRef, details);
  return sturdyRef;
};

/**
 * Resolve a `(location, secret)` pair to an actual reference: local values
 * come from the injected `locator`; remote values are fetched from the
 * peer's bootstrap over a session.
 *
 * @param {SturdyRefDetails} details
 * @param {(location: OcapnLocation) => Promise<InternalSession>} provideSession
 * @param {(location: OcapnLocation) => boolean} isSelfLocation
 * @param {{ get(secret: string | Uint8Array): unknown | Promise<unknown> }} locator
 */
export const enlivenSturdyRefDetails = async (
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
  return E(ocapn.getRemoteBootstrap()).fetch(wireSecret);
};

/**
 * Resolve an OCapN-minted `SturdyRef` through the given client machinery.
 *
 * @param {SturdyRef} sturdyRef
 * @param {(location: OcapnLocation) => Promise<InternalSession>} provideSession
 * @param {(location: OcapnLocation) => boolean} isSelfLocation
 * @param {{ get(secret: string | Uint8Array): unknown | Promise<unknown> }} locator
 */
export const enlivenSturdyRef = async (
  sturdyRef,
  provideSession,
  isSelfLocation,
  locator,
) => {
  const details = sturdyRefDetails.get(sturdyRef);
  if (!details) {
    throw Error('SturdyRef details not found');
  }
  return enlivenSturdyRefDetails(
    details,
    provideSession,
    isSelfLocation,
    locator,
  );
};

/**
 * @typedef {object} SturdyRefTracker
 * @property {(location: OcapnLocation, secret: string | Uint8Array) => SturdyRef} makeSturdyRef
 * @property {(sturdyRef: SturdyRef) => SturdyRefDetails | undefined} getDetails
 *   The `(location, secret)` pair of a SturdyRef this tracker minted, or
 *   `undefined` for any other value, including a SturdyRef another
 *   tracker minted.
 * @property {(secretBytes: Uint8Array) => Promise<any | undefined>} lookup
 *   Async look up a locally-held capability by the on-wire secret
 *   bytes. Calls through to the injected locator with either the
 *   ASCII-decoded string (for printable secrets) or the raw bytes (for
 *   non-printable secrets like Spritely Goblins' 24-byte randoms).
 */

/**
 * @param {{ get(secret: string | Uint8Array): unknown | Promise<unknown> }} locator
 * @param {EnlivenSturdyRefDetails} [enlivenDetails] how the SturdyRefs this
 *   tracker mints are enlivened; typically bound to the owning client.
 * @returns {SturdyRefTracker}
 */
export const makeSturdyRefTracker = (locator, enlivenDetails) => {
  /** @type {WeakSet<SturdyRef>} */
  const minted = new WeakSet();
  return harden({
    makeSturdyRef: (location, secret) => {
      const sturdyRef = makeSturdyRef(location, secret, enlivenDetails);
      minted.add(sturdyRef);
      return sturdyRef;
    },
    getDetails: sturdyRef =>
      minted.has(sturdyRef) ? sturdyRefDetails.get(sturdyRef) : undefined,
    lookup: async secretBytes => {
      const swissNum = swissnumFromBytes(thawedBytes(secretBytes));
      // Try ASCII decoding first so locators keyed by friendly string
      // names continue to match. If the bytes aren't valid ASCII (e.g.
      // a Spritely-style random 24-byte secret), fall back to passing
      // the raw bytes through; locators that index by bytes can match
      // those, locators that don't will simply return undefined.
      let secret;
      try {
        secret = decodeSwissnum(swissNum);
      } catch {
        return locator.get(swissnumToBytes(swissNum));
      }
      return locator.get(secret);
    },
  });
};
