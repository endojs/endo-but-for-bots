// @ts-check

import { iterateWriter } from '@endo/exo-stream/iterate-writer.js';

/** @import { Passable } from '@endo/pass-style' */
/** @import { ERef } from '@endo/far' */
/** @import { PassablePublisher, IteratePublisherOptions, WriterIterator } from './types.js' */

/**
 * Convert a remote `PassablePublisher` reference to a local async writer
 * iterator (initiator side).
 *
 * The dual of `publisherFromWriter`. The returned iterator's `next(value)`
 * publishes `value` to the remote topic over CapTP; `return()` / `throw()`
 * terminate it. A publisher is wire-identical to an exo-stream Writer, so this
 * composes `iterateWriter` under the pubsub vocabulary.
 *
 * @template {Passable} [TValue=Passable]
 * @template {Passable} [TReturn=undefined]
 * @param {ERef<PassablePublisher<TValue, TReturn>>} publisherRef
 * @param {IteratePublisherOptions<TValue, TReturn>} [options]
 * @returns {WriterIterator<TValue, TReturn>}
 */
export const iteratePublisher = (publisherRef, options = {}) =>
  iterateWriter(publisherRef, options);
