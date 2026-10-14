# The wasm Thixotrope worker spike

The engine's store seam (`ironhorse_snapshot::store::HeapStore`) over a
SQLite-backed Durable Object, with the whole store stack in wasm and the
database reached through a small host-import ABI.
It is the evidence behind
[`designs/thixotrope-wasm-worker.md`](../../../designs/thixotrope-wasm-worker.md):
the backend acceptance suite passes inside local workerd, and the design's
Phase 0 numbers (wake, commit, rows, memory) come from `run.py`.
It is a standalone cargo root outside the engine workspace, like
`stack-lanes/probe`, because its wasm build uses the unstable unwinding recipe
of
[WASM-BLOCKERS.md B1](../WASM-BLOCKERS.md#b1-unwinding-is-required-and-stable-wasm-cannot-provide-it)
(`../scripts/build-wasm.py`, whose flags and environment `run.py` imports).
It carries no production code.

## Layout

| Path | What |
|---|---|
| `src/host.rs` | The import side of the ABI: `host_exec`, `host_take`, `host_log`, `host_random`; tagged values, one statement per call, no re-entry. |
| `src/store.rs` | `DoStore`: `HeapStore` on the `MemoryStore` pattern, rows keyed by a store id, sections chunked by `(id, chunk)`, every value at most 2,000,000 bytes, no transaction statements. |
| `src/session.rs` | The worker's crank loop (`eval` and `Compiler` from `rust/thixotrope-ironhorse-worker/src/main.rs`, unchanged) around a thread-local session; commit tokens from host randomness. |
| `src/lib.rs` | `extern "C-unwind"` exports, every engine-running body under `catch_unwind`, a status plus a message buffer; the four buffer helpers have no path that unwinds. |
| `host/worker.js` | The Durable Object: lazy instantiation, the `sql.exec` shim returning error codes, the WASI preview1 shim std needs, one `transactionSync` per crank, the instance dropped after any exception. |
| `host/config.capnp.in` | workerd config: one SQLite-backed class, local-disk storage. |
| `run.py` | Build, serve, and the commands below. |
| `export-heap/` | Native: a Thixotrope `heap.sqlite` to its canonical container, with the profile string the importer must present. |

## Running

Toolchain: the pinned Rust (`rust/engine/rust-toolchain.toml`) with `rust-src`
and the `wasm32-wasip1` target (from `rust/engine`, so that rustup reads the
pin: `rustup component add rust-src` and `rustup target add wasm32-wasip1`),
and the `workerd` binary (`$WORKERD`, or `workerd` on PATH; it is the one file
of the platform package `@cloudflare/workerd-linux-64`).
`-Zbuild-std` compiles the standard library from `rust-src`, but the link
still takes wasi-libc and the crt objects from the target's `rust-std`;
`run.py build` checks for both before it starts, as the engine's recipe does.
It is WASI rather than `wasm32-unknown-unknown` because the acceptance suite's
own sessions draw commit tokens from the engine's default source, which needs
a clock and seeded hash keys (the engine refuses on the other target); the
host shims the WASI imports std reaches for (the module imports six), and the
sessions the spike owns draw their tokens from `host_random` on either target.

```sh
cd rust/engine/wasm-worker-spike
python3 run.py build                       # the module, two to three minutes cold
python3 run.py --no-build suite            # the acceptance suite, all eight parts
python3 run.py --no-build boot --boot ../../../packages/thixotrope/dist-ironhorse/boot.js \
    --boot ../../../packages/thixotrope/dist-ironhorse/worker-peer.js --wakes 3
python3 run.py --no-build wake --container boot.container --profile spike-boot-profile --wakes 3
python3 run.py --no-build sweep --wakes 2
```

Every command prints one JSON record per measurement and `--json FILE` saves
them as they are made; the exit status is 1 when any measurement failed.
A record's `*_ms` figures are `performance.now()` deltas around one export,
which workerd reports in whole milliseconds; a committing export's `sync_ms`
is the durable write that follows it (`ctx.storage.sync()`), which the
export's own time excludes and which `total_ms` and `crank_total_ms` include.
No record holds the design's "wake total": for a wake record it is
`instantiate_ms + resume_ms + crank_total_ms - sync_ms`.
A wake record's `object_first_request_ms` is the client-side wall time of the
first request after the idle, the object's own construction when it was
evicted (`object_evicted`).
`--idle 15` before each wake lets local workerd evict the object, so the wake
re-runs the constructor and reopens the database.
The boot files come from `yarn build:ironhorse-bundles` in
`packages/thixotrope`; a Thixotrope heap comes from the native worker
(`cargo build --release -p thixotrope-ironhorse-worker` at the repository
root, then `yarn demo:ironhorse:counter init <dir>`), and `export-heap`
turns it into a container:

```sh
cd export-heap && cp ../../../../Cargo.lock . && cargo build --release   # the repository's lock
./target/release/ih-export-heap <state>/heaps/snapshots/<hash>.sqlite vat.container
```

## The suite

`run.py suite` runs the eight parts of `ironhorse_snapshot::store_suite`
against fresh `DoStore`s inside one Durable Object, each part in one
`transactionSync`: `sparse`, `checkpoint`, `resume`, `commit`, `edits`,
`lazy`, `boundary` and `metamorphic`.
A part's status is 0 when it passes; a failed assertion comes back as status
2 with the panic text.

## What the spike does not do

- No transactions of its own: a crank is one `transactionSync` on the host.
  The suite runs each part inside one, so its many commits are one
  transaction; a production host commits once per crank.
- No `rebuild_edge_pairs`, no `edge_pairs` table and no CTE overrides: the
  trait's dense reachability defaults serve the collectors.
- No migration: it ports current-schema heaps only (`replace_for_migration`
  keeps the trait's refusal).
- No OCapN, no outbox, no routing: the crank is the worker's `eval`, with the
  boot files and the drain crank as the realistic workloads.
