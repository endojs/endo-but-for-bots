// @ts-check

import harden from '@endo/harden';
import { concatBytes } from '@endo/bytes/concat.js';

import { decodeByteStringHead, MAX_SAFE_PAYLOAD_LENGTH } from './head.js';

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
  // The decoded head of the frame currently being assembled, cached across
  // chunk arrivals. Holding it here means an incomplete payload never
  // re-decodes (or re-copies) the carry just to re-read a head that cannot
  // have changed; reset to undefined after each completed frame.
  /** @type {import('./head.js').HeadDecode | undefined} */
  let head;

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
      if (head === undefined) {
        // Probe for a head. A head is at most 11 bytes (2 tag-24 + 1 initial +
        // 8 follow), and after every completed frame the carry is collapsed to
        // a single chunk, so this either takes the single-chunk no-copy path or
        // copies only the few bytes of a head that straddles a chunk boundary.
        const probe = pending.length === 1 ? pending[0] : concatBytes(pending);
        try {
          head = decodeByteStringHead(probe);
        } catch (e) {
          throw Error(
            `${/** @type {Error} */ (e).message} at offset ${frameStart} of ${name}`,
            { cause: e },
          );
        }
        if (head === undefined) {
          // Head not yet complete; wait for more input.
          break;
        }
        if (head.length > maxMessageLength) {
          throw Error(
            `CBOR message too big (length ${head.length}, max ${maxMessageLength}) at offset ${frameStart} of ${name}`,
          );
        }
      }
      const frameLength = head.headLength + head.length;
      if (pendingLength < frameLength) {
        // Payload not yet complete; wait for more input. No copy: the head is
        // cached, so nothing re-materializes while the payload accumulates.
        break;
      }
      // The frame is complete; materialize the carry exactly once.
      if (pending.length !== 1) {
        pending = [concatBytes(pending)];
      }
      const view = pending[0];
      const payload = view.subarray(head.headLength, frameLength);
      // Replace the carry with the suffix following the current frame.
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
      head = undefined;
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
