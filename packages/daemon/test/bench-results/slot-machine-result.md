# Slot-machine bench delta — Rust+XS, Rust+Node, Node

Captured 2026-04-23 against `slot-machine-pr` after the full
splice landed: Stage A (worker-spawn kind plumbing), per-edge
supervisor sessions, daemon-side splice in `bus-daemon-rust-xs.js`,
worker-side splice in `bus-worker-node-raw.js` (Node workers) and
`bus-worker-xs.js` (XS workers).

## Setup

* `cargo build -p endo --release`
* `node packages/daemon/scripts/bundle-bus-daemon-rust-xs.mjs`
  to regenerate `daemon_bootstrap.js`.
* `node packages/daemon/scripts/bundle-bus-worker-xs.mjs`
  to regenerate `worker_bootstrap.js`.
* Default-mode (CapTP) baseline: `node test/bench-daemon.js`.
* Flagged: `ENDO_USE_SLOT_MACHINE=1 node test/bench-daemon.js`.
* `ENDO_DEFAULT_PLATFORM=node` and `ENDO_NODE_WORKER_BIN` are set
  by the bench's Rust+Node section.  `defaultWorkerKind = 'node'`
  threads through `formulateNumberedWorker` so worker formulas
  carry `kind: 'node'` on disk and the daemon's spawn dispatch
  picks `bus-worker-node-raw.js`.

## Per-bench averages — mean of 3 back-to-back runs

| variant   | label              | baseline (CapTP) | slot-machine | Δ      |
|-----------|--------------------|------------------|--------------|--------|
| Node      | ping               |   0.27 ms        |   0.30 ms    | +13%   |
| Node      | eval_warm          |   1.53 ms        |   1.43 ms    |  −7%   |
| Node      | eval_string_result |   1.80 ms        |   1.80 ms    |   0%   |
| Node      | cancel_worker      |   4.73 ms        |   5.00 ms    |  +6%   |
| Node      | cancel_reprovision | 184.6  ms        | 190.6  ms    |  +3%   |
| Rust+XS   | ping               |   0.60 ms        |   0.50 ms    | −17%   |
| Rust+XS   | eval_warm          |   3.37 ms        |   3.77 ms    | +12%   |
| Rust+XS   | eval_string_result |   4.47 ms        |   5.63 ms    | +26%   |
| Rust+XS   | cancel_worker      |  19.07 ms        |  15.30 ms    | −20%   |
| Rust+XS   | cancel_reprovision | 315.3  ms        | 298.8  ms    |  −5%   |
| Rust+Node | ping               |   0.63 ms        |   0.57 ms    | −11%   |
| Rust+Node | eval_warm          |   3.47 ms        |   3.33 ms    |  −4%   |
| Rust+Node | eval_string_result |   5.10 ms        |   4.63 ms    |  −9%   |
| Rust+Node | cancel_worker      |  20.10 ms        |  17.97 ms    | −11%   |
| Rust+Node | cancel_reprovision | 204.4  ms        | 191.1  ms    |  −7%   |

(Node-only daemon doesn't go through any XS supervisor or
worker-bus splice; numbers there are noise floor for the
infrastructure shared with the Rust variants.)

### What this says

* `cancel_worker` shrinks meaningfully under the flag for both
  Rust variants (−11% Rust+Node, −20% Rust+XS).  Slot-machine's
  `terminate` path skips a CapTP marshal hop on each side.
* `eval_warm` on **Rust+Node** improves slightly (−4%) and
  **Rust+XS** regresses (+12%).  The XS worker's slot-machine
  inbox capture goes through an extra `onControl` indirection
  (since the default `handleCommand` only routes `deliver` to
  registered sessions, slot verbs other than deliver have to
  fall through to `onControl`); that overhead is comparable to
  what the path saves by skipping CapTP marshal.  On Node
  workers, the splice replaces CapTP wholesale and gains a bit.
* `eval_string_result` (1 KiB result) is a wash on Rust+Node
  (−9%), regresses on Rust+XS (+26%) — same indirection
  argument.
* `cancel_reprovision`, `eval_cold`, `list`, `ping` are all
  within run-to-run noise.

The headline metric — `worker_to_worker_ping` — is **not
measured** under the slot-machine flag (see Skipped below).

## What's covered, what's skipped

The slot-machine path is engaged on every daemon→worker
`evaluate` and `terminate` call in the bench under
`ENDO_USE_SLOT_MACHINE=1`.  Verified live in XS workers via
daemon-side `daemon-xs(slots): SEND/RECV` traces (96+ slot ops
per flagged bench run).

The *worker-to-worker* benches (`worker_to_worker_ping`,
`worker_to_worker_echo_1kib`) are guarded off because the
slot-machine path lacks a bridge from slot-machine presences in
the daemon (representing worker B's Far value) to the
bench-client's CapTP session.  The bench-client's
`await E(host).evaluate(workerB, "Far(...)", ..., 'iw-target')`
hangs because the returned slot-machine HandledPromise never
settles through CapTP's marshal layer.

The actual hot path that slot-machine targets is exactly this
worker-to-worker forwarding case (capability held by worker A,
method invoked on an object owned by worker B, daemon as
forwarder).  Until the CapTP-to-slot-machine bridge lands the
delta there is unmeasured — it could be substantial or
negligible.  The simple daemon→worker `evaluate` path that the
current bench measures is not where CapTP's overhead is
biggest, which explains why the deltas above are modest.

Tracked as the next follow-up after this PR: a daemon-side
wrapper that exposes slot-machine remotes via a CapTP-side
facet, so the bench-client (and any other CapTP consumer) can
hold a usable proxy to a slot-machine-owned cap.

## Reproducibility

```sh
cargo build -p endo --release
cd packages/daemon
node scripts/bundle-bus-daemon-rust-xs.mjs
node scripts/bundle-bus-worker-xs.mjs
( cd ../../rust/endo && cargo build -p endo --release )

rm -rf tmp/bench-*
node test/bench-daemon.js                    # CapTP baseline

rm -rf tmp/bench-*
ENDO_USE_SLOT_MACHINE=1 node test/bench-daemon.js   # slot-machine
```
