# Potential Thixotrope designs

The [main design](../../../designs/thixotrope.md) describes the architecture and current runtime.
This directory holds potential designs and experiments, not additional implemented guarantees.
[Vat replacement and SQL heap upgrades](vat-replacement.md) explore upgrade fallback mechanisms and
possible table designs in more detail.

This document records the current hypotheses, requirements, and open questions.
It is not a claim that the implementation satisfies them.

## What persistence should enable

The goal extends beyond avoiding manual serialization or making correct programs easier to write.
Two desired capabilities are durable remote objects that reconnect lazily and durable promise
listeners that remain registered across restarts.
An unavailable connection, a sleeping vat, a retired vat, and a lost external resource have different
meanings even when they all prevent a call from completing now.

## User-space upgrade and migration

The hypothesis is that orthogonal persistence with conventional user-space upgrade abstractions can
provide a better development experience than a restart-based upgrade model.
This hypothesis remains untested.
An application upgrade is distinct from migrating the engine's heap format or runtime profile.

Success means finding a small set of abstractions that make bug fixes and enhancements routine for
programs that already hold important heap state.
Failure includes becoming unable to repair those programs or burdening applications with so much
upgrade machinery that orthogonal persistence loses its benefit.
The current application registry installs and retains code; it does not yet provide upgrade.

Stable forwarding objects, replaceable implementations, and explicit migration functions are
candidate abstractions, not requirements selected by this document.
An experiment must include references already held by other vats, persisted listeners, suspended
async functions, and state captured by old closures.
Replacing an application registry entry alone does not replace those references or activations.

Useful experiments should try both a bug fix and a state-shape change in an existing application.
They should include a failed or interrupted migration and record what application authors must
anticipate, what they can repair afterward, and which old behavior remains reachable.

[Vat replacement](vat-replacement.md) explores an emergency alternative: prepare a new vat and
preserve old externally visible export identities at an explicit cutover boundary.
It describes required host validation and why exporting replacement objects alone is insufficient.

## Connection failure and delivery responsibility

Treat a message sent over the wire as potentially processed.
A connection failure or missing reply must not be interpreted as proof that an operation did not run.
This is a conservative rule for callers, not a guarantee that every transmitted message arrives.

A receiver should robustly record incoming dispatches before attempting to process them.
A transport-level commit acknowledgement should establish that the receiver has durably accepted
responsibility for the dispatch, so the sender can release its retained copy.
Acceptance does not mean execution completed or that its result reached the caller.
The acknowledgement must identify the receiving hop; acceptance by a forwarding host is not yet
acceptance by the final guest.

Requirements for a durable delivery contract are:

- Retain enough sender state to recover an unacknowledged dispatch where sender durability is promised.
- Give retransmissions a stable identity and suppress duplicate logical dispatches at the receiver.
- Before acknowledging durable acceptance, save the payload for recovery or atomically commit its
  processing effects and any resulting outgoing work.
- Recover accepted work after restart without requiring a copy the sender was told it could discard.
- Distinguish acceptance, application result, and uncertain outcome in the transport/API contract.
- Do not turn a connection error into a fresh application retry without an application-level reason
  that duplicate effects are acceptable or suppressed.

Protocol retransmission with the same identity differs from invoking the method again as a new call.
Deterministic replay can re-execute internal computation while suppressing duplicate observable
messages; this does not establish exactly-once effects in an arbitrary external service.

The selected direction is lazy connection for each call that needs a connection.
Reuse a healthy connection; otherwise attempt to connect when the call is made.
If that attempt fails, reject the call while leaving the durable reference usable for a later call.
A lost reply to a sent call leaves its outcome uncertain; the call must not be automatically retried
as a new application invocation.
Connection-attempt deadlines and coordination of concurrent attempts remain to be specified.

An explicit user-space store-and-forward proxy can offer durable waiting to applications that want it.
That proxy needs policies for expiry, ordering, cancellation, capacity, and result delivery.
A durable reference by itself does not require indefinite waiting or a new socket for every call.

