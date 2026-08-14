// @ts-check
/* eslint-disable no-bitwise */

import harden from '@endo/harden';
import { makeError, q, X } from '@endo/errors';
import {
  cborWriterBytes,
  makeCborReader,
  makeCborWriter,
  writeArrayHeader,
  writeUint as writeCborUint,
  readArrayHeader,
  readUint as readCborUint,
} from '@endo/cbor';

/** @typedef {ReturnType<typeof makeCborReader>} Reader */

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
 * @property {0 | 1} direction
 * @property {0 | 1 | 2 | 3} kind
 * @property {number} position non-negative integer
 */

const KIND_RESERVED_MASK = 0b1111_1000;

/**
 * Flip a direction: what the sender called Local, the receiver
 * reads as Remote.
 *
 * @param {0 | 1} direction
 * @returns {0 | 1}
 */
export const flipDirection = direction =>
  direction === Direction.Local ? 1 : 0;
harden(flipDirection);

/**
 * Encode a descriptor into the shared canonical form:
 * a 2-element CBOR array `[kindByte, position]`.
 *
 * @param {ReturnType<typeof makeCborWriter>} writer
 * @param {Descriptor} d
 */
export const writeDescriptor = (writer, d) => {
  const kindByte = (d.kind << 1) | d.direction;
  writeArrayHeader(writer, 2);
  writeCborUint(writer, BigInt(kindByte));
  writeCborUint(writer, BigInt(d.position));
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
  const writer = makeCborWriter();
  writeDescriptor(writer, d);
  return cborWriterBytes(writer);
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
  const kindByte = Number(readCborUint(r));
  const positionBigint = readCborUint(r);
  if (positionBigint > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw makeError(X`descriptor position exceeds safe-integer range`);
  }
  const position = Number(positionBigint);
  if ((kindByte & KIND_RESERVED_MASK) !== 0) {
    throw makeError(
      X`descriptor kind byte ${q(kindByte)} has reserved bits set`,
    );
  }
  const direction = /** @type {0 | 1} */ (kindByte & 0b1);
  const kind = /** @type {0 | 1 | 2 | 3} */ ((kindByte >> 1) & 0b11);
  return { direction, kind, position };
};
harden(readDescriptor);

/**
 * Standalone decode from a stand-alone descriptor byte sequence.
 *
 * @param {Uint8Array} bytes
 * @returns {Descriptor}
 */
export const decodeDescriptor = bytes => {
  return readDescriptor(makeCborReader(bytes, { name: 'slot descriptor' }));
};
harden(decodeDescriptor);

/**
 * Canonical map key for a descriptor.  Must be stable for any
 * two equal descriptors and distinct for any two non-equal ones.
 *
 * @param {Descriptor} d
 * @returns {string}
 */
export const descriptorKey = d =>
  `${(d.kind << 1) | d.direction}:${d.position}`;
harden(descriptorKey);
