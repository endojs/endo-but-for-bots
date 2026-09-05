// @ts-check

import harden from '@endo/harden';

/**
 * CBOR byte-string head encoding and decoding helpers.
 *
 * Implements just enough of [RFC 8949](https://www.rfc-editor.org/rfc/rfc8949.html)
 * to read and write the head of a CBOR byte string (major type 2),
 * mandatorily wrapped in CBOR tag 24 (Encoded CBOR data item; major
 * type 6, argument 24).
 *
 * Tag 24 (major type 6, argument 24) prefixes the byte-string head with
 * the two bytes 0xd8 0x18.
 *
 * Head shapes for the inner major type 2 (initial byte = 0x40 plus an
 * additional-info nibble, since major type 2 occupies the top three
 * bits and the additional info occupies the bottom five):
 *
 * - 1-byte head: length 0 to 23, encoded inline in the initial byte
 *   (0x40 + length).
 * - 2-byte head: initial byte 0x58, then one follow byte (uint8 length).
 * - 3-byte head: initial byte 0x59, then two follow bytes (uint16 BE).
 * - 5-byte head: initial byte 0x5a, then four follow bytes (uint32 BE).
 * - 9-byte head: initial byte 0x5b, then eight follow bytes (uint64 BE).
 */

// Initial byte for major type 2 (byte string) with the additional-info
// nibble cleared.
export const MAJOR_2_BASE = 0x40;
harden(MAJOR_2_BASE);

// Initial byte for major type 3 (text string) with the additional-info
// nibble cleared; used by the reader's diagnostic only.
const MAJOR_3_BASE = 0x60;

// Threshold above which the additional-info nibble is no longer the
// argument itself but instead names the width of follow bytes carrying
// the argument.
export const ARG_INLINE_MAX = 23;
harden(ARG_INLINE_MAX);

// Additional-info nibbles naming the width of the follow-byte argument.
export const ARG_U8 = 24;
harden(ARG_U8);
export const ARG_U16 = 25;
harden(ARG_U16);
export const ARG_U32 = 26;
harden(ARG_U32);
export const ARG_U64 = 27;
harden(ARG_U64);
export const ARG_INDEFINITE = 31;
harden(ARG_INDEFINITE);

// Initial-byte values for the four explicit-length byte-string heads.
const INITIAL_U8 = MAJOR_2_BASE + ARG_U8; // 0x58
const INITIAL_U16 = MAJOR_2_BASE + ARG_U16; // 0x59
const INITIAL_U32 = MAJOR_2_BASE + ARG_U32; // 0x5a
const INITIAL_U64 = MAJOR_2_BASE + ARG_U64; // 0x5b
const INITIAL_INDEFINITE = MAJOR_2_BASE + ARG_INDEFINITE; // 0x5f

// Tag-24 wrapper bytes: 0xd8 (major 6 with one follow argument byte) and
// 0x18 (the argument value 24).
const TAG_24_INITIAL = 0xd8;
const TAG_24_ARG = 0x18;

/**
 * Maximum payload length representable by an unsigned 53-bit integer.
 * The CBOR head argument is a uint64; JavaScript numbers safely cover
 * up to 2^53 - 1, which is far above any sane buffer ceiling. Payloads
 * declaring lengths above this would have to be carried via BigInt,
 * which this framing primitive deliberately does not do.
 */
export const MAX_SAFE_PAYLOAD_LENGTH = Number.MAX_SAFE_INTEGER;
harden(MAX_SAFE_PAYLOAD_LENGTH);

/**
 * Default ceiling a reader or writer applies to a framed message length
 * when the caller supplies no `maxMessageLength`. Matches the sibling
 * `@endo/netstring` reader/writer default so the two framings share a
 * sane finite bound rather than admitting the full `MAX_SAFE_PAYLOAD_LENGTH`
 * head range; a caller parsing untrusted input should still set an
 * explicit, tighter `maxMessageLength` for its transport.
 */
