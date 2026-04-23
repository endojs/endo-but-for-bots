// @ts-check
/* eslint-disable no-bitwise */

import harden from '@endo/harden';
import { makeError, q, X } from '@endo/errors';

/**
 * Canonical CBOR writer/reader tuned to the slot-machine wire format.
 *
 * We write bytes directly per RFC 8949 §4.2 so that every output is
 * byte-identical to the Rust `rust/endo/slots` crate.  Only the
 * subset of CBOR used by the four slot verbs is supported:
 *   - unsigned integers (minimal-head)
 *   - byte strings
 *   - arrays (definite length)
 *   - null (for the optional reply field)
 *
 * Definite-length only; no maps, no floats, no tags, no indefinite
 * containers.
 */

const MAJOR_UINT = 0;
const MAJOR_BYTES = 2;
const MAJOR_ARRAY = 4;

const CBOR_NULL = 0xf6;

const MAX_SAFE_U32 = 0xffffffff;

/**
 * Internal writer state: a growing byte list.
 *
 * @typedef {{ bytes: number[] }} Writer
 */

/** @returns {Writer} */
export const makeWriter = () => ({ bytes: [] });
harden(makeWriter);

/** @param {Writer} w */
export const writerToBytes = w => new Uint8Array(w.bytes);
harden(writerToBytes);

/**
 * @param {Writer} w
 * @param {number} major 0..=7
 * @param {number} value non-negative
 */
const writeHead = (w, major, value) => {
  const m = (major & 0b111) << 5;
  if (value <= 23) {
    w.bytes.push(m | value);
  } else if (value <= 0xff) {
    w.bytes.push(m | 24, value);
  } else if (value <= 0xffff) {
    w.bytes.push(m | 25, (value >> 8) & 0xff, value & 0xff);
  } else if (value <= MAX_SAFE_U32) {
    w.bytes.push(
      m | 26,
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    );
  } else if (Number.isSafeInteger(value)) {
    // 53-bit ceiling.  For 32..53-bit values use the 8-byte head.
    w.bytes.push(m | 27);
    // split into high/low 32-bit halves
    const high = Math.floor(value / 0x100000000);
    const low = value >>> 0;
    w.bytes.push(
      (high >>> 24) & 0xff,
      (high >>> 16) & 0xff,
      (high >>> 8) & 0xff,
      high & 0xff,
      (low >>> 24) & 0xff,
      (low >>> 16) & 0xff,
      (low >>> 8) & 0xff,
      low & 0xff,
    );
  } else {
    throw makeError(X`CBOR value out of safe-integer range: ${q(value)}`);
  }
};

/**
 * @param {Writer} w
 * @param {number} v
 */
export const writeUint = (w, v) => {
  if (v < 0 || !Number.isFinite(v)) {
    throw makeError(X`writeUint requires non-negative number: ${q(v)}`);
  }
  writeHead(w, MAJOR_UINT, v);
};
harden(writeUint);

/**
 * @param {Writer} w
 * @param {Uint8Array} bytes
 */
export const writeByteString = (w, bytes) => {
  writeHead(w, MAJOR_BYTES, bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    w.bytes.push(bytes[i]);
  }
};
harden(writeByteString);

/**
 * @param {Writer} w
 * @param {number} len
 */
export const writeArrayHeader = (w, len) => {
  writeHead(w, MAJOR_ARRAY, len);
};
harden(writeArrayHeader);

/** @param {Writer} w */
export const writeNull = w => {
  w.bytes.push(CBOR_NULL);
};
harden(writeNull);

// ---- reader ----

/**
 * @typedef {{ data: Uint8Array, pos: number }} Reader
 */

/** @param {Uint8Array} data */
export const makeReader = data => ({ data, pos: 0 });
harden(makeReader);

/**
 * @param {Reader} r
 * @param {number} n
 * @returns {number} single byte value, or throws on EOF
 */
const readByte = (r, n = 1) => {
  if (r.pos + n > r.data.length) {
    throw makeError(X`CBOR: unexpected EOF at offset ${q(r.pos)}`);
  }
  const b = r.data[r.pos];
  r.pos += 1;
  return b;
};

/**
 * @param {Reader} r
 * @returns {{ major: number, value: number }}
 */
const readHead = r => {
  const initial = readByte(r);
  const major = initial >> 5;
  const info = initial & 0x1f;
  if (info < 24) return { major, value: info };
  let size;
  if (info === 24) size = 1;
  else if (info === 25) size = 2;
  else if (info === 26) size = 4;
  else if (info === 27) size = 8;
  else throw makeError(X`CBOR: unsupported additional info ${q(info)}`);
  if (r.pos + size > r.data.length) {
    throw makeError(X`CBOR: unexpected EOF reading head`);
  }
  let value = 0;
  for (let i = 0; i < size; i += 1) {
    const b = r.data[r.pos + i];
    value = value * 256 + Number(b);
  }
  r.pos += size;
  if (!Number.isSafeInteger(value)) {
    throw makeError(
      X`CBOR: integer ${q(value)} exceeds JavaScript safe-integer range`,
    );
  }
  return { major, value };
};

/** @param {Reader} r */
export const readUint = r => {
  const { major, value } = readHead(r);
  if (major !== MAJOR_UINT) {
    throw makeError(X`CBOR: expected uint, got major ${q(major)}`);
  }
  return value;
};
harden(readUint);

/** @param {Reader} r */
export const readByteString = r => {
  const { major, value } = readHead(r);
  if (major !== MAJOR_BYTES) {
    throw makeError(X`CBOR: expected byte string, got major ${q(major)}`);
  }
  if (r.pos + value > r.data.length) {
    throw makeError(X`CBOR: byte string body truncated`);
  }
  const out = r.data.subarray(r.pos, r.pos + value);
  r.pos += value;
  return new Uint8Array(out);
};
harden(readByteString);

/** @param {Reader} r @returns {number} */
export const readArrayHeader = r => {
  const { major, value } = readHead(r);
  if (major !== MAJOR_ARRAY) {
    throw makeError(X`CBOR: expected array, got major ${q(major)}`);
  }
  return value;
};
harden(readArrayHeader);

/**
 * Peek: is the next item CBOR null?  Consumes the byte if so.
 *
 * @param {Reader} r
 */
export const readNullOrPeek = r => {
  if (r.pos >= r.data.length) {
    throw makeError(X`CBOR: unexpected EOF`);
  }
  if (r.data[r.pos] === CBOR_NULL) {
    r.pos += 1;
    return true;
  }
  return false;
};
harden(readNullOrPeek);

/**
 * Assert the reader has consumed all bytes.
 *
 * @param {Reader} r
 */
export const assertConsumed = r => {
  if (r.pos !== r.data.length) {
    throw makeError(
      X`CBOR: ${q(r.data.length - r.pos)} trailing byte(s) after payload`,
    );
  }
};
harden(assertConsumed);
