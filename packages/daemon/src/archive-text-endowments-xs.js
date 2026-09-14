// @ts-check

// Web-platform text endowments handed to archive compartments (the npm
// browser and dual builds executed by the endor XS runtime). This
// module is bundled to `rust/endo/xsnap/src/archive_text_endowments.js`
// by `scripts/bundle-archive-text-endowments-xs.mjs` and evaluated as a
// side-effecting script after `globalThis.__archiveEndowments` is
// created, so its top-level statements install the endowments.
//
// The base64 codec is NOT reimplemented here: `@endo/base64` is the
// single behavioral oracle for the byte<->string transform (its
// alphabet, padding, and RFC 4648 error semantics), reached through
// bundling. `@endo/base64` also exports its own `atob`/`btoa` (and an
// `@endo/base64/shim.js` that installs them on `globalThis`), but those
// are the strict RFC 4648 flavor that throws a plain Error; this module
// contributes the thin WHATWG adaptation layer they omit: forgiving-
// base64 whitespace handling, optional trailing padding, and the
// `InvalidCharacterError` name that browser code branches on.

import { encodeBase64, decodeBase64 } from '@endo/base64';

const { fromCharCode } = String;

// The XS runtime creates this host global before evaluating the bundle.
// eslint-disable-next-line no-underscore-dangle
const endowments = globalThis.__archiveEndowments;

// TextEncoder/TextDecoder: pass the machine's globals straight through
// (native-backed where the XS runtime installed replacements, otherwise
// the pure-JS polyfills). No new authority — a byte<->text transform.
endowments.TextEncoder = globalThis.TextEncoder;
endowments.TextDecoder = globalThis.TextDecoder;

/**
 * @param {string} message
 * @returns {never}
 */
const throwInvalidCharacter = message => {
  // WHATWG `atob`/`btoa` reject with a DOMException named
  // `InvalidCharacterError`; browser code branches on `.name`, so
  // preserve it even though `@endo/base64` itself throws a plain Error.
  const err = Error(message);
  err.name = 'InvalidCharacterError';
  throw err;
};

/**
 * WHATWG `btoa`: encode a binary string (each code unit a byte in
 * 0..=255) to base64. Delegates the codec to `@endo/base64`.
 *
 * @param {string} data
 * @returns {string}
 */
endowments.btoa = data => {
  const s = String(data);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code > 0xff) {
      throwInvalidCharacter(`btoa: character beyond U+00FF at index ${i}`);
    }
    bytes[i] = code;
  }
  return encodeBase64(bytes);
};

/**
 * WHATWG `atob`: decode base64 (forgiving of ASCII whitespace and of
 * absent trailing padding) to a binary string. Delegates the codec to
 * `@endo/base64`, whose decoder is strict about padding, so normalize
 * the input first (strip whitespace, then re-pad) and re-map its plain
 * Error to `InvalidCharacterError`.
 *
 * @param {string} data
 * @returns {string}
 */
endowments.atob = data => {
  const stripped = String(data).replace(/[\t\n\f\r ]+/g, '');
  if (stripped.length % 4 === 1) {
    // A single trailing base64 digit encodes no whole byte: rejected by
    // WHATWG forgiving-base64 before any alphabet check.
    throwInvalidCharacter('atob: invalid base64');
  }
  const unpadded = stripped.replace(/={1,2}$/, '');
  const padded = unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4);
  let bytes;
  try {
    bytes = decodeBase64(padded);
  } catch (_err) {
    throwInvalidCharacter('atob: invalid base64');
  }
  return fromCharCode(...bytes);
};
