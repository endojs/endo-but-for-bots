// @ts-check

/**
 * @file CBOR decoder for OCapN messages.
 *
 * Implements the OCapN CBOR encoding specification, validating canonical
 * encoding for signature verification.
 *
 * The RFC 8949 head grammar, byte/text strings, tags, floats, simple values,
 * and bignums are the shared canonical subset now provided by `@endo/cbor`
 * (see designs/cbor-codec.md); this module retains only the OCapN-specific
 * policy layer: the `CborReader` class implementing the `OcapnReader` interface
 * (structure stack, record labels, `peekTypeHint` type-hinting), the
 * immutability conversion on byte strings, and selector tag 280 / record tag 27
 * handling. `@endo/cbor`'s readers are strict — they reject non-minimal heads
 * and non-minimal bignum payloads — so this decoder no longer accepts
 * non-canonical encodings the previous hand-rolled reader tolerated.
 *
 * See docs/cbor-encoding.md for the specification.
 */

import { bytesToImmutable } from '@endo/bytes/to-immutable.js';

import {
  makeCborReader as makeCborReaderState,
  readArrayHeader,
  readBignum,
  readBoolean,
  readByteString,
  readFloat64,
  readHead,
  readMapHeader,
  readTag,
  readTextString,
  peekHead,
} from '@endo/cbor';

/**
 * @import { OcapnReader, TypeHint, RecordLabelInfo, TypeAndMaybeValue } from '../codec-interface.js'
 * @import { CborReader as CborReaderState } from '@endo/cbor'
 */

// CBOR Major Types (3 most significant bits)
// Major types 0 and 1 (unsigned/negative) are not used directly
// because OCapN uses bignums (tags 2/3) for all integers.
const MAJOR_BYTESTRING = 2;
const MAJOR_TEXTSTRING = 3;
const MAJOR_ARRAY = 4;
const MAJOR_MAP = 5;
const MAJOR_TAG = 6;
const MAJOR_FLOAT_SIMPLE = 7;

// CBOR Additional Info value for an 8-byte argument (a float64 head).
const AI_8BYTE = 27;

// CBOR Simple Values (Major 7)
const SIMPLE_FALSE = 20;
const SIMPLE_TRUE = 21;
const SIMPLE_NULL = 22;
const SIMPLE_UNDEFINED = 23;

// CBOR Tags used in OCapN. Kept as bigints for the cross-module contract with
// the codec layer, which compares against these exact values.
const TAG_UNSIGNED_BIGNUM = 2n;
const TAG_NEGATIVE_BIGNUM = 3n;
const TAG_RECORD = 27n;
const TAG_SYMBOL = 280n;
const TAG_TAGGED_VALUE = 55_799n;

/**
 * Peek the major type and additional-info nibble of the next initial byte,
 * without consuming it or reading any argument bytes. Unlike `@endo/cbor`'s
 * `peekHead`, this stays at the single byte: a `float64` head is not read as an
 * 8-byte argument, so it is safe to probe a type category before deciding how
 * to read it. Retained OCapN policy per the design's "what stays" table.
 *
 * @param {CborReaderState} reader
 * @returns {{major: number, info: number}}
 */
function peekTypeByte(reader) {
  if (reader.index >= reader.bytes.length) {
    throw new Error(
      `Unexpected end of CBOR input at index ${reader.index} of ${reader.name}`,
    );
  }
  const byte = reader.bytes[reader.index];
  return {
    // eslint-disable-next-line no-bitwise
    major: byte >> 5,
    // eslint-disable-next-line no-bitwise
    info: byte & 0x1f,
  };
}

/**
 * Peek at a tag value without consuming it.
 *
 * @param {CborReaderState} reader
 * @returns {bigint | null} The tag number, or null if not a tag
 */
function peekTag(reader) {
  const { major } = peekTypeByte(reader);
  if (major !== MAJOR_TAG) {
    return null;
  }
  // peekHead reads the full (minimal-checked) head and rewinds the cursor.
  return peekHead(reader).value;
}

/**
 * Read a symbol (Tag 280 + text string).
 *
 * @param {CborReaderState} reader
 * @returns {string}
 */
function readSelectorAsString(reader) {
  const start = reader.index;
  const tag = readTag(reader);

  if (tag !== Number(TAG_SYMBOL)) {
    throw new Error(
      `Expected symbol tag (280), got tag ${tag} at index ${start} of ${reader.name}`,
    );
  }

  return readTextString(reader);
}

