// @ts-check

import { makeExo } from '@endo/exo';
import { frozenBytes } from '@endo/immutable-arraybuffer';
import { mapReader } from '@endo/stream';

import { PassableBytesReaderInterface } from './type-guards.js';
import { makeReaderPump } from './reader-pump.js';

/** @import { Pattern } from '@endo/patterns' */
/** @import { SomehowAsyncIterable, PassableBytesReader, MakeBytesReaderOptions } from './types.js' */

/**
 * Convert a local AsyncIterator<Uint8Array> to a remote PassableBytesReader reference
 * (Responder/Producer side).
 *
 * This is the Producer for a bytes Reader: it wraps a local bytes iterator and
 * produces immutable byte arrays for the remote Initiator/Consumer.
 *
 * Mutable local chunks are copied into immutable byte arrays before they enter
 * the generic stream() protocol. The bytes-specific helpers remain the
 * canonical adapters because they own this passability boundary.
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
 * - Responder sends acknowledgements (immutable bytes) via the acknowledgement chain
 *
 * @param {SomehowAsyncIterable<Uint8Array>} bytesIterator
 * @param {MakeBytesReaderOptions} [options]
 * @returns {PassableBytesReader}
 */
export const bytesReaderFromIterator = (bytesIterator, options = {}) => {
  const { buffer = 0, readReturnPattern } = options;

  const frozenIterator = mapReader(
    // @ts-expect-error mapReader types aren't perfect with iterables
    bytesIterator,
    frozenBytes,
  );

  const pump = makeReaderPump(frozenIterator, { buffer });

  // @ts-expect-error Exo pump types use Passable where template expects specific subtype
  return makeExo('PassableBytesReader', PassableBytesReaderInterface, {
    stream: pump,

    /**
     * Returns the pattern for validating TReadReturn (return value).
     * @returns {Pattern | undefined}
     */
    readReturnPattern() {
      return readReturnPattern;
    },
  });
};