### User-space retry proxy and runtime support

User-space retry policy does not imply that the proxy can work without Thixotrope support.
A proxy may need narrow runtime capabilities to observe opportunities to deliver queued work.
For example, its destination may connect inbound while outbound dialing is failing.
An authenticated incoming connection from that destination should be a possible trigger to wake the
proxy and retry delivery using the available connection, where the protocol permits it.
A socket opening alone does not establish the destination's identity or authority to receive the work.

The proxy can own the durable queue, retry policy, deadlines, and result promises while Thixotrope
provides destination-scoped connection availability and access to usable routes.
The design should not require exposing raw sockets, session credentials, or all peer activity.
Whether the proxy also needs transport assistance with stable dispatch identities and acceptance
status depends on which delivery guarantees it offers.
A new connection is an opportunity to deliver; it is not evidence that an earlier sent call failed.
Retrying work known not to have been sent differs from recovering an uncertain dispatch without
creating duplicate application effects.

Open interface questions include how a proxy subscribes without missing a connection between its
availability check and subscription, how subscriptions survive proxy sleep or daemon restart, and
how cancellation, queue exhaustion, or destination retirement releases them.
Concurrent triggers must not dispatch the same queued operation twice.
Notifications can become stale before use, so delivery must still handle connection failure.
This is a required design exploration, not an implemented hook or a settled API.

A useful experiment is to queue work while outbound connection attempts fail, then let the destination
connect inbound and verify that the proxy wakes and delivers through that connection.
Repeat across restart and duplicate availability notifications, and verify that retired destinations
produce terminal failure rather than endless retries.

### Current implementation and gaps

- The [worker transport](../src/durable-worker-transport.js) journals an incoming frame before
  delivering it to the worker and saves the hub delivery identifier used to suppress retries.
- The [hub](../src/hub.js) commits an incoming processed watermark, routing changes, and outgoing
  frames together before sending those frames.
  Destination journals recognize repeated hub delivery identifiers.
- The [remote transport](../src/durable-netlayer.js) retains outgoing frames and supports durable
  acceptor-side session recovery.
  Originator-side recovery across process restart is not implemented.
- There is an acknowledgement gap: the remote transport records a receive watermark and sends
  `ack` before calling the message handler.
  It does not journal the incoming payload there.
  If the peer receives that ack and discards its copy, then the receiver crashes before the hub
  commits the dispatch, neither side necessarily retains the work.
  Reporting the hub's older committed watermark on resume cannot recover an already discarded frame.
  A committed-acceptance protocol or durable inbox is required to close this gap.
- Physical socket failure currently stays hidden behind automatic reconnect and queued sends.
  This differs from the proposed prompt-failure default with an explicit store-and-forward proxy.
  Retransmission buffers are unbounded, and a disconnected acceptor session can remain parked
  indefinitely.
- Existing process-crash tests cover several local journal, heap, output, and snapshot boundaries.
  They do not establish the remote commit-acknowledgement contract or hardware power-loss safety.

A decisive regression test for the acknowledgement gap should let the sender receive the ack and
release its frame, kill the receiver before handler commit, and then restart and resume both sides.
The intended contract must recover the accepted dispatch without duplicating its effects.
This document records the gap; it does not change transport behavior.

## Host-directed vat retirement

The host must be able to remove local objects even when remote references still retain them.
This is an explicit exercise of the host's authority, independent of garbage collection.
Remote holders do not get to require indefinite local storage or execution.

Fine-grained revocation can be implemented in user space.
One proposed system-level unit is a whole vat: retire it and make future calls to its objects reject.
“Vat retirement” is the working name; this is not merely revoking one caller's grant.
The retired vat's identity must not later designate a new live vat.

The current daemon has worker retirement and the hub tombstones reference rows, removes publications,
and breaks listeners whose resolvers belonged to the retired session.
Those are useful mechanisms, not yet a complete user-facing retirement contract.
We still need to define the point after which new calls are refused, behavior for queued and running
calls, crash recovery during retirement, and what minimal records survive deletion of the heap.
An offline caller can learn the terminal outcome only when communication becomes possible again.
Retirement cannot undo effects already performed outside the vat.

