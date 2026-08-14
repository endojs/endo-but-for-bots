// @ts-check
/* eslint-disable no-bitwise */

import { concatBytes } from '@endo/bytes/concat.js';
import {
  makeCborWriter,
  cborWriterBytes,
  writeArrayHeader,
  writeInt,
  writeByteString,
  writeTextString,
  makeCborReader,
  readArrayHeader,
  readInt,
  readByteString,
  readTextString,
} from '@endo/cbor';

/**
 * The engo envelope protocol over shared canonical CBOR primitives.
 *
 * Envelopes are 4-element CBOR arrays: [handle, verb, payload, nonce].
 * Frames are CBOR byte strings wrapping encoded envelopes.
 *
 * The single-item CBOR grammar (heads, integers, byte strings, text strings,
 * array headers) is the shared canonical subset provided by `@endo/cbor`
 * (design: designs/cbor-codec.md, migration phase 4). What stays here is the
 * envelope framing and the `[handle, verb, payload, nonce]` protocol shape.
 *
 * Number domain: `@endo/cbor`'s `writeInt` / `readInt` work in the full
 * uint64/int64 range a CBOR head can carry, so they take and return `bigint`.
 * The envelope's `handle` and `nonce` cross that boundary; they stay `number`
 * in this module's public API — every consumer (session maps keyed by handle,
 * `nonce > 0` comparisons across the bus riders) uses them as numbers — and are
 * converted to and from bigint only at the head, right at the codec edge.
 *
 * Byte-format note: this is a pure refactor. Writers stay canonical (identical
 * bytes to the previous hand-rolled encoder). `@endo/cbor`'s readers are strict:
 * they reject non-minimal heads that the previous tolerant reader accepted. The
 * Rust peer (rust/endo/xsnap/src/envelope.rs) writes minimal heads, so no live
 * traffic exercises that tightening; it only rejects malformed input the design
 * requires rejecting.
 */

// ---------------------------------------------------------------------------
// CBOR encoding
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Envelope
 * @property {number} handle
 * @property {string} verb
 * @property {Uint8Array} payload
 * @property {number} nonce
 */

/**
 * Encode an envelope as a CBOR 4-element array.
 * @param {Envelope} env
 * @returns {Uint8Array}
 */
export const encodeEnvelope = env => {
  const writer = makeCborWriter();
  writeArrayHeader(writer, 4);
  writeInt(writer, BigInt(env.handle));
  writeTextString(writer, env.verb);
  writeByteString(writer, env.payload || new Uint8Array(0));
  writeInt(writer, BigInt(env.nonce || 0));
  return cborWriterBytes(writer);
};
harden(encodeEnvelope);

/**
 * Encode a CBOR frame: a byte string wrapping the given data.
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
export const encodeFrame = data => {
  const writer = makeCborWriter();
  writeByteString(writer, data);
  return cborWriterBytes(writer);
};
harden(encodeFrame);

// ---------------------------------------------------------------------------
// CBOR decoding
// ---------------------------------------------------------------------------

/**
 * Decode a CBOR frame (byte string) from raw bytes.
 * @param {Uint8Array} frameData
 * @returns {Uint8Array} - the inner content
 */
export const decodeFrame = frameData => {
  const reader = makeCborReader(frameData, { name: 'frame' });
  return readByteString(reader);
};
harden(decodeFrame);

/**
 * Decode an envelope from a CBOR 4-element array.
 * @param {Uint8Array} data
 * @returns {Envelope}
 */
export const decodeEnvelope = data => {
  const reader = makeCborReader(data, { name: 'envelope' });
  const n = readArrayHeader(reader);
  if (n !== 3 && n !== 4) {
    throw new Error(`Envelope: expected 3 or 4 elements, got ${n}`);
  }
  const handle = Number(readInt(reader));
  const verb = readTextString(reader);
  const payload = readByteString(reader);
  const nonce = n === 4 ? Number(readInt(reader)) : 0;
  // Do not harden the envelope: the payload field is a Uint8Array
  // whose indexed elements are non-configurable in XS, so
  // Object.freeze (harden) fails.
  return { handle, verb, payload, nonce };
};
harden(decodeEnvelope);

