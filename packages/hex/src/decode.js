// @ts-check

import { hexDigitTable } from './common.js';

/**
 * Pure-JavaScript hex decoder, exported for benchmarking and for
 * environments where the native TC39 `Uint8Array.fromHex` intrinsic
 * (proposal-arraybuffer-base64) is unavailable or has been removed.
 * See `decodeHex` below for the dispatched default.
 *
 * Accepts both upper- and lowercase input.  Throws on odd-length input
 * and on any character outside `[0-9a-fA-F]`.
 *
 * @param {string} string
 * @param {string} [name] Name of the string for error diagnostics.
 * @returns {Uint8Array}
 */
export const jsDecodeHex = (string, name = '<unknown>') => {
  if (string.length % 2 !== 0) {
    throw Error(
      `Hex string must have an even length, got ${string.length} in string ${name}`,
    );
  }
  const bytes = new Uint8Array(string.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    const hi = hexDigitTable[string.charCodeAt(i * 2)];
    const lo = hexDigitTable[string.charCodeAt(i * 2 + 1)];
    if (hi < 0 || lo < 0) {
      throw Error(
        `Invalid hex character at offset ${
          hi < 0 ? i * 2 : i * 2 + 1
        } of string ${name}`,
      );
    }
    // eslint-disable-next-line no-bitwise
    bytes[i] = (hi << 4) | lo;
  }
  return bytes;
};

// Capture the native TC39 `Uint8Array.fromHex` intrinsic at module load,
// before any caller can reach `decodeHex` and before SES lockdown
// freezes `Uint8Array`.  Post-lockdown mutation cannot redirect the
// dispatched binding.
const nativeFromHex =
  typeof (/** @type {any} */ (Uint8Array).fromHex) === 'function'
    ? /** @type {(hex: string) => Uint8Array} */ (
        /** @type {any} */ (Uint8Array).fromHex
      )
    : undefined;

/**
 * Decodes a hex string to a Uint8Array.  Accepts both upper- and
 * lowercase input.  Throws on odd-length strings and on characters
 * outside `[0-9a-fA-F]`.
 *
 * Dispatches to the native `Uint8Array.fromHex` intrinsic when
 * available (stage-4 TC39 proposal-arraybuffer-base64).  Otherwise
 * falls through to the pure-JavaScript polyfill.  Native errors are
 * rewrapped so callers see a uniform error shape across engines.
 *
 * @type {typeof jsDecodeHex}
 */
export const decodeHex =
  nativeFromHex !== undefined
    ? (string, name = '<unknown>') => {
        try {
          return /** @type {any} */ (nativeFromHex)(string);
        } catch (e) {
          const cause = /** @type {Error} */ (e);
          throw Error(`Invalid hex in string ${name}: ${cause.message}`, {
            cause,
          });
        }
      }
    : jsDecodeHex;
