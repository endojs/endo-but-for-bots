# @endo/exo-pubsub

CapTP bridge layer exposing [`@endo/pubsub`](../pubsub/README.md) topics,
publishers, and subscriptions as remotable exo objects.

## Overview

`@endo/pubsub` provides *local* pub/sub topics: a publisher puts values to a
topic and each subscriber iterates an independent cursor over a shared async
linked list, with either lossless-deltas (`makeChangeTopic`) or lossy-latest
(`makeLatestTopic`) semantics.
Those topics are local objects.
This package bridges them across a CapTP boundary, the same way
[`@endo/exo-stream`](../exo-stream/README.md) bridges a single async iterator
stream, so a publisher and its subscribers can live in different vats, daemons,
or workers.

A subscription is, on the wire, exactly an exo-stream **Reader** (published
values flow from the topic owner to the subscriber).
A publisher is, on the wire, exactly an exo-stream **Writer** (values to publish
flow from the producer to the topic owner).
This package therefore composes exo-stream's reader and writer pumps rather than
re-implementing the streaming protocol, and adds the one primitive exo-stream
does not have: the **topic** itself, a fan-out capability whose `subscribe()`
mints a fresh subscription on demand.
Bridging the topic (rather than a single subscription) lets the remote consumer
decide *when* to subscribe and obtain *independent* cursors, preserving the
lossless or lossy semantics of the underlying topic across the boundary.

This package does not use barrel exports.
Import each function from its own module.

## The bridges

Each primitive has a **responder** side (wrap a local value as a passable exo)
and an **initiator** side (drive a remote exo as a local value).

| Primitive    | Responder (`local → passable exo`)              | Initiator (`passable exo → local`)        |
| ------------ | ----------------------------------------------- | ----------------------------------------- |
| subscription | `subscription-from-reader.js`                   | `iterate-subscription.js`                 |
| publisher    | `publisher-from-writer.js`                      | `iterate-publisher.js`                    |
| topic        | `topic-from-subscribe.js`                       | `subscribe-topic.js`                      |

### Topic

Bridge a topic's `subscribe` capability so a remote consumer can subscribe over
CapTP:

```js
import { makeChangeTopic } from '@endo/pubsub/change-topic.js';
import { topicFromSubscribe } from '@endo/exo-pubsub/topic-from-subscribe.js';
import { subscribeTopic } from '@endo/exo-pubsub/subscribe-topic.js';

// Responder: vend the read side of a local topic over CapTP.
const { publisher, subscribe } = makeChangeTopic();
const topicRef = topicFromSubscribe(subscribe);
// topicRef can now be passed over CapTP.

// Initiator: subscribe to the remote topic and iterate a fresh subscription.
const remote = subscribeTopic(topicRef);
const subscription = remote.subscribe();
for await (const value of subscription) {
  console.log(value);
}

// Meanwhile, the responder publishes:
await publisher.next(harden({ add: 'alice' }));
```

### Subscription

Bridge a single subscription (a Reader over a topic) directly, when the
responder decides the subscription rather than the consumer:

```js
import { subscriptionFromReader } from '@endo/exo-pubsub/subscription-from-reader.js';
import { iterateSubscription } from '@endo/exo-pubsub/iterate-subscription.js';

const subscriptionRef = subscriptionFromReader(subscribe());
// subscriptionRef can now be passed over CapTP.
const subscription = iterateSubscription(subscriptionRef);
for await (const value of subscription) {
  console.log(value);
}
```

### Publisher

Bridge a topic's publisher so a remote producer can publish into a local topic:

```js
import { publisherFromWriter } from '@endo/exo-pubsub/publisher-from-writer.js';
import { iteratePublisher } from '@endo/exo-pubsub/iterate-publisher.js';

const publisherRef = publisherFromWriter(publisher);
// publisherRef can now be passed over CapTP.
const remotePublisher = iteratePublisher(publisherRef);
await remotePublisher.next(harden({ add: 'bob' }));
```

## Buffering and patterns

Every bridge accepts the same `{ buffer, readPattern, readReturnPattern }` (for
the read side) or `{ buffer, writePattern, writeReturnPattern }` (for the write
side) options as the corresponding exo-stream bridge.
`buffer` pre-acknowledges that many iterations to hide round-trip latency over
high-latency links; the patterns are `@endo/patterns` guards applied to each
value at the boundary.
For a topic, the options are applied to every subscription it mints.

## Relationship to exo-stream

`@endo/exo-pubsub` depends on `@endo/exo-stream`: a subscription *is* a Reader
and a publisher *is* a Writer, so re-implementing the bidirectional promise-chain
protocol would fork a subtle, well-tested implementation.
The value this package adds is the topic abstraction and a pubsub-aligned
vocabulary for the subscription and publisher bridges, so a caller that thinks
in topics imports a single surface.
