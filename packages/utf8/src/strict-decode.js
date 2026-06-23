import harden from '@endo/harden';

// Capture a fatal `TextDecoder` at module load.
// The `fatal: true` decoder throws on malformed UTF-8 sequences instead
// of substituting U+FFFD.
// Capturing once at module init avoids per-call allocation and avoids
// any post-lockdown mutation of the global from redirecting calls.
const fatalTextDecoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Return a `Uint8Array` view or value that `TextDecoder.decode` will
 * accept.
 * `TextDecoder.decode` rejects views backed by an immutable
 * `ArrayBuffer` (as produced by the `@endo/immutable-arraybuffer` shim
 * or a native stage-3 implementation), so we copy into a mutable buffer
 * only when necessary.
 *
 * @param {Uint8Array} input
 * @returns {Uint8Array | ArrayBuffer}
 */
const toDecodable = input => {
  const buf = /** @type {ArrayBuffer} */ (input.buffer);
  const { byteOffset, byteLength } = input;

  if (/** @type {any} */ (buf).immutable === true) {
    return new Uint8Array(buf.slice(byteOffset, byteOffset + byteLength));
  }

  if (byteOffset === 0 && byteLength === buf.byteLength) {
    return new Uint8Array(buf);
  }
  return new Uint8Array(buf, byteOffset, byteLength);
};

/**
 * Decodes UTF-8 bytes to a string.
 * Throws a `TypeError` on any malformed UTF-8 sequence rather than
 * substituting U+FFFD.
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
export const strictDecodeUtf8 = input =>
  fatalTextDecoder.decode(toDecodable(input));
harden(strictDecodeUtf8);
