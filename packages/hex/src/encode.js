// @ts-check

import { hexAlphabetLower, hexAlphabetUpper } from './common.js';

/**
 * Pure-JavaScript hex encoder, exported for benchmarking and for
 * environments where the native TC39 `Uint8Array.prototype.toHex`
 * intrinsic (proposal-arraybuffer-base64) is unavailable or has been
 * removed.  See `encodeHex` below for the dispatched default.
 *
 * This function is exported from this *file* for use in benchmarking,
 * but is not part of the *module*'s public API.
 *
 * @param {Uint8Array} bytes
 * @param {object} [options]
 * @param {boolean} [options.uppercase]
 * @returns {string}
 */
export const jsEncodeHex = (bytes, options) => {
  const alphabet =
    options !== undefined && options.uppercase === true
      ? hexAlphabetUpper
      : hexAlphabetLower;
  let string = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    // eslint-disable-next-line no-bitwise
    string += alphabet[(b >>> 4) & 0x0f] + alphabet[b & 0x0f];
  }
  return string;
};

// Capture the native TC39 `Uint8Array.prototype.toHex` intrinsic at
// module load, before any caller can reach `encodeHex` and before SES
// lockdown freezes the prototype.  Post-lockdown mutation cannot
// redirect the dispatched binding.
const nativeToHex =
  typeof (/** @type {any} */ (Uint8Array.prototype).toHex) === 'function'
    ? /** @type {() => string} */ (
        /** @type {any} */ (Uint8Array.prototype).toHex
      )
    : undefined;

/**
 * Encodes a Uint8Array as a hex string.  Default alphabet is lowercase;
 * pass `{ uppercase: true }` to force uppercase output.
 *
 * Dispatches to the native `Uint8Array.prototype.toHex` intrinsic when
 * available (stage-4 TC39 proposal-arraybuffer-base64).  Otherwise
 * falls through to the pure-JavaScript polyfill.  The native intrinsic
 * only produces lowercase output, so uppercase requests fall through
 * to the polyfill unconditionally.
 *
 * @type {typeof jsEncodeHex}
 */
export const encodeHex =
  nativeToHex !== undefined
    ? (bytes, options) => {
        if (options !== undefined && options.uppercase === true) {
          return jsEncodeHex(bytes, options);
        }
        return /** @type {any} */ (nativeToHex).call(bytes);
      }
    : jsEncodeHex;
