// @ts-check

import harden from '@endo/harden';

// Capture both `TextDecoder` modes once at module load.
// The default UTF-8 decoder substitutes U+FFFD for malformed sequences;
// the `fatal: true` decoder throws on the same input.
// Capturing once at module init avoids per-call allocation and avoids
// any post-lockdown mutation of the global from redirecting calls.
const lenientTextDecoder = new TextDecoder();
const fatalTextDecoder = new TextDecoder('utf-8', { fatal: true });

const { isView } = ArrayBuffer;

/**
 * Return a `Uint8Array` view or value that `TextDecoder.decode` will
 * accept.  `TextDecoder.decode` rejects views backed by an immutable
 * `ArrayBuffer` (as produced by the `@endo/immutable-arraybuffer` shim
 * or a native stage-3 implementation), so we copy into a mutable buffer
 * only when necessary.
 *
 * - Plain mutable `Uint8Array`: pass through unchanged (zero allocation).
 * - Other `ArrayBufferView`: wrap in a `Uint8Array` view without copying.
 * - Bare `ArrayBufferLike`: wrap without copying.
 * - Any of the above backed by an immutable `ArrayBuffer`: copy once into
 *   a fresh mutable buffer before passing to `TextDecoder`.
 *
 * @param {ArrayBufferView | ArrayBufferLike} input
 * @returns {Uint8Array | ArrayBuffer}
 */
const toDecodable = input => {
  // Determine the underlying ArrayBuffer and the byte range.
  let buf;
  let byteOffset;
  let byteLength;
  if (isView(input)) {
    buf = /** @type {ArrayBuffer} */ (
      /** @type {ArrayBufferView} */ (input).buffer
    );
    byteOffset = /** @type {ArrayBufferView} */ (input).byteOffset;
    byteLength = /** @type {ArrayBufferView} */ (input).byteLength;
  } else {
    buf = /** @type {ArrayBuffer} */ (input);
    byteOffset = 0;
    byteLength = buf.byteLength;
  }

  // `ArrayBuffer.prototype.immutable` is the presence-check for the
  // @endo/immutable-arraybuffer shim (and future native stage-3 impl).
  // When the accessor reports `true`, TextDecoder will reject the view,
  // so we must produce a mutable copy.
  if (/** @type {any} */ (buf).immutable === true) {
    return new Uint8Array(buf.slice(byteOffset, byteOffset + byteLength));
  }

  // Mutable buffer: return a Uint8Array view (no copy).
  if (byteOffset === 0 && byteLength === buf.byteLength) {
    return new Uint8Array(buf);
  }
  return new Uint8Array(buf, byteOffset, byteLength);
};

/**
 * @typedef {object} BytesToTextOptions
 * @property {boolean} [fatal] When `true`, malformed UTF-8 throws instead of
 *   substituting U+FFFD.
 */

/**
 * Decodes UTF-8 bytes to a string.
 *
 * Accepts a frozen `Uint8Array` backed by an immutable `ArrayBuffer`
 * (the byteArray passable form), any other `ArrayBufferView`, or a bare
 * `ArrayBufferLike` — callers do not need to produce a mutable copy
 * before calling this function.  The copy, when required because
 * `TextDecoder.decode` rejects immutable backing buffers, is done
 * internally.
 *
 * Pass `{ fatal: true }` for strict UTF-8 decoding that throws on
 * invalid input. The default lenient mode substitutes the
 * Unicode replacement character (U+FFFD) for malformed sequences.
 *
 * @param {ArrayBufferView | ArrayBufferLike} input
 * @param {BytesToTextOptions} [options]
 * @returns {string}
 */
export const bytesToText = (input, options = undefined) => {
  const decodable = toDecodable(input);
  if (options !== undefined && options.fatal) {
    return fatalTextDecoder.decode(decodable);
  }
  return lenientTextDecoder.decode(decodable);
};
harden(bytesToText);
