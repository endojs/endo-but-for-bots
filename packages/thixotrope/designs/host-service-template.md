# What a host service has to write

Status: a description of the current shape and an open question, not a selected
abstraction.
The [main design](../../../designs/thixotrope.md) describes host resources as
capabilities with durable descriptions reconstructed through registered
factories.
This note records what registering one actually costs today.

## The obligations

Two host services exist: the durable clock (`src/alarms/clock-service.js`) and
HTTP listeners (`src/http/http-services.js`).
Neither shares code with the other, and each implements all eleven of the
following.

1. **Durable metadata.**
   A `SyncStringAtom` holding JSON, with encoding and validation in the
   consumer.
   The clock validates a version, an allocation id, an optional worker id and a
   secret; HTTP validates a version and a list of listener recipes.
2. **Lazy provision.**
   A `provideX()` memo in the supervisor, so that reifying a service allocates
   nothing until something asks for it.
3. **Registration.**
   An entry in the daemon's `resources` map, keyed by the name a guest names.
4. **Description validation.**
   A `resource(description)` entry point that refuses a description it did not
   issue, and returns a `Far` facet.
5. **A readiness latch.**
   Settled by `start()` and awaited by every facet method, so a call that
   arrives during restoration waits rather than observing a half-restored
   service.
6. **A lifecycle state machine.**
   The clock spells it `initializing`/`initialized`/`stopped`/`failure`; HTTP
   spells it `'restoring' | 'running' | 'stopped'`.
   Both encode the same three questions: has restoration finished, did it fail,
   and are we stopping.
7. **A liveness re-check after every await.**
   Shutdown can land in any gap between steps, so each step re-reads rather
   than acting on state read before it yielded.
8. **A transient-client borrow**, for the host to call into a guest: open a
   disposable session, `lookup` a secret, act, and close however that ends.
9. **In-flight tracking and a drain**, so that no work outlives the store
   ownership its owner is about to release.
10. **A `status()`** of internal counters, surfaced over the control socket.
11. **A rung in the supervisor's shutdown ladder**, ordered against the
    daemon's own shutdown.

## What is shared now, and what is not

Obligations 7, 9 and parts of 5 have named support: `makeInFlight` and
`makeFirstFailure` in `src/in-flight.js`, `withExpiry` and `settleWithin` in
`src/platform/timers.js`, `makePromiseKit` for the latch, and the
`assertRunning()` idiom for the re-checks.

Obligations 1, 2, 3, 4, 6, 8, 10 and 11 are still written out by each service.
A third service would write them again.

## The open question

Whether a `makeHostService({ storage, validate, restore })` is worth building,
or whether the remaining obligations are too dissimilar to share.

Two instances are not enough evidence.
The two lifecycle encodings (obligation 6) look like one idea spelled twice, but
the two metadata shapes (obligation 1) differ in kind: the clock holds a single
allocation record whose worker id is chosen once, while HTTP holds a list of
recipes with independent states.
A template fitted to those two risks fitting neither a third.

The useful experiment is to write a third service — an outbound fetch
capability and a filesystem watch are the obvious candidates, and they differ
from each other in exactly the way that matters, since one is request-shaped and
borrows a transient client while the other is observer-shaped and does not.
Then see which of the eleven the three actually agree on.
