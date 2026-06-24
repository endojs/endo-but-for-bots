// @ts-check

/**
 * @import { OcapnLocation } from '../codecs/components.js'
 * @import { LocationId, SwissNum } from './types.js'
 */

import { encodeAscii } from '@endo/ascii/encode.js';
import { frozenBytes } from '@endo/pass-style/to-bytes.js';

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
 * Encodes a printable ASCII string as a `SwissNum` (branded `Uint8Array`).
 * Throws a `RangeError` if any character code exceeds 127.
 *
 * Callers that already have raw wire-format bytes and only need the branded
 * type wrapping should use `swissnumFromBytes` instead.
 *
 * @param {string} value
 * @returns {SwissNum}
 */
export const encodeSwissnum = value => {
  // @ts-expect-error - Branded type: SwissNum is Uint8Array at runtime
  return frozenBytes(encodeAscii(value));
};

/**
 * Wrap raw swissnum bytes as a `SwissNum`. Use this
 * when the bytes already came from a wire-format source (e.g. the
 * base64url-decoded `/s/<…>` segment of a sturdyref URI) and only the
 * branded type wrapping is missing.
 *
 * For the common case of constructing a swissnum from a printable
 * ASCII string (e.g. a hard-coded test name), use `encodeSwissnum`,
 * which validates the alphabet for you.
 *
 * `SwissNum` is a branded `Uint8Array` — this cast is zero-copy.
 * The function exists to make the branding explicit at call sites;
 * callers that need to decode the bytes back to a string should call
 * `decodeAscii` from `@endo/ascii/decode.js` on the result.
 *
 * @param {Uint8Array} bytes
 * @returns {SwissNum}
 */
export const swissnumFromBytes = bytes => {
  // @ts-expect-error - Branded type: SwissNum is Uint8Array at runtime
  return frozenBytes(bytes);
};

/**
 * View the raw bytes of a swissnum.
 *
 * `SwissNum` is a branded `Uint8Array` — this cast is zero-copy.
 * The function exists to make the branding explicit at call sites.
 *
 * @param {SwissNum} swissNum
 * @returns {Uint8Array}
 */
export const swissnumToBytes = swissNum => {
  return swissNum;
};
