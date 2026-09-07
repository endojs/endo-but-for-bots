// @ts-check

import { makeExo } from '@endo/exo';

import { PassableReaderInterface } from './type-guards.js';
import { makeReaderPump } from './reader-pump.js';

/** @import { Passable } from '@endo/pass-style' */
/** @import { Pattern } from '@endo/patterns' */
/** @import { SomehowAsyncIterable, MakeReaderOptions, PassableReader } from './types.js' */

/**
 * Convert a local iterator to a remote PassableReader reference (Responder/Producer side).
 *
 * This creates a Reader stream where:
 * - Synchronization values are `undefined` (flow control only - "give me more").
 *   When the initiator calls `return(value)` to close early, the final
 *   synchronization node carries that argument value. If the responder is backed
 *   by a JavaScript iterator with a `return(value)` method, it forwards the
 *   argument and uses the iterator’s returned value as the terminal ack;
 *   otherwise it terminates with the original argument value.
 * - Acknowledgement values are `TRead` (actual data from the iterator)
 *
 * The Producer wraps a local iterator and produces values for the remote
 * Initiator/Consumer.
 *
 * The stream uses bidirectional promise chains for flow control:
 * - Initiator sends synchronizations via the synchronization chain
 * - Responder sends acknowledgements (data) via the acknowledgement chain
 *
 * With buffer > 0, the responder pre-pulls values and sends acknowledgements
 * before waiting for synchronization messages, allowing the initiator to receive
 * values without additional round-trips.
 *
 * @template {Passable} [TRead=Passable]
 * @template {Passable} [TReadReturn=undefined]
 * @param {SomehowAsyncIterable<TRead, undefined, TReadReturn>} iterator
 * @param {MakeReaderOptions} [options]
 * @returns {PassableReader<TRead, TReadReturn>}
 */
export const readerFromIterator = (iterator, options = {}) => {
  const { buffer = 0, readPattern, readReturnPattern, once = false } = options;

  const pump = makeReaderPump(iterator, {
    buffer,
    readPattern,
    readReturnPattern,
  });

  // A `PassableReader` backed by a single underlying iterator can, by default,
  // have `stream()` invoked more than once: each invocation drives the *same*
  // iterator, so concurrent streams silently split the element set between them
  // and each holds its own pre-ack `buffer` window. `once: true` latches the
  // reader to a single active stream — a second `stream()` rejects rather than
  // splitting — which is what a per-request producer (one reader, one intended
  // consumer) wants, and which bounds the pre-ack / post-revoke window to the
  // reader rather than to `k` concurrent streams a grantee could open.
  let streamed = false;
  const stream = once
    ? synPromise => {
        if (streamed) {
          throw new Error(
            'This PassableReader is once-only; stream() was already called',
          );
        }
        streamed = true;
        return pump(synPromise);
      }
    : pump;

  return /** @type {PassableReader<TRead, TReadReturn>} */ (
    /** @type {unknown} */ (
      makeExo(
        'PassableReader',
        PassableReaderInterface,
        /** @type {any} */ ({
          stream,

          /**
           * Returns the pattern for validating TRead (yielded values).
           * @returns {Pattern | undefined}
           */
          readPattern() {
            return readPattern;
          },

          /**
           * Returns the pattern for validating TReadReturn (return value).
           * @returns {Pattern | undefined}
           */
          readReturnPattern() {
            return readReturnPattern;
          },
        }),
      )
    )
  );
};
