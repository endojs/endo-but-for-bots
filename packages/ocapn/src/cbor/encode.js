// @ts-check

/**
 * @file CBOR encoder for OCapN messages.
 *
 * Implements the OCapN CBOR encoding specification with canonical output
 * suitable for signature verification.
 *
 * The RFC 8949 head grammar, byte/text strings, arrays, maps, tags, floats,
 * simple values, and bignums are the shared canonical subset now provided by
 * `@endo/cbor` (see designs/cbor-codec.md); this module retains only the
 * OCapN-specific policy layer: the `CborWriter` class implementing the
 * `OcapnWriter` interface (structure tracking, record labels), selector tag
 * 280, record tag 27, and the self-described tag 55799.
 *
 * See docs/cbor-encoding.md for the specification.
 */

import {
  makeCborWriter as makeCborWriterState,
  cborWriterBytes,
  writeArrayHeader,
  writeBignum,
  writeBoolean,
  writeByteString,
  writeFloat64,
  writeMapHeader,
  writeNull,
  writeTag,
  writeTextString,
  writeUndefined,
} from '@endo/cbor';

/**
 * @import { OcapnWriter } from '../codec-interface.js'
 * @import { CborWriter as CborWriterState } from '@endo/cbor'
 */

// CBOR Major Types (3 most significant bits), re-exported for the codec layer.
const MAJOR_UNSIGNED = 0; // 0b000
const MAJOR_NEGATIVE = 1; // 0b001
const MAJOR_BYTESTRING = 2; // 0b010
const MAJOR_TEXTSTRING = 3; // 0b011
const MAJOR_ARRAY = 4; // 0b100
const MAJOR_MAP = 5; // 0b101
const MAJOR_TAG = 6; // 0b110
const MAJOR_FLOAT_SIMPLE = 7; // 0b111

// CBOR Tags used in OCapN. Kept as bigints for the cross-module contract with
// the codec layer, which compares against these exact values.
const TAG_UNSIGNED_BIGNUM = 2n;
const TAG_NEGATIVE_BIGNUM = 3n;
const TAG_RECORD = 27n; // Generic record/structure
const TAG_SYMBOL = 280n; // OCapN symbol (selector)
const TAG_TAGGED_VALUE = 55_799n; // Self-described CBOR / OCapN tagged

/**
 * Write a byte string, accepting either a Uint8Array or an (immutable)
 * ArrayBuffer. `@endo/cbor`'s `writeByteString` requires a Uint8Array, so the
 * ArrayBuffer coercion stays here at the OCapN boundary.
 *
 * @param {CborWriterState} writer
 * @param {Uint8Array | ArrayBufferLike} value
 */
function writeBytestring(writer, value) {
  const bytes =
    value instanceof Uint8Array ? value : new Uint8Array(value.slice());
  writeByteString(writer, bytes);
}

/**
 * Write a selector (symbol) as Tag 280 + text string.
 *
 * @param {CborWriterState} writer
 * @param {string} value - The symbol name
 */
function writeSelectorFromString(writer, value) {
  writeTag(writer, Number(TAG_SYMBOL));
  writeTextString(writer, value);
}

const defaultCapacity = 256;

/**
 * CBOR Writer implementing the OcapnWriter interface.
 *
 * @implements {OcapnWriter}
 */
export class CborWriter {
  /** @type {CborWriterState} */
  #writer;

  /** @type {string} */
  name;

  /**
   * Record label type preference for this codec.
   * CBOR uses plain strings for record labels (not symbols).
   * @type {'string'}
   */
  recordLabelType = 'string';

  /**
   * Stack tracking nested structures for validation.
   * Each entry is the type of structure we're inside.
   * @type {Array<'record' | 'list' | 'dictionary' | 'set'>}
   */
  #stack = [];

  /**
   * Deferred length positions for structures.
   * Maps stack depth to the running element count.
   * @type {Map<number, {count: number}>}
   */
  #structureInfo = new Map();

  /**
   * @param {CborWriterState} writer
   * @param {object} options
   * @param {string} [options.name]
   */
  constructor(writer, options = {}) {
    const { name = '<unknown>' } = options;
    this.name = name;
    this.#writer = writer;
  }

  get index() {
    return this.#writer.length;
  }

