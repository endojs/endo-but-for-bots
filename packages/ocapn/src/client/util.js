// @ts-check

/**
 * @import { OcapnLocation } from '../codecs/components.js'
 * @import { LocationId, SwissNum } from './types.js'
 */

import { decodeAscii, encodeAscii } from '@endo/ascii';
import { bytesFromImmutable } from '@endo/bytes/from-immutable.js';
import { bytesToImmutable } from '@endo/bytes/to-immutable.js';
import { encodeHex } from '@endo/hex';

/**
 * @param {ArrayBufferLike} value
 * @returns {string}
 */
export const toHex = value => {
  return encodeHex(bytesFromImmutable(value));
};

/**
 * We need a unique and deterministic way to identify a location as a string, for internal use.
 * We use https://github.com/ocapn/ocapn/blob/main/draft-specifications/Locators.md#uri-serialization
 * @param {OcapnLocation} location
 * @returns {LocationId}
 */
export const locationToLocationId = location => {
  const { designator, transport, hints } = location;

  // Build the base URI: ocapn://<designator>.<transport>
  let uri = `ocapn://${designator}.${transport}`;

  // Add hints as query parameters if present
  if (hints && typeof hints === 'object') {
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

/**
 * Decode a swissnum's wire bytes back to its string form, rejecting any byte
 * outside the 7-bit ASCII range. This is the strict inverse of
 * `encodeSwissnum`: `TextDecoder('ascii')` cannot enforce this, because per the
 * [WHATWG Encoding Standard](https://encoding.spec.whatwg.org/#names-and-labels)
 * the `'ascii'` label is an alias for `windows-1252`, so `fatal: true` never
 * fires on bytes `0x80`–`0xff` and they decode to Latin-1/windows-1252
 * characters instead of throwing. Raw-bytes swissnums that carry non-ASCII
 * bytes on the wire are represented as bytes, not decoded to a string, so they
 * are unaffected.
 *
 * @param {ArrayBufferLike} value
 * @returns {string}
 */
export const decodeSwissnum = value => {
  return decodeAscii(bytesFromImmutable(value), 'swissnum');
};

/**
 * @param {string} value
 * @returns {SwissNum}
 */
export const encodeSwissnum = value => {
  // @ts-expect-error - Branded type: SwissNum is ArrayBufferLike at runtime
  return bytesToImmutable(encodeAscii(value, 'swissnum'));
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
  // @ts-expect-error - Branded type: SwissNum is ArrayBufferLike at runtime
  return bytesToImmutable(bytes);
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
  return bytesFromImmutable(swissNum);
};
