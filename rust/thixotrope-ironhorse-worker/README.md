# Thixotrope Ironhorse worker

A process containing one Ironhorse machine and one SQLite heap store. It has no
XS runtime dependency. The host adapter and runnable two-guest-vat demo are in
[`packages/thixotrope`](../../packages/thixotrope/README.md#ironhorse-demos-and-ci-tests).

```
cargo build --release -p thixotrope-ironhorse-worker
thixotrope-ironhorse-worker heap.sqlite PROFILE_DIGEST ACTIVE_LEASE_PATH boot.js worker-peer.js
```

For a fresh file, the runner evaluates trusted boot files and commits before
printing `{"op":"ready"}`. For an existing file, it validates and restores the
heap, reinstalls the source compiler and meter, and prints the same ready record.
The worker binary and bootstrap must match the stored image's engine profile.

Stdin and stdout carry NDJSON. An eval request has `op: "eval"`, `source`, and an
optional `budget` in computrons. The reply is `op: "result"` with the engine's
string rendering of the result. It is emitted only after the complete crank
(including promise jobs) commits to SQLite. Deterministic VM halts produce
`op: "fatal"` and exit without committing the failed crank. Storage failures
exit without publishing a result. `op: "close"` folds the SQLite WAL before a
successful exit; the adapter requires that success before copying an image.

The NDJSON interface is a **trusted supervisor interface**, not a guest-facing
protocol. Guests run in SES compartments supplied by the worker bootstrap. Guest
OCapN output stays in the heap queue until a separate crank drains and commits
it.
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
