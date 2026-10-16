// spell-out-exempt: swissNum spells the OCapN "Swiss number" domain term used package-wide.
// @ts-check

/**
 * @import { OcapnLocation } from '../codecs/components.js'
 * @import { LocationId, SwissNum } from './types.js'
 */

import { encodeAscii } from '@endo/ascii/encode.js';
import { thawedBytes, frozenBytes } from '@endo/immutable-arraybuffer';
import { encodeHex } from '@endo/hex';

/**
 * @param {Uint8Array} value
 * @returns {string}
 */
export const toHex = value => {
  return encodeHex(thawedBytes(value));
};

/**
 * The network identifier of a location. During the `network` migration a
 * location carries the legacy `transport` field on the wire and may carry
 * `network` in memory; the network is `network ?? transport`. A network
 * names how a peer is identified; it does not select a byte carrier.
 *
 * @param {Pick<OcapnLocation, 'network' | 'transport'>} location
 * @returns {string}
 */
export const locationNetworkId = location =>
  location.network ?? location.transport;

/**
 * Networks whose session identity is `(network, designator)`: the designator
 * is an authenticated key, and the hints only suggest ways to reach it. A
 * peer's hints change as its endpoints bind, rebind, or are withdrawn, so
 * they must not take part in its location ID, lest one authenticated peer
 * appear as several and defeat session reuse.
 *
 * See designs/ocapn-network-transport-separation.md § Target Model.
 */
const identityKeyedNetworks = new Set(['np']);

/**
 * We need a unique and deterministic way to identify a location as a string, for internal use.
 * We use https://github.com/ocapn/ocapn/blob/main/draft-specifications/Locators.md#uri-serialization
 *
 * For identity-keyed networks (`np`), the ID is `ocapn://<designator>.<network>`
 * and omits the hints. Other networks keep the hints as sorted query
 * parameters until they migrate to the identity rule.
 *
 * @param {OcapnLocation} location
 * @returns {LocationId}
 */
export const locationToLocationId = location => {
  const { designator, hints } = location;
  const networkId = locationNetworkId(location);

  // Build the base URI: ocapn://<designator>.<network>
  let uri = `ocapn://${designator}.${networkId}`;

  // Add hints as query parameters if present
  if (
    !identityKeyedNetworks.has(networkId) &&
    hints &&
    typeof hints === 'object'
  ) {
    // Sort keys deterministically
    const sortedKeys = Object.keys(hints).sort();
    if (sortedKeys.length > 0) {
      const params = sortedKeys
        .map(key => {
          const value = hints[key];
          return `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`;
        })
        .join('&');
      uri += `?${params}`;
    }
  }

  // @ts-expect-error - Branded type: LocationId is string at runtime
  return uri;
};

const swissnumDecoder = new TextDecoder('ascii', { fatal: true });

/**
 * @param {SwissNum} value
 * @returns {string}
 */
export const decodeSwissnum = value => {
  const bytes = thawedBytes(value);
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] > 0x7f) {
      throw RangeError(
        `Non-ASCII byte 0x${bytes[i].toString(16)} at offset ${i} of swissnum`,
      );
    }
  }
  return swissnumDecoder.decode(bytes);
};

/**
 * @param {string} value
 * @returns {SwissNum}
 */
export const encodeSwissnum = value => {
  // @ts-expect-error - Branded type: SwissNum is Uint8Array at runtime
  return frozenBytes(encodeAscii(value, 'swissnum'));
};

/**
 * Wrap raw swissnum bytes as a hardened immutable `SwissNum`. Use this
 * when the bytes already came from a wire-format source (e.g. the
 * base64url-decoded `/s/<…>` segment of a sturdyref URI) and only the
 * branded type wrapping is missing.
 *
 * For the common case of constructing a swissnum from a printable
 * ASCII string (e.g. a hard-coded test name), use `encodeSwissnum`,
 * which validates the alphabet for you.
 *
 * @param {Uint8Array} bytes
 * @returns {SwissNum}
 */
export const swissnumFromBytes = bytes => {
  // @ts-expect-error - Branded type: SwissNum is Uint8Array at runtime
  return frozenBytes(bytes);
};

/**
 * View the raw bytes of a swissnum. Returns a freshly allocated
 * (mutable) `Uint8Array` over a copy, so the caller may safely write
 * into it without disturbing the underlying immutable `SwissNum`.
 *
 * @param {SwissNum} swissNum
 * @returns {Uint8Array}
 */
export const swissnumToBytes = swissNum => {
  return thawedBytes(swissNum);
};
