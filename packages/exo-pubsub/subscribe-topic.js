// @ts-check

import { E } from '@endo/far';

import { iterateSubscription } from './iterate-subscription.js';

/** @import { Passable } from '@endo/pass-style' */
/** @import { ERef } from '@endo/far' */
/** @import { PassableTopic, SubscribeTopicOptions, RemoteTopicSubscriber } from './types.js' */

/**
 * Convert a remote `PassableTopic` reference to a local subscriber (initiator
 * side).
 *
 * The dual of `topicFromSubscribe`. Returns the read half of a local
 * `@endo/pubsub`-shaped topic (`{ subscribe }`): each `subscribe()` call sends
 * `subscribe()` to the remote topic and wraps the returned `PassableSubscription`
 * as a local async iterator via `iterateSubscription`. Independent calls yield
 * independent cursors, preserving the topic's fan-out semantics across CapTP.
 *
 * @template {Passable} [TValue=Passable]
 * @template {Passable} [TReturn=undefined]
 * @param {ERef<PassableTopic<TValue, TReturn>>} topicRef
 * @param {SubscribeTopicOptions<TValue, TReturn>} [options] applied to every subscription
 * @returns {RemoteTopicSubscriber<TValue, TReturn>}
 */
export const subscribeTopic = (topicRef, options = {}) => {
  return harden({
    /**
     * Subscribe to the remote topic, returning a local async iterator over a
     * fresh remote subscription.
     */
    subscribe() {
      return iterateSubscription(E(topicRef).subscribe(), options);
    },
  });
};
