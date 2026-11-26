# The wasm worker harness for workerd

A harness that runs the product crates of the wasm Thixotrope worker inside local workerd, as a SQLite-backed Durable Object.
It is the evidence behind
[`designs/thixotrope-wasm-worker.md`](../../../designs/thixotrope-wasm-worker.md):
the store acceptance suite passes there against the product store, the product module boots, serves, closes and wakes there through the real JavaScript host, and the design's numbers (wake, commit, rows, memory) come from `run.py`.
It is not a prototype of those crates and holds no copy of them.

It runs in two modes.
The harness module is a wasm cdylib of its own over the product crates: its store is `ironhorse_store_do::DoStore` over an executor built on the product module's host imports, and its worker is `thixotrope_ironhorse_core::Worker`.
Its exports add what only a harness needs: the acceptance suite, a clean store per begin, container import and export, and residency counters.
The product mode loads the product module itself (`rust/thixotrope-ironhorse-wasm`, built by its `build.py`) with `packages/thixotrope/src/ironhorse/wasm/host-abi.mjs`, the JavaScript half of its ABI, bundled from where it lives.

The harness is a standalone cargo root outside both workspaces, like `stack-lanes/probe`, because its wasm build uses the unstable unwinding recipe of
[WASM-BLOCKERS.md B1](../WASM-BLOCKERS.md#b1-unwinding-is-required-and-stable-wasm-cannot-provide-it)
(`../scripts/build-wasm.py`, whose flags and environment `run.py` imports).
It does not link `thixotrope-ironhorse-wasm`, whose `#[no_mangle]` exports would collide with its own.
`run.py build` seeds its `Cargo.lock` from the repository root's, the lock the product module is built from, so the harness links every crate at the version the product does.

## Layout

| Path | What |
|---|---|
| `src/host.rs` | The product module's `env` imports (`host_exec`, `host_take`, `host_log`, `host_random`) and the `SqlExecutor` and commit-token source `DoStore` and the worker run on, under the product's contract. |
| `src/session.rs` | One `Worker` over one `DoStore` in a thread-local, with the harness's clean begin, container import and export, and stats. |
| `src/suite.rs` | The eight parts of `ironhorse_snapshot::store_suite` against fresh `DoStore`s, one store id each, and the consistent-edit part's row rewrites. |
| `src/lib.rs` | `extern "C-unwind"` exports, every engine-running body under `catch_unwind`, a status plus a message buffer; the four buffer helpers have no path that unwinds. |
| `host/worker.js` | The harness module's Durable Object: lazy instantiation, the `sql.exec` shim answering the product ABI's error codes, the WASI preview1 shim std needs, one `transactionSync` per committing call, the instance dropped after any exception. |
| `host/config.capnp.in` | workerd config for the harness module: one SQLite-backed class, local-disk storage. |
| `host/product.js` | The product module's Durable Object: `host-abi.mjs` over `ctx.storage.sql`, one `transactionSync` per status-answering export call, rolled back unless the status says commit, with fault injection, forced rollback, a storage digest and `ctx.abort()`. |
| `host/product.capnp.in` | workerd config for the product mode, embedding `product.js`, the real `host-abi.mjs` and the product module from their own paths. |
| `run.py` | Build, serve, and the commands below. |
| `export-heap/` | Native: a Thixotrope `heap.sqlite` to its canonical container, with the profile string the importer must present. |

## Running

Toolchain: the pinned Rust (`rust/engine/rust-toolchain.toml`) with `rust-src` and the `wasm32-wasip1` target (from `rust/engine`, so that rustup reads the pin: `rustup component add rust-src` and `rustup target add wasm32-wasip1`), and the `workerd` binary (`$WORKERD`, or `workerd` on PATH; it is the one file of the platform package `@cloudflare/workerd-linux-64`).
`-Zbuild-std` compiles the standard library from `rust-src`, but the link still takes wasi-libc and the crt objects from the target's `rust-std`; `run.py build` checks for both before it starts, as the engine's recipe does.
It is WASI, the product module's target, because the acceptance suite's own sessions draw commit tokens from the engine's default source, which needs a clock and seeded hash keys (the engine refuses on `wasm32-unknown-unknown`); the workers the harness opens draw theirs from `host_random`, as the product's do.

The boot files come from the Thixotrope bundles (`corepack yarn install --immutable`, then `corepack yarn workspace @endo/thixotrope build:ironhorse-bundles`), and the product module from `python3 rust/thixotrope-ironhorse-wasm/build.py` at the repository root.

```sh
cd rust/engine/wasm-worker-spike
python3 run.py build                       # the harness module, two to three minutes cold
python3 run.py --no-build suite            # the acceptance suite, all eight parts
python3 run.py --no-build --keep /tmp/heap boot --boot ../../../packages/thixotrope/dist-ironhorse/boot.js \
    --boot ../../../packages/thixotrope/dist-ironhorse/worker-peer.js --wakes 3
python3 run.py --no-build --keep /tmp/heap export --store 1 --out boot.container
python3 run.py --no-build wake --container boot.container --profile spike --wakes 3
python3 run.py --no-build sweep --wakes 2
python3 run.py product --wakes 3           # the product module, end to end
```

Every command prints one JSON record per measurement and `--json FILE` saves them as they are made; the exit status is 1 when any measurement or check failed.
`--keep DIR` keeps workerd's directory, and with it the object's database, so a later command over the same directory reads what an earlier one wrote.
A record's `*_ms` figures are `performance.now()` deltas around one export inside the object, which workerd reports in whole milliseconds, unless the name says the client measured it (`wall_ms`, `object_first_request_ms`).
A committing call's `sync_ms` is the durable write that follows it (`ctx.storage.sync()`), which the export's own time excludes.
`--idle 15` before each wake lets local workerd evict the object, so the wake re-runs the constructor and reopens the database; a wake record's `object_evicted` says whether it did.
A Thixotrope heap from the native worker (`cargo build --release -p thixotrope-ironhorse-worker` at the repository root, then `yarn demo:ironhorse:counter init <dir>`) becomes a container through `export-heap`:

```sh
cd export-heap && cp ../../../../Cargo.lock . && cargo build --release   # the repository's lock
./target/release/ih-export-heap <state>/heaps/snapshots/<hash>.sqlite vat.container
```

## The suite

`run.py suite` runs the eight parts of `ironhorse_snapshot::store_suite` against the product `DoStore` inside one Durable Object, each part in one `transactionSync`: `sparse`, `checkpoint`, `resume`, `commit`, `edits`, `lazy`, `boundary` and `metamorphic`.
Each fresh store is `DoStore::open` and `reset_for_harness` on a store id of its own, from 1,000 up, in the object's one database.
The `commit` part reopens a store by dropping its handle and opening the same id again, through the stamp check; the `edits` part rewrites each row at rest through the executor between a drop and an open, in the layout `DoStore` keeps.
A part's status is 0 when it passes; a failed assertion comes back as status 2 with the panic text.
Because a part runs in one transaction, its many commits are one transaction; the product commits once per call.

## What the measurements mean

The product worker commits at boot (the bare machine at `Worker::begin`, then the booted heap at ready) and at close, never per request, and a request's crank ends with a collection and the finalizer cascade.
The records follow that shape, so their fields are not the quantities of the design's earlier figures, which came from a private store and crank loop whose crank was `eval` and a checkpoint in one transaction.

- `begin`: `Worker::begin` on a clean store, the first, full commit of a bare machine.
- `boot-file`: one boot source through `Worker::boot` under the bootstrap budget, committing nothing (`boot_ms`).
- `boot-checkpoint`: the one commit of the booted heap, the commit the product's `ih_ready` makes after a fresh open (`checkpoint_ms`, `rows_written`, `sync_ms`).
- `booted`: the committed manifest's geometry and the machine's residency after that commit.
- `wake`: a cold wake of a stored heap: `instantiate_ms` (a new instance of the compiled module), `resume_ms` (`Worker::resume`: migration check, restore, eager or lazy), `request_ms` (one request line through `Worker::respond`: compile, run, promise jobs, collection and finalizer cascade, committing nothing; a lazy worker's `request_rows_read` are the rows it faulted in), `wake_to_reply_ms` (the sum of those three, the time to the first reply), then `close_ms`, `close_rows_written` and `sync_ms` for the close's commit, which comes after the reply.
- `import`: a container restored and written as a store's first commit, through the harness's own route (the core has no import).
- `sweep-build`: one builder request on a fresh store and its commit (`commit_*`, by `Worker::checkpoint`, the commit `Worker::close` makes, taken before the close so that the stats read the committed manifest).
- `suite`: one part's time, rows and statements, as before.

The product mode's records:

- `product-module`: the module's size, uncompressed and gzip level 9, and `workerd_start_ms`, the time from starting workerd to its listening socket (polled every 50 ms), which bounds loading the worker's modules and says nothing about when V8 compiles the wasm's functions.
- `product-probe` and `product-key-types`: what `sql.exec` does with the values `host-abi.mjs` binds and the columns it answers, and the storage class SQLite gave the integer keys the module wrote.
- `product-call`: one status-answering export call in one `transactionSync`, with its status and message, whether it `committed`, whether the instance was `dropped`, `ms` inside the object, `wall_ms` at the client, `rowsRead` and `rowsWritten` from the SQL cursors, `bytesBound` and `bytesReturned` (blob and text bytes passed to and answered by `sql.exec`), and `memory` (`memory.buffer.byteLength`) after the call.
- `product-wake`: after `ctx.abort()` (or an idle with `--evict idle`), a new object's instantiate, a non-fresh open, ready and one request, with `wake_to_reply_ms` their sum inside the object and `object_first_request_ms` the new object's first request at the client.
- `product-digest`: a SHA-256 over every row of the store's tables in key order, so equal digests are equal stored heaps.
- `product-check`: a check that failed; `product-summary` lists them and the tail of workerd's log.

## The product command

`run.py product` opens fresh, boots `boot.js` and `worker-peer.js`, and answers ready; sends an eval, a `deliver` with one outbound frame, a malformed line and `close`, then closes; resets the object and wakes it, eager and lazy, with a request and a close each; forces one successful close to roll back and shows the digest unchanged and a new object resuming the prior commit; runs a crank that exhausts its budget (status 3, then refusals, then a close that answers 1) and shows the digest unchanged; and fails one statement of a close (status 1 with the executor's text) and shows the digest unchanged and a new object resuming the prior commit.
Each answer is checked against what the product's ABI says it must be.

## What the harness does not do

- No OCapN and no routing: `deliver` is exercised with a frame the boot bundles' `thixotropeSend` queues, nothing more.
- No platform limits: local workerd does not enforce the hosted platform's script size, memory or CPU limits, so the records report the module size and linear memory to compare against them, and cannot show the platform refusing either.
- No concurrency: one client drives one object, so input and output gates are never contended.
