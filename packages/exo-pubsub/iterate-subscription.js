// @ts-check

import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

/** @import { Passable } from '@endo/pass-style' */
/** @import { ERef } from '@endo/far' */
/** @import { PassableSubscription, IterateSubscriptionOptions, ReaderIterator } from './types.js' */

/**
 * Convert a remote `PassableSubscription` reference to a local async iterator
 * (initiator side).
 *
 * The dual of `subscriptionFromReader`. The returned iterator drives the remote
 * subscription's reader protocol over CapTP, yielding each value the publisher
 * put to the topic after this subscription's cursor began. Closing the iterator
 * early (`return()`) releases the remote subscription.
 *
 * A subscription is wire-identical to an exo-stream Reader, so this composes
 * `iterateReader`; it is named for the pubsub vocabulary so callers import a
 * single surface.
 *
 * @template {Passable} [TValue=Passable]
 * @template {Passable} [TReturn=undefined]
 * @param {ERef<PassableSubscription<TValue, TReturn>>} subscriptionRef
 * @param {IterateSubscriptionOptions<TValue, TReturn>} [options]
 * @returns {ReaderIterator<TValue, TReturn>}
 */
export const iterateSubscription = (subscriptionRef, options = {}) =>
  iterateReader(subscriptionRef, options);
