# Slot-machine bench delta — end-to-end

Captured 2026-04-30 against `slot-machine-pr` after closing the
last gap: bench-client <-> daemon now also speaks slot-machine
when `ENDO_USE_SLOT_MACHINE=1` (in addition to daemon <-> workers).
The whole chain — bench-client, daemon, both workers — runs the
same protocol, so worker-to-worker forwarding works without a
CapTP<->slot-machine marshal bridge.

## What enables the end-to-end path

1. **Slot presence is now passable.**
   `packages/slots/src/client.js`'s `makePresence` uses
   `HandledPromise`'s `resolveWithPresence` with a Remotable-
   tagged proxy target.  The result is `passStyleOf === 'remotable'`
   for Object slots (so `@endo/marshal`'s smallcaps decoder
   accepts it as a remotable cap), still routes `E(p).method(...)`
   through the slot-machine handler, and stays
   `passStyleOf === 'promise'` for Promise slots so `$cancelled`-
   style args pass too.
2. **Netstring slot-machine transport.**
   `packages/daemon/src/connection.js`'s new `makeNetstringSlots`
   wraps a byte-level pipe in netstring framing of CBOR envelopes
   — same envelope codec used on fd 3/4.  Used by both
   `makeEndoClient` (the bench-client side) and
   `serve-private-path.js` (the Node daemon's listener).  Each
   side flips descriptor direction once on send, matching the
   slot-machine peer-to-peer convention from the unit tests.
3. **Rust daemon listener and supervisor.**
   `rust/endo/src/socket.rs`'s client-IO tasks decode the inner
   CBOR envelope when `ENDO_USE_SLOT_MACHINE=1` so the verb
   (deliver / resolve / drop / abort) is preserved end-to-end —
   the prior code hardcoded verb=`deliver`, which was fine for
   CapTP but lost slot verbs.  `rust/endo/src/supervisor.rs`
   skips its position-1 kref pre-binding for external client
   handles (`info.is_some()`), letting the codec-level flip do
   the direction translation peer-to-peer.
4. **Daemon-side slot-machine client sessions.**
   `bus-manager-endor.js`'s `setupClientSession` mirrors the
   worker-side splice — per-client async-iterator inbox for the
   four slot verbs, outbound writer that flips on send.

## Per-bench averages (mean of 3 back-to-back runs, ms)

### Rust+XS (XS workers, slot-machine end-to-end vs CapTP end-to-end)

| operation              | CapTP   | slot   | Δ      |
|------------------------|---------|--------|--------|
| ping                   |   0.57  |  0.63  | +12%   |
| eval_cold              | 152.7   | 153.0  |  ±0    |
| eval_warm              |   3.33  |  3.37  |  ±0    |
| eval_string_result     |   4.80  |  5.77  | +20%   |
| list                   |   1.20  |  1.33  | +11%   |
| cancel_worker          |  15.2   | 17.1   | +13%   |
| **worker_to_worker_ping** | 2.73 |  2.50  | **-9%** |
| cancel_reprovision     | 320.8   | 328.0  |  +2%   |

### Rust+Node (Node workers, slot-machine end-to-end vs CapTP)

| operation              | CapTP   | slot   | Δ      |
|------------------------|---------|--------|--------|
| ping                   |   0.60  |  0.73  | +22%   |
| eval_cold              |  95.5   | 100.0  |  +5%   |
| eval_warm              |   3.00  |  3.93  | +31%   |
| eval_string_result     |   5.00  |  7.13  | +43%   |
| list                   |   1.60  |  2.00  | +25%   |
| cancel_worker          |  13.2   | 20.7   | +57%   |
| **worker_to_worker_ping** | 1.47 |  1.63  | **+11%** |
| cancel_reprovision     | 210.4   | 197.6  |  -6%   |

### Honest reading of the deltas

* The chain **works end-to-end** under the flag now — every
  operation that the bench measures completes, including the
  `worker_to_worker_*` cases that previously had to be skipped.
  This is the load-bearing functional result.
* Slot-machine is **not** systematically faster than CapTP on
  this workload: most ops regress 10–50%, and `cancel_worker`
  on Rust+Node is +57%.  The slot-machine library is younger and
  unoptimized; CapTP has had more attention.
* `worker_to_worker_ping`, the metric the design called out as
  the slot-machine target, lands at parity-or-slightly-better on
  Rust+XS (-9%) and slightly worse on Rust+Node (+11%) — within
  run-to-run noise on either reading.
* The promised efficiency win likely depends on either (a)
  optimization of the slot-machine codec / smallcaps body
  encoding, (b) workloads where CapTP's question-table churn or
  Promise-pipelining overhead dominates (the bench's evaluate
  path is dominated by worker-spawn + compartment-eval cost,
  neither of which the wire protocol affects), or (c) the swingset
  GC pillars — which slot-machine is structured to support but
  which we haven't exercised.

What we *can* claim from this PR: a working end-to-end
slot-machine alternative to CapTP across `bench-client ->
daemon -> workers`, with a measurable bench delta on the same
benchmark.  What we cannot claim: a perf win in the simple eval
hot path.

## Reproducibility

```sh
# From the workspace root.
cd packages/daemon
node scripts/bundle-bus-daemon-endor.js
node scripts/bundle-bus-worker-xs.js
( cd ../../rust/endo && cargo build -p endo --release )

rm -rf tmp/bench-*
node test/bench-daemon.js --rust-only                 # CapTP baseline

rm -rf tmp/bench-*
ENDO_USE_SLOT_MACHINE=1 node test/bench-daemon.js --rust-only --rust-node-only

rm -rf tmp/bench-*
ENDO_USE_SLOT_MACHINE=1 node test/bench-daemon.js --node-only
```
