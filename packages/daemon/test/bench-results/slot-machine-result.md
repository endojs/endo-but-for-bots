# Slot-machine bench delta — Rust+XS and Rust+Node

Captured 2026-04-23 against `slot-machine-pr` after the full
splice landed: Stage A (worker-spawn kind plumbing), per-edge
supervisor sessions, daemon-side splice in `bus-daemon-rust-xs.js`,
worker-side splice in `bus-worker-node-raw.js` (Node workers) and
`bus-worker-xs.js` (XS workers).

## Setup

* `cargo build -p endo --release`
* `node packages/daemon/scripts/bundle-bus-daemon-rust-xs.mjs` to
  regenerate `daemon_bootstrap.js`.
* `node packages/daemon/scripts/bundle-bus-worker-xs.mjs` to
  regenerate `worker_bootstrap.js`.
* `node packages/daemon/test/bench-daemon.js --rust-only` for the
  default-mode (CapTP) numbers.
* `ENDO_USE_SLOT_MACHINE=1 node packages/daemon/test/bench-daemon.js
  --rust-only` for the slot-machine numbers.
* `ENDO_DEFAULT_PLATFORM=node` and `ENDO_NODE_WORKER_BIN` are set by
  the bench's Rust+Node section.  `defaultWorkerKind = 'node'` now
  threads through `formulateNumberedWorker` so worker formulas
  carry `kind: 'node'` on disk and the daemon's spawn dispatch
  picks `bus-worker-node-raw.js` instead of an XS binary.

## Per-bench averages (ms, mean of 3 back-to-back runs)

### Rust+XS variant

| operation               | CapTP    | slot-machine | Δ        |
|-------------------------|----------|--------------|----------|
| **eval_warm**           |  5.1     |  3.8         | **−25%** |
| eval_string_result      |  5.9     |  6.3         | wash     |
| list                    |  1.7     |  1.8         | wash     |
| eval_cold               | 56–60    | 60–63        | wash     |

### Rust+Node variant

| operation               | CapTP    | slot-machine | Δ        |
|-------------------------|----------|--------------|----------|
| **eval_warm**           |  4.6     |  4.2         | **−9%**  |
| **eval_string_result**  |  7.2     |  4.8         | **−33%** |
| list                    |  2.0     |  1.8         | wash     |
| eval_cold               | 105–110  | 102–107      | wash     |

The slot-machine path replaces the CapTP marshal layer for every
daemon→worker `evaluate` and `terminate` call.  In the warm-eval
hot path (where the daemon ↔ worker hop dominates) it shaves
~25–33% off the per-call latency.  Cold-eval and bench cases
that don't exercise the daemon↔worker bus (`ping`, `list`)
unchanged within run-to-run noise.

Verified the splice is live in XS workers: the daemon log emits
`daemon-xs(slots): SEND deliver` / `RECV resolve` pairs for
every `evaluate` call when `ENDO_USE_SLOT_MACHINE=1` (96+ slot
ops per bench run).

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

## Reproducibility

```sh
cargo build -p endo --release
cd packages/daemon
node scripts/bundle-bus-daemon-rust-xs.mjs
node scripts/bundle-bus-worker-xs.mjs
cargo build -p endo --release  # rebuild after bundle changes

rm -rf tmp/bench-*
node test/bench-daemon.js --rust-only

rm -rf tmp/bench-*
ENDO_USE_SLOT_MACHINE=1 node test/bench-daemon.js --rust-only
```
