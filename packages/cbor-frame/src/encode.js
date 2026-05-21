// @ts-check

import harden from '@endo/harden';
import { makePromiseKit } from '@endo/promise-kit';

import {
  encodeByteStringHead,
  TAG_24_PREFIX,
  MAX_SAFE_PAYLOAD_LENGTH,
} from './head.js';

/**
 * Create a writer stream which wraps messages into a CBOR byte-string
 * frame encoding and writes them to an output writer stream.
 *
 * Each frame is the CBOR tag-24 prefix (Encoded CBOR data item; major
 * type 6, argument 24) followed by the CBOR byte-string head (major
 * type 2) per RFC 8949 and then the payload bytes. The tag-24 wrapper
 * is mandatory: it makes the wire format self-describing to a generic
 * CBOR-aware analyzer at a fixed two-byte per-frame cost.
 *
 * This transform can be zero-copy, if the output stream supports
 * consecutive writes without waiting. In that case the by default off
 * `chunked` mode can be enabled.
 *
 * Accepts the message as an array of buffers in case the producer would
 * like to avoid pre-concatenating them.
 *
 * @param {import('@endo/stream').Writer<Uint8Array, undefined>} output
 * @param {object} [opts]
 * @param {boolean} [opts.chunked]
 * @param {string} [opts.name]
 * @param {number} [opts.maxMessageLength]
 * @returns {import('@endo/stream').Writer<Uint8Array | Uint8Array[], undefined>}
 */
export const makeCborFrameWriter = (
  output,
  {
    chunked = false,
    name = '<unknown>',
    maxMessageLength = MAX_SAFE_PAYLOAD_LENGTH,
  } = {},
) => {
  return harden({
    async next(messageChunks) {
      if (!Array.isArray(messageChunks)) {
        messageChunks = [messageChunks];
      }

      const messageLength = messageChunks.reduce(
        (acc, { length }) => acc + length,
        0,
      );

      if (messageLength > maxMessageLength) {
        throw Error(
          `CBOR message too big (length ${messageLength}, max ${maxMessageLength}) at ${name}`,
        );
      }

      const head = encodeByteStringHead(messageLength);

      if (chunked) {
        const ack = makePromiseKit();

        /** @type {Promise<IteratorResult<undefined, undefined>>[]} */
        const partsWritten = [];
        partsWritten.push(output.next(TAG_24_PREFIX));
        partsWritten.push(output.next(head));
        for (const chunk of messageChunks) {
          partsWritten.push(output.next(chunk));
        }

        // Resolve early if the output writer closes early. Each per-chunk
        // promise also gets a swallowing catch so that a rejection from
        // one chunk (e.g. socket FIN'd mid-stream) does not surface as
        // an unhandled rejection; the aggregate is already observed by
        // the Promise.all chain below, which routes failures into
        // ack.reject.
        for (const promise of partsWritten) {
          promise.then(
            partWritten => {
              if (partWritten.done) {
                ack.resolve(partWritten);
              }
            },
            () => {},
          );
        }

        Promise.all(partsWritten).then(results => {
          // Redundant resolution is safe and clean.
          ack.resolve({
            done: results.some(({ done }) => done),
            value: undefined,
          });
        }, ack.reject);

        return ack.promise;
      } else {
        const buffer = new Uint8Array(
          TAG_24_PREFIX.length + head.length + messageLength,
        );
        let i = 0;
        buffer.set(TAG_24_PREFIX, i);
        i += TAG_24_PREFIX.length;
        buffer.set(head, i);
        i += head.length;
        for (const chunk of messageChunks) {
          buffer.set(chunk, i);
          i += chunk.length;
        }

        return output.next(buffer);
      }
    },
    async return() {
      return output.return(undefined);
    },
    async throw(error) {
      return output.throw(error);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  });
};
harden(makeCborFrameWriter);
