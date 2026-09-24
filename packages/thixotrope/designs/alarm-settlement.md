# Recoverable alarm settlement

The host persists a bounded ledger of pending deadlines and terminal outcomes.
It writes the fulfillment time or cancellation before resolving the corresponding promise.
After a crash, the resource factory reconstructs exactly that recorded outcome.
Deleting the deadline before settlement delivery is durable would strand a guest listener.

The guest clock observes the host promise and gives callers a separate, guest-owned promise.
That promise may be shared with other vats without making them independent listeners on the host.
In the crank that settles its own promise, the clock queues an idempotent `release(id)` call.
The incoming settlement is journaled before delivery to the vat.
A saved heap plus deterministic replay recovers both its local settlement and queued release;
a new heap snapshot is not required for every crank.
Consequently, the host can delete the row without waiting for every downstream listener.

The clock retains outstanding release IDs until the host acknowledges them.
An answer interrupted by restart retries automatically through the resumed promise continuation.
Other failures remain queued for the next clock operation, avoiding a tight retry loop.
An interrupted arm also queues release: losing the answer does not prove no deadline was stored.
Both pending and unacknowledged terminal rows count toward the 1,024-row limit.

Host updates write the replacement ledger before installing the new in-memory state.
Release always persists, including when the ID is absent in memory: an earlier file replacement
may have succeeded before its directory sync failed.
Repeated release remains harmless when the original release succeeded but its answer was lost.
This protocol is local to alarms and does not add a general transaction or resource-retirement API.

Workspace metadata version 3 identifies clocks with this acknowledgement protocol.
Startup checks it under the store lease before restoring workers or starting alarms.
Older heap-persisted clock implementations cannot acknowledge outcomes and require migration or
fresh state; automatically substituting new source would not replace their retained closures.
The alarm ledger reads version-1 pending rows and writes version 2, which also carries outcomes.

Validation covers fulfillment and cancellation crashes immediately after the terminal write,
restoration through the daemon with a listener in another vat, release interruption before and
after effect, interrupted arming, failed writes, and rejection of older workspace metadata.
The precommit adversarial review checks both the persistence ordering and bounded cleanup.
