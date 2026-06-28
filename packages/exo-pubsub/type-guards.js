// @ts-check

import { M } from '@endo/patterns';
import {
  PassableReaderInterface,
  PassableWriterInterface,
} from '@endo/exo-stream/type-guards.js';

/**
 * Interface for a passable subscription reference.
 *
 * A subscription is the consumer end of a `@endo/pubsub` topic: an async
 * iterator over the values a publisher puts to the topic. On the wire a
 * subscription is exactly an exo-stream Reader (data flows from the responder
 * that owns the topic to the initiator that subscribed), so this guard is the
 * same shape as exo-stream's `PassableReaderInterface`. It is re-exported under
 * a pubsub-aligned name so callers of this package import a single vocabulary.
 *
 * @see subscriptionFromReader - responder side
 * @see iterateSubscription - initiator side
 */
export const PassableSubscriptionInterface = PassableReaderInterface;

/**
 * Interface for a passable publisher reference.
 *
 * A publisher is the producer end of a `@endo/pubsub` topic: a writer whose
 * pushed values fan out to every subscription. On the wire a publisher is
 * exactly an exo-stream Writer (data flows from the initiator that holds the
 * publisher to the responder that owns the topic), so this guard is the same
 * shape as exo-stream's `PassableWriterInterface`.
 *
 * @see publisherFromWriter - responder side
 * @see iteratePublisher - initiator side
 */
export const PassablePublisherInterface = PassableWriterInterface;

/**
 * Interface for a passable topic reference.
 *
 * A topic is the pub/sub-specific capability exo-stream lacks: a fan-out point
 * whose `subscribe()` method mints a fresh subscription each time it is called.
 * Bridging the topic (rather than a single subscription) lets a remote consumer
 * decide *when* to subscribe and obtain *independent* cursors over the same
 * underlying linked list, preserving the lossless-deltas / lossy-latest
 * semantics of `@endo/pubsub` across a CapTP boundary.
 *
 * `subscribe()` returns a `PassableSubscription` remotable (built by
 * `subscriptionFromReader`). E.get() pipelining handles remote access.
 *
 * @see topicFromSubscribe - responder side
 * @see subscribeTopic - initiator side
 */
export const PassableTopicInterface = M.interface('PassableTopic', {
  // subscribe(): PassableSubscription
  subscribe: M.call().returns(M.remotable('PassableSubscription')),
});
