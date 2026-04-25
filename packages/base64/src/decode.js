// @ts-check
/* eslint no-bitwise: ["off"] */
/* global globalThis */

import { monodu64, padding } from './common.js';

/**
 * Pure-JavaScript base64 decoder, exported for benchmarking and for
 * environments where the native TC39 `Uint8Array.fromBase64` intrinsic
 * (proposal-arraybuffer-base64) is unavailable or has been removed.
 * See `decodeBase64` below for the dispatched default.
 *
 * This function is exported from this *file* for use in benchmarking,
 * but is not part of the *module*'s public API.
 *
 * @param {string} string Base64-encoded string
 * @param {string} [name] The name of the string as it will appear in error
 * messages.
 * @returns {Uint8Array} decoded bytes
 */
export const jsDecodeBase64 = (string, name = '<unknown>') => {
  const data = new Uint8Array(Math.ceil((string.length * 4) / 3));
  let register = 0;
  let quantum = 0;
  let i = 0; // index in string
  let j = 0; // index in data

  while (i < string.length && string[i] !== padding) {
    const number = monodu64[string[i]];
    if (number === undefined) {
      throw Error(`Invalid base64 character ${string[i]} in string ${name}`);
    }
    register = (register << 6) | number;
    quantum += 6;
    if (quantum >= 8) {
      quantum -= 8;
      data[j] = register >>> quantum;
      j += 1;
      register &= (1 << quantum) - 1;
    }
    i += 1;
  }

  while (quantum > 0) {
    if (i === string.length || string[i] !== padding) {
      throw Error(`Missing padding at offset ${i} of string ${name}`);
    }
    // We MAY reject non-zero padding bits, but choose not to.
    // https://datatracker.ietf.org/doc/html/rfc4648#section-3.5
    i += 1;
    quantum -= 2;
  }

  if (i < string.length) {
    throw Error(
      `Base64 string has trailing garbage ${string.substr(
        i,
      )} in string ${name}`,
    );
  }

  return data.subarray(0, j);
};

// Capture the native TC39 `Uint8Array.fromBase64` intrinsic at module
// load, before any caller can reach `decodeBase64` and before SES
// lockdown freezes `Uint8Array`.  Post-lockdown mutation cannot redirect
// the dispatched binding.  See designs/base64-native-fallthrough.md.
const nativeFromBase64 =
  typeof (/** @type {any} */ (Uint8Array).fromBase64) === 'function'
    ? /** @type {(input: string, options?: object) => Uint8Array} */ (
        /** @type {any} */ (Uint8Array).fromBase64
      )
    : undefined;

// Pin native options to the strictest semantics that match
// `jsDecodeBase64`:
//   - `lastChunkHandling: 'strict'` rejects unpadded / short final
//     chunks (the proposal default `'loose'` would silently accept
//     them).
//   - `alphabet: 'base64'` rejects URL-safe characters (`-_`) and
//     pins forward compatibility against any future spec drift.
// `Object.freeze` rather than `@endo/harden` because this module is on
// the pre-lockdown shim path; importing `@endo/harden` here would
// install a fallback `harden` before SES `lockdown()` and break it.
const nativeFromBase64Options = Object.freeze({
  lastChunkHandling: 'strict',
  alphabet: 'base64',
});

/** @type {typeof jsDecodeBase64} */
const nativeDecodeBase64 = (string, name) => {
  try {
    return /** @type {any} */ (nativeFromBase64)(string, nativeFromBase64Options);
  } catch (_err) {
    // Native error messages are implementation-defined and do not
    // embed `name` or report the failing offset.  Re-run the polyfill
    // to surface its precise diagnostic.  The polyfill must reject
    // anything the native call rejected; if it does not (i.e. the
    // dispatched options diverge silently), throw a generic error
    // rather than masking the divergence.
    jsDecodeBase64(string, name);
    throw Error(`Invalid base64 in string ${name}`);
  }
};

// The legacy XS `Base64.decode` function is faster than the pure JS
// polyfill, but might return ArrayBuffer (not Uint8Array); adapt it.
const adaptDecoder =
  nativeDecoder =>
  (...args) => {
    const decoded = nativeDecoder(...args);
    if (decoded instanceof Uint8Array) {
      return decoded;
    }
    return new Uint8Array(decoded);
  };

/** @type {typeof jsDecodeBase64 | undefined} */
const xsDecodeBase64 =
  globalThis.Base64 !== undefined
    ? adaptDecoder(globalThis.Base64.decode)
    : undefined;

/**
 * Decodes a Base64 string into bytes, as specified in
 * https://tools.ietf.org/html/rfc4648#section-4.
 *
 * Dispatches to the native `Uint8Array.fromBase64` intrinsic when
 * available (stage-4 TC39 proposal-arraybuffer-base64).  Otherwise
 * falls through to the legacy `globalThis.Base64.decode` XS binding,
 * and finally to the pure-JavaScript `jsDecodeBase64`.
 *
 * On the native path the `name` argument is silently accepted and
 * ignored: the native intrinsic throws `SyntaxError` with implementation-
 * defined messages that do not embed a caller-supplied name.  No
 * monorepo consumer pattern-matches the error text.
 *
 * @type {typeof jsDecodeBase64}
 */
export const decodeBase64 = (() => {
  if (nativeFromBase64 !== undefined) return nativeDecodeBase64;
  if (xsDecodeBase64 !== undefined) return xsDecodeBase64;
  return jsDecodeBase64;
})();
