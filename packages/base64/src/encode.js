// @ts-check
/* eslint no-bitwise: ["off"] */
/* global globalThis */

import { alphabet64, padding } from './common.js';

/**
 * Pure-JavaScript base64 encoder, exported for benchmarking and for
 * environments where the native TC39 `Uint8Array.prototype.toBase64`
 * intrinsic (proposal-arraybuffer-base64) is unavailable or has been
 * removed.  See `encodeBase64` below for the dispatched default.
 *
 * This function is exported from this *file* for use in benchmarking,
 * but is not part of the *module*'s public API.
 *
 * @param {Uint8Array} data
 * @returns {string} base64 encoding
 */
export const jsEncodeBase64 = data => {
  // A cursory benchmark shows that string concatenation is about 25% faster
  // than building an array and joining it in v8, in 2020, for strings of about
  // 100 long.
  let string = '';
  let register = 0;
  let quantum = 0;

  for (let i = 0; i < data.length; i += 1) {
    const b = data[i];
    register = (register << 8) | b;
    quantum += 8;
    if (quantum === 24) {
      string +=
        alphabet64[(register >>> 18) & 0x3f] +
        alphabet64[(register >>> 12) & 0x3f] +
        alphabet64[(register >>> 6) & 0x3f] +
        alphabet64[(register >>> 0) & 0x3f];
      register = 0;
      quantum = 0;
    }
  }

  switch (quantum) {
    case 0:
      break;
    case 8:
      string +=
        alphabet64[(register >>> 2) & 0x3f] +
        alphabet64[(register << 4) & 0x3f] +
        padding +
        padding;
      break;
    case 16:
      string +=
        alphabet64[(register >>> 10) & 0x3f] +
        alphabet64[(register >>> 4) & 0x3f] +
        alphabet64[(register << 2) & 0x3f] +
        padding;
      break;
    default:
      throw Error(`internal: bad quantum ${quantum}`);
  }
  return string;
};

// Capture the native TC39 `Uint8Array.prototype.toBase64` intrinsic at
// module load, before any caller can reach `encodeBase64` and before SES
// lockdown freezes the prototype.  Post-lockdown mutation cannot redirect
// the dispatched binding.  See designs/base64-native-fallthrough.md.
const nativeToBase64 =
  typeof (/** @type {any} */ (Uint8Array.prototype).toBase64) === 'function'
    ? /** @type {(options?: object) => string} */ (
        /** @type {any} */ (Uint8Array.prototype).toBase64
      )
    : undefined;

/** @type {typeof jsEncodeBase64} */
const nativeEncodeBase64 = data =>
  /** @type {any} */ (nativeToBase64).call(data);

// Legacy XSnap path: the older Moddable/XS build shipped a native
// `globalThis.Base64.encode` before the TC39 intrinsic existed.  The
// TC39 path takes precedence; this is a second-chance fallback.
/** @type {typeof jsEncodeBase64 | undefined} */
const xsEncodeBase64 =
  globalThis.Base64 !== undefined ? globalThis.Base64.encode : undefined;

/**
 * Encodes bytes into a Base64 string, as specified in
 * https://tools.ietf.org/html/rfc4648#section-4.
 *
 * Dispatches to the native `Uint8Array.prototype.toBase64` intrinsic
 * when available (stage-4 TC39 proposal-arraybuffer-base64).  Otherwise
 * falls through to the legacy `globalThis.Base64.encode` XS binding,
 * and finally to the pure-JavaScript `jsEncodeBase64`.
 *
 * @type {typeof jsEncodeBase64}
 */
const selectEncodeBase64 = () => {
  if (nativeToBase64 !== undefined) return nativeEncodeBase64;
  if (xsEncodeBase64 !== undefined) return xsEncodeBase64;
  return jsEncodeBase64;
};
export const encodeBase64 = selectEncodeBase64();