/**
 * @typedef {object} CborReaderStackEntry
 * @property {'record' | 'list' | 'dictionary' | 'set'} type
 * @property {number} remaining - Elements remaining (for definite length)
 * @property {number} start - Start position
 */

/**
 * CBOR Reader implementing the OcapnReader interface.
 *
 * @implements {OcapnReader}
 */
export class CborReader {
  /** @type {CborReaderState} */
  #reader;

  /** @type {string} */
  name;

  /**
   * Record label type preference for this codec.
   * CBOR uses plain strings for record labels (not symbols).
   * @type {'string'}
   */
  recordLabelType = 'string';

  /** @type {CborReaderStackEntry[]} */
  #stack = [];

  /**
   * @param {CborReaderState} reader
   * @param {object} options
   * @param {string} [options.name]
   */
  constructor(reader, options = {}) {
    const { name = '<unknown>' } = options;
    this.name = name;
    this.#reader = reader;
  }

  get index() {
    return this.#reader.index;
  }

  /**
   * @returns {boolean}
   */
  readBoolean() {
    this.#decrementRemaining();
    return readBoolean(this.#reader);
  }

  /**
   * @returns {bigint}
   */
  readInteger() {
    this.#decrementRemaining();
    return readBignum(this.#reader);
  }

  /**
   * @returns {number}
   */
  readFloat64() {
    this.#decrementRemaining();
    return readFloat64(this.#reader);
  }

  /**
   * @returns {string}
   */
  readString() {
    this.#decrementRemaining();
    return readTextString(this.#reader);
  }

  /**
   * @returns {ArrayBufferLike}
   */
  readBytestring() {
    this.#decrementRemaining();
    // Immutability conversion stays OCapN policy at the class layer.
    return bytesToImmutable(readByteString(this.#reader));
  }

  /**
   * @returns {string}
   */
  readSelectorAsString() {
    this.#decrementRemaining();
    return readSelectorAsString(this.#reader);
  }

  /**
   * Peek at the type category without consuming the value.
   * @returns {TypeHint}
   */
  peekTypeHint() {
    const { major, info } = peekTypeByte(this.#reader);

    // Check for tag first
    if (major === MAJOR_TAG) {
      const tag = peekTag(this.#reader);
      if (tag === TAG_UNSIGNED_BIGNUM || tag === TAG_NEGATIVE_BIGNUM) {
        return 'number-prefix'; // Integer encoded as bignum
      }
      if (tag === TAG_SYMBOL) {
        return 'number-prefix'; // Symbol (selector)
      }
      if (tag === TAG_RECORD) {
        return 'record';
      }
      // Other tags fall through to their content type
    }

    switch (major) {
      case MAJOR_FLOAT_SIMPLE:
        if (info === SIMPLE_TRUE || info === SIMPLE_FALSE) {
          return 'boolean';
        }
        if (info === AI_8BYTE) {
          return 'float64';
        }
        // null, undefined are also float/simple but need special handling
        return 'number-prefix'; // Will be handled by readTypeAndMaybeValue
      case MAJOR_BYTESTRING:
      case MAJOR_TEXTSTRING:
        return 'number-prefix';
      case MAJOR_ARRAY:
        return 'list';
      case MAJOR_MAP:
        return 'dictionary';
      default:
        throw new Error(
          `Unexpected CBOR major type ${major} at index ${this.#reader.index} of ${this.name}`,
        );
    }
  }

  /**
   * Read type and possibly value.
   * For structured types, returns type with null value.
   * For atomic types, reads and returns the value.
   *
   * @returns {TypeAndMaybeValue}
   */
  readTypeAndMaybeValue() {
    const start = this.#reader.index;
    const { major, info } = peekTypeByte(this.#reader);

    // Handle tags
    if (major === MAJOR_TAG) {
      const tag = peekTag(this.#reader);

      if (tag === TAG_UNSIGNED_BIGNUM || tag === TAG_NEGATIVE_BIGNUM) {
        const value = this.readInteger();
        return { type: 'integer', value };
      }

      if (tag === TAG_SYMBOL) {
        const value = this.readSelectorAsString();
        return { type: 'selector', value };
      }

      if (tag === TAG_RECORD) {
        // Don't consume the array, let enterRecord handle it; consume just the
        // tag head.
        readHead(this.#reader);
        return { type: 'record', value: null };
      }

      throw new Error(
        `Unexpected tag ${tag} at index ${start} of ${this.name}`,
      );
    }

    switch (major) {
      case MAJOR_FLOAT_SIMPLE:
        if (info === SIMPLE_TRUE) {
          readHead(this.#reader);
          return { type: 'boolean', value: true };
        }
        if (info === SIMPLE_FALSE) {
          readHead(this.#reader);
          return { type: 'boolean', value: false };
        }
        if (info === SIMPLE_NULL) {
          readHead(this.#reader);
          return { type: 'null', value: null };
        }
        if (info === SIMPLE_UNDEFINED) {
          readHead(this.#reader);
          return { type: 'undefined', value: undefined };
        }
        if (info === AI_8BYTE) {
          const value = this.readFloat64();
          return { type: 'float64', value };
        }
        throw new Error(
          `Unexpected simple value ${info} at index ${start} of ${this.name}`,
        );

      case MAJOR_BYTESTRING: {
        const value = this.readBytestring();
        return { type: 'bytestring', value };
      }

      case MAJOR_TEXTSTRING: {
        const value = this.readString();
        return { type: 'string', value };
      }

      case MAJOR_ARRAY:
        // Don't consume, let enterList handle it
        return { type: 'list', value: null };

      case MAJOR_MAP:
        // Don't consume, let enterDictionary handle it
        return { type: 'dictionary', value: null };

      default:
        throw new Error(
          `Unexpected CBOR major type ${major} at index ${start} of ${this.name}`,
        );
    }
  }

  /**
   * Enter a record structure (Tag 27 + array).
   */
  enterRecord() {
    // Entering a record counts as one element of the parent structure
    this.#decrementRemaining();

    const start = this.#reader.index;
    const { major } = peekTypeByte(this.#reader);

    // The tag might already be consumed by readTypeAndMaybeValue
    if (major === MAJOR_TAG) {
      const tag = readTag(this.#reader);
      if (tag !== Number(TAG_RECORD)) {
        throw new Error(
          `Expected record tag (27), got tag ${tag} at index ${start} of ${this.name}`,
        );
      }
    }

    // Now read the array header
    const length = readArrayHeader(this.#reader);
    this.#stack.push({ type: 'record', remaining: length, start });
  }

  exitRecord() {
    const entry = this.#stack.pop();
    if (!entry || entry.type !== 'record') {
      throw new Error(
        `Cannot exit record: not inside a record at index ${this.#reader.index} of ${this.name}`,
      );
    }
    if (entry.remaining !== 0) {
      throw new Error(
        `Record has ${entry.remaining} remaining elements at index ${this.#reader.index} of ${this.name}`,
      );
    }
  }

  peekRecordEnd() {
    const entry = this.#stack[this.#stack.length - 1];
    if (!entry || entry.type !== 'record') {
      throw new Error(
        `Cannot peek record end: not inside a record at index ${this.#reader.index} of ${this.name}`,
      );
    }
    return entry.remaining === 0;
  }

  /**
   * Read the record's label.
   * Uses raw read functions to avoid double-decrementing (since this
   * method already decrements).
   * @returns {RecordLabelInfo}
   */
  readRecordLabel() {
    this.#decrementRemaining();

    // In CBOR, record labels are typically symbols (Tag 280)
    const tag = peekTag(this.#reader);

    if (tag === TAG_SYMBOL) {
      // Use raw function to avoid double-decrement
      const value = readSelectorAsString(this.#reader);
      return { type: 'selector', value };
    }

    // Could also be a plain string
    const { major } = peekTypeByte(this.#reader);
    if (major === MAJOR_TEXTSTRING) {
      // Use raw function to avoid double-decrement
      const value = readTextString(this.#reader);
      return { type: 'string', value };
    }

    if (major === MAJOR_BYTESTRING) {
      // Use raw function to avoid double-decrement
      const value = bytesToImmutable(readByteString(this.#reader));
      return { type: 'bytestring', value };
    }

    throw new Error(
      `Expected record label (symbol, string, or bytestring) at index ${this.#reader.index} of ${this.name}`,
    );
  }

  enterList() {
    // Entering a list counts as one element of the parent structure
    this.#decrementRemaining();

    const start = this.#reader.index;
    // readArrayHeader rejects a non-array with the same "Expected array
    // (major 4), got major N at index N of NAME" diagnostic as before.
    const length = readArrayHeader(this.#reader);
    this.#stack.push({ type: 'list', remaining: length, start });
  }

  exitList() {
    const entry = this.#stack.pop();
    if (!entry || entry.type !== 'list') {
      throw new Error(
        `Cannot exit list: not inside a list at index ${this.#reader.index} of ${this.name}`,
      );
    }
    if (entry.remaining !== 0) {
      throw new Error(
        `List has ${entry.remaining} remaining elements at index ${this.#reader.index} of ${this.name}`,
      );
    }
  }

  peekListEnd() {
    const entry = this.#stack[this.#stack.length - 1];
    if (!entry || entry.type !== 'list') {
      throw new Error(
        `Cannot peek list end: not inside a list at index ${this.#reader.index} of ${this.name}`,
      );
    }
    return entry.remaining === 0;
  }

  enterDictionary() {
    // Entering a dictionary counts as one element of the parent structure
    this.#decrementRemaining();

    const start = this.#reader.index;
    // readMapHeader rejects a non-map with the same "Expected map (major 5),
    // got major N at index N of NAME" diagnostic as before.
    const length = readMapHeader(this.#reader);
    // For maps, length is number of pairs, so remaining is 2x
    this.#stack.push({ type: 'dictionary', remaining: length * 2, start });
  }

  exitDictionary() {
    const entry = this.#stack.pop();
    if (!entry || entry.type !== 'dictionary') {
      throw new Error(
        `Cannot exit dictionary: not inside a dictionary at index ${this.#reader.index} of ${this.name}`,
      );
    }
    if (entry.remaining !== 0) {
      throw new Error(
        `Dictionary has ${entry.remaining / 2} remaining pairs at index ${this.#reader.index} of ${this.name}`,
      );
    }
  }

  peekDictionaryEnd() {
    const entry = this.#stack[this.#stack.length - 1];
    if (!entry || entry.type !== 'dictionary') {
      throw new Error(
        `Cannot peek dictionary end: not inside a dictionary at index ${this.#reader.index} of ${this.name}`,
      );
    }
    return entry.remaining === 0;
  }

  enterSet() {
    // CBOR doesn't have a native set type; we could use a tagged array
    // For now, treat as array
    this.enterList();
    const entry = this.#stack[this.#stack.length - 1];
    entry.type = 'set';
  }

  exitSet() {
    const entry = this.#stack.pop();
    if (!entry || entry.type !== 'set') {
      throw new Error(
        `Cannot exit set: not inside a set at index ${this.#reader.index} of ${this.name}`,
      );
    }
    if (entry.remaining !== 0) {
      throw new Error(
        `Set has ${entry.remaining} remaining elements at index ${this.#reader.index} of ${this.name}`,
      );
    }
  }

  peekSetEnd() {
    const entry = this.#stack[this.#stack.length - 1];
    if (!entry || entry.type !== 'set') {
      throw new Error(
        `Cannot peek set end: not inside a set at index ${this.#reader.index} of ${this.name}`,
      );
    }
    return entry.remaining === 0;
  }

  /**
   * Decrement the remaining count for the current structure.
   * Called automatically when reading values.
   */
  #decrementRemaining() {
    const entry = this.#stack[this.#stack.length - 1];
    if (!entry) {
      return; // Not tracking
    }
    if (entry.remaining <= 0) {
      throw new Error(
        `No more elements in ${entry.type} at index ${this.#reader.index} of ${this.name}`,
      );
    }
    entry.remaining -= 1;
  }
}

/**
 * Create a CborReader from bytes.
 *
 * @param {Uint8Array} bytes - The CBOR bytes to read
 * @param {object} [options]
 * @param {string} [options.name] - Name for error messages
 * @returns {CborReader}
 */
export function makeCborReader(bytes, options = {}) {
  const reader = makeCborReaderState(bytes, options);
  return new CborReader(reader, options);
}

// Export tag constants for use by codec layer
export {
  TAG_UNSIGNED_BIGNUM,
  TAG_NEGATIVE_BIGNUM,
  TAG_RECORD,
  TAG_SYMBOL,
  TAG_TAGGED_VALUE,
};
