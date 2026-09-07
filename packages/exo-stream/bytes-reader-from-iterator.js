// @ts-check

import { makeExo } from '@endo/exo';
import { encodeBase64 } from '@endo/base64';

import { asyncIterate } from './async-iterate.js';
import { PassableBytesReaderInterface } from './type-guards.js';
import { makeReaderPump } from './reader-pump.js';

/** @import { Passable } from '@endo/pass-style' */
/** @import { Pattern } from '@endo/patterns' */
/** @import { SomehowAsyncIterable, PassableBytesReader, MakeBytesReaderOptions } from './types.js' */

/**
 * Convert a local AsyncIterator<Uint8Array> to a remote PassableBytesReader reference
 * (Responder/Producer side).
 *
 * This is the Producer for a bytes Reader: it wraps a local bytes iterator and
 * produces base64-encoded values for the remote Initiator/Consumer.
 *
 * Bytes are automatically base64-encoded for transmission over CapTP.
 * Uses streamBase64() method instead of stream() to allow future migration
 * to direct bytes transport when CapTP supports it. At that time, bytes-streamable
 * Exos can implement stream() directly, and initiators can gracefully transition
 * to using iterateReader() instead of iterateBytesReader().
 *
 * The interface implies Uint8Array yields (no readPattern method).
 * Only readReturnPattern can be customized.
 *
 * The reader uses bidirectional promise chains for flow control:
 * - Initiator sends synchronizations via the synchronization chain to induce
 *   production. When the initiator calls `return(value)` to close early, the
 *   final syn node carries that argument value. If the responder is backed by a
 *   JavaScript iterator with a `return(value)` method, it forwards the argument
 *   and uses the iterator’s returned value as the terminal ack; otherwise it
 *   terminates with the original argument value.
 * - Responder sends acknowledgements (base64 strings) via the acknowledgement chain
 *
 * @param {SomehowAsyncIterable<Uint8Array>} bytesIterator
 * @param {MakeBytesReaderOptions} [options]
 * @returns {PassableBytesReader}
 */
export const bytesReaderFromIterator = (bytesIterator, options = {}) => {
  const { buffer = 0, readReturnPattern, cancelPending } = options;

  // Forward cleanup explicitly. A generator-based map closes itself when a
  // cancelled pull completes or rejects, so a subsequent return() would never
  // reach the byte source.
  const iterator = asyncIterate(bytesIterator);
  /**
   * @param {IteratorResult<Uint8Array, Passable>} result
   * @returns {IteratorResult<string, Passable>}
   */
  const encodeResult = result =>
    result.done
      ? result
      : harden({ done: false, value: encodeBase64(result.value) });
  const base64Iterator = harden({
    async next() {
      const result = await iterator.next();
      return encodeResult(result);
    },
    /** @param {undefined} [value] */
    async return(value) {
      await null;
      if (iterator.return) return encodeResult(await iterator.return(value));
      return harden({ done: /** @type {const} */ (true), value });
    },
  });

  const pump = makeReaderPump(base64Iterator, { buffer, cancelPending });

  // @ts-expect-error Exo pump types use Passable where template expects specific subtype
  return makeExo('PassableBytesReader', PassableBytesReaderInterface, {
    streamBase64: pump,

    /**
     * Returns the pattern for validating TReadReturn (return value).
     * @returns {Pattern | undefined}
     */
    readReturnPattern() {
      return readReturnPattern;
    },
  });
};
