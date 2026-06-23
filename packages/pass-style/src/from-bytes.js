// @ts-check

import harden from '@endo/harden';

/**
 * Copies the contents of a frozen `Uint8Array` backed by an immutable
 * `ArrayBuffer` into a fresh mutable `Uint8Array`.
 *
 * The hardened frozen `Uint8Array` produced by `toBytes` cannot itself
 * be written through, and consumers such as `TextDecoder.decode` reject
 * views over immutable buffers.
 * This helper produces a working mutable `Uint8Array` copy that callers
 * can pass to those APIs.
 *
 * Also accepts a plain mutable `Uint8Array` (returns a fresh copy either way).
 * The result is always a fresh, mutable `Uint8Array`.
 *
 * @param {Uint8Array} buffer
 * @returns {Uint8Array}
 */
export const fromBytes = buffer => {
  return new Uint8Array(
    buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ),
  );
};
harden(fromBytes);