export const DEFAULT_MAX_MESSAGE_LENGTH = 999_999_999;
harden(DEFAULT_MAX_MESSAGE_LENGTH);

/**
 * Return the length in bytes of the shortest canonical (RFC 8949 § 4.2)
 * byte-string head for a payload of the given length.
 *
 * @param {number} length
 * @returns {1 | 2 | 3 | 5 | 9}
 */
export const headLengthFor = length => {
  if (length <= ARG_INLINE_MAX) {
    return 1;
  }
  if (length <= 0xff) {
    return 2;
  }
  if (length <= 0xffff) {
    return 3;
  }
  if (length <= 0xffff_ffff) {
    return 5;
  }
  return 9;
};
harden(headLengthFor);

/**
 * Write the big-endian byte representation of `value` into `out` starting
 * at index `at`, using `width` bytes.
 *
 * @param {Uint8Array} out
 * @param {number} at
 * @param {number} value
 * @param {number} width
 */
const writeUintBE = (out, at, value, width) => {
  for (let i = width - 1; i >= 0; i -= 1) {
    out[at + i] = value % 256;
    value = Math.floor(value / 256);
  }
};

/**
 * Encode the CBOR byte-string head (major type 2) for a payload of the
 * given length into a freshly allocated `Uint8Array`, using the shortest
 * canonical (RFC 8949 § 4.2) argument form.
 *
 * @param {number} length non-negative integer, payload byte count.
 * @returns {Uint8Array}
 */
export const encodeByteStringHead = length => {
  if (!Number.isInteger(length) || length < 0) {
    throw Error(
      `CBOR byte-string head length must be a non-negative integer, got ${length}`,
    );
  }
  if (length > MAX_SAFE_PAYLOAD_LENGTH) {
    throw Error(
      `CBOR byte-string head length ${length} exceeds safe-integer bound`,
    );
  }
  if (length <= ARG_INLINE_MAX) {
    // No bit-twiddling needed: major type 2 occupies bits 5..7 and the
    // additional-info nibble occupies bits 0..4, which are zero for
    // lengths in [0, 23], so the two are added without overlap.
    return new Uint8Array([MAJOR_2_BASE + length]);
  }
  if (length <= 0xff) {
    return new Uint8Array([INITIAL_U8, length]);
  }
  if (length <= 0xffff) {
    const buf = new Uint8Array(3);
    buf[0] = INITIAL_U16;
    writeUintBE(buf, 1, length, 2);
    return buf;
  }
  if (length <= 0xffff_ffff) {
    const buf = new Uint8Array(5);
    buf[0] = INITIAL_U32;
    writeUintBE(buf, 1, length, 4);
    return buf;
  }
  const buf = new Uint8Array(9);
  buf[0] = INITIAL_U64;
  writeUintBE(buf, 1, length, 8);
  return buf;
};
harden(encodeByteStringHead);

/**
 * The two-byte CBOR tag-24 (Encoded CBOR data item) prefix.
 * Major type 6, argument 24 = initial byte 0xd8, then the argument
 * 0x18 as a one-byte follow.
 */
export const TAG_24_PREFIX = harden(
  new Uint8Array([TAG_24_INITIAL, TAG_24_ARG]),
);

/**
 * The result of decoding a byte-string head from a prefix of a buffer.
 *
 * @typedef {object} HeadDecode
 * @property {number} length payload length declared by the head.
 * @property {number} headLength bytes consumed by the head, including
 *   the mandatory leading tag-24 wrapper.
 */

/**
 * Read `width` bytes from `buffer` starting at `at` as an unsigned
 * big-endian integer.
 *
 * @param {Uint8Array} buffer
 * @param {number} at
 * @param {number} width
 * @returns {number}
 */
const readUintBE = (buffer, at, width) => {
  let value = 0;
  for (let i = 0; i < width; i += 1) {
    value = value * 256 + buffer[at + i];
  }
  return value;
};