## Potential forced revocation: tombstone one vat export

A finer-grained system mechanism could tombstone a particular export index of a vat.
Its intended effect is to reject future incoming invocations through that export identity and
release the export table's retention of the object, even while remote holders retain references.
The object remains usable through the vat's own local references.
This revokes an externally accessible identity rather than destroying the object or retiring its vat.
If local references still retain the object, this mechanism does not make the object collectible.

This direction depends on the hub model: the hub mediates every invocation through that identity
and can enforce the tombstone for every holder.
It does not provide the same guarantee under 3pho, where references can be used without that hub
remaining on the invocation path.
It is a potential design direction, not an implemented feature or a replacement for user-space
revocation abstractions.

The target must be identified by its full vat/session incarnation and export position, not a bare
integer that could later designate another object.
All hub-facing aliases and publications of that identity must observe the same terminal outcome.
Releasing the actual guest export-table entry needs coordinated runtime support; marking a hub row
as dead alone does not establish that the guest no longer retains the object through its export table.
The host must retain enough terminal routing information to reject old references across restart
without retaining the revoked object merely to remember the tombstone.
Ordinary reference-count and GC traffic must not accidentally restore the export or corrupt a later
export's accounting.

Re-export policy remains open:

- Forbid exporting the same object again, which requires tracking revocation without adding a strong
  reference that defeats the intended release.
- Allow a later export under a fresh external identity, while every old reference remains tombstoned.
  This lets local code intentionally grant access again, but means one locally identical object can
  have an old broken identity and a new usable identity from remote holders' perspectives.

Either choice interacts with stable reference identity, export canonicalization, and references
already held by other vats.
Re-enabling the old index would resurrect previously revoked authority and must not happen implicitly.
The design must specify what happens if the revoked object is returned from another method or
included in a subsequent message, rather than exported through an explicit user command.

Host authority, the admission/cutover point, queued messages, already running calls, and stale replay
need explicit rules, as with whole-vat retirement.
The intended guarantee applies to incoming invocations after the revocation boundary; it cannot
undo an invocation's completed effects or retract independent capabilities previously returned.
Promise exports, answer positions, and protocol resolver exports have additional obligations and
need separate treatment before extending this mechanism beyond ordinary object exports.
Experiments should verify local continued use, remote rejection, release of export retention,
restart behavior, alias consistency, and each candidate re-export policy.

## Crossing persistence regimes

A durable object can outlive a terminal, external process, network connection, or file descriptor.
An external service may have its own durable state while its local connection is ephemeral.
Persisting a JavaScript reference does not preserve the underlying OS resource.

Direction matters:

- An ephemeral client can call a durable object and disappear while the durable object remains.
  The inventory TUI exercises this case, including the reverse callback edge created by its
  subscription and release of that callback when the UI closes.
- A durable object can initiate and manage an ephemeral resource, such as a child process or listening
  web server.
  The lifecycle, recovery, and authority model for this direction has not yet been established.

A durable resource manager might hold a recreation recipe, a reference to a live incarnation, and
pending operations whose outcomes differ after failure.
That is a candidate abstraction, not permission to replay arbitrary process launches or I/O.
Recreating a listener does not recreate its accepted sockets, and restarting a process does not
establish whether a previous request produced an external effect.

Experiments should cover normal close, process death, daemon restart, and failure during creation.
They should determine whether stale references break or reconnect, how pending promises settle,
what cleanup occurs, and whether recovery needs renewed user authority.
Generation identity must prevent an old operation from silently targeting a replacement resource
when its meaning would change.

## Connections between the challenges

An upgrade must account for persistent references and listeners as well as live external resources.
A store-and-forward proxy must treat vat retirement as terminal rather than retry it indefinitely.
A recreated external resource may restore service while leaving an earlier operation's outcome unknown.
These cases need distinct observable outcomes even if they share recovery mechanisms.
