// @ts-check

/**
 * @import { OcapnLocation } from '../codecs/components.js'
 * @import { LocationId, SwissNum } from './types.js'
 */

import { toBytes } from '@endo/pass-style/to-bytes.js';
import { encodeHex } from '@endo/hex';

/**
 * @param {ArrayBufferView | ArrayBufferLike} value
 * @returns {string}
 */
export const toHex = value => {
  return encodeHex(value);
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

// Capture the ASCII TextDecoder once at module load.  ASCII decoding is
// used for swissnum values, which are constrained to the printable ASCII
// alphabet.  Fatal mode ensures any non-ASCII byte causes an immediate
// throw rather than silent substitution.
const swissnumDecoder = new TextDecoder('ascii', { fatal: true });
const swissnumEncoder = new TextEncoder();

/**
 * @param {Uint8Array} value
 * @returns {string}
 */
export const decodeSwissnum = value => {
  // TextDecoder.decode rejects views backed by an immutable ArrayBuffer
  // (the byteArray passable form).  Copying via the typed-array copy
  // constructor produces a plain mutable Uint8Array with the same bytes.
  return swissnumDecoder.decode(new Uint8Array(value));
};

/**
 * @param {string} value
 * @returns {SwissNum}
 */
export const encodeSwissnum = value => {
  // Validate the value is strictly valid ASCII
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code > 127) {
      throw new Error(
        `Invalid ASCII character in swissnum at position ${i}: ${value[i]}`,
      );
    }
  }
  // @ts-expect-error - Branded type: SwissNum is ArrayBufferLike at runtime
  return toBytes(swissnumEncoder.encode(value));
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
  return toBytes(bytes);
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
  return new Uint8Array(swissNum);
};
