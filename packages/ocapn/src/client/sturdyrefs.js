// @ts-check

/**
 * @import { OcapnLocation } from '../codecs/components.js'
 * @import { InternalSession } from './types.js'
 */

import harden from '@endo/harden';
import { E } from '@endo/eventual-send';
import { makeTagged } from '@endo/pass-style';
import { encodeSwissnum } from './util.js';

/**
 * @import { CopyTagged } from '@endo/pass-style'
 * @typedef {CopyTagged<'ocapn-sturdyref', undefined>} SturdyRef
 * A `SturdyRef` addresses a capability by `(location, secret)`. It is
 * reified in JavaScript as a tagged value purely so `passStyleOf` has
 * something to return; it never crosses the wire in this form (on the
 * wire OCapN uses the `'ocapn-sturdyref'` spec tag).
 *
 * @typedef {object} SturdyRefDetails
 * @property {OcapnLocation} location
 * @property {string} secret - Plain-text locator key. The wire form
 *   encodes this as `LocatorSecret` bytes.
 */

/** @type {WeakMap<SturdyRef, SturdyRefDetails>} */
const sturdyRefDetails = new WeakMap();

/** @param {any} value */
export const isSturdyRef = value => sturdyRefDetails.has(value);

/** @param {SturdyRef} sturdyRef */
export const getSturdyRefDetails = sturdyRef => sturdyRefDetails.get(sturdyRef);

/**
 * Resolve a `SturdyRef` to an actual reference: local values come from
 * the injected `locator`; remote values are fetched from the peer's
 * bootstrap over a session.
 *
 * @param {SturdyRef} sturdyRef
 * @param {(location: OcapnLocation) => Promise<InternalSession>} provideSession
 * @param {(location: OcapnLocation) => boolean} isSelfLocation
 * @param {{ get(secret: string): unknown | Promise<unknown> }} locator
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
  return E(/** @type {any} */ (ocapn.getRemoteBootstrap())).fetch(
    encodeSwissnum(secret),
  );
};

/**
 * @typedef {object} SturdyRefTracker
 * @property {(location: OcapnLocation, secret: string) => SturdyRef} makeSturdyRef
 * @property {(secretBytes: ArrayBufferLike) => Promise<any | undefined>} lookup
 *   Async look up a locally-held capability by the on-wire secret
 *   bytes. Calls through to the injected locator.
 */

/**
 * @param {{ get(secret: string): unknown | Promise<unknown> }} locator
 * @returns {SturdyRefTracker}
 */
export const makeSturdyRefTracker = locator => {
  const textDecoder = new TextDecoder('ascii', { fatal: true });
  return harden({
    makeSturdyRef: (location, secret) => {
      const sturdyRef = makeTagged('ocapn-sturdyref', undefined);
      sturdyRefDetails.set(sturdyRef, { location, secret });
      return harden(sturdyRef);
    },
    lookup: async secretBytes => {
      // The wire speaks bytes; the locator speaks strings. Decode once
      // at the boundary.
      const view =
        secretBytes instanceof Uint8Array
          ? secretBytes
          : new Uint8Array(/** @type {ArrayBuffer} */ (secretBytes.slice()));
      const secret = textDecoder.decode(view);
      return locator.get(secret);
    },
  });
};
