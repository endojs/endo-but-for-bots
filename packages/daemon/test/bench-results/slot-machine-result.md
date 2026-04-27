# Slot-machine bench delta — Rust+Node

Captured 2026-04-23 against `slot-machine-pr` after Stage A
(worker-spawn kind plumbing) and the per-edge supervisor session
fix.

## Setup

* `cargo build -p endo --release`
* `node packages/daemon/test/bench-daemon.js --rust-only` for the
  default-mode (CapTP) numbers.
* `ENDO_USE_SLOT_MACHINE=1 node packages/daemon/test/bench-daemon.js
  --rust-only` for the slot-machine numbers.
* `ENDO_DEFAULT_PLATFORM=node` and `ENDO_NODE_WORKER_BIN` are set by
  the bench's Rust+Node section.  `defaultWorkerKind = 'node'` now
  threads through `formulateNumberedWorker` so worker formulas
  carry `kind: 'node'` on disk and the daemon's spawn dispatch
  picks `bus-worker-node-raw.js` instead of an XS binary.

## Per-bench averages (ms)

| operation               | CapTP (Rust+Node) | slot-machine (Rust+Node) |  Δ        |
|-------------------------|-------------------|--------------------------|-----------|
| ping                    |  0.6              |  0.7                     | bench-client → daemon path is CapTP either way; delta is noise. |
| provideWorker           |  9.2              |  8.8                     | wash      |
| eval_cold               | 127.8             | 102.1                    | −25.7 ms  |
| **eval_warm**           | 10.7              |  3.6                     | **−66%** (−7.1 ms) |
| **eval_string_result**  |  8.2              |  4.6                     | **−44%** (−3.6 ms) |
| list                    |  2.0              |  1.8                     | wash      |
| storeValue_lookup       |  3.1              |  3.5                     | wash      |
| cancel_worker           | 20.9              | 17.2                     | −3.7 ms   |
| cancel_reprovision      | 201.2             | 204.0                    | wash      |

The two bench rows that target the daemon↔worker hot path
(`eval_warm`, `eval_string_result`) show clear improvements: a
warm `evaluate` of `1+1` drops from 10.7 ms to 3.6 ms — i.e.
the daemon→worker call shaves ~7 ms by replacing the CapTP
serialization layer with the slot-machine codec.  The 1 KiB
result variant gains ~3.6 ms.

## What's covered, what's skipped

The slot-machine path is engaged on every daemon→worker
`evaluate` and `terminate` call in the bench under
`ENDO_USE_SLOT_MACHINE=1`.  The *worker-to-worker* benches
(`worker_to_worker_ping`, `worker_to_worker_echo_1kib`) are
guarded off because the slot-machine path lacks a bridge from
slot-machine presences in the daemon (representing worker B's
Far value) to the bench-client's CapTP session.  The bench
client's `await E(host).evaluate(workerB, "Far(...)", ...,
'iw-target')` hangs because the returned slot-machine
HandledPromise never settles through CapTP's marshal layer.
Closing that gap requires a bridging facet on the daemon that
exposes slot-machine remotes via a CapTP-side wrapper.  Tracked
as a follow-up to this PR.

The Rust+XS variant of the bench is also skipped under
`ENDO_USE_SLOT_MACHINE=1`: the XS-worker bootstrap in
`rust/endo/xsnap/src/worker_bootstrap.js` was generated from a
`packages/daemon/src/bus-worker-xs.js` source that was never
checked in.  Without the source we can't apply the slot-machine
splice in the XS worker.  Tracked as Stage B of the resilient-
foraging-eich plan.

## Reproducibility

```sh
cargo build -p endo --release
cd packages/daemon
rm -rf tmp/bench-*

# Default-mode CapTP baseline.
node test/bench-daemon.js --rust-only

# Slot-machine flagged run.
rm -rf tmp/bench-*
ENDO_USE_SLOT_MACHINE=1 node test/bench-daemon.js --rust-only
```