  /**
   * @param {string} value
   */
  writeSelectorFromString(value) {
    writeSelectorFromString(this.#writer, value);
    this.#incrementCount();
  }

  /**
   * @param {string} value
   */
  writeString(value) {
    writeTextString(this.#writer, value);
    this.#incrementCount();
  }

  /**
   * @param {ArrayBufferLike} value
   */
  writeBytestring(value) {
    writeBytestring(this.#writer, value);
    this.#incrementCount();
  }

  /**
   * @param {boolean} value
   */
  writeBoolean(value) {
    writeBoolean(this.#writer, value);
    this.#incrementCount();
  }

  /**
   * @param {bigint} value
   */
  writeInteger(value) {
    writeBignum(this.#writer, value);
    this.#incrementCount();
  }

  /**
   * @param {number} value
   */
  writeFloat64(value) {
    writeFloat64(this.#writer, value);
    this.#incrementCount();
  }

  /**
   * Write undefined
   */
  writeUndefined() {
    writeUndefined(this.#writer);
    this.#incrementCount();
  }

  /**
   * Write null
   */
  writeNull() {
    writeNull(this.#writer);
    this.#incrementCount();
  }

  /**
   * Increment the element count for the current structure
   */
  #incrementCount() {
    if (this.#stack.length > 0) {
      const info = this.#structureInfo.get(this.#stack.length - 1);
      if (info) {
        info.count += 1;
      }
    }
  }

  /**
   * Begin tracking a structure's elements
   * @param {'record' | 'list' | 'dictionary' | 'set'} type
   */
  #beginStructure(type) {
    this.#stack.push(type);
    this.#structureInfo.set(this.#stack.length - 1, {
      count: 0,
    });
  }

  /**
   * End tracking a structure and return element count
   * @param {'record' | 'list' | 'dictionary' | 'set'} expectedType
   * @returns {number} Element count
   */
  #endStructure(expectedType) {
    if (this.#stack.length === 0) {
      throw new Error(`Cannot exit ${expectedType}: not inside any structure`);
    }
    const actualType = this.#stack[this.#stack.length - 1];
    if (actualType !== expectedType) {
      throw new Error(
        `Cannot exit ${expectedType}: currently inside ${actualType}`,
      );
    }

    const info = this.#structureInfo.get(this.#stack.length - 1);
    this.#structureInfo.delete(this.#stack.length - 1);
    this.#stack.pop();

    // Increment parent's count
    this.#incrementCount();

    return info ? info.count : 0;
  }

  /**
   * Enter a record (Tag 27 + array).
   * The label should be written first using writeSelectorFromString.
   * @param {number} elementCount - Total elements including the label
   */
  enterRecord(elementCount) {
    writeTag(this.#writer, Number(TAG_RECORD));
    writeArrayHeader(this.#writer, elementCount);
    this.#beginStructure('record');
  }

  exitRecord() {
    this.#endStructure('record');
  }

  /**
   * Enter a list/array.
   * @param {number} elementCount - Number of elements in the list
   */
  enterList(elementCount) {
    writeArrayHeader(this.#writer, elementCount);
    this.#beginStructure('list');
  }

  exitList() {
    this.#endStructure('list');
  }

  /**
   * Enter a dictionary/map.
   * @param {number} pairCount - Number of key-value pairs
   */
  enterDictionary(pairCount) {
    writeMapHeader(this.#writer, pairCount);
    this.#beginStructure('dictionary');
  }

  exitDictionary() {
    this.#endStructure('dictionary');
  }

  /**
   * Enter a set.
   * @param {number} elementCount - Number of elements in the set
   */
  enterSet(elementCount) {
    // Sets are encoded as arrays in CBOR
    writeArrayHeader(this.#writer, elementCount);
    this.#beginStructure('set');
  }

  exitSet() {
    this.#endStructure('set');
  }

  getBytes() {
    return cborWriterBytes(this.#writer);
  }
}

/**
 * Create a CborWriter that buffers content for later length encoding.
 *
 * This implementation uses a simpler approach: write array/map headers
 * with the length inline. The caller must know the length in advance
 * or use the streaming API.
 *
 * @param {object} [options]
 * @param {number} [options.length] - Initial capacity
 * @param {string} [options.name] - Name for error messages
 * @returns {CborWriter & {
 *   writeArrayHeader: (length: number) => void,
 *   writeMapHeader: (pairs: number) => void,
 *   writeTaggedValue: (tagName: string, payload: () => void) => void
 * }}
 */
export function makeCborWriter(options = {}) {
  const { length: capacity = defaultCapacity, ...writerOptions } = options;
  const writerState = makeCborWriterState({ capacity });
  const writer = /** @type {any} */ (
    new CborWriter(writerState, writerOptions)
  );

  // Add convenience methods for definite-length structures
  writer.writeArrayHeader = (/** @type {number} */ length) => {
    writeArrayHeader(writerState, length);
  };

  writer.writeMapHeader = (/** @type {number} */ pairs) => {
    writeMapHeader(writerState, pairs);
  };

  // Helper for OCapN Tagged values (Tag 55799)
  writer.writeTaggedValue = (
    /** @type {string} */ tagName,
    /** @type {() => void} */ writePayload,
  ) => {
    writeTag(writerState, Number(TAG_TAGGED_VALUE));
    writeArrayHeader(writerState, 2);
    writeTextString(writerState, tagName);
    writePayload();
  };

  return writer;
}

// Re-export constants for use by codec layer
export {
  TAG_UNSIGNED_BIGNUM,
  TAG_NEGATIVE_BIGNUM,
  TAG_RECORD,
  TAG_SYMBOL,
  TAG_TAGGED_VALUE,
  MAJOR_UNSIGNED,
  MAJOR_NEGATIVE,
  MAJOR_BYTESTRING,
  MAJOR_TEXTSTRING,
  MAJOR_ARRAY,
  MAJOR_MAP,
  MAJOR_TAG,
  MAJOR_FLOAT_SIMPLE,
};
