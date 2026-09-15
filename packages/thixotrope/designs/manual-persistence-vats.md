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

Two things where an ordinary vat holds one.

- **Desired state** — durable, ordinary heap. What the user asked for.
- **An incarnation** — ephemeral. What currently exists.

`http-services.js` already has exactly this shape, as `Recipe[]` against
`Runtime`; it is simply on the host side of the line, which is why it also has
to persist the recipes by hand.

Three things needed from the host, and only three:

1. **A capability to construct the resource**, granted by the user rather than
   ambient, and revocable.
2. **Generation identity**, so an operation issued against incarnation *n*
   cannot silently land on *n+1*.
3. **A wake**, because the vat may be asleep when the world wants it.

## The pair: a durable manager and an ephemeral resource vat

The incarnation should not be host code, and it should not be in the durable
vat either. It should be a second vat that is expected to die.

The reason is that orthogonal persistence is indiscriminate.
A durable vat that handled live connections would persist connection objects,
half-parsed buffers, and in-flight request closures — state that must not
survive, and whose non-survival its author would have to reason about case by
case.
`http-services.js` avoids the problem by being host code.
An ephemeral vat makes "everything here dies" structurally true instead, so the
author does not have to keep deciding.
The ephemeral vat is a persistence barrier before it is a resource holder, and
that is what generalises past HTTP: a parser, a connection table, a request
context, an open descriptor.

**One resource vat per resource kind**, not per instance: a web server, a
filesystem, a process spawner.
These map one-to-one onto the ports that already exist under `src/platform/` —
`http-listeners`, `files`, `sync-files`, `sockets`, `processes`, `terminal` —
and each adapter is granted the single port it adapts.
So the shape is not "manual persistence vats" in general so much as: every host
port gets a guest-side adapter, and the adapter is allowed to die.

### Policy and mechanism

The durable manager holds policy; the ephemeral vat holds mechanism.

Consumers never hold a reference to the ephemeral vat.
Only its manager does.
So the manager is where "this consumer may bind these ports" lives, and it
survives restarts to keep enforcing it, while the vat holding the broad host
power holds no policy and no memory of who asked for what.

This is the mitigation for the one real cost of per-kind granularity: a single
adapter holds the full `listen` authority, where per-instance adapters could
each have been granted less.
Concentrating the authority in a thing with no policy and no durable state, and
keeping every consumer a step removed from it, is the trade.

It also contains reference breakage.
When the ephemeral vat is retired, the only holder left with dangling
references is the manager — which is the one thing equipped to re-establish.

### Retirement is already generation identity

Requirement 2 above needs no new mechanism once the incarnation is a vat.
The hub namespaces sessions by an epoch that bumps on `retireSession`, so
"retired rows become dead tombstones that keep holders' positions resolving —
loudly, as breaks — until the holders release them", and `retireSession` takes
an `expectedEpoch` precisely so an old tombstone cannot retire a replacement
under the same alias.

That is stronger than the per-binding generation counter sketched in
`host-listeners.js`, and it arrives for free.
A stale reference into a dead incarnation breaks; it never silently reaches its
successor.

### Only managers are notified at start

Each consumer holding its own desired state would mean each consumer needs to be
started by the host.
With one manager per resource kind, the manager is the only thing the host has
to notify.
It then pushes the whole desired set into a fresh ephemeral vat, and consumer
vats stay asleep until the first request reaches them through the handler
references the manager replayed.

Start notices therefore scale with the number of resource kinds, not with the
number of things being served.

### The manager retains its consumers

A manager holding a consumer's handler reference retains that consumer's vat,
and this is correct: a vat that is being served is reachable, and should not be
collectible merely because nothing else refers to it.

The consequence is that withdrawing the service is the only way to release it.
`reachability` will report the manager as the retaining root, which is the true
answer, and a user who expects an idle server vat to be collected should be
told to stop serving rather than to wait.

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

## HTTP is the other shape

The restorable promise is no use here, and that is the point.
An HTTP request expects a response, so the host-to-guest direction is an
*answer*, and an answer aborting when the host dies is exactly right: an
in-flight request whose host is gone has failed and must not resume against a
later incarnation.

What HTTP needs instead is the eager pin, which alarms never did.
Today `http-services.js` re-binds its sockets at start because the host holds
the recipes.
Move them into the vat and that inverts: after a restart the desired listener
set is inside a sleeping vat, and no deadline will wake it.
Something has to start it.

Built on the pair as `src/http/http-port.js` (host), `src/http/http-adapter.js`
(ephemeral), and `src/http/http-manager.js` (durable), with
`test/http-manual-persistence.test.js`.
128 host lines, 45 adapter, 53 manager, against 279 in `http-services.js`, and
the difference is almost entirely the recipe state machine and its persistence.

Authority is per port: `makeResource('http-port', { port })` is authority over
that port and nothing else.
Because it is a resource, a guest's reference to it is re-seated by the endpoint
after a host restart rather than breaking, which is what lets the durable
manager go on holding it.

What stays host-side is only what a guest cannot enforce: the byte and time
ceilings, applied while bytes are arriving.

Admission is **not** among them, though an earlier draft of this document said
it was.
`HttpListenerPowers.admit` was synchronous, and that was read as a constraint —
the host having no way to await a vat mid-header.
It was not.
`respond` is an ordinary event handler, and an `IncomingMessage` is paused until
something reads it, so the bytes wait in the socket while a decision is
outstanding.
What the synchrony really did was let the request cap and the deadline be
applied *after* admission; making it asynchronous required moving both ahead of
it, so that an unadmitted request is neither uncounted nor untimed.

