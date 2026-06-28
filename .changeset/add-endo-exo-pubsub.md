---
'@endo/exo-pubsub': major
'@endo/daemon': minor
'@endo/chat': minor
---

Add `@endo/exo-pubsub`: a CapTP bridge layer that exposes `@endo/pubsub` topics, publishers, and subscriptions as remotable exo objects, following the `@endo/exo-stream` sibling pattern (no barrel module; one bridge per subpath export).
A subscription is wire-identical to an exo-stream Reader and a publisher to an exo-stream Writer, so the package composes exo-stream's pumps and adds the pub/sub-specific primitive exo-stream lacks: the **topic**, a fan-out capability whose remote `subscribe()` mints an independent cursor on demand and preserves the lossless-deltas / lossy-latest semantics of the underlying topic across the boundary.
Ships six bridges, responder and initiator side for each of subscription (`subscription-from-reader.js` / `iterate-subscription.js`), publisher (`publisher-from-writer.js` / `iterate-publisher.js`), and topic (`topic-from-subscribe.js` / `subscribe-topic.js`).
As empirical validation, the daemon's chat-consumed name-change and message follow paths (the pet-store `nameChangesTopic` and the mailbox `messagesTopic`) now cross CapTP through `@endo/exo-pubsub`'s subscription bridge instead of `@endo/exo-stream` directly, and `@endo/chat` consumes them through the same bridge; the chat subscription test suite passing is the proof the migration is wire-equivalent.
Incubates on the `llm` roadmap branch ahead of projection to `master`.
