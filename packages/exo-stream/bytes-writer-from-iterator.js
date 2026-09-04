// @ts-check

import { makeExo } from '@endo/exo';
import { thawedBytes } from '@endo/immutable-arraybuffer';
import { M } from '@endo/patterns';

import { PassableBytesWriterInterface } from './type-guards.js';
import { makeWriterPump } from './writer-pump.js';
import { asyncIterate } from './async-iterate.js';

/** @import { Passable } from '@endo/pass-style' */
/** @import { Pattern } from '@endo/patterns' */
/** @import { SomehowAsyncIterable, PassableBytesWriter, MakeBytesWriterOptions } from './types.js' */

/**
 * Convert a local sink AsyncIterator to a remote PassableBytesWriter reference
 * (Responder/Consumer side).
 *
 * This is the Consumer for a bytes Writer: it wraps a local sink iterator and
 * receives immutable byte arrays from the remote Initiator/Producer and copies
 * them into mutable Uint8Arrays before pushing to the local iterator.
 *
 * Uses the generic stream() protocol. The bytes-specific helpers remain the
 * canonical adapters because they own the passability boundary.
 *
 * The interface implies Uint8Array writes (no writePattern method).
 * Only writeReturnPattern can be customized.
 *
 * The writer uses bidirectional promise chains for flow control:
 * - Initiator sends synchronizations (immutable bytes) via the synchronization chain.
 *   When the initiator calls `return(value)` to close early, the final syn node
 *   carries that argument value. If the responder is backed by a JavaScript
 *   iterator with a `return(value)` method, it forwards the argument and uses the
 *   iterator’s returned value as the terminal ack; otherwise it terminates with
 *   the original argument value.
 * - Responder sends acknowledgements via the acknowledgement chain to induce production
 *
 * @template {Passable} [TWriteReturn=undefined]
 * @param {SomehowAsyncIterable<unknown, Uint8Array, TWriteReturn>} iterator
 * @param {MakeBytesWriterOptions<TWriteReturn>} [options]
 * @returns {PassableBytesWriter<TWriteReturn>}
 */
export const bytesWriterFromIterator = (iterator, options = {}) => {
  const { buffer = 0, writeReturnPattern, byteLengthLimit } = options;

  // Copy passable immutable bytes into mutable local chunks before forwarding.
  const sinkIterator = asyncIterate(iterator);
  const thawingIterator = {
    /** @param {Uint8Array} bytes */
    async next(bytes) {
      return sinkIterator.next(thawedBytes(bytes));
    },
    /** @param {TWriteReturn} [value] */
    async return(value) {
      if (sinkIterator.return) {
        return sinkIterator.return(value);
      }
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };

  // Validate every syn value against the byte-array pattern before it reaches
  // `thawedBytes`. Without this the responder trusts the remote initiator: a
  // peer sending a stale base64 string (or any non-bytes producer) would flow
  // through `thawedBytes`, which silently coerces a non-Uint8Array to
  // `Uint8Array(0)` — a truncated write that acks as success. This mirrors the
  // reader direction, which already guards with `M.byteArray()`.
  //
  // The check is on the *kind* (a base64 string is not a `byteArray` and is
  // rejected regardless of size). A caller may bound the per-frame size with
  // `byteLengthLimit` (symmetric with `iterateBytesReader`); when omitted the
  // limit is effectively unbounded, preserving the prior no-`writePattern`
  // behaviour so a legitimate large frame (e.g. a 256 KiB file write) is not
  // newly rejected by the default 100 KB `M.byteArray()` cap.
  const writePattern = M.byteArray({
    byteLengthLimit:
      byteLengthLimit === undefined ? Number.MAX_SAFE_INTEGER : byteLengthLimit,
  });
  const pump = makeWriterPump(thawingIterator, {
    buffer,
    writePattern,
  });

  return /** @type {PassableBytesWriter<TWriteReturn>} */ (
    /** @type {unknown} */ (
      makeExo(
        'PassableBytesWriter',
        PassableBytesWriterInterface,
        /** @type {any} */ ({
          stream: pump,

          /**
           * Returns the pattern for validating TWriteReturn (return value).
           * @returns {Pattern | undefined}
           */
          writeReturnPattern() {
            return writeReturnPattern;
          },
        }),
      )
    )
  );
};
