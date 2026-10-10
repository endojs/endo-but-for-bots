// @ts-check

import { makeExo } from '@endo/exo';
import { encodeBase64 } from '@endo/base64';
import { frozenBytes } from '@endo/immutable-arraybuffer';

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
 * produces its chunks for the remote Initiator/Consumer in either of two forms:
 *
 * - `stream()` yields each chunk as a passable byte array (a frozen
 *   `Uint8Array` over an immutable `ArrayBuffer`). Initiators consume it with
 *   `iterateReader()`.
 * - `streamBase64()` yields each chunk as a base64 string, for initiators that
 *   still use `iterateBytesReader()`. It is retained for compatibility and is
 *   slated for deprecation.
 *
 * Both methods draw from the same underlying iterator, so a reader is
 * consumed once, through whichever method an initiator calls.
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
 * - Responder sends acknowledgements (byte arrays, or base64 strings through
 *   `streamBase64()`) via the acknowledgement chain
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
   * Adapt the shared byte iterator, transforming each yielded chunk.
   *
   * @template T
   * @param {(bytes: Uint8Array) => T} encode
   */
  const makeEncodedIterator = encode => {
    /**
     * @param {IteratorResult<Uint8Array, Passable>} result
     * @returns {IteratorResult<T, Passable>}
     */
    const encodeResult = result =>
      result.done
        ? result
        : harden({ done: false, value: encode(result.value) });
    return harden({
      async next() {
        const result = await iterator.next();
        return encodeResult(result);
      },
      /** @param {undefined} [value] */
      async return(value) {
        await null;
        if (iterator.return) {
          return encodeResult(await iterator.return(value));
        }
        return harden({ done: /** @type {const} */ (true), value });
      },
    });
  };

  const pumpOptions = { buffer, cancelPending };
  const pump = makeReaderPump(makeEncodedIterator(frozenBytes), pumpOptions);
  const pumpBase64 = makeReaderPump(
    makeEncodedIterator(encodeBase64),
    pumpOptions,
  );

  // @ts-expect-error Exo pump types use Passable where template expects specific subtype
  return makeExo('PassableBytesReader', PassableBytesReaderInterface, {
    stream: pump,
    streamBase64: pumpBase64,

    /**
     * Returns the pattern for validating TReadReturn (return value).
     * @returns {Pattern | undefined}
     */
    readReturnPattern() {
      return readReturnPattern;
    },
  });
};
