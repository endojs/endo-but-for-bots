// @ts-check

import { makeExo } from '@endo/exo';

import { PassableTopicInterface } from './type-guards.js';
import { subscriptionFromReader } from './subscription-from-reader.js';

/** @import { Passable } from '@endo/pass-style' */
/** @import { Reader } from '@endo/stream' */
/** @import { PassableTopic, PassableSubscription, TopicFromSubscribeOptions } from './types.js' */

/**
 * Wrap a local `@endo/pubsub` topic's `subscribe` capability as a remotable
 * `PassableTopic` exo, passable over CapTP (responder side).
 *
 * This is the pub/sub-specific bridge that exo-stream lacks. exo-stream bridges
 * *one* stream; this bridges the *topic*, so a remote consumer holds a fan-out
 * point and decides when to subscribe, obtaining an independent cursor each
 * time. The lossless-deltas (`makeChangeTopic`) or lossy-latest
 * (`makeLatestTopic`) semantics of the underlying topic are preserved: each
 * remote `subscribe()` invokes the local `subscribe()`, whose returned Reader is
 * wrapped as a fresh `PassableSubscription`.
 *
 * Pass `topic.subscribe` (the subscribe half of a `@endo/pubsub` topic), not
 * the whole `{ publisher, subscribe }` pair: a topic vended to subscribers
 * exposes only the read side; the publisher stays with the owner (bridge it
 * separately with `publisherFromWriter` if a remote producer is intended).
 *
 * @template {Passable} [TValue=Passable]
 * @template {Passable} [TReturn=undefined]
 * @param {() => Reader<TValue, TReturn>} subscribe the topic's `subscribe`
 * @param {TopicFromSubscribeOptions} [options] applied to every minted subscription
 * @returns {PassableTopic<TValue, TReturn>}
 */
export const topicFromSubscribe = (subscribe, options = {}) => {
  return /** @type {PassableTopic<TValue, TReturn>} */ (
    /** @type {unknown} */ (
      makeExo('PassableTopic', PassableTopicInterface, {
        /**
         * Mint a fresh subscription over the underlying topic.
         * @returns {PassableSubscription<TValue, TReturn>}
         */
        subscribe() {
          return subscriptionFromReader(subscribe(), options);
        },
      })
    )
  );
};
