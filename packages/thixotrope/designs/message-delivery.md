# Layered message delivery

This document records the selected design intention and sketches an implementation.
The core handoffs below are implemented: synchronous acceptance receipts, atomic session inboxes
and outboxes, version 2 acknowledgement/retransmission, and recovery of both session roles.
The application admission API, capacity policy, and user-space proxy availability subscriptions
remain interface proposals; they are not required to recover an already accepted message.
See the [main design](../../../designs/thixotrope.md) for current implementation limits.

## Contract and vocabulary

Committing a vat's send creates a node delivery obligation.
The node must preserve that obligation across temporary connection loss and process restart.
An accepted message cannot be forgotten merely because a dial failed, even if it has not reached
any socket yet.
Connection acquisition can fail before invocation acceptance; the exact application-facing API
for that admission boundary remains to be designed.
Checking that a route is available is not a guarantee that it remains available after admission.

An unconfirmed delivery is a specific message awaiting confirmation of durable acceptance by the
next owner.
An unsettled application promise waits for its eventual result, independently of whether the
invocation has already been delivered.
Disconnection does not reject unsettled promises or remove their listeners.
When a result becomes available, its settlement becomes another outgoing message and follows the
same delivery rules, including waiting for reconnection.

Assume any attempted wire transmission may have been processed.
Recover an unconfirmed delivery by retransmitting the same identity and suppressing duplicate
logical dispatches, not by making a new application invocation.
This does not promise exactly-once effects in arbitrary external services or delivery during a
permanent partition.
Permanent retirement and other terminal dispositions need explicit durable handling; socket loss
and timeout alone do not prove non-delivery.

## Responsibility transfers

| Boundary | Acceptance evidence | Recovery obligation |
| --- | --- | --- |
| Sending vat to its node | Committed heap output or equivalent recoverable record, eventually handed to the node outbox under a stable identity. | Preserve the send through extraction, hub processing, and outbox creation. |
| Sending node to receiving node | Receiver has durably stored the payload and identity, or committed dispatch effects plus onward work. | Receiver recovers onward delivery without needing the sender's discarded payload. |
| Receiving node to local vat | Destination journal durably contains the message and handoff identity. | Restore the vat from its selected image and replay the journal under the existing deduplication discipline. |
| Vat producing a result to result recipient | Settlement is committed outgoing work. | Use the same sequence of handoffs; invocation acceptance did not complete this obligation. |

A single node can contain several of these transfers.
Acceptance by a remote host does not mean that the final guest has executed the invocation.
An acknowledgement releases one owner's payload only after the next owner has taken responsibility.
A crash during transfer may leave two copies; replay must not create two logical invocations.
There must never be a recoverability gap between recording the send and preserving its bytes.
Atomic transactions are one implementation; replayable intermediate records are another.

## Initial implementation sketch

### 1. Make local handoff acceptance explicit

Audit [hub outbox flushing](../src/hub.js),
[worker delivery](../src/durable-worker-transport.js), and the Ironhorse output-drain boundary.
The hub currently removes a queued frame after its synchronous `session.send` returns.
The worker transport journals before scheduling execution, while some closed write paths return
without accepting anything.
A normal return must not ambiguously mean either durable acceptance or a no-op.

Introduce an internal acceptance result for durable destinations: accepted, temporarily unavailable,
or terminally refused.
An acceptance receipt identifies the handoff; it is not an application result.
Retain the outbox entry on temporary unavailability or ambiguous failure.
Only release it on acceptance, or transfer it to a durable terminal-disposition path.
If adapters become asynchronous, serialize completion per destination and match receipts by identity.
Do not hold an open hub storage transaction across network or worker I/O.

Preserve existing worker output sequence and hub delivery identifiers where their scope suffices.
Prove that committed worker output survives a crash before hub acceptance, including draining output
from the heap and replaying from the selected snapshot/journal baseline.
There is no need to move every intermediate queue into one SQLite transaction to establish this proof.

### 2. Give remote acceptance a recoverable inbox

For an initial version, add a durable remote inbox before the existing hub dispatch path.
Key messages by authenticated peer, durable session incarnation, direction, and sequence.
Sequence counters use bigint internally and a canonical wire/storage representation.
Persist enough session state for both originators and acceptors to recover the same identities.
A newly authenticated socket does not by itself authorize adoption of another session's state.