// ---------------------------------------------------------------------------
// Streaming: read CBOR frames from a Node.js readable stream
// ---------------------------------------------------------------------------

/**
 * Read exactly `n` bytes from a Node.js readable stream.
 * @param {import('stream').Readable} stream
 * @param {number} n
 * @returns {Promise<Uint8Array | null>}
 */
const readExactly = (stream, n) => {
  return new Promise((resolve, reject) => {
    // Node.js Buffer instances are Uint8Array subclasses, so they are
    // valid inputs to concatBytes from @endo/bytes.
    const chunks = /** @type {Uint8Array[]} */ ([]);
    let remaining = n;

    const onReadable = () => {
      while (remaining > 0) {
        const chunk = stream.read(Math.min(remaining, stream.readableLength));
        if (chunk === null) {
          return; // Wait for more data
        }
        chunks.push(chunk);
        remaining -= chunk.length;
      }
      cleanup();
      resolve(concatBytes(chunks));
    };

    const onEnd = () => {
      cleanup();
      if (remaining === n) {
        resolve(null); // Clean EOF
      } else {
        reject(new Error('CBOR: unexpected EOF in frame'));
      }
    };

    const onError = (/** @type {Error} */ err) => {
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      stream.removeListener('readable', onReadable);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
    };

    stream.on('readable', onReadable);
    stream.on('end', onEnd);
    stream.on('error', onError);

    // Try reading immediately in case data is already buffered.
    onReadable();
  });
};

// CBOR major type for a byte string (major 2), the frame's outer shape. The
// streaming reader parses the frame's byte-string head one chunk at a time
// against the incremental stream rather than a whole-buffer `@endo/cbor`
// reader, so this one constant stays local to the framing layer.
const CBOR_BYTES = 2;

/**
 * Read one CBOR byte-string frame from a Node.js readable stream.
 * Returns the inner content bytes, or null on EOF.
 * @param {import('stream').Readable} stream
 * @returns {Promise<Uint8Array | null>}
 */
export const readFrameFromStream = async stream => {
  // Read the CBOR byte-string header.
  const firstByte = await readExactly(stream, 1);
  if (firstByte === null) return null;

  const major = firstByte[0] >> 5;
  if (major !== CBOR_BYTES) {
    throw new Error(
      `CBOR frame: expected byte string (major 2), got major ${major}`,
    );
  }
  const info = firstByte[0] & 0x1f;

  let length;
  if (info < 24) {
    length = info;
  } else if (info === 24) {
    const b = await readExactly(stream, 1);
    if (b === null) throw new Error('CBOR: unexpected EOF in frame header');
    length = b[0];
  } else if (info === 25) {
    const b = await readExactly(stream, 2);
    if (b === null) throw new Error('CBOR: unexpected EOF in frame header');
    length = (b[0] << 8) | b[1];
  } else if (info === 26) {
    const b = await readExactly(stream, 4);
    if (b === null) throw new Error('CBOR: unexpected EOF in frame header');
    length = (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3];
  } else {
    throw new Error(`CBOR frame: unsupported length info ${info}`);
  }

  if (length === 0) return new Uint8Array(0);

  const content = await readExactly(stream, length);
  if (content === null) {
    throw new Error('CBOR: unexpected EOF in frame content');
  }
  return content;
};
harden(readFrameFromStream);

/**
 * Write a CBOR byte-string frame to a Node.js writable stream.
 * @param {import('stream').Writable} stream
 * @param {Uint8Array} data
 * @returns {Promise<void>}
 */
export const writeFrameToStream = (stream, data) => {
  const frame = encodeFrame(data);
  return new Promise((resolve, reject) => {
    stream.write(frame, err => {
      if (err) reject(err);
      else resolve(undefined);
    });
  });
};
harden(writeFrameToStream);
