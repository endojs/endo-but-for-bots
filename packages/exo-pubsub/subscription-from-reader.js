// @ts-check

import { makeExo } from '@endo/exo';
import { makeReaderPump } from '@endo/exo-stream/reader-pump.js';

import { PassableSubscriptionInterface } from './type-guards.js';

/** @import { Passable } from '@endo/pass-style' */
/** @import { Pattern } from '@endo/patterns' */
/** @import { SomehowAsyncIterable } from '@endo/exo-stream' */
/** @import { PassableSubscription, SubscriptionFromReaderOptions } from './types.js' */

/**
 * Wrap a local pubsub subscription (a Reader over a topic) as a remotable
 * `PassableSubscription` exo, passable over CapTP (responder side).
 *
 * A subscription is the consumer end of a `@endo/pubsub` topic. On the wire it
 * is an exo-stream Reader: the topic's published values travel from this
 * responder to the remote initiator along the acknowledgement chain, while the
 * synchronization chain carries flow control. This composes exo-stream's reader
 * pump under a pubsub-named exo identity so a remote peer that introspects the
 * reference sees `PassableSubscription`.
 *
 * @template {Passable} [TValue=Passable]
 * @template {Passable} [TReturn=undefined]
 * @param {SomehowAsyncIterable<TValue, undefined, TReturn>} subscription the topic's `subscribe()` Reader
 * @param {SubscriptionFromReaderOptions} [options]
 * @returns {PassableSubscription<TValue, TReturn>}
 */
export const subscriptionFromReader = (subscription, options = {}) => {
  const { buffer = 0, readPattern, readReturnPattern } = options;

  const pump = makeReaderPump(subscription, {
    buffer,
    readPattern,
    readReturnPattern,
  });

  return /** @type {PassableSubscription<TValue, TReturn>} */ (
    /** @type {unknown} */ (
      makeExo(
        'PassableSubscription',
        PassableSubscriptionInterface,
        /** @type {any} */ ({
          stream: pump,

          /**
           * Returns the pattern for validating published values.
           * @returns {Pattern | undefined}
           */
          readPattern() {
            return readPattern;
          },

          /**
           * Returns the pattern for validating the terminal value.
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
