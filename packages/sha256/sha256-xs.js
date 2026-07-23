// @ts-check

// XS implementation: streaming-triple host function composition.
// Uses the same host functions (`hostSha256Init`, `hostSha256UpdateBytes`,
// `hostSha256Finish`) that `makeXsCryptoPowers` uses — init a handle,
// pump all input via `updateBytes`, finish to get hex, then convert
// back to raw bytes.

/** @import { hostSha256Init, hostSha256UpdateBytes, hostSha256Finish } from './bus-xs-host-globals.d.ts' */

/**
 * Convert a hex string to a Uint8Array.
 * @param {string} hex
 * @returns {Uint8Array}
 */
const fromHex = (hex) => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
};

/**
 * One-shot SHA-256 over binary input, returning the raw 32-byte digest.
 * Uses the XS host function streaming triple: `init` → `updateBytes` → `finish`.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}  // length 32
 */
export const sha256 = (bytes) => {
  const handle = hostSha256Init();
  hostSha256UpdateBytes(handle, bytes);
  return fromHex(hostSha256Finish(handle));
};

/**
 * Bring-your-own-buffer variant: write the 32-byte digest into `out`
 * at `offset` and return the number of bytes written (32). Throws
 * RangeError if `out.length - offset < 32`.
 * @param {Uint8Array} out
 * @param {Uint8Array} bytes
 * @param {number} [offset=0]
 * @returns {number}
 */
export const sha256Into = (out, bytes, offset = 0) => {
  if (out.length - offset < 32) {
    throw new RangeError('output buffer too small for SHA-256 digest');
  }
  const handle = hostSha256Init();
  hostSha256UpdateBytes(handle, bytes);
  out.set(fromHex(hostSha256Finish(handle)), offset);
  return 32;
};
