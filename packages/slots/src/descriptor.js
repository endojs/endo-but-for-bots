// @ts-check
/* eslint-disable no-bitwise */

import harden from '@endo/harden';
import { makeError, q, X } from '@endo/errors';

import {
  makeWriter,
  writerToBytes,
  writeArrayHeader,
  writeUint,
  readArrayHeader,
  readUint,
} from './cbor.js';

/** @import { Reader } from './cbor.js' */

/**
 * Direction of a capability reference, from the *sender's* frame.
 * Local means the sending session allocated the position; Remote
 * means it was allocated by the other side.
 *
 * @type {Readonly<{ Local: 0, Remote: 1 }>}
 */
export const Direction = harden({ Local: 0, Remote: 1 });

/**
 * The kind of vref a descriptor points at.  Matches
 * `rust/endo/slots/src/wire/descriptor.rs::Kind` exactly.
 *
 * @type {Readonly<{ Object: 0, Promise: 1, Answer: 2, Device: 3 }>}
 */
export const Kind = harden({ Object: 0, Promise: 1, Answer: 2, Device: 3 });

/**
 * @typedef {object} Descriptor
 * @property {0 | 1} dir
 * @property {0 | 1 | 2 | 3} kind
 * @property {number} position non-negative integer
 */

const KIND_RESERVED_MASK = 0b1111_1000;

/**
 * Flip a direction: what the sender called Local, the receiver
 * reads as Remote.
 *
 * @param {0 | 1} dir
 * @returns {0 | 1}
 */
export const flipDirection = dir => (dir === Direction.Local ? 1 : 0);
harden(flipDirection);

/**
 * Encode a descriptor into the shared canonical form:
 * a 2-element CBOR array `[kindByte, position]`.
 *
 * @param {import('./cbor.js').Writer} w
 * @param {Descriptor} d
 */
export const writeDescriptor = (w, d) => {
  const kindByte = (d.kind << 1) | d.dir;
  writeArrayHeader(w, 2);
  writeUint(w, kindByte);
  writeUint(w, d.position);
};
harden(writeDescriptor);

/**
 * Standalone encode: returns a new Uint8Array containing exactly
 * the bytes of this descriptor.
 *
 * @param {Descriptor} d
 * @returns {Uint8Array}
 */
export const encodeDescriptor = d => {
  const w = makeWriter();
  writeDescriptor(w, d);
  return writerToBytes(w);
};
harden(encodeDescriptor);

/**
 * @param {Reader} r
 * @returns {Descriptor}
 */
export const readDescriptor = r => {
  const n = readArrayHeader(r);
  if (n !== 2) {
    throw makeError(X`descriptor must be 2-element array, got ${q(n)}`);
  }
  const kindByte = readUint(r);
  const position = readUint(r);
  if ((kindByte & KIND_RESERVED_MASK) !== 0) {
    throw makeError(
      X`descriptor kind byte ${q(kindByte)} has reserved bits set`,
    );
  }
  const dir = /** @type {0 | 1} */ (kindByte & 0b1);
  const kind = /** @type {0 | 1 | 2 | 3} */ ((kindByte >> 1) & 0b11);
  return { dir, kind, position };
};
harden(readDescriptor);

/**
 * Standalone decode from a stand-alone descriptor byte sequence.
 *
 * @param {Uint8Array} bytes
 * @returns {Descriptor}
 */
export const decodeDescriptor = bytes => {
  const r = { data: bytes, pos: 0 };
  return readDescriptor(r);
};
harden(decodeDescriptor);

/**
 * Canonical map key for a descriptor.  Must be stable for any
 * two equal descriptors and distinct for any two non-equal ones.
 *
 * @param {Descriptor} d
 * @returns {string}
 */
export const descriptorKey = d => `${(d.kind << 1) | d.dir}:${d.position}`;
harden(descriptorKey);
