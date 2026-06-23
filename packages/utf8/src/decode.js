import harden from '@endo/harden';

// Capture a lenient `TextDecoder` at module load.
// The default UTF-8 decoder substitutes U+FFFD for malformed sequences.
// Capturing once at module init avoids per-call allocation and avoids
// any post-lockdown mutation of the global from redirecting calls.
const lenientTextDecoder = new TextDecoder();

/**
 * Return a `Uint8Array` view or value that `TextDecoder.decode` will
 * accept.
 * `TextDecoder.decode` rejects views backed by an immutable
 * `ArrayBuffer` (as produced by the `@endo/immutable-arraybuffer` shim
 * or a native stage-3 implementation), so we copy into a mutable buffer
 * only when necessary.
 *
 * - Plain mutable `Uint8Array`: pass through unchanged (zero allocation).
 * - Frozen `Uint8Array` backed by an immutable `ArrayBuffer`: copy once
 *   into a fresh mutable buffer before passing to `TextDecoder`.
 *
 * @param {Uint8Array} input
 * @returns {Uint8Array | ArrayBuffer}
 */
const toDecodable = input => {
  const buf = /** @type {ArrayBuffer} */ (input.buffer);
  const { byteOffset, byteLength } = input;

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
 * Decodes UTF-8 bytes to a string, substituting U+FFFD for any
 * malformed sequences.
 *
 * Accepts a frozen `Uint8Array` backed by an immutable `ArrayBuffer`
 * (the byteArray passable form) or a plain mutable `Uint8Array`.
 * Callers do not need to produce a mutable copy before calling this
 * function.
 * The copy, when required because `TextDecoder.decode` rejects immutable
 * backing buffers, is done internally.
 *
 * @param {Uint8Array} input
 * @returns {string}
 */
export const decodeUtf8 = input =>
  lenientTextDecoder.decode(toDecodable(input));
harden(decodeUtf8);