With that done, admission belongs to the adapter.
The host cannot judge a request — it does not know what is being served, or by
whom — and a user who wants a different policy should not have to change the
daemon to get one.
The default is same-origin, because loopback is reachable by any page in the
user's browser; a vat that wants to serve other origins now says so itself.

Refusing in the adapter is cheap in the way that matters.
The adapter answers and the consumer behind it is never consulted, so a
cross-site request costs a call into the vat that is already warm rather than
waking a sleeping workspace.
This is the first concrete use for the **resident** pin: the adapter is the vat
that should not idle-sleep, precisely because it is the one that absorbs
unadmitted traffic.

The generation counter the single-vat sketch needed is gone, as predicted: the
adapter is a vat, its death is a retirement, and the session epoch breaks stale
references without help.

One property only the pair gives: the host holds exactly **one** guest
reference, the adapter's, rather than one per service.
Consumers are reached through it, so the host's retention surface is a single
ephemeral vat and consumers are retained by their manager — which is where that
responsibility belongs.

The host does still have to notice when the vat serving a port is gone, because
the socket is on its side and would otherwise stay open in front of a handler
that can never answer.
A failed request is the first evidence it has, so that is where the check lives:
probe the handler, and if it is unreachable, answer 503 and release the port on
the next turn — closing a listener destroys every socket on it, including the
one still waiting for that answer.

## Wakefulness

Endo daemon gives each agent an `@pins` directory; `revivePins` walks it at
startup and `provide`s each id, and naming something there also retains it.
Two jobs in one gesture, because daemon formulas do not sleep.

A first pass here copied that shape: a `pin` of `eager` or `resident`, durable
in worker meta, plus a retention root.
All three parts turned out to be unnecessary once the pair model was in place,
and what is left is two much smaller things.

### An ephemeral vat is resident, and does not ask

There is no residency flag.
An ephemeral vat never idle-sleeps, because it cannot want to: its state is
discarded at the next startup regardless, so snapshotting it on idle is I/O
spent on something already known to be disposable — and a resource adapter that
sleeps is one that has to be woken by the very traffic it exists to absorb.

Residency is the host declining to park a vat on its own initiative, not a
refusal to obey a request: an explicit `sleep` is still honoured.

### A manager is not pinned; it is notified

The manager does not need to stay awake, because it is not on the request path.
The host reaches the adapter, the adapter reaches the consumer, and the policy
the adapter enforces was pushed into it at bind time.

Not that it *could* not be woken — a delivery always wakes a sleeping vat, so a
manager consulted per event would work.
What it would pay is latency and churn: the first event after idle spawns a
process and restores a heap, and events arriving just slower than the idle
timeout produce a wake, a snapshot and a sleep apiece.

That is an argument for where per-event work belongs, not for a residency flag.
An ephemeral vat can decline to sleep for free, because it has no snapshot to
write; a durable vat declining to sleep would be holding a process alive to
avoid I/O, which is a tuning decision `idleSleepMs` already expresses.

So the rule is: anything consulted per event belongs in the adapter — not
because the manager cannot be woken, but because the adapter is the side where
per-event work costs nothing.
Pushing policy at bind time is how that is arranged.

So the manager sleeps, and needs exactly one thing — to learn that a new host
incarnation exists.
`notifyOnStart(secret)` records a publication in worker meta, and the daemon
calls `started()` on it at every startup.

Two consequences of that being a delivery rather than a flag.
The delivery *is* the wake, so nothing needs to start the vat separately — which
matters, because waking runs none of a vat's code: orthogonal persistence
resumes the heap exactly where it was, and the main design is explicit that
sleep is host policy and not a guest lifecycle event.
And the publication is already a retention root, so a notified vat is retained
without any rule about pins and collection.

It is send-only.
A manager that cannot restore its resource is a condition for it to report, not
a reason to refuse to start the host — and there is no caller at startup to
receive a rejection.

### What is left of the third kind

A scheduled wake is the restorable host promise above, and belongs to the vat
that wants it rather than to any host-side registry.

## Utilities

Guest-side, shipped by source the way `makeObservableMap` is:

- An **ephemeral vat keeper** for the manager: create the resource vat when
  absent, evaluate the adapter into it, push the desired state, and hand back a
  live reference. Generation-stamping is not among its jobs; retirement does
  that.
- An effect-intent helper — record intent, act, record outcome — because
  "restarting a process does not establish whether a previous request produced
  an external effect" becomes the vat's problem once the vat owns the resource.

Host-side, small and generic:

- **Ephemeral workers**: a worker whose heap is not a recovery baseline and
  which is retired at the next daemon startup.
- A durable alarm table offering restorable promise resources.
- **Start notices**: `notifyOnStart(secret)` on a worker facade, durable in
  worker meta, delivered send-only at every startup.

### Retrying across a break is the caller's decision

The keeper can re-establish an incarnation.
It must not silently re-issue the call that discovered the old one was dead.

A broken call is an uncertain call: the adapter may have performed its effect
before dying.
Re-establishing a listener is idempotent and safe to retry; delivering a request
is not.
So the keeper offers liveness and re-establishment, and leaves the retry to the
operation that knows whether repeating it is harmless.

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

Whether the keeper's shape is right.
It is a guess drawn from two examples, one of which does not exist yet.
The honest sequence is to write the durable alarm first, then a second manual
vat that owns something genuinely reconstructible — a child process is the
sharpest test, since it exercises effect uncertainty as well — and only then
look for the shared shape.
