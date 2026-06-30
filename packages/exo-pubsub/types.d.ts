import type { Passable } from '@endo/pass-style';
import type { Reader, Writer } from '@endo/stream';
import type {
  PassableReader,
  PassableWriter,
  ReaderIterator,
  WriterIterator,
  IterateReaderOptions,
  IterateWriterOptions,
  MakeReaderOptions,
  MakeWriterOptions,
} from '@endo/exo-stream';

/**
 * A passable subscription reference.
 *
 * The consumer end of a `@endo/pubsub` topic, on the wire. Identical to an
 * exo-stream `PassableReader`: a subscription is a Reader whose acknowledgement
 * chain carries the published values.
 */
export type PassableSubscription<
  TValue extends Passable = Passable,
  TReturn extends Passable = Passable,
> = PassableReader<TValue, TReturn>;

/**
 * A passable publisher reference.
 *
 * The producer end of a `@endo/pubsub` topic, on the wire. Identical to an
 * exo-stream `PassableWriter`: a publisher is a Writer whose synchronization
 * chain carries the values to publish.
 */
export type PassablePublisher<
  TValue extends Passable = Passable,
  TReturn extends Passable = Passable,
> = PassableWriter<TValue, TReturn>;

/**
 * A passable topic reference.
 *
 * The fan-out capability of a `@endo/pubsub` topic, on the wire. Each call to
 * `subscribe()` mints an independent `PassableSubscription` over the same
 * underlying list.
 */
export interface PassableTopic<
  TValue extends Passable = Passable,
  TReturn extends Passable = Passable,
> {
  subscribe(): PassableSubscription<TValue, TReturn>;
}

/**
 * The local view of a remote topic returned by `subscribeTopic`.
 *
 * Mirrors the `subscribe` half of a `@endo/pubsub` topic
 * (`{ publisher, subscribe }`): calling `subscribe()` returns a local Reader
 * over a fresh remote subscription.
 */
export interface RemoteTopicSubscriber<
  TValue extends Passable = Passable,
  TReturn extends Passable = Passable,
> {
  subscribe(): ReaderIterator<TValue, TReturn>;
}

/** Options for `subscriptionFromReader`. */
export type SubscriptionFromReaderOptions<
  TValue extends Passable = Passable,
  TReturn extends Passable = undefined,
> = MakeReaderOptions<TValue, TReturn>;

/** Options for `iterateSubscription`. */
export type IterateSubscriptionOptions<
  TValue extends Passable = Passable,
  TReturn extends Passable = undefined,
> = IterateReaderOptions<TValue, TReturn>;

/** Options for `publisherFromWriter`. */
export type PublisherFromWriterOptions<
  TValue extends Passable = Passable,
  TReturn extends Passable = undefined,
> = MakeWriterOptions<TValue, TReturn>;

/** Options for `iteratePublisher`. */
export type IteratePublisherOptions<
  TValue extends Passable = Passable,
  TReturn extends Passable = undefined,
> = IterateWriterOptions<TValue, TReturn>;

/**
 * Options for `topicFromSubscribe`. The `buffer` and pattern options are
 * applied to every subscription the topic mints.
 */
export type TopicFromSubscribeOptions<
  TValue extends Passable = Passable,
  TReturn extends Passable = undefined,
> = MakeReaderOptions<TValue, TReturn>;

/**
 * Options for `subscribeTopic`. The `buffer` and pattern options are applied to
 * every subscription the local subscriber iterates.
 */
export type SubscribeTopicOptions<
  TValue extends Passable = Passable,
  TReturn extends Passable = undefined,
> = IterateReaderOptions<TValue, TReturn>;

export type { Reader, Writer, ReaderIterator, WriterIterator };