On receipt, validate the envelope and session binding, then atomically persist the payload and its
accepted sequence before sending an acceptance acknowledgement.
Dispatch accepted inbox entries to the hub in order.
After the hub commits routing effects and onward outboxes, mark the inbox entry processed and
reclaim its payload.
A crash between hub commit and inbox cleanup redelivers the same sequence; the hub watermark
suppresses duplicate processing.
This explicitly separates accepted and processed watermarks.

The current pre-handler `ack` in [durable-netlayer.js](../src/durable-netlayer.js) must no longer
allow payload disposal on the strength of a receive counter alone.
Resume advertisements must also report durable acceptance, never merely observed receipt.
Duplicate accepted frames should generate acceptance acknowledgements again, including when the
original acknowledgement was lost.
Validate acknowledgements against the sending session and the actually issued range.
Cumulative acknowledgements require a contiguous accepted prefix.

Version the resumption envelope to distinguish this contract from the current receipt-only protocol.
An old peer must not silently be treated as supplying durable acceptance.
Define the storage failure model separately: process-crash safety is not proof of power-loss safety.
Audit flush/fsync and atomic publication before advertising the stronger guarantee.

### 3. Recover the sender outbox independently of sockets

Keep accepted outgoing messages in durable storage until the receiving hop acknowledges acceptance.
The hub-to-transport handoff may release the hub copy once the transport has durably accepted it;
that transport copy remains until remote acceptance.
Use the existing hub delivery identifier to deduplicate retries of that local handoff.

Keep a durable session record separate from its current physical connection.
A route manager attaches an authenticated usable connection and pumps outstanding deliveries.
Connection failure detaches the route and leaves outbox obligations, promise routes, and listeners
intact.
Reconnect or a compatible authenticated incoming route resumes delivery with the same identities.
Originator restart recovery must join the existing acceptor recovery path.
An incoming connection needs validated session association; peer identity alone does not specify
which session's sequence space to resume.

Persist acknowledgement progress before reclaiming payloads.
Retain compact accepted/processed watermarks or tombstones after payload deletion so delayed retries
remain recognizable.
Specify session retirement and stale-incarnation rejection before reclaiming deduplication records;
do not reuse an identity after forgetting its history.
Apply capacity limits before acceptance and backpressure while full, rather than dropping already
accepted work.
Reserve a way to advance acknowledgements and settlements under pressure; queue limits must not
prevent the control traffic needed to release capacity.

### 4. Keep application policy above delivery recovery

A user-space proxy can wait for availability before requesting admission, schedule calls, and decide
whether to initiate a new call after a defined failure.
Once admitted, node delivery recovery owns the message.
Proxy expiry or cancellation cannot silently erase that obligation or imply that execution stopped.
Expose admission status if the proxy needs it, with crash-safe correlation to its queued operation.

Destination-scoped availability subscriptions may wake the proxy on authenticated incoming routes.
These hooks need an atomic subscribe/check or equivalent no-missed-notification contract, durable
registration where promised, duplicate-safe wakeups, and cleanup on cancellation or retirement.
The node outbox also uses route availability without requiring an application proxy.
No reconnect event should cause the proxy to duplicate a message already admitted to the outbox.

## Validation sequence

1. Commit a vat send, crash before extraction or hub acceptance, and recover one logical invocation.
2. Crash after destination journal acceptance but before hub outbox removal; retry the handoff and
   verify one destination journal entry for that identity.
3. Drop a connection after local acceptance but before any wire write; reconnect and deliver without
   rejecting the application promise.
4. Crash the receiver before inbox commit; verify it has not acknowledged acceptance and the sender
   retains the message.
5. Receive an acknowledgement and release the sender payload, then kill the receiver before hub
   dispatch; recover the invocation from its inbox.
6. Lose an acknowledgement, restart both peers, and retransmit; confirm duplicate suppression and
   repeated acknowledgement without new application effects.
7. Crash after hub processing but before inbox cleanup; replay without duplicate onward messages.
8. Leave a method's result promise unsettled after invocation acceptance, disconnect and restart,
   settle it while the other node is offline, then reconnect and deliver its settlement to the
   existing listener.
9. Exercise stale incarnations, invalid acknowledgement ranges, queue saturation, and explicit
   retirement; verify no silent loss or implicit identity resurrection.

Tests should inject failures at durable handoff boundaries, not infer correctness from a successful
socket reconnection alone.
