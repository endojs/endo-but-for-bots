// @ts-check

import harden from '@endo/harden';

import { decodeByteStringHead, MAX_SAFE_PAYLOAD_LENGTH } from './head.js';

/**
 * Concatenate a list of byte chunks into a single Uint8Array.
 *
 * @param {Uint8Array[]} chunks
 * @param {number} total
 * @returns {Uint8Array}
 */
const concat = (chunks, total) => {
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
};

/**
 * @param {Iterable<Uint8Array> | AsyncIterable<Uint8Array>} input
 * @param {object} opts
 * @param {string} [opts.name]
 * @param {number} [opts.maxMessageLength]
 */
async function* makeCborFrameIterator(
  input,
  { name = '<unknown>', maxMessageLength = MAX_SAFE_PAYLOAD_LENGTH } = {},
) {
  // Byte offset of data consumed so far in the input stream.
  let offset = 0;
  // The byte offset of the start of the frame currently being assembled.
  let frameStart = 0;

  // Carry buffer for bytes received but not yet consumed by a frame.
  // We hold pending chunks as a list and concatenate lazily, so single-chunk
  // frames never pay the copy cost.
  /** @type {Uint8Array[]} */
  let pending = [];
  let pendingLength = 0;

  /**
   * Materialize the pending list into a single contiguous view.
   * Returns the empty array view when nothing is pending.
   *
   * @returns {Uint8Array}
   */
  const materialize = () => {
    if (pendingLength === 0) {
      return new Uint8Array(0);
    }
    if (pending.length === 1) {
      return pending[0];
    }
    return concat(pending, pendingLength);
  };

  for await (const chunk of input) {
    if (chunk.length !== 0) {
      pending.push(chunk);
      pendingLength += chunk.length;
    }

    // Drain as many complete frames as the pending buffer can yield.
    let progressed = true;
    while (progressed) {
      progressed = false;
      if (pendingLength === 0) {
        break;
      }
      let view = materialize();
      let decoded;
      try {
        decoded = decodeByteStringHead(view);
      } catch (e) {
        throw Error(
          `${/** @type {Error} */ (e).message} at offset ${frameStart} of ${name}`,
        );
      }
      if (decoded === undefined) {
        // Head not yet complete; wait for more input.
        break;
      }
      if (decoded.length > maxMessageLength) {
        throw Error(
          `CBOR message too big (length ${decoded.length}, max ${maxMessageLength}) at offset ${frameStart} of ${name}`,
        );
      }
      const frameLength = decoded.headLength + decoded.length;
      if (pendingLength < frameLength) {
        // Payload not yet complete; wait for more input.
        break;
      }
      // Re-materialize if the chunk we sampled was not the only chunk.
      if (pending.length !== 1) {
        view = materialize();
        pending = [view];
      }
      const payload = view.subarray(
        decoded.headLength,
        decoded.headLength + decoded.length,
      );
      // Replace the carry with the suffix of the current view.
      const suffix = view.subarray(frameLength);
      if (suffix.length === 0) {
        pending = [];
        pendingLength = 0;
      } else {
        pending = [suffix];
        pendingLength = suffix.length;
      }
      offset += frameLength;
      frameStart = offset;
      yield payload;
      progressed = true;
    }
  }

  if (pendingLength !== 0) {
    throw Error(
      `Unexpected dangling message at offset ${frameStart} of ${name}`,
    );
  }

  return undefined;
}
harden(makeCborFrameIterator);

/**
 * Create a reader that consumes a stream of byte chunks and yields one
 * `Uint8Array` per CBOR-framed payload it sees.
 *
 * @param {Iterable<Uint8Array> | AsyncIterable<Uint8Array>} input
 * @param {object} [opts]
 * @param {string} [opts.name]
 * @param {number} [opts.maxMessageLength]
 * @returns {import('@endo/stream').Reader<Uint8Array, undefined>}
 */
export const makeCborFrameReader = (input, opts) => {
  return harden(makeCborFrameIterator(input, opts));
};
harden(makeCborFrameReader);
