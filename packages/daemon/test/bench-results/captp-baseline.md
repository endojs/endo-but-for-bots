# CapTP baseline — inter-worker benchmark

Recorded 2026-04-23 on slot-machine branch (`66ec178aa8`) via
`node packages/daemon/test/bench-daemon.js`.

All variants use the same worker model: worker-A holds a reference
to a Remotable in worker-B and invokes a method in a loop.  The loop
runs inside worker-A (one `evaluate()` round-trip from bench-client);
each inner call is a worker-A → daemon → worker-B → daemon → worker-A
CapTP round trip.

## Inter-worker round-trip

| Operation                    | Node.js daemon | Rust+XS workers | Rust+Node workers |
|------------------------------|---------------:|----------------:|------------------:|
| `worker_to_worker_ping`      |         0.4 ms |          1.4 ms |            1.2 ms |
| `worker_to_worker_echo_1kib` |         0.4 ms |          2.6 ms |            2.3 ms |

Sample size: ping 200 calls, echo 100 calls.  Numbers are per-call
means including the one-time outer `evaluate()` overhead, which is
constant across variants.

## Observations

- **Pure Node.js is ~3× faster than Rust+XS on inter-worker.**  The
  Node.js daemon lives in-process with its worker threads, so the
  daemon↔worker hops are in-memory message passes.  The Rust
  supervisor paths pay CBOR-over-pipe IPC on every hop.
- **Rust+XS and Rust+Node are comparable.**  Both pay the same IPC
  cost; XS's SES-overhead per-invocation is roughly balanced by
  Node's slightly heavier worker startup / snapshot boundary.
- **Payload size matters more on Rust variants.**  Ping→echo went
  1.4→2.6 ms on Rust+XS (+1.2 ms for 1 KiB), vs. 0.4→0.4 ms in
  Node.js (within noise).  CBOR framing the 1 KiB body through two
  pipes dominates.

## What slot-machine targets

The Rust+XS and Rust+Node rows share a hot path:
`worker → CapTP JSON+netstring → daemon.connection.js → CapTP JSON+netstring → worker`.
Slot-machine replaces that with:
`worker → slot-machine CBOR → Rust supervisor translate_deliver → worker`.

Expected wins, in order of magnitude:

1. **Skip CapTP's per-message JSON parse+reserialize** on both ends
   of the daemon hop.  The daemon today decodes the incoming
   netstring, runs CapTP's `dispatch`, re-encodes for the outbound
   side.  With slot-machine, the daemon rewrites only the parallel
   descriptor arrays and forwards the opaque Tag-24 body unchanged.
2. **Canonical CBOR is smaller than JSON** for the same payload,
   especially with a descriptor table of small integers.
3. **Translation lives in Rust**, not JS — the daemon's hot path
   drops from a JS event-loop turn per hop to a hash-map lookup in
   the supervisor.

Speculative targets:
- `worker_to_worker_ping` Rust+XS: **1.4 → 0.6–0.9 ms** (1.5–2× win).
- `worker_to_worker_echo_1kib` Rust+XS: **2.6 → 1.0–1.5 ms**
  (~2× win, dominated by the skipped JSON encode/decode of the body).

These are projections; the comparison run after integration will
measure the reality.
