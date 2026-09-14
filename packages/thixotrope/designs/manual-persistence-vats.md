# Manual persistence vats

Status: exploratory design with a working mechanism probe, not an implemented
contract or a decision to move the existing clock and HTTP services.

Orthogonal persistence preserves a vat's heap.
It does not preserve an OS resource: a listening socket, a child process, a
timer.
A vat that owns one has to persist it *manually* — keep a durable recipe, and
reconstruct the resource whenever an incarnation is lost.

This document asks what such a vat needs from the host, why almost nothing it
needs is specific to clocks or HTTP, and what utilities would make one routine
to write.
[Crossing persistence regimes](README.md#crossing-persistence-regimes) states
the problem; this is a candidate answer to the second direction it names.

## Why the existing services are in the wrong place

The durable clock and HTTP listeners are host services today.
[What a host service has to write](host-service-template.md) counts eleven
obligations that each of them implements by hand.

Nine of the eleven exist only because the host's heap is ephemeral.
A vat does not need durable JSON metadata, a lifecycle state machine, a
readiness latch, a liveness re-check after every await, in-flight tracking and
a drain, a transient-client borrow, a lazy provider, a `resources` registration,
or a rung in a shutdown ladder.
It needs none of those because its heap *is* the durable record and because it
does not outlive itself.

What is left after removing them is the actual content: a desired state, an
incarnation, and the reconciliation between them.

## The threshold

A manual-persistence vat holds two things where an ordinary vat holds one.

- **Desired state** — durable, ordinary heap. What the user asked for.
- **An incarnation** — ephemeral, host-side. What currently exists.

`http-services.js` already has exactly this shape, as `Recipe[]` against
`Runtime`; it is simply on the host side of the line, which is why it also has
to persist the recipes by hand.

Three things such a vat needs from the host, and only three:

1. **A capability to construct the resource**, granted by the user rather than
   ambient, and revocable.
2. **Generation identity**, so an operation issued against incarnation *n*
   cannot silently land on *n+1*.
3. **A wake**, because the vat may be asleep when the world wants it.

## The mechanism: a restorable host promise

The third is the one that looked hard, and it is already built.

A host operation that a guest awaits is an *answer*, and
`restorePendingResolver` in `@endo/ocapn` rejects every pending answer on
restart — "the computation that owed this answer died with the previous
process".
That is correct for an operation whose effects are unknown.

A guest listening on a host *promise* is a different case, and the same
function re-links it: it re-provides the host's local export at the recorded
position and re-attaches the listener.
The endpoint re-seats that export through `provideCapability`, which for a
`{ kind: 'resource', name, description }` record calls the registered factory
again.
`provideResource` memoises per `(name, description)`, so the description is the
recipe.

So the primitive is: **a host promise whose settlement is a pure function of a
durable description.**
A deadline is the canonical case.
A DNS lookup or an outbound request is not, which is why answers abort and this
does not.

`test/restorable-promise.test.js` confirms the mechanism end to end: a resource
factory that returns a pending promise, a guest that listens on it, a daemon
crash, a restart in which the factory re-runs for the same description, and a
settlement that reaches the guest's listener.

One handover detail is load-bearing and not obvious.
A host method that returns the promise *bare* does not hand over a reference:
the promise becomes that call's answer, so the call waits for the deadline and,
being an answer, aborts on restart — the exact opposite of what is wanted.
Returned inside a record, it travels as a promise reference the guest can listen
on, and the call settles immediately.
The same test pins both halves of that.

`src/alarms/durable-alarms.js` and `src/alarms/guest-clock.js` implement the
alarm on this mechanism, and `test/durable-alarms.test.js` covers arming across
a crash, an alarm that came due while no host was running, cancellation, and the
claim the whole design rests on: a settlement alone wakes a sleeping vat, with
nothing calling into it.

## What this does to the clock

Almost all of it disappears.

The host keeps a durable table of `(workerId, alarmId) -> deadline` and one
timer for the earliest.
When a deadline arrives it resolves the corresponding promise resource, which
settles the guest's listener, which wakes the vat.

Gone from the host: the allocation intent and its secret, the published control
facet, the transient-client borrow with its deadline race and close-failure
gate, the `pending()`/`fire()` protocol, the reconciliation scan, the polling
loop, the retry watermarks, and `clock.json`.

Gone because the host no longer calls *into* the vat.
Every one of those existed to let an ephemeral host reach a sleeping guest and
recover when that failed.
Waking is enough, and waking is idempotent.

What remains in the vat is what was always the real content: a map from id to
`{ deadline, resolve }`, which was already there.

The fragile window shrinks to the arming call itself.
If the host restarts between `armAlarm` being sent and its answer arriving,
that answer aborts and the caller learns arming did not complete — which is
true.
The waiting, which is the long part, is durable.

## HTTP needs no residency either

The host owns the socket, which it must, and the vat owns the handler.
An inbound request reaches the vat through the existing publication path, which
wakes it.
The recipes and the lifecycle move into the vat; what stays host-side is
`listen(port) -> forward to this published handler`, which `http-listeners`
almost already is.

## Pins

Endo daemon gives each agent an `@pins` directory; `revivePins` walks it at
startup and `provide`s each id, and naming something there also retains it.
Two jobs in one gesture, because daemon formulas do not sleep.

Thixotrope already separates retention: `keep` in `vat-reachability.js` is a GC
root and says nothing about wakefulness, and an ordinary reference retains a vat
anyway.
So a pin here is about wakefulness, and it is three distinct requests that a
single directory would conflate:

- **eager** — wake at daemon start even with no pending journal.
  Today's rule is `journalLength() > snapshot.cut`.
- **resident** — never idle-sleep.
  Needed only when sleeping would abandon something the vat supervises, such as
  a child process or a stateful outbound connection.
  Notably *not* needed by the clock or by HTTP.
- **scheduled** — wake at a time, which is the restorable promise above.

Residency is the expensive one and the rarest, and it is worth making a caller
say which one it means.

## Utilities

Guest-side, shipped by source the way `makeObservableMap` is:

- `makeResident({ desired, incarnate, retire })` — the reconcile loop, with
  generation-stamped handles so a call against a dead incarnation rejects rather
  than reaching its replacement.
- An effect-intent helper — record intent, act, record outcome — because
  "restarting a process does not establish whether a previous request produced
  an external effect" becomes the vat's problem once the vat owns the resource.

Host-side, small and generic:

- A durable alarm table offering restorable promise resources.
- A pins facet granting `eager` and `resident`.
- `listen(port) -> published handler`.

## Open questions

The generation identity contract.
A stale handle must reject, but the vat also needs to know *why* — a
reconstructed resource and a retired one are different answers to its caller.

Failure of reconstruction.
A pinned vat whose `incarnate` keeps failing should not spin.
Backoff, quarantine and the report to the user are undesigned.

Authority renewal.
If the capability to listen or spawn was granted by a user who has since
revoked it, reconstruction must fail rather than proceed on the strength of a
recipe.
Whether that is a plain revoked-capability rejection or needs its own signal is
open.

Whether `makeResident` is real.
It is a guess drawn from two examples, one of which does not exist yet.
The honest sequence is to write the durable alarm first, then a second manual
vat that owns something genuinely reconstructible — a child process is the
sharpest test, since it exercises effect uncertainty as well — and only then
look for the shared shape.