/**
 * Attempt to decode a CBOR byte-string head, wrapped in the mandatory
 * tag-24 prefix, from the start of the given buffer. Returns undefined
 * when the buffer is too short to determine the head; throws when the
 * buffer's initial bytes are not a valid tag-24-wrapped byte-string
 * head.
 *
 * Returns undefined (not null) for the under-read case so that callers
 * can use the `maybeRead`-style idiom: a missing result is the absence
 * of a value, not a sentinel value.
 *
 * @param {Uint8Array} buffer
 * @returns {HeadDecode | undefined}
 */
export const decodeByteStringHead = buffer => {
  if (buffer.length === 0) {
    return undefined;
  }
  if (buffer[0] !== TAG_24_INITIAL) {
    const initialHex = buffer[0].toString(16).padStart(2, '0');
    throw Error(
      `CBOR framing reader expects the mandatory tag-24 prefix (initial byte 0x${TAG_24_INITIAL.toString(16)}); got 0x${initialHex}`,
    );
  }
  if (buffer.length < 2) {
    return undefined;
  }
  if (buffer[1] !== TAG_24_ARG) {
    const argHex = buffer[1].toString(16).padStart(2, '0');
    throw Error(
      `CBOR framing reader only accepts tag 24 wrappers; saw tag argument byte 0x${argHex}`,
    );
  }
  let cursor = 2;
  if (cursor >= buffer.length) {
    return undefined;
  }
  const initial = buffer[cursor];
  // Distinguish major type via comparison against the per-major base
  // values. The bottom five bits are the additional-info nibble.
  if (initial >= MAJOR_2_BASE && initial < MAJOR_3_BASE) {
    // OK: major type 2.
  } else {
    const initialHex = initial.toString(16).padStart(2, '0');
    const majorNumber = Math.floor(initial / 32);
    throw Error(
      `CBOR framing reader expects major type 2 (byte string) inside tag 24; got major type ${majorNumber} (initial byte 0x${initialHex})`,
    );
  }
  const arg = initial - MAJOR_2_BASE;
  cursor += 1;
  if (arg === ARG_INDEFINITE) {
    throw Error(
      `CBOR framing reader rejects indefinite-length byte strings (initial byte 0x${INITIAL_INDEFINITE.toString(16)})`,
    );
  }
  if (arg <= ARG_INLINE_MAX) {
    return { length: arg, headLength: cursor };
  }
  let follow;
  if (arg === ARG_U8) {
    follow = 1;
  } else if (arg === ARG_U16) {
    follow = 2;
  } else if (arg === ARG_U32) {
    follow = 4;
  } else if (arg === ARG_U64) {
    follow = 8;
  } else {
    throw Error(
      `CBOR framing reader saw reserved additional-info ${arg} in byte-string head`,
    );
  }
  if (buffer.length < cursor + follow) {
    return undefined;
  }
  let length;
  if (follow <= 4) {
    length = readUintBE(buffer, cursor, follow);
  } else {
    // 8-byte follow: split into hi and lo 32-bit halves to keep the
    // arithmetic inside Number's safe-integer range. Lengths above
    // 2^53 - 1 are rejected. The pair share the same width, which
    // makes a transposition error visually obvious at the call site.
    const hi = readUintBE(buffer, cursor, 4);
    const lo = readUintBE(buffer, cursor + 4, 4);
    if (hi > 0x1f_ffff) {
      throw Error(
        `CBOR byte-string head declares payload length above 2^53-1 (hi32=${hi}); refusing to allocate`,
      );
    }
    length = hi * 0x1_0000_0000 + lo;
    if (length > MAX_SAFE_PAYLOAD_LENGTH) {
      throw Error(
        `CBOR byte-string head declares payload length above 2^53-1 (${length}); refusing to allocate`,
      );
    }
  }
  cursor += follow;
  return { length, headLength: cursor };
};
harden(decodeByteStringHead);
