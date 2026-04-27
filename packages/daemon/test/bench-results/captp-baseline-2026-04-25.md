# CapTP baseline — re-validated 2026-04-25

Reproduced on `slot-machine-pr` at the latest commit (after the
twelve-reviewer pass and the worker-side splice landed, with the
committed `daemon_bootstrap.js` driving the XS daemon and the
slot-machine flag unset).

`node packages/daemon/test/bench-daemon.js`:

| Operation                    | Node.js daemon | Rust+XS workers | Rust+Node workers |
|------------------------------|---------------:|----------------:|------------------:|
| `worker_to_worker_ping`      |         0.4 ms |          1.4 ms |            1.4 ms |
| `worker_to_worker_echo_1kib` |         0.5 ms |          2.8 ms |            2.0 ms |

Sample size: ping 200 calls, echo 100 calls.  Numbers are per-call
means including the one-time outer `evaluate()` overhead.  Within
~5% of the original baseline at `66ec178aa8` — no regression from
the slot-machine work.

## Slot-machine path NOT exercised here

`ENDO_USE_SLOT_MACHINE` was not set for this run.  The worker-side
splice in `bus-worker-node-raw.js` is dormant; the daemon-side
splice is blocked on the bundle-drift issue documented in
`slot-machine-splice-plan.md`.  The library is feature-complete and
89 unit tests + 43 Rust unit tests pass byte-for-byte against the
pinned hex fixtures, but a real cross-process bench delta requires
unblocking the daemon bundle regeneration first.
