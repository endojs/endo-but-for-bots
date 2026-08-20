// @ts-check

/**
 * Direction-neutral byte framing for the HTTP client.
 *
 * A body that crosses CapTP has to arrive in bounded pieces rather than as one
 * value: the same fixed-size framing that lets a response body be hauled
 * incrementally lets a request body be produced incrementally. The framing
 * carries no policy — the byte caps live with the confinement that enforces
 * them — so the only thing this module decides is how large a piece is.
 */

import harden from '@endo/harden';
import { makeError, X } from '@endo/errors';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { getInterfaceOf } from '@endo/pass-style';

/**
 * Frame size for either direction. The value trades per-frame overhead against
 * memory residency and is not security-relevant: the response byte cap and the
 * request byte cap are enforced by the confinement, not by the frame size.
 */
export const FRAME_BYTES = 16 * 1024;
harden(FRAME_BYTES);

/**
 * Interface names an `@endo/exo-stream` bytes reader presents, with or without
 * the `Alleged: ` prefix a marshalled remotable may carry.
 */
const BYTES_READER_INTERFACE = /(^|: )Passable(Bytes)?Reader$/;

/**
 * Yield `bytes` in fixed-size frames. A fresh generator per call keeps each
 * consumer independent of every other consumer of the same buffer.
 *
 * @param {Uint8Array} bytes
 * @param {number} [frameBytes]
 * @returns {AsyncGenerator<Uint8Array, void, undefined>}
 */
export const generateByteFrames = async function* generateByteFrames(
  bytes,
  frameBytes = FRAME_BYTES,
) {
  await null;
  for (let offset = 0; offset < bytes.length; offset += frameBytes) {
    yield bytes.slice(offset, offset + frameBytes);
  }
};
harden(generateByteFrames);

/**
 * Wrap a byte buffer as a passable bytes reader that hauls it in frames.
 *
 * @param {Uint8Array} bytes
 * @param {number} [frameBytes]
 */
export const makeFramedBytesReader = (bytes, frameBytes = FRAME_BYTES) =>
  bytesReaderFromIterator(generateByteFrames(bytes, frameBytes));
harden(makeFramedBytesReader);

/**
 * Recognize the shapes a caller may hand us as a streaming body.
 *
 * The discriminator is the pass-style interface name, not a probe for a
 * method: a CapTP presence for a remote reader answers no synchronous method,
 * so duck-typing would classify every remote reader as "not a reader" and
 * silently send an empty body. A local async iterable is accepted too, for
 * in-process callers that never cross a CapTP boundary.
 *
 * A string or a `Uint8Array` is deliberately *not* streaming — it is already
 * resident in memory, and re-framing it would only add copies.
 *
 * @param {unknown} value
 * @returns {'reader' | 'async-iterable' | 'none'}
 */
export const classifyStreamingBody = value => {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer
  ) {
    return 'none';
  }
  if (typeof value !== 'object' && typeof value !== 'function') {
    return 'none';
  }
  const iface = getInterfaceOf(/** @type {any} */ (value));
  if (typeof iface === 'string' && BYTES_READER_INTERFACE.test(iface)) {
    return 'reader';
  }
  if (
    typeof (/** @type {Record<PropertyKey, unknown>} */ (value)[
      Symbol.asyncIterator
    ]) === 'function'
  ) {
    return 'async-iterable';
  }
  return 'none';
};
harden(classifyStreamingBody);

/**
 * Turn any recognized streaming body into an async iterable of byte chunks.
 * Throws for a value `classifyStreamingBody` does not recognize, so a caller
 * that meant to stream never silently sends an empty body.
 *
 * @param {unknown} body
 * @returns {AsyncIterable<Uint8Array>}
 */
export const iterateStreamingBody = body => {
  const kind = classifyStreamingBody(body);
  if (kind === 'reader') {
    return iterateBytesReader(
      /** @type {import('@endo/exo-stream').PassableBytesReader} */ (
        body
      ),
    );
  }
  if (kind === 'async-iterable') {
    return /** @type {AsyncIterable<Uint8Array>} */ (body);
  }
  throw makeError(X`Request body is not a bytes reader or an async iterable`);
};
harden(iterateStreamingBody);
