// @ts-check

import harden from '@endo/harden';

/**
 * Copies the contents of a frozen `Uint8Array` (or any `ArrayBufferView`
 * or `ArrayBufferLike`) into a fresh mutable `Uint8Array`.
 *
 * The hardened frozen `Uint8Array` produced by `bytesToImmutable`
 * cannot itself be written through, and consumers such as
 * `TextDecoder.decode` reject views over immutable buffers. This
 * helper produces a working mutable `Uint8Array` copy that callers
 * can pass to those APIs.
 *
 * Accepts both an `ArrayBufferView` (such as the frozen `Uint8Array`
 * produced by `bytesToImmutable`) and a bare `ArrayBufferLike`
 * (the raw immutable `ArrayBuffer` shape previously produced by
 * `bytesToImmutable`, still supported here so cross-version callers
 * remain working). The result is always a fresh, mutable
 * `Uint8Array`.
 *
 * @param {ArrayBufferView | ArrayBufferLike} buffer
 * @returns {Uint8Array}
 */
export const bytesFromImmutable = buffer => {
  if (ArrayBuffer.isView(buffer)) {
    return new Uint8Array(
      buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ),
    );
  }
  return new Uint8Array(buffer.slice(0));
};
harden(bytesFromImmutable);
