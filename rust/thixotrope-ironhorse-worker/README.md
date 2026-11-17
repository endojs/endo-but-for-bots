# Thixotrope Ironhorse worker

A process containing one Ironhorse machine and one SQLite heap store. It has no
XS runtime dependency. The host adapter and runnable two-guest-vat demo are in
[`packages/thixotrope`](../../packages/thixotrope/README.md#ironhorse-demos-and-ci-tests).

```
cargo build --release -p thixotrope-ironhorse-worker
thixotrope-ironhorse-worker heap.sqlite PROFILE_DIGEST ACTIVE_LEASE_PATH LIMITS_JSON boot.js worker-peer.js
```

For a fresh file, the runner evaluates trusted boot files and commits before
printing `{"op":"ready","features":["deliver-v1"]}`.
For an existing file, it migrates the heap to the current store schema if needed, restores it,
reinstalls the source compiler and meter, and prints the same ready record.
The worker binary and bootstrap must match the stored image's engine profile.

Stdin and stdout carry NDJSON.
An eval request has `op: "eval"`, `source`, and an optional `budget` in computrons.
It executes the source and promise jobs, then collects and runs the complete finalizer cascade.
The reply is `op: "result"` with the engine's string rendering of the result.

A combined request has `op: "deliver"`, dispatch `source`, `budget`, and an optional
`drainBudget` (defaulting to the crank budget).
It performs the same dispatch, promise jobs, collection, and finalizer cascade, then executes
`JSON.stringify(thixotropeTakeOutbound())` with the separate drain budget.
Extraction runs after finalizer callbacks and their promise jobs, so their frames are included.
It does not collect a second time: the trusted bootstrap's outbox contains JSON-parsed frame data,
and extraction allocates only unregistered bridge temporaries.
The next crank can reclaim those temporaries.
The adapter uses this operation only when the ready record advertises `deliver-v1`.
Pinned older binaries retain their original two-evaluation delivery schedule.

Deterministic VM halts produce `op: "fatal"` and exit without checkpointing the failed crank.
Results do not checkpoint the heap on every request.
`op: "close"` checkpoints the heap and folds the SQLite WAL before a successful exit;
the adapter requires that success before copying an image.
Storage failures exit without publishing a successful close.

The NDJSON interface is a **trusted supervisor interface**, not a guest-facing protocol.
Guests run in SES compartments supplied by the worker bootstrap.
Guest OCapN output stays in the heap queue until the combined operation extracts it.
The adapter then releases those frames to the comms hub.
The daemon acquires a kernel lease through `--lock-state STATE_DIRECTORY`.
The helper reports `locked`, waits for `prepare` after host compatibility checks,
reclaims abandoned incarnations under an exclusive worker lease, then reports
`ready` on stderr.
The helper flocks the supervisor file descriptor inherited on stdout; the parent
retains that descriptor until all workers stop, even if the helper dies.
The helper exits when stdin closes.
Each worker holds a shared lease on ACTIVE_LEASE_PATH until it exits.
The adapter passes the verified runtime profile digest into the SQLite signature.

The daemon transport owns replay, sequences, immutable sleep-image selection,
and failure quarantine. A private live database may be ahead of the last sleep
image; it is never selected as a recovery baseline. See the package README for
that commit protocol, integration tests, and current limitations.
