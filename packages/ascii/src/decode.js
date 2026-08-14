// @ts-check

import harden from '@endo/harden';

const TypedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const { apply } = Reflect;
const { fromCharCode } = String;
const isView = /** @type {(value: unknown) => boolean} */ (ArrayBuffer.isView);
const { fill: typedArrayFill } = TypedArrayPrototype;
const { slice: typedArraySlice } = TypedArrayPrototype;
const { get: typedArrayLength } = /** @type {PropertyDescriptor} */ (
  Object.getOwnPropertyDescriptor(TypedArrayPrototype, 'length')
);
const { get: typedArrayTag } = /** @type {PropertyDescriptor} */ (
  Object.getOwnPropertyDescriptor(TypedArrayPrototype, Symbol.toStringTag)
);

const CODE_UNIT_CHUNK_SIZE = 4096;

/**
 * Decodes bytes to ASCII text, one UTF-16 code unit per byte, asserting that
 * every byte is in the admitted 7-bit range `0x00`–`0x7f` and hard-failing on
 * the first byte that is not. It is the exact inverse of `encodeAscii`: what
 * `encodeAscii` admits, `decodeAscii` round-trips, and what `encodeAscii`
 * rejects, `decodeAscii` refuses to have produced.
 *
 * Pure JavaScript with no `TextDecoder`, no `node:` imports, and no host
 * globals, so it imports and runs under XS (`xst`) exactly as it does under
 * Node.js and browsers. It is also the strict counterpart the `TextDecoder`
 * label `'ascii'` is not: per the [WHATWG Encoding
 * Standard](https://encoding.spec.whatwg.org/#names-and-labels) that label is
 * an alias for `windows-1252`, so `new TextDecoder('ascii', { fatal: true })`
 * silently maps bytes `0x80`–`0xff` to Latin-1/windows-1252 characters instead
 * of throwing — the exact trap this primitive avoids.
 *
 * @param {Uint8Array} bytes
 * @param {string} [name] Name of the bytes, for error diagnostics.
 * @returns {string}
 */
export const decodeAscii = (bytes, name = '<unknown>') => {
  /** @type {Uint8Array} */
  let genuineBytes;
  try {
    if (isView(bytes)) {
      if (
        apply(
          /** @type {(this: unknown) => string | undefined} */ (typedArrayTag),
          bytes,
          [],
        ) !== 'Uint8Array'
      ) {
        throw TypeError('not a Uint8Array');
      }
      // A zero-length intrinsic fill performs ValidateTypedArray, including the
      // detached/out-of-bounds check, without invoking a subclass species
      // constructor or reading through a caller-controlled Proxy.
      apply(typedArrayFill, bytes, [0, 0, 0]);
      genuineBytes = bytes;
    } else {
      // The freezable-TypedArray shim represents a Uint8Array over an emulated
      // immutable ArrayBuffer with a non-exotic wrapper. Its shimmed `slice`
      // amplifies the wrapper and copies its bytes into a genuine Uint8Array,
      // matching the compatibility path used by @endo/bytes and @endo/utf8.
      genuineBytes = apply(typedArraySlice, bytes, []);
    }
  } catch (cause) {
    throw TypeError(`ascii: expected bytes ${name} to be a Uint8Array`, {
      cause,
    });
  }
  const length = apply(
    /** @type {(this: unknown) => number} */ (typedArrayLength),
    genuineBytes,
    [],
  );

  /** @type {string[]} */
  const chunks = [];
  for (let offset = 0; offset < length; offset += CODE_UNIT_CHUNK_SIZE) {
    const chunkLength = Math.min(CODE_UNIT_CHUNK_SIZE, length - offset);
    const codeUnits = new Array(chunkLength);
    for (let index = 0; index < chunkLength; index += 1) {
      const byteOffset = offset + index;
      const byte = genuineBytes[byteOffset];
      if (!(byte >= 0 && byte <= 0x7f)) {
        throw RangeError(
          `Non-ASCII byte 0x${byte.toString(16)} at offset ${byteOffset} of bytes ${name}`,
        );
      }
      codeUnits[index] = byte;
    }
    chunks.push(apply(fromCharCode, undefined, codeUnits));
  }
  return chunks.join('');
};
harden(decodeAscii);
