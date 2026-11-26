# Thixotrope wasm worker

| | |
|---|---|
| **Created** | 2026-10-14 |
| **Updated** | 2026-11-26 |
| **Author** | Aaron Davis (prompted) |
| **Status** | In Progress |

*A plan, with evidence from a spike, for running the Thixotrope worker on wasm: the worker split
into a host-neutral core and host shells, the heap store ported onto Durable Object SQLite over a
host-import ABI, and the design's Phase 0 numbers measured in local workerd.*

This document answers [WASM-BLOCKERS.md B5](../rust/engine/WASM-BLOCKERS.md#b5-the-worker-binary-is-not-wasm-ready)
("the worker binary is not wasm-ready") and checks
[Thixotrope on Cloudflare](thixotrope-on-cloudflare.md) §6 (the `ironhorse-store-do` port) and
§8 Phase 0 (the go/no-go measurements) against the current code.
Its evidence is the spike under
[`rust/engine/wasm-worker-spike/`](../rust/engine/wasm-worker-spike/README.md), which is checked
in and re-runnable.
Where the [verification review](thixotrope-on-cloudflare-review.md) already corrected the base
design, this document follows the correction and cites it.

## Status

In Progress, as of 2026-11-26.
Phases 1, 2 and 4 have landed, Phase 3 is deferred, and Phases 0b and 5 are blocked; §8 gives
each phase's status.
The body of this document describes the code as it stands, and the deviations below record
where the code departs from the plan and why.

Landed:

- `rust/thixotrope-ironhorse-core` (Phase 1): the host-neutral worker, made of the crank
  (`eval`, `deliver`, the post-crank collection and its finalizer cascade), `WorkerLimits`, the
  NDJSON protocol, and `Worker<S: HeapStore>`, one machine bound to one heap store (§2, §3).
  `rust/thixotrope-ironhorse-worker/src/main.rs` is now the native shell over it.
- `rust/engine/ironhorse-store-do` (Phase 2): `DoStore<E: SqlExecutor>`, the Durable Object
  `HeapStore`, and its `wire` value encoding (§4.3); and
  `rust/endo/ironhorse-store-do-rusqlite`, a rusqlite executor that runs the engine's store
  acceptance suite against `DoStore` on real SQLite.
- `rust/thixotrope-ironhorse-lease` and `rust/thixotrope-ironhorse-wasm-launcher`, which the
  plan did not have: the state directory's kernel leases as a crate both worker binaries share,
  and the native front of the local wasm engine (§6.3).
- `rust/thixotrope-ironhorse-wasm` (Phase 4): the worker as a `wasm32-wasip1` module, the core
  over `DoStore` behind the export ABI that its `src/lib.rs` specifies (§4), built and checked by
  its `build.py`.
- `packages/thixotrope/src/ironhorse/wasm/host-abi.mjs` (Phase 4): the JavaScript half of that
  ABI, shared by every host of the module, with a Node lane that runs the built module over
  `node:sqlite` (§6.3).
- The runtime-identity change in `packages/thixotrope/src/ironhorse/ironhorse-runtime.js`
  (Phase 4): the parts the launcher names are pinned and privately copied, and a state directory
  of one engine is refused by the other (§6.3).
- `rust/engine/wasm-worker-spike/` is now a workerd harness for the product crates and the
  product module rather than a prototype with private copies; §7.6 has its measurements.
- The rest of Phase 4 (§6.3): the Node shell `packages/thixotrope/src/ironhorse/wasm/shell.mjs`,
  staging with `python3 rust/thixotrope-ironhorse-wasm/build.py --stage`, the lane
  `test:ironhorse:wasm` that runs the host's Ironhorse tests under the wasm engine, the CI job
  `test-thixotrope-ironhorse-wasm`, and a section of `packages/thixotrope/README.md` on the
  engine.

### Deviations from the plan as built

- **The heap is committed after a fresh boot and at close, never per crank.**
  The plan reasoned from a worker loop of eval then checkpoint; before Phase 1 began the
  default branch dropped the per-crank checkpoint, because the host recovers a worker from an
  immutable image plus journal replay (§2), so the checkpoint bought no durability and, once
  every crank's collection marked every small-state section dirty, cost a re-encoding of every
  section.
  §2, §4.4, §5.2, §7.5 and §9 are read against this.
- **The core holds the protocol, the limits, delivery and the collection.**
  The plan's core had `eval` and the session calls only; by the time of the split the native
  `main.rs` had grown the `deliver` request, the finalizer cascade, the limits argument and the
  migration at open, and a second shell must produce the same bytes, so the protocol is a pure
  function (`respond(&str) -> Step`) every shell drives.
- **`Worker`, not `Session`, and a failed crank latches it dead.**
  After a failed crank every later crank, checkpoint and close refuses, so nothing the failed
  crank did can be committed by any shell, rather than each shell having to remember not to.
- **A lazy store's failed row read is a host failure.**
  A lazy machine faults rows in mid-crank and a failed read unwinds; the core catches it and
  fails the crank as a host failure (`StoreFault`, restore in a fresh worker) so the unwind never
  reaches a shell.
- **Errors are typed and keep the store's error.**
  `WorkerError` carries the `StoreError` of the step that failed, so a shell can classify it, and
  its text is the native worker's old text, so the native worker's output did not change.
- **The core depends on `serde_json`.**
  The protocol and the limits argument are JSON, and the core parses both.
- **The store takes a statement executor as a trait.**
  §5.3 recommended it to keep the `unsafe` import block out of the engine workspace; it also let
  the whole acceptance suite run natively on real SQLite through
  `rust/endo/ironhorse-store-do-rusqlite`, which sits in the root workspace so that `rust/engine`
  stays zero-C.
- **`DoStore::open` never resets.**
  The spike's `ih_store_open(id, reset)` could empty a store; the product's open stamps only a
  database whose `ih_*` tables are absent or empty and refuses a populated unstamped one before
  any write, so a production open cannot erase or adopt a heap, and the harness resets with
  `DoStore::reset_for_harness`.
- **Migration runs on the Durable Object store.**
  `replace_for_migration` is implemented (§5.2 row 2), because the core runs `migrate_store`
  before every resume, as the native worker does, and a backend that refused it could not
  resume a heap written at an older store schema.
- **A first-wins failure record.**
  `DoStore::record_failure` keeps the first reason recorded, in a host transaction of its own
  after the failed crank's rollback, so the cause of a quarantine outlives that rollback and is
  not overwritten by what failed after it (§4.4).
- **Every committing call plans its writes before the first one runs.**
  Each refusal the store raises itself (the value cap, a framing it cannot store) then precedes
  any write, so a refusal never depends on the host's rollback; and the plan borrows the row
  bytes, so a commit's peak is the batch plus one row.
- **Sections end in a chunk strictly shorter than a full one.**
  The spike cut a section into 1,000,000-byte pieces; the product stores full chunks and then a
  final shorter one (empty when the length is an exact multiple), so a lost chunk is detectable
  wherever it was (§4.3).
- **Integers are integers in Rust and doubles only on the wire.**
  `Value::Integer(i64)` keeps the domain's integers exact, and the `wire` module maps them to the
  doubles `sql.exec` binds, checked both ways, so an inexact value is refused rather than
  rounded (§4.1).
- **The local engine has a native launcher.**
  Node resets inherited `SIG_IGN` dispositions, so the lock helper cannot be Node, and the shared
  lease on `heaps/active.lock` must be held for the worker's whole life by the pid the host
  spawned and later kills, so `thixotrope-ironhorse-wasm-worker` holds the lease and `exec`s
  Node (§6.3).
- **The wasm cdylib moved to Phase 4, with its own build.**
  `rust/engine/scripts/build-wasm.py` builds only the engine workspace's library crates and the
  core is in the root workspace, so the cdylib is built by a script of its own that imports the
  recipe, and Phase 1 landed without it.
- **The runtime identity keeps execution limits out and stays at `format: 2`.**
  The native runtime deliberately keeps limits out of the profile so heaps reopen after a limit
  change, and `format: 2` is already its current format, so the local engine only adds
  `heapFormat` and `parts`, and §6.2's limits-in-the-profile question is left to Phase 3.
- **A close request has a status of its own, and one rule decides every commit.**
  `ih_request` answers 5 for `close`, and a host commits only on status 0 or on 5 from
  `ih_request`; status 1 once meant "close, commit" from `ih_request` and "error, roll back"
  everywhere else, and a host that committed a failed `ih_close` tore the heap beyond recovery.
- **A fresh worker's opening is one host transaction, by rule.**
  With a transaction per call, a failed boot left the bare machine's first commit in place, and
  a later open resumed and served a heap that never booted.
- **Traps and JavaScript exceptions mean status 2, and no import throws.**
  The module cannot catch a trap or a foreign exception, so the host must treat either as a
  poisoned instance; `host_random` therefore answers a status, and a failed fill fails the commit
  that needed the token as an ordinary error rather than throwing across a wasm frame.
- **The module's build is reproducible across locations.**
  The module's SHA-256 is part of the pinned runtime identity, and its bytes first carried the
  checkout's path through panic locations, so `build.py` builds with Cargo's `trim-paths = "all"`
  and fails if the checkout's root, `CARGO_HOME` or the toolchain's sysroot occurs in the module.
- **The launcher passes `--disable-sigusr1` to Node.**
  Without it a SIGUSR1 to the worker's pid makes Node start its inspector on 127.0.0.1:9229, a
  debugger into the heap; with it the signal stays pending and the worker keeps serving, where the
  native worker dies of it, and the host only ever sends SIGKILL.
- **The spike became a harness for the product crates.**
  Its private store and crank loop were replaced by `DoStore` and the core's `Worker`, and a
  second mode serves the product module through the real `host-abi.mjs`, so that the workerd
  evidence is about the code that ships (§7.6).

---

## 1. Summary

- **The store port works, and it is small.**
  A `HeapStore` over Durable Object SQLite, written on the `MemoryStore` pattern the review
  directs a first port to, is under 500 lines of Rust including its six-table schema.
  The engine's whole backend acceptance suite (`ironhorse_snapshot::store_suite`, all eight parts,
  the seven-way metamorphic runner included) passes against it inside a SQLite-backed Durable
  Object in local workerd, with the entire store stack running in wasm.
  The product crate made from it, `rust/engine/ironhorse-store-do`, is larger (its `store.rs` is
  837 lines) and passes the same suite natively on real SQLite and, through the harness the spike
  has become, inside local workerd (§7.6).
- **The worker's host dependencies are four, and all four sit in the shell.**
  `flock` leases, the big-stack thread, file paths and bundled SQLite are what
  `rust/thixotrope-ironhorse-worker/src/main.rs` adds around the engine; the crank loop and the
  protocol now live in the core crate of §3, `rust/thixotrope-ironhorse-core`, on which the
  native worker is built.
  The spike's own copy of `Compiler`, `eval` and `crank_halted`, on which §7.1–§7.4 ran, has
  since been replaced by the core itself.
- **The engine's commit tokens are the embedder's to choose, and the worker must choose them.**
  When the spike began, the default commit-token source (`RandomTokens`,
  `ironhorse-snapshot/src/store.rs`) read the clock and the process id, which the standard
  library does not provide on `wasm32-unknown-unknown`, and the first checkpoint there trapped
  the instance.
  `llm` fixed both while this work was in flight (`34464d6c6`, then `935798807`): an embedder
  now passes its own `CommitTokenSource` when it begins or resumes a session, and `RandomTokens`
  refuses on `wasm32-unknown-unknown` rather than mint tokens that repeat from run to run.
  The spike's source draws from `host_random`, so the worker's tokens come from the platform's
  randomness on every target, and this document carries no engine change.
- **The base design's §6.3 list shrinks.**
  Of its six required changes, the first port needs two (drop the pragmas, no transaction
  statements of its own), the section chunking its item 4 asks for and the review's correction 14
  made mandatory by measurement, and none of
  the other three: with the trait's dense reachability defaults there are no TEMP tables and no
  edge index to rebuild, and the WAL fold has no counterpart.
- **Phase 0 numbers** are in §7, from `run.py` against local workerd, with a re-measurement on
  the product crates and the product module in §7.6.
  Cold wake and commit cost are measured on first boot inside the object, on the SES boot heap
  and on the demo counter vat imported from native heaps; the limits local workerd cannot
  enforce (memory, CPU, the 2 MB value cap) are stated as such.

What this document does not do: it does not resolve the review's blockers 1 (the platform's host
stack), 2 (the 128 MB isolate), 6 (heaps moving between builds) or 7–11 (the hub, delivery,
collection and lifecycle protocols of Addendum A).
It names, for each, what the wasm worker plan depends on.

---

## 2. The worker today, and what is host-specific

`rust/thixotrope-ironhorse-worker/src/main.rs` is one process around one Ironhorse machine and
one SQLite heap.
When this plan was written it was 490 lines (at `863a9957f`, 360 before its tests); by the time
Phase 1 began it was 1,042, and it is now a 244-line shell (128 before its tests) over the core
crate of §3, whose files the table names.
Read from the inside out:

| Layer | Where | What it is | Host-neutral? |
|---|---|---|---|
| `Compiler` | core, `src/compiler.rs` | The `SourceCompiler` the machine uses for `eval` and `Function`, mapping compiler refusals onto the VM's halt vocabulary, a host allocation failure included | yes |
| `eval`, `deliver` | core, `src/crank.rs` | One crank: arm the meter, compile the script under the parse meter, link or relink, run, report the halt; then collect garbage and run the finalizer cascade, at most `FINALIZATION_ROUNDS` (64) sweep-and-notify rounds under one budget of their own. `deliver` (protocol feature `deliver-v1`) is that crank followed by `JSON.stringify(thixotropeTakeOutbound())` under a separate drain budget | yes |
| `crank_halted` | core, `src/crank.rs` | The fatal text of a crank that did not complete, naming a host failure apart from the program's own halts so the host restores rather than records it | yes |
| `WorkerLimits` | core, `src/limits.rs` | `crankBudget`, `bootstrapBudget`, `slotCeiling` and `chunkCeiling`, parsed and validated from one JSON argument; the ceilings are reapplied after every restore, since arena policy is not snapshot state | yes |
| `respond`, `ready_line` | core, `src/protocol.rs` | The NDJSON protocol as a pure function from a request line to a `Step` (`Continue`, `Close` or `Die`) | yes |
| `Worker` | core, `src/worker.rs` | One machine bound to one `HeapStore`: begin, or `migrate_store` then resume, boot, checkpoint, respond, close | yes |
| `open_heap`, `close_heap` | `main.rs` | Open or create the SQLite store; a new file begins, an existing one is migrated and resumed eagerly; close commits and closes the file | the store is host-specific; the session calls are not |
| `run` | `main.rs` | Parse the arguments (heap, profile, active-lease path, limits JSON, boot files), take the shared lease, boot a fresh heap from files and commit it once, then the NDJSON loop over stdio, and commit at close | the protocol and the loop are the core's; the lease, the files and the pipes are not |
| `lock_file`, `supervise_lock` | `rust/thixotrope-ironhorse-lease` | `flock` on the lease files; the `--lock-state` helper that holds the supervisor's exclusive lease | host-specific |
| `main` | `main.rs` | A thread with `NATIVE_STACK_BYTES` of stack, exit codes | host-specific |

The loop does not checkpoint per crank.
A crank's result is answered and nothing is committed: the heap is committed after a fresh boot
and at close (`thixotrope-ironhorse-core/src/protocol.rs`).
The host never resumes a worker from an incarnation's own file; it recovers one from an immutable
image, a closed copy of `heap.sqlite` kept as `heaps/snapshots/<sha256>.sqlite`, plus journal
replay (`packages/thixotrope/src/ironhorse/ironhorse-engine.js`).

The four host dependencies B5 lists each map onto one Durable Object fact:

| Native worker | On a Durable Object |
|---|---|
| Kernel lease (`flock` on `supervisor.lock`), shared active lease per worker, exclusive lease to reclaim incarnations | The platform runs one live instance per object id; single-writer holds by construction, and the control object (Addendum A §8) owns incarnation |
| `std::thread::Builder::spawn` with `stack_size(NATIVE_STACK_BYTES)` | The shadow stack is a link-time size (4 MiB, `-zstack-size`); the host stack is V8's and cannot be raised (review blocker 1) |
| Heap database, boot files and state directory as paths | `ctx.storage.sql` for the heap; boot files bundled with the Worker as text modules; no directory |
| Bundled SQLite C through rusqlite | Durable Object SQLite through host imports (§4) |

Everything in the table's second column is what the spike's host shell does or stubs.

---

## 3. The worker split

```
                         thixotrope-ironhorse-core  (Rust, builds for every target)
                         ┌──────────────────────────────────────────────┐
                         │ Compiler, crank (eval, deliver, sweep),      │
                         │ limits, NDJSON protocol, Worker (begin,      │
                         │ resume lazy or eager, checkpoint, close)     │
                         │ HeapStore consumer only; no I/O, no clock    │
                         └───────┬───────────────────────┬──────────────┘
                                 │                       │
          native shell (main.rs)                 wasm shell (cdylib exports)
          ┌───────────────────────────┐          ┌───────────────────────────┐
          │ flock leases, thread,     │          │ extern "C-unwind" exports │
          │ paths, NDJSON on stdio,   │          │ status + message buffer,  │
          │ SqliteHeapStore (rusqlite)│          │ DoStore over host imports │
          └───────────────────────────┘          └─────────────┬─────────────┘
                                                               │
                                              JS host: Durable Object (production),
                                              or Node with node:sqlite (local engine)
```

The crate layout, as built:

- **`rust/thixotrope-ironhorse-core`** (library, landed): `Compiler`, the crank, `WorkerLimits`,
  the protocol, and `Worker<S: HeapStore>`, which owns the `StoreSession`, the store, the
  signature and the limits and exposes `begin`, `resume` (with `Resume::Eager` or
  `Resume::Lazy`, after `migrate_store`), `boot`, `checkpoint`, `eval`, `deliver`,
  `respond(&str) -> Step`, `close`, `into_store` and `is_dead`.
  `WorkerLimits` is constructible only by `WorkerLimits::parse`, so every one is validated, and
  `WorkerError` names the failed step and keeps its `StoreError`.
  It depends on `ironhorse-vm` (with `consensus`), `ironhorse-compile`, `ironhorse-snapshot` and
  `serde_json`, and its own tests run against `MemoryStore`.
  It has grown well past the spike's `src/session.rs`, which has no protocol, limits, delivery or
  collection.
  A known conformance gap is recorded in its `src/compiler.rs`: there is no
  `compile_eval_units`, so a direct `eval('super.x')` throws a catchable `SyntaxError` where the
  specification gives the value.
- **`rust/thixotrope-ironhorse-worker`** (binary, native, landed): `main.rs` with the crank, the
  limits and the protocol deleted in favour of the core crate, and the leases in favour of
  `rust/thixotrope-ironhorse-lease`; its own tests run against the SQLite store.
- **`rust/thixotrope-ironhorse-wasm`** (cdylib and rlib, wasm, Phase 4, landed): the core over
  `DoStore`, with the import block and the exports of §4, the only `unsafe`, in `src/ffi.rs`
  (the crate denies unsafe code elsewhere).
  Its `build.py` builds it for `wasm32-wasip1` in the root workspace with the B1 recipe imported
  from `rust/engine/scripts/build-wasm.py`, and fails unless the module's imports and exports are
  exactly the lists checked into the script.
  Every engine-running body runs under `catch_unwind`; a result is a status and a message buffer
  the host copies out.
- **`rust/thixotrope-ironhorse-lease`** and **`rust/thixotrope-ironhorse-wasm-launcher`**
  (landed, not in the plan): the kernel leases both worker binaries honour, and the native front
  of the local wasm engine (§6.3).

The ABI between core and shell is the `Worker` type on the Rust side.
Between the wasm shell and its JS host it is §4.

What replaces the kernel lease on a Durable Object is not code: the object id is the lease.
The local wasm engine keeps the kernel leases, held by its launcher (§6.3).
What the native lease protected against, an abandoned incarnation still writing, cannot happen
when the platform guarantees one instance; what it cannot protect against, a host that reuses a
poisoned instance, is the host contract of §4.4.

What replaces the thread's stack is the link: the engine's recursion budget is measured against
`NATIVE_STACK_BYTES` natively and against the shadow stack plus V8's stack on wasm, and
[STACK-DEPTH-REFACTOR.md](../rust/engine/STACK-DEPTH-REFACTOR.md) Phases 1–3 have brought the
accepted programs under workerd's fixed stack for every family but the trapped-Proxy ceilings its
Phase 4 (B10) addresses.

---

## 4. The host-import ABI

The product module's ABI is specified by the crate documentation of
`rust/thixotrope-ironhorse-wasm/src/lib.rs`, which is the authority for every rule this section
summarizes; `packages/thixotrope/src/ironhorse/wasm/host-abi.mjs` is its JavaScript half.
It grew out of the spike's ABI, on which §7.1–§7.4 ran, and the differences are noted where they
matter.
It follows the review's directions for §6.1 (one statement per call, integers as doubles within
u32, error codes instead of throws, no reentrant `tx`).

### 4.1 Imports (module `env`)

| Import | Signature | What |
|---|---|---|
| `host_exec` | `(sql_ptr, sql_len, params_ptr, params_len) -> i32` | Run one statement with the tagged parameters; answer the encoded result's byte length `n >= 0`, or `-1 - m` with the `m` bytes of the error text pending (the spike answered `-1`) |
| `host_take` | `(dst_ptr, cap) -> u32` | Copy whatever is pending (a result or an error) into guest memory the guest allocated; the guest sizes the buffer from `host_exec`'s answer |
| `host_random` | `(dst_ptr, len) -> i32` | Host randomness (`crypto.getRandomValues`), for commit tokens; `0`, or non-zero if the fill failed (the spike's returned nothing) |
| `host_log` | `(ptr, len)` | A diagnostic line |

Values both ways are one tag byte then a payload: null; an f64 (integers travel as doubles, which
is what `sql.exec` binds and returns); a blob (u32 length, bytes); text (u32 length, UTF-8).
A result is a u32 row count, then per row a u32 column count and that many values.
In the spike every integer is a u32, exact as a double by construction.
`ironhorse-store-do`'s `wire` module carries the same encoding with integers as
`Value::Integer(i64)` on the Rust side, and checks the mapping both ways: an integer that no
double represents exactly is refused on encode, and a double that is not an integer or lies
outside the `i64` range is refused on decode.

The module is built for `wasm32-wasip1`, so the standard library also imports six functions from
`wasi_snapshot_preview1` (`random_get`, `clock_time_get`, `fd_write`, `environ_get`,
`environ_sizes_get` and `proc_exit`), which the host shims (with a few more that std may reach
for), answering `ENOSYS` to any other name.
The worker needs none of them: they are there so that the acceptance suite's own sessions, which
draw commit tokens from the engine's default source, can run inside the object (§6.1), and so
that a panic's message reaches the host's log.
The product module imports the same six, although the worker itself reads no clock, environment
or file, and its `build.py` fails the build on any other import.
The same cdylib built for `wasm32-unknown-unknown` has only the four imports above, and the spike
ran on that target until its rebase of 2026-10-15.

Two properties matter more than the encoding:

- **An import never calls back into wasm.**
  Results are handed over in two steps so the host never needs the guest's allocator while a
  guest frame is live.
  No Rust frame is ever re-entered, so no `RefCell` borrow can be held across a host call
  (review correction 12 and C9: the reentrant `tx(fn_id)` is gone).
- **An import never throws through wasm.**
  The JS shim catches every exception from `sql.exec` and returns a negative answer; the Rust
  side turns it into `StoreError::Io`.
  Through an `extern "C"` import a JS exception skips Rust destructors; through
  `extern "C-unwind"` they run (WASM-BLOCKERS, Cloudflare section).
  The spike declares every import and export `extern "C-unwind"` anyway, so that a shim bug
  still unwinds correctly rather than leaving a borrow held.

### 4.2 Exports

The spike's exports, as §7.1–§7.4 ran on them (the harness the spike has become exports a
different set of its own, which nothing outside it depends on):

| Export | What |
|---|---|
| `ih_alloc(len)`, `ih_free(ptr, len)` | Guest memory the host fills (container bytes, source text, names) |
| `ih_message_len()`, `ih_message_copy(dst, cap)` | The pending message of the last export: a result string, an error text, a panic text, or container bytes |
| `ih_store_open(id, reset)` | Create the schema and the stamp; optionally empty store `id` |
| `ih_import(id, bytes, len, profile, len)`, `ih_export(id)` | A store from a container, a container from a store |
| `ih_session_begin(id, profile, len, slots, chunk)` | A fresh machine bound to store `id`, emptied first (the harness's convenience; a production begin keeps the engine's `NotEmpty` guard), with ceilings |
| `ih_session_resume(id, lazy, profile, len, slots, chunk)` | Wake the machine stored in `id` |
| `ih_session_eval(src, len, budget)` | One crank; the completion value is the message; a halt is status 1 with the halt's name, as the worker's `fatal` reply |
| `ih_session_checkpoint()` | Commit the dirty rows; the message is the new epoch |
| `ih_session_stats()`, `ih_session_drop()` | Residency and progress as JSON; release the session |
| `ih_run_suite(name, len)` | One part of the acceptance suite against fresh stores |

Every export that runs the engine answers a status: 0, 1 (a reported error), or 2 (a caught
unwind, with its text); the four buffer helpers (`ih_alloc`, `ih_free`, `ih_message_len`,
`ih_message_copy`) answer a pointer or a length and have no path that unwinds.
The panic hook records a panic's text before the unwind, and a store fault, which the engine
raises with `resume_unwind` past the hook, is read from the payload itself, so an assertion of the
suite, a store fault and an engine invariant all come back by name.

The product module, `rust/thixotrope-ironhorse-wasm`, has a smaller table shaped to the worker
rather than to the harness: `ih_abi_version` (which answers 1); the four buffer helpers;
`ih_open(fresh, lazy, profile, limits)`, which begins a fresh machine or migrates and resumes the
stored one (store id 1) and applies the limits; `ih_boot(name, source)` under the bootstrap
budget; `ih_ready()`, whose message is the ready line and which, after a fresh open, first
commits the booted heap; `ih_request(line)`; and `ih_close()`, which checkpoints the worker in
place and then drops it.
The status-answering exports answer 0 (success), 1 (an error, always rolled back) or 2 (a caught
unwind, which poisons the instance), and `ih_request` also answers 3 (the crank failed; the
message is the `fatal` line and the worker is dead), 4 (refused before anything ran) or 5
(`close` was requested, with no message).
After a status 2 every later status-answering export answers 2 without touching the worker, and
the host drops the instance; a trap or a JavaScript exception out of any export means the same
to the host as status 2, and no further export, not even an allocator one, is called on that
instance.
After a status 3 or 4 the host drops the instance or calls `ih_close` before any new `ih_open`.
The calling sequence and the exact refusals are in the crate documentation.

### 4.3 The store: `DoStore`

The spike's store is now the product crate `rust/engine/ironhorse-store-do`, as
`DoStore<E: SqlExecutor>`; what differs from the spike is stated here.
Six tables, every row keyed by a store id so that several stores share one database (the suite
needs a fresh store per case; a production object holds one; store id 0 holds the database's
stamp and is refused):

```sql
ih_meta        (store, key, value)             -- 'manifest', 'failure'; the 'IRON' stamp under store 0
ih_slot_pages  (store, page, bytes)
ih_chunk_exts  (store, ext, bytes)
ih_free_segs   (store, seg, bytes)
ih_page_edges  (store, page, targets)          -- big-endian u32s, as the SQLite backend stores them
ih_sections    (store, id, chunk, bytes, hash) -- small-state sections in chunks,
                                               -- the whole payload's hash on chunk 0
```

A section of `len` bytes is stored as `len / 1,000,000` full chunks followed by one final chunk
strictly shorter than a full one, which is empty when `len` is an exact multiple (an empty payload
is one empty chunk).
A read therefore detects a lost chunk wherever it was: a gap in the chunk numbers, a chunk after a
short one, or a section whose last chunk is full.
The spike cut sections into 1,000,000-byte pieces with no such final chunk.

`DoStore::open` creates the schema and writes the stamp only in a database whose `ih_*` tables
are absent or empty; it refuses a foreign stamp, or a populated database with none, before any
write, and it never resets a store (`DoStore::reset_for_harness` does, for harnesses).
It learns which `ih_*` tables exist by name from `sqlite_master` and never counts that table's
rows.

`commit_verified` reads the manifest, runs the shared verifier, then plans every write before
the first one runs: upserts for the dirty pages, extents, free segments and edge summaries,
deletes beyond the new geometry, the changed sections (all 34 on the first commit at schema 38,
the batch's updates after), the manifest.
Planning first puts every refusal the store raises itself before any write, and the plan borrows
the row bytes, so a commit's peak is the batch plus one row.
It issues no `BEGIN`: the host runs every committing call inside one transaction of its own and
rolls it back when the call fails (review correction 10; §4.4).
In the spike's host that is one `transactionSync` per export that commits (begin, import, a crank
with its checkpoint), which a failed status makes throw, rolling the callback back.
Every blob and text value is checked against 2,000,000 bytes as it is planned, and refused as
`StoreError::Unsupported`, and the sections are chunked under it, because local workerd accepts
4 MiB and would not catch an over-cap row (review §6 findings).
`replace_for_migration` is built the same way, so `migrate_store` runs on this backend, and
`DoStore::record_failure` keeps a failure record beside the heap (§4.4).

### 4.4 The host contract (the JS side)

What any host of `DoStore` must do is fixed by the crate
(`rust/engine/ironhorse-store-do/src/lib.rs`, "The host contract"):

1. Run exactly one statement per `SqlExecutor::exec`, binding the parameters positionally and
   answering every row the statement produces with exactly its columns, in order; a statement
   that writes answers no rows.
2. Never re-enter the store from `exec`.
3. Run each committing call (`commit_verified`, `replace_for_migration`, `DoStore::open` and
   `DoStore::reset_for_harness`) inside one host transaction, and roll it back when the call
   fails.
   The crate issues no `BEGIN`, `COMMIT` or `SAVEPOINT`, which a Durable Object refuses.
   Within a call every read and every refusal the store raises itself precede the first write,
   so once writing starts only the executor can fail, and the atomicity of a call that fails
   part-way is the host's transaction and nothing else.
4. Write `DoStore::record_failure` in a transaction of its own after the failed one has rolled
   back, so that the failure outlives the crank it describes.
   The first record wins, and a reason over the value cap is cut to fit at a character boundary.

The store also relies on one writer: a commit's read of the stored manifest and its writes are
atomic only inside the host's transaction, which a Durable Object's single thread and input gates
make exclusive.

Which calls commit is the worker's choice, not the store's.
The core commits the heap after a fresh boot and at close and never per crank (§2), so a crank
in a host built on it runs no `commit_verified`.
The product module adds the host's side of that ("The host's transaction" in
`rust/thixotrope-ironhorse-wasm/src/lib.rs`):

- The host runs every status-answering export call inside a host transaction
  (`transactionSync` in a Durable Object; `BEGIN IMMEDIATE` and `COMMIT` over SQLite).
- One rule decides every commit: the host commits only when the status is 0, or 5 from
  `ih_request`, and rolls back on every other status, 1 included.
  `host-abi.mjs` exports it as `commits(exportName, status)`.
- A fresh worker's opening is one transaction, held from a fresh `ih_open` across every
  `ih_boot` through `ih_ready` and committed only if every one of those calls answered 0.
  Every other call, a non-fresh `ih_open` and its `ih_ready` included, is a transaction of its
  own.
- A host that rolls back a successful call's transaction drops the instance, since the machine
  has advanced past what the database holds.

The harness's product mode follows these rules inside a Durable Object
(`rust/engine/wasm-worker-spike/host/product.js`), and the Node shell
(`packages/thixotrope/src/ironhorse/wasm/shell.mjs`) and the module lane's host
(`packages/thixotrope/test/ironhorse-wasm/_sqlite-host.js`) do over `node:sqlite`.
How often a Durable Object worker commits, and so what a crank costs it in rows, is for Phase 5
to decide; nothing beyond the module has been built for it.

The spike's `host/worker.js` is the Durable Object the review's work item 4 describes, and the
measurements of §7.1–§7.4 ran under it as it was then; the harness's `host/worker.js` and
`host/product.js` keep items 1, 2, 4 and 5:

1. The module is a static import, bundled with the Worker (`WebAssembly.instantiate` of bytes is
   refused by workerd).
2. The instance is created lazily inside each handler and kept across events while it is healthy.
   The module exports no `_initialize`: rustc links no crt object into a `wasm32-wasip1` cdylib,
   so it is not a WASI reactor and has no constructors to run; the host would call one once before
   any other export if a build ever exported it.
3. A crank was `transactionSync(() => { eval; checkpoint })`, the spike's choice rather than the
   worker's (above); a halt or a store error throws inside the callback, so SQL rolls back.
   Begin, import and a standalone checkpoint commit the same way, and the durable write that
   workerd performs after the handler yields is waited for and timed (`ctx.storage.sync()`).
4. After any exception from an export, trap or thrown error alike, after any status 2 (a caught
   unwind leaves the machine mid-crank, which the engine says must be rewound), and after any
   failed status from a committing export (its transaction rolled back), the instance is dropped
   and the next event instantiates afresh (WASM-BLOCKERS: a trap poisons the instance
   cumulatively; review blocker 4).
5. Frames and results are copied out of linear memory with `slice()` before the instance can
   touch them again.

What the spike did not implement from that list: the failure row written in a separate
transaction after a halt (Addendum A §6.4 needs it for quarantine; `DoStore::record_failure` is
now the store's half, and no host writes it yet), and
`new_sqlite_classes` wiring for a deployed Worker (local workerd's config uses
`enableSql = true` on the namespace instead).

---

## 5. The store port, checked against the code

### 5.1 The compatibility audit (base design §6.2), verified

Each row of §6.2 against `rust/endo/ironhorse-store-sqlite/src/lib.rs` as it is today:

| Base design row | In the code | Verified disposition |
|---|---|---|
| Tables, composite keys, `WITHOUT ROWID`, `CREATE INDEX` | `meta`, `slot_pages`, `chunk_exts`, `small_state`, `page_edges`, `free_segs`, `side_tables`, `edge_pairs` (WITHOUT ROWID), `edge_pairs_by_page`; `small_sections` created by the first write | Carries over. `small_state` is written only for schemas before 28 and `side_tables` has no reader or writer: both are dead for a current-schema heap, and the port omits them. |
| `ON CONFLICT … DO UPDATE`, `INSERT OR REPLACE` | every upsert in `commit_verified`, `write_small_state`, `rebuild_edge_pairs` | Carries over; the spike uses the same statements. |
| `WITH RECURSIVE` CTEs | `reachable_pages_sql`, `reachable_within` | Legal, but they read TEMP tables (next rows). Not needed by the first port: the trait's dense defaults answer the collectors. |
| Reading `sqlite_master` | the fresh-database gate counts tables | Would refuse an object that ever set an alarm, since `_cf_*` tables are listed (review §6). The spike stamps a `meta` row and never counts tables; `ironhorse-store-do` stamps one too and reads `sqlite_master` only to look up its own `ih_*` tables by name. |
| Blob sizes | slot page ≤ 256 × 20 B, extent 64 KiB, free segment 16 KiB | Under the cap; the spike checks every blob against it anyway. |
| Bound parameters ≤ 3 | at most 5 in the spike and in `ironhorse-store-do` (`ih_sections` insert) | Under the limit of 100. |
| Pragmas and `busy_timeout` | `application_id` read and set; `locking_mode=EXCLUSIVE`, `journal_mode=WAL` and `synchronous=FULL` each read back and refused if the read-back disagrees, `wal_autocheckpoint` and `foreign_keys=ON` set without one; `busy_timeout` through the API | All dropped. The read-back verification is what would make the native backend refuse to open on a Durable Object; the stamp moves to `meta`. `foreign_keys` is allowlisted but the schema declares no foreign key. |
| Transactions | `BEGIN IMMEDIATE; COMMIT;` at open to take the exclusive lock; `unchecked_transaction` in `rebuild_edge_pairs`; `transaction_with_behavior(Immediate)` in `commit_verified` and `replace_for_migration` | All absent in the port: the host's transaction (`transactionSync` on a Durable Object) is the transaction, and nothing in the commit path needs one of its own, since every read precedes every write. |
| `CREATE TEMP TABLE` | `reach_roots`, `gen_targets`, `gen_within`, `gen_roots`; `TEMP TRIGGER`s in tests only | Absent in the port with the dense defaults. If the indexed queries are wanted later, the `json_each` form with `+e.target` (review §6) replaces them. |
| Small-state section payloads | one row per section, whole payload | The 2 MB cap is real: on the demo counter vat the Functions section is 1,548,529 B and the Arrays section 1,388,992 B (`small_sections` of the exported heap, measured). The spike chunks every section at 1,000,000 B with the whole payload's hash on chunk 0; `ironhorse-store-do` keeps the size and the hash and ends every section with a shorter chunk (§4.3). |
| `rebuild_edge_pairs` on every open | only when the `edge_pairs_epoch` marker does not name the committed epoch (issue #1330) | Already conditional natively. The port has no `edge_pairs` at all until the CTE overrides are wanted. |
| `close()` WAL fold | `Connection::close` | No counterpart; `export_to_container` is the portable image. |

### 5.2 The required changes (base design §6.3), re-sized

| § 6.3 item | Needed by the first port? | Size | Note |
|---|---|---|---|
| 1 Pragmas | yes | S | Done in the spike and in `ironhorse-store-do`: no pragma, stamp in `meta`. |
| 2 Transactions as `transactionSync` callbacks | yes, as "no transaction statements" | S | Done in the spike and in `ironhorse-store-do`. `commit_verified` already orders reads before writes natively (`lib.rs:1106` on, its transaction at `:1117`), so nothing is restructured. `ironhorse-store-do` also implements `replace_for_migration` with plain statements inside the host's transaction, so `migrate_store` runs on it, for store schemas from 28, the first sectioned one. |
| 3 TEMP tables → `json_each` | no | — | Dense defaults. Revisit when a heap's edge set makes the dense reachability read (`page_edges` whole) the wake's cost. |
| 4 Section size | yes | S | Done in the spike, by `(id, chunk)` with the hash on chunk 0, and in `ironhorse-store-do` with a final chunk strictly shorter than the rest (§4.3). The review is right that chunking does not fix commit cost: a changed section is still re-encoded and rewritten whole, so the Functions section (1.5 MB) is rewritten by every commit since which a function was defined. Every crank's collection marks every section dirty, so each commit also re-encodes and hashes all of them to find the changed ones. §7 measures the spike's per-crank commits. |
| 5 Edge-index rebuild | no | — | Already conditional natively; absent in the port. |
| 6 Close and handoff | no | — | `export_to_container` exists; PITR is the platform's. |

### 5.3 New crate, or the SQLite backend behind a SQL trait?

Two ways to get `ironhorse-store-do`:

- **A new crate on the `MemoryStore` pattern** (the spike): the eight required `HeapStore`
  methods plus `small_section_hashes`, which has a default, under 500 lines, no transaction
  statements, no index.
  As built, with `replace_for_migration`, the failure record and the planned writes,
  `ironhorse-store-do`'s `store.rs` is 837 lines.
- **Refactor `ironhorse-store-sqlite` behind a SQL-execution trait** with two backends, rusqlite
  and the host imports: one implementation of the schema and the commit, the CTE overrides for
  free.

Recommendation: **the new crate**, placed in `rust/engine` beside the snapshot crate, which
requires `forbid(unsafe_code)` (the SQLite backend's workspace placement note explains why).
The spike's `DoStore` has no `unsafe` of its own but calls `host::exec`, whose
`extern "C-unwind"` import block is `unsafe`; the crate therefore takes its statement executor as
a trait (`exec(sql, params) -> rows`), and the import block, the only `unsafe`, stays in the wasm
cdylib beside the exports.
That is what was built: `rust/engine/ironhorse-store-do` defines `SqlExecutor` and
`DoStore<E: SqlExecutor>`, and the trait also let a native executor,
`rust/endo/ironhorse-store-do-rusqlite`, run the acceptance suite against the store on real
SQLite from the root workspace.
Reasons:

1. The two backends want different schemas: the native one keeps `edge_pairs` and its marker, the
   exclusive lock and the WAL discipline, none of which has a Durable Object meaning; the port
   wants chunked sections and a store id.
   A shared trait would carry both sets of differences as flags.
2. The native backend's correctness rests on its transactions (`BEGIN IMMEDIATE` at open, the
   migration's single write); the port's rests on the host's.
   Sharing the commit body would hide which contract each line relies on.
3. The acceptance suite is the parity instrument, and it already runs against both (§7.1).
   Two small backends under one suite is the design the store seam intended
   ("runs the same instrument rather than a hand-copied subset", `store_suite.rs`).

The CTE overrides can be ported later as `json_each` queries without changing the trait.

---

## 6. The engine, the profile and the local engine

### 6.1 Engine changes the port needs

- **Commit tokens come from the embedder** (`ironhorse-snapshot/src/store.rs`).
  The default source, `RandomTokens`, reads the clock and keys a hasher from the standard
  library's `RandomState`.
  On `wasm32-unknown-unknown` the clock is the stub that panics with "time not implemented", and
  the hasher keys come from memory addresses that repeat from one run of a build to the next, so
  without the clock every run would mint the previous run's tokens and a lost lineage could pair
  with a copy of its store at its next commit.
  When the spike began, the first checkpoint on that target trapped the instance; `llm` fixed it
  in flight (`935798807`, after `34464d6c6` had replaced the process-id read on WASI):
  `begin_store_session_with_tokens` and `begin_shared_store_session_with_tokens` take the
  embedder's `CommitTokenSource` for a new store, `StoreSession::set_token_source` (no longer
  test-only) gives one to a resumed session, `next_token` returns a `Result`, and `RandomTokens`
  refuses on `wasm32-unknown-unknown` with `StoreError::TokenSource`, which reaches the commit
  that asked for it and writes nothing.
  The spike's `HostTokens` draws sixteen bytes from `host_random` per token and is installed on
  every session the worker owns, on both targets; a container import goes through
  `from_snapshot_bytes` and a begin with that source, because `import_from_container` draws from
  the default.
  A production worker does the same, which is why `host_random` is in the ABI; WASM-BLOCKERS
  ("What builds today") records the refusal and the embedder's route.
- **B1** (unwinding): the official build recipe landed on `llm` as `scripts/build-wasm.py`
  (`RUSTC_BOOTSTRAP=1`, `-Zbuild-std=std,panic_unwind`, `-C panic=unwind`, exnref, a 4 MiB
  shadow stack, `consensus`; overflow checks come from the `release` profile), and CI's
  `build-ironhorse-wasm` job builds the
  engine's runtime crates for both wasm targets with it and runs the WASI snapshot tests, which
  is B6's gate.
  The script builds the engine workspace's library crates only, `ironhorse-store-do` among them
  since Phase 2; the worker core lives in the root workspace and is not among them, and the
  product module is built by `rust/thixotrope-ironhorse-wasm/build.py`, which imports this
  recipe.
  The spike, now the harness, imports the recipe's flags and environment from that script, as
  `stack-lanes/build_probe.py` does, and builds its cdylib for `wasm32-wasip1`.
  A cold build of the module is two to three minutes with the standard library rebuilt; a warm
  rebuild of the spike alone is 16 seconds.
- **B7 and B8** (determinism and memory) are prerequisites for a shared heap format and for
  ceilings that mean anything under 128 MB; they do not block the port itself.
  Since the measurements, `llm` landed the declared admission widths and the decode hardening
  (all four of B7's families of sites are now closed; its latent issues, among them ceilings
  raised to exactly the consensus caps, remain), the consensus ceiling caps (`27fa0d8e6`:
  44,739,242 slots and 2^29 bytes of chunks, above which `set_slot_ceiling` and
  `set_chunk_ceiling` now refuse; `WASM-MEMORY.md` asks for 2^23 and 2^28, which has not landed),
  the memory model (`WASM-MEMORY.md`: 4 MiB of chunks and 262,144 slots for a 128 MB isolate) and
  `Halt::HostAllocationFailed` for a host allocator's refusal.
  The spike applies its ceilings through the fallible setters and otherwise runs under the engine
  defaults; §7's series predates these changes, and the spot check after the rebase agrees with
  it.
- **Lazy resume** (review blocker 3): the spike measures it (§7.3); the five fixes the review
  lists (work item 8: deferred side-table validation, checkpoint checks of reused or grown slots
  only, a sparse chunk arena, free-list dirty bits, a persisted ledger) are engine work this plan
  depends on for a "go" on latency.

### 6.2 A platform-neutral runtime profile

Today `packages/thixotrope/src/ironhorse/ironhorse-runtime.js` hashes the worker executable into
the profile (`identity.worker = sha256(binary)`), and `Signature::new(profile)` plus the engine's
boot fingerprint is what resume checks (`ironhorse-snapshot/src/format.rs`, `is_compatible_with`).
A heap written by the native worker therefore refuses to resume under the wasm module, and the
spike had to present the native profile string to import the demo vat (as the review's
verification did, correction 4).

Proposal, the review's work item 5 made concrete, for Phase 3 (deferred).
The native identity is already `format: 2` (`{ format, hostProtocol, worker, bootstrap }`), so a
platform-neutral one is `format: 3`:

```js
const identity = {
  format: 3,
  hostProtocol: 'sequenced-hub-outbox-v1',
  engine: { bootFingerprint, costTableVersion, storeSchema },   // from the engine, not the binary
  bootstrap: hashes,                                            // the boot files
  crankBudget,
  ceilings: { slots, chunkBytes },
};
```

- `bootFingerprint` is `Interp::boot_fingerprint()` (already in the signature's boot half, so the
  host string stops duplicating it under another name); `costTableVersion` is
  `ironhorse_vm::COST_TABLE_VERSION`, which resume already refuses to cross; `storeSchema` is
  `STORE_SCHEMA_VERSION`.
  The native worker and the wasm module of one engine commit then share a profile, and so can
  share heaps, once B7's divergence sites are closed.
- The ceilings belong in the profile because they are part of execution acceptance (a program that
  halts at a ceiling on one host and completes on another is a divergence).
  The native runtime decided the other way for its identity: execution limits are deliberately
  kept out of it, so that the same heaps reopen after a limit change, and `runtime.json` records
  them beside the identity, where `checkSavedManifest` refuses only a heap ceiling that decreases
  (`ironhorse-runtime.js`; `heapCeilingNames` in `ironhorse-limits.js`).
  Phase 3 has to reconcile the two before the budget and the ceilings go into a shared profile.
- The snapshot signature needs no change: `Signature { host, boot }` already carries the boot
  fingerprint, and `host` becomes the hash of the identity above.
  A `format: 3` profile refuses a `format: 2` state directory by the existing version check of
  `runtime.json` (`assertRecordVersion`), which is the right outcome: those heaps are pinned to
  the binary that wrote them.

Until Phase 3, the local engine keeps `format: 2` and adds to the identity only what tells the
engines apart (§6.3), so no heap moves between them.

### 6.3 A local wasm engine

Thixotrope does not go through the Rust daemon's `engine_for_spawn_request`
(`rust/endo/src/engine.rs`, which knows `separate`, `shared` and `node`); its `makeIronhorseEngine`
(`packages/thixotrope/src/ironhorse/ironhorse-engine.js`) spawns `workerBinary` directly and
speaks NDJSON to it.
So the cheapest local wasm engine is a second host shell for the same module: a Node script that
loads the cdylib, implements the four imports over `node:sqlite` (built into Node 22) with the
`DoStore` schema, and speaks the worker's NDJSON protocol on stdio.
`workerBinary` is spawned at two sites.
`acquireIronhorseRuntime` (`packages/thixotrope/src/ironhorse/ironhorse-runtime.js`) runs it as
the lock helper, `/bin/sh -c 'trap "" TERM INT HUP; exec "$0" "$@"' <binary> --lock-state <state>`,
so that the helper ignores the termination signals a service manager sends the whole process
group (ignored dispositions survive `exec`, and the binary forbids the unsafe code a handler would
need); it then hashes the file into the profile and copies it to `runtime/<profile>/0`.
`ironhorse-engine.js` runs the copy as
`<copy> <heap.sqlite> <profile> <heaps/active.lock> <limits JSON> <boot files...>`, the limits
being `crankBudget`, `bootstrapBudget`, `slotCeiling` and `chunkCeiling`
(`ironhorse-limits.js`).

The plan put a Node script at both sites.
Two facts rule that out:

- Node resets inherited `SIG_IGN` dispositions, so a lock helper running as Node would honour the
  termination signals the shell wrapper set it to ignore.
- The shared `flock` lease on `heaps/active.lock` must be held for the worker's whole life by the
  process the host spawned and later kills, and Node has no `flock`.

The local engine therefore has a native front, which has landed.
`rust/thixotrope-ironhorse-wasm-launcher` builds the binary `thixotrope-ironhorse-wasm-worker`,
which accepts exactly the native worker's two invocations, so the host chooses the engine by
binary path alone (`THIXOTROPE_IRONHORSE_WORKER`) and `ironhorse-engine.js` does not change.
With `--lock-state` it is the lock helper itself, on the same `rust/thixotrope-ironhorse-lease`
code as the native worker, and its `locked` line names the heap format and the absolute paths of
the three parts it expects beside itself:
`{"op":"locked","heapFormat":"do-v1","parts":[…]}`, listing
`thixotrope-ironhorse-wasm-shell.mjs`, `host-abi.mjs` and `thixotrope_ironhorse_wasm.wasm` in
that order (the native worker prints `{"op":"locked"}`).
As a worker it takes the shared lease, clears close-on-exec on it, and `exec`s `$THIXOTROPE_NODE`
(by default `node`) with `--disable-sigusr1` and `--disable-warning=ExperimentalWarning` on the
shell beside itself,
passing `--lease-fd=<fd>` and the worker's own arguments, so the lease outlives the launcher's
image and the pid the host kills is the pid running the worker.
It drops `NODE_OPTIONS` from Node's environment, and its documentation states the trust
boundary: the Node binary is not part of the pinned runtime identity, so whoever controls the
daemon's environment controls which Node runs the worker.

Landed with it:

- `rust/thixotrope-ironhorse-wasm`, the module of §3 and §4.
- `packages/thixotrope/src/ironhorse/wasm/host-abi.mjs`: the host imports, the WASI shims, the
  value encoding, the commit rule (`commits`) and the export wrapper (`makeHostImports`,
  `makeWasiImports`, `makeExports`), with no imports and no Node globals, so that the Node shell
  and a Durable Object host share it.
  Its unit tests are `packages/thixotrope/test/ironhorse-host-abi.test.js`, and the lane
  `test:ironhorse:wasm-module` (`packages/thixotrope/test/ironhorse-wasm/module.js`) drives the
  built module over `node:sqlite` and compares its replies byte for byte with the native
  worker's.
- The runtime identity in `ironhorse-runtime.js` gains `heapFormat` and `parts` (each part's
  basename and SHA-256, sorted) only when the `locked` line carries them, so the native identity
  and every existing native profile stay byte-identical and `format` stays 2.
  Every part is copied privately into `runtime/<profile>/`, as the launcher and the boot files
  are; part names must be unique ignoring case, so that two parts cannot share one private copy
  on a case-insensitive filesystem; a state directory written by one engine is refused by the
  other by its `heapFormat` in `checkSavedManifest`, before any code identity is compared; and a
  part that differs from `runtime.json` is refused by name.
- `packages/thixotrope/src/ironhorse/wasm/shell.mjs`, the Node shell.
  It opens the heap file with `node:sqlite`'s `DatabaseSync` in `journal_mode=DELETE`, read back
  and required, with `synchronous=FULL`, and runs every export call inside `BEGIN IMMEDIATE` and
  then `COMMIT` or `ROLLBACK` as `commits` decides, with a fresh open, its boots and ready as one
  transaction (§4.4); a failed fresh boot removes the heap file.
  Before it opens an existing file it reads the SQLite header, refusing a file that is not SQLite
  or is in WAL mode (a native heap), and then requires the `IRON` stamp.
  It refuses a lease descriptor that is not open on the lease file, reads and writes fd 0 and
  fd 1 synchronously, backing off on `EAGAIN`, and ends every failure in exactly one
  `worker failed: <text>` line and exit status 1.
  It needs Node 22.16.0 or later (`MIN_NODE_VERSION`): `node:sqlite` is unflagged from 22.13.0,
  `StatementSync#setReturnArrays` exists from 22.16.0 and `--disable-sigusr1` from 22.14.0.
  It has run on Node 22.23.5 and 24.22.3 only; that 22.16.0 to 22.23.4 accept the module's exnref
  encoding is inferred from their identical V8 version, and a compile failure is reported as such
  at startup.
- Staging: `python3 rust/thixotrope-ironhorse-wasm/build.py --stage [DIR]` builds the module and
  the launcher and installs the four files side by side in DIR (by default
  `target/thixotrope-ironhorse-wasm/`): `thixotrope-ironhorse-wasm-worker`,
  `thixotrope-ironhorse-wasm-shell.mjs`, `host-abi.mjs` and `thixotrope_ironhorse_wasm.wasm`.
- The lane `test:ironhorse:wasm` (`packages/thixotrope/ava.ironhorse-wasm.config.mjs`) runs the
  13 files of `packages/thixotrope/test/ironhorse/`, unmodified, with
  `THIXOTROPE_IRONHORSE_WORKER` pointing at the staged launcher, and then
  `test/ironhorse-wasm/runtime-identity.js`, `shell.js`, `shell-failures.js`,
  `engine-mismatch.js` and `node-version.js`.
  `THIXOTROPE_IRONHORSE_WASM_WORKER` and `THIXOTROPE_IRONHORSE_NATIVE_WORKER` override the
  lanes' launcher and native worker.
  CI's job `test-thixotrope-ironhorse-wasm` stages the engine and runs this lane and the module
  lane, on the Node of the repository's `.node-version` (`lts/*`).
- Phase 4's exit criterion is met: the 13 files pass under both engines, 55 tests each, on the
  implementer's run and again on the final tree, where the wasm lane's 81 tests (those 55 and the
  26 of the engine's own files) all pass.
  One of them changed, in its time budget only: the supervisor test that installs the counter
  example through the CLI went from 60 s to 120 s, since it took about 47 s native and 70 s under
  wasm on four shared cores.
  On that machine the wasm lane took about 40 minutes against 28 for the native lane, and the
  per-file sums ran from 1.3 to 1.7 times native.

Known differences from the native worker, found by an independent review and left as is:

- Node resets inherited ignored signal dispositions (except SIGPIPE and SIGXFSZ), so a wasm
  worker started with SIGHUP, SIGINT or SIGTERM ignored dies of them where the native worker
  survives; the host stops workers with SIGKILL, which neither can ignore.
- The wasm heap is not locked exclusively.
  A second worker opened on a live heap is detected only at close (`checkpoint: EpochMismatch`,
  the heap staying the first closer's and consistent), and an outside reader holding a read
  transaction makes the close fail with "database is locked", where the native worker refuses
  the second opener at open; the host gives each incarnation its own directory, so neither
  arises there.
- A worker SIGKILLed during a fresh boot leaves a file a later start refuses rather than serves,
  and does not boot fresh again; the host discards the incarnation directory.
  The native worker in the same situation restarts as ready over a machine that never booted, a
  native defect recorded here and not fixed.
- An unrelated rollback-journal SQLite database with a hot journal beside it is rolled back by
  SQLite itself before the shell refuses it; every other foreign file is refused untouched, where
  the native worker converts any file it opens to WAL.
- Two shells started fresh on one path between the existence check and the open can delete each
  other's unbooted heap; the host never starts two workers on one heap path.
- Staging replaces the four files one at a time, not as a set, so stage while no host is
  acquiring the directory.
- Not executed: Node releases before 22.23.5 or newer than 24.22.3 (`lts/*` moves), the CI job on
  a real hosted runner, a read-only heap or directory, a full disk, and a module panic (status 2)
  through the shell process.

The review also measured, under both engines where it applies: 15 SIGKILLs during the close's
commit, 3 of which left a hot journal, each reopened as exactly the machine before or after the
close; a 64 MiB request line gives the same fatal line under both engines; and resuming a 27 MB
heap takes about 0.5 s under wasm against 0.2 s natively.

This defers Phase 3: no profile is shared between the engines, and no heap moves between them.

What it is for:

- a determinism cross-check: the same vat driven natively and under wasm, with the B6 differential
  comparing results and computrons crank by crank;
- the daemon's `-e wasm` (`endor.rs` lists it as a future engine; not part of Phase 4): with the
  Node shell in place, a `wasm` platform in `engine_for_spawn_request` is
  `Engine::Separate` with that command, since `proc.rs` already spawns any command on fd 3/4;
- the `store-suite` under `node:sqlite` as a second host for the port's parity.

It is not a substitute for workerd measurements (V8 tiers, isolate limits), only a cheaper
harness.

---

## 7. Phase 0: what the spike measured

Everything here was produced by `rust/engine/wasm-worker-spike/run.py` against local workerd
1.20260923.1 (the `@cloudflare/workerd-linux-64` binary) with the module built from the engine at
`204033b39` plus the token fix that `935798807` has since superseded, on a 4-core container.
The streaming snapshot writer that landed on `llm` afterwards (`a6b452a58`) serves
`MachineSnapshot::write_snapshot`, not the paths measured here: its commit keeps `snapshot_image`
and `write_machine` for the store's first full commit and for images, and `export_to_container`
goes through the image.
After the rebase onto `863a9957f` (the embedder-chosen tokens, the declared widths, the consensus
caps and the memory model of §6.1) the suite's eight parts pass again on the `wasm32-wasip1`
module, and a spot check of §7.2 on the rebuilt module has the series' shape with less CPU: the
two boot cranks took 1,077 and 872 ms (1,404 and 965 in the series) with checkpoints of 73 and
96 ms, to 64.1 MiB, for a slightly larger heap (164,118 slots and 2,257,515 bytes of chunks)
from the engine's changes since; lazy cold wakes of it resumed in 123–155 ms and ran the drain
crank in 7–9 ms with a 48–49 ms checkpoint, and eager ones resumed in 111–130 ms.
The native containers of §7.3 were written by the engine at `204033b39` and no longer import
(`BootLayoutMismatch`: review blocker 6, heaps across builds, met in practice), so their rows are
not re-run.
The tables below are the original series.
Local workerd enforces no memory or CPU limit, caps values at 4 MiB rather than 2 MB, and advances
`Date.now()` during execution; the review's "What Phase 0 needs" lists what only a deployed Worker
can settle, and nothing below is a production figure.
Times are `performance.now()` deltas around one export call, inside the object, which workerd
reports in whole milliseconds, so a figure under about 10 ms carries a millisecond of
quantization.
No checkpoint figure below includes the durable write: `transactionSync` stages the rows, and
workerd writes them to storage after the handler yields (its output gate), outside every measured
window.
The harness now waits for that write (`ctx.storage.sync()`) and times it apart: on the spot check
it was 28 ms after each boot crank's checkpoint (about 1,350 rows), 3–13 ms after a wake's
(12 rows) and 2–3 ms after `begin`, on local disk; what the platform's storage costs is a Phase 0b
figure.

### 7.1 The acceptance suite

`python3 run.py suite`, every part inside one `transactionSync`:

| Part | Status | Wall time | Rows read | Rows written | Statements |
|---|---|---|---|---|---|
| sparse | pass | 190 ms | 1,397 | 401 | 627 |
| checkpoint | pass | 50 ms | 612 | 91 | 245 |
| resume | pass | 20 ms | 212 | 84 | 136 |
| commit | pass | 55 ms | 761 | 192 | 337 |
| edits | pass | 142 ms | 438 | 117 | 226 |
| lazy | pass | 38 ms | 341 | 180 | 241 |
| boundary | pass | 71 ms | 636 | 252 | 408 |
| metamorphic | pass | 4,269 ms | 129,684 | 15,920 | 44,250 |

The metamorphic part runs 21 scenarios (eight seeded symbol-churn runs and thirteen named ones,
from globals to an uncoercible completion) seven ways each (uninterrupted, from a blob, eager
store, lazy store with three eviction schedules, checkpoint every crank) and compares results,
computrons after every crank and final bytes; it also runs the suspend-subset scenario through
sixteen suspend schedules four ways, and the halting-crank scenario twice.
`lazy` is the working-set bound: after a lazy resume of a wide store, a crank touching one global
leaves at least three quarters of the slot pages non-resident; it passes, so the store faults
pages on demand through the host imports as it does through rusqlite.

### 7.2 First boot inside the object

`python3 run.py boot --boot boot.js --boot worker-peer.js --wakes 3 --crank <drain>`: a fresh
machine bound to an empty store (`ih_session_begin`), then each boot file as one crank with the
worker's boot
budget, each crank in its own `transactionSync`, then cold wakes of the result.
The boot files are the ones `packages/thixotrope` ships the native worker
(`dist-ironhorse/boot.js`, 591,324 B: the codec polyfills, the Ironhorse prelude, `ses` and
`lockdown`; `worker-peer.js`, 1,224,240 B: the OCapN worker peer).

| Step | Wall time | Rows written | Statements | Linear memory after |
|---|---|---|---|---|
| Instantiate the module | 3 ms | — | — | 7.1 MiB (7,405,568 B, of which 4 MiB is the shadow stack) |
| Begin the session (schema, stamp, epoch 1) | 65 ms | — | — | 7.4 MiB |
| `boot.js`: compile, run, drain promise jobs | 1,404 ms | — | — | — |
| its checkpoint (epoch 2) | 66 ms | 1,397 | 716 | 28.3 MiB |
| `worker-peer.js`: compile, run, drain | 965 ms | — | — | — |
| its checkpoint (epoch 3) | 109 ms | 1,333 | 685 | 62.4 MiB |

The booted heap is 163,701 slots in 640 pages and 2,248,761 bytes of chunks: the same geometry
the native worker produces from the same files (its SQLite store, exported, is a 7,730,152-byte
container), and the import of that native container (§7.3) resumes to the same `meter`
(224,006,565,544 raw units) as the heap booted here.
So first boot inside the object is 2.4 s of CPU under Liftoff and V8's tiers, plus 0.2 s of
commit, and it writes 2,730 rows over two checkpoints, one per boot file; the native worker
checkpoints once after both, so its one commit is smaller than these two together, while the
geometry and the meter are the same either way.
Linear memory after boot, 62.4 MiB, sits under the review's "67–83 MiB for first boot, export and
import" range (*Node*, with an 8 MiB shadow stack where the spike's is 4); it never shrinks, so a
worker that boots in the object and then serves cranks starts from there.

### 7.3 Cold wake: the SES boot heap and the demo counter vat

`python3 run.py wake --container <heap>.container --profile <profile> --wakes 3 --crank <drain>`:
import the native heap's container into the store (`ih_import`, once), then for each of three
lazy and three eager wakes drop the session and the instance, instantiate, resume, run the
worker's drain crank (`--crank 'JSON.stringify(thixotropeTakeOutbound())'`, the second eval of
every delivery; the harness's default crank is `1 + 1`) and checkpoint it.
The two heaps are the native worker's SES boot heap (the heap of §7.2 written natively,
7,730,152 B as a container, 640 pages) and the demo counter vat after two `incr` deliveries
(`yarn demo:ironhorse:counter`, 19,365,066 B, 1,241 pages, epoch 28), exported from their
SQLite stores by `export-heap`.

**Import** (the one-time cost of moving a native heap into the object):

| Heap | Container | Import | Rows written | Statements | Linear memory after |
|---|---|---|---|---|---|
| SES boot heap | 7,730,152 B | 239 ms | 2,718 | 1,400 | 40.5 MiB |
| counter vat | 19,365,066 B | 468 ms | 5,344 | 2,713 | 122.5 MiB |

Import holds the container bytes, the decoded image and the epoch-1 batch at once, so it costs
about six times the container in linear memory: the counter vat's import alone reaches the
128 MB isolate limit.
This is the review's correction 4 (export and import at 3–3.5× in Node, 4.3× with the rows kept)
measured on the Durable Object.
The streaming writer that has since landed on `llm` (`ironhorse-snapshot/src/stream.rs`) does not
serve `export_to_container`, which still builds the image, so both sides of the container path
need that treatment.

**Cold wake** (instance dropped between wakes; the object and its database stay open; medians of
three):

| Heap | Resume | Instantiate | Resume | Rows read | Resident after resume | Drain crank | Checkpoint | Rows written | Wake total | Memory after resume / after crank |
|---|---|---|---|---|---|---|---|---|---|---|
| SES boot heap | lazy | 2 ms | 123 ms | 1,406 | 631 of 640 pages | 6 ms | 46 ms | 12 | 174 ms | 22.6 / 30.9 MiB |
| SES boot heap | eager | 2 ms | 149 ms | 1,386 | 640 of 640 | 5 ms | 70 ms | 12 | 223 ms | 30.1 / 35.0 MiB |
| counter vat | lazy | 13 ms | 594 ms | 3,009 | 1,196 of 1,241 | 100 ms | 107 ms | 15 | 818 ms | 42.4 / 62.5 MiB |
| counter vat | eager | 15 ms | 646 ms | 2,809 | 1,241 of 1,241 | 73 ms | 83 ms | 15 | 868 ms | 63.6 / 81.7 MiB |

Spread across the three wakes of each row: the boot heap's lazy resume ran 119–172 ms and its
eager 146–154 ms; the vat's lazy 425–610 ms and eager 576–706 ms.
"Wake total" is its own median of instantiate plus resume plus the crank's transaction, so it
does not sum from the other columns' medians; the series was taken before the harness waited for
the durable write, so none of it is that write.
No record of today's harness holds it: a wake record's `crank_total_ms` is the crank's
transaction plus that write, so the table's figure is `instantiate_ms + resume_ms +
crank_total_ms - sync_ms`.
"Rows read" counts every statement's rows: a lazy fault reads the manifest and then the page, two
rows and two statements, so a resume's rows read are about twice the pages it faulted, as with the
native SQLite store.

**Evicted-object wakes** (`--idle 15`): local workerd evicts an idle object between 5 and 12
seconds of quiet (a probe read the object's age through `/memory`: 5,003 ms after 5 s, 0 ms after
12 s; the harness now records that age on each wake's first request as `object_evicted`, and that
request's wall time: 3.0–3.5 ms for an evicted object against 1.2–1.6 ms warm, the object's own
construction and database open), so a wake after 15 s of idle re-runs the constructor and reopens
the database.
Two such wakes per mode gave the same figures as the instance-swap wakes above, with identical
rows and memory: the boot heap's lazy resume 147–241 ms and eager 145–264 ms, the vat's lazy
454–690 ms and eager 560–705 ms.
In local workerd, then, the object's own wake is free next to the engine's resume; what
production adds (a cold isolate, storage on another machine) only a deployed Worker shows.

### 7.4 Synthetic heaps

`python3 run.py sweep --wakes 2`: five one-crank heaps built on fresh stores under the engine's
default ceilings, each checkpointed, then two lazy and two eager wakes, each a `1 + 1` crank (the
harness's default; these heaps have no worker peer to drain).

**Build** (one crank, then its checkpoint; memory is linear memory after the eval and after the
checkpoint):

| Heap | Program | Slots / pages / chunk bytes | Build | Checkpoint | Rows written | Memory after eval / checkpoint |
|---|---|---|---|---|---|---|
| objects-50k | 50,000 `{v, w}` objects kept in an array | 150,946 / 590 / 1,091,096 | 657 ms | 69 ms | 2,408 | 20.8 / 31.2 MiB |
| array-500k | 500,000 integers pushed onto one array | 946 / 4 / 13,316 | 2,478 ms | 831 ms | 54 | 33.9 / 112.9 MiB |
| map-100k | 100,000 `Map` entries | 976 / 4 / 13,316 | 736 ms | 279 ms | 38 | 21.7 / 43.6 MiB |
| strings-16m | one string doubled from 8 to 2^24 code units | 947 / 4 / 67,122,252 | 424 ms | 182 ms | 2,078 | 248.6 / 248.6 MiB |
| closures-20k | 20,000 closures kept in an array | 280,947 / 1,098 / 173,316 | 408 ms | 190 ms | 4,417 | 36.4 / 50.1 MiB |

**Wake** (medians of the two wakes per mode):

| Heap | Resume | Resume | Rows read | Resident after resume | Checkpoint of the wake's crank | Memory after resume |
|---|---|---|---|---|---|---|
| objects-50k | lazy | 74 ms | 1,224 | 590 of 590 pages | 14 ms | 17.3 MiB |
| objects-50k | eager | 80 ms | 1,250 | 590 of 590 | 29 ms | 23.2 MiB |
| array-500k | lazy | 802 ms | 63 | 4 of 4 | 132 ms | 103.6 MiB |
| array-500k | eager | 912 ms | 57 | 4 of 4 | 171 ms | 103.6 MiB |
| map-100k | lazy | 222 ms | 55 | 4 of 4 | 87 ms | 38.3 MiB |
| map-100k | eager | 142 ms | 49 | 4 of 4 | 75 ms | 38.3 MiB |
| strings-16m | lazy | 45 ms | 51 | 4 of 4 | 1 ms | 71.4 MiB |
| strings-16m | eager | 221 ms | 2,093 | 4 of 4 | 1 ms | 247.6 MiB |
| closures-20k | lazy | 158 ms | 2,249 | 1,098 of 1,098 | 85 ms | 34.5 MiB |
| closures-20k | eager | 148 ms | 2,239 | 1,098 of 1,098 | 76 ms | 43.6 MiB |

What the sweep shows, beyond the real heaps:

- **Array items and `Map` entries live in the small state, not in pages.**
  Half a million array items are four slot pages and one 12 MB Arrays section.
  Its checkpoint took linear memory from 33.9 MiB to 112.9 MiB (the review's "500,000 array
  items that ran in 40 MB reached 122 MB at the checkpoint", reproduced on the object), its
  resume is 0.8–0.9 s to decode that one section from 63 rows, and the wake crank's checkpoint
  still costs 130–170 ms afterwards, since every checkpoint re-encodes the sections to find the
  changed ones.
  This is the commit cost the review's correction 16 names, and it is per crank, not per touch.
- **Lazy resume is lazy for chunks and not for slots.**
  The 64 MB string heap wakes lazily in 45 ms reading 51 rows and holding 71 MiB; eagerly it reads
  all 2,093 extent rows and holds 248 MiB.
  But every slot-heavy heap, synthetic or real, is fully or nearly fully resident after a lazy
  resume (590 of 590, 1,098 of 1,098, 631 of 640, 1,196 of 1,241): the objects are reachable from
  a side-table owner or a direct reference, and restore validation faults those pages
  (review correction 7).
  The working-set bound the suite proves (`lazy`, §7.1) holds for its fixture, whose globals
  are plain; a real vat's globals are not.
- **Memory never comes back.**
  The string heap's doubling peaked at 248.6 MiB of linear memory and stays there; the array
  heap's checkpoint peak of 112.9 MiB stays.
  On a 128 MB isolate, either program ends the worker: the default 256 MiB chunk ceiling would
  stop the first one only past a gigabyte of linear memory, and nothing bounds the second
  (WASM-BLOCKERS B8).

### 7.5 Reading the numbers

These readings take the spike's worker loop as it was: every crank was followed by its
checkpoint, and the spike's crank, its own copy of `eval`, does not collect garbage.
The worker as it stands commits only after a fresh boot and at close, and collects after every
crank, which marks every small-state section dirty (`Interp::collect_garbage`), so its next
commit re-encodes and hashes every section to find the changed ones.
Items 3, 4 and 6 below, and the per-crank checkpoints of §7.4, are what a worker that commits
every crank would pay without that collection, not what today's worker pays per crank.

Against the review's ranked measurements (its "What Phase 0 needs", 1–7):

1. **Stack depth**: not measured here; the lanes of STACK-DEPTH-REFACTOR.md cover workerd, and
   only a deployed Worker shows production's stack.
2. **Peak linear memory per awake worker**: 7.1 MiB empty, 30.9–35.0 MiB serving the SES boot
   heap, 62.5–81.7 MiB serving the counter vat, and 122.5 MiB during the vat's import.
   Lazy resume saves 20 MiB on the vat at wake, not more, because it faults 96% of the pages
   (next item).
   Against a 128 MB isolate shared with the host's JS heap, one counter-vat-sized worker fits and
   two do not, before any guest growth, and no ceiling bounds that growth today (WASM-BLOCKERS B8).
3. **Cold wake**: 174–223 ms for the boot heap and 818–868 ms for the counter vat, instantiate
   included, when the object's database is already open; the idle wakes below add the constructor
   and the database.
   Resume dominates, and it is a row-count cost: the vat's lazy resume runs 2,982 statements to
   read 3,009 rows, about 0.2 ms each through the import ABI, because restore validation faults
   every page a side table or a direct reference touches (review correction 7) and each fault is
   two statements (the empty-store gate's manifest read, then the row).
   Lazy resume reads *more* rows than eager (3,009 against 2,809 on the vat) for that reason.
   The review's lazy-resume fixes (its work item 8, deferred side-table validation and a sparse
   chunk arena among them) are the
   only route to a wake that costs the pages the message touches; without them lazy and eager
   are the same wake with different memory.
4. **CPU per crank**: the drain crank is 5–6 ms on the boot heap and 73–100 ms on the vat, the
   difference being the pages the vat's drain faults (the lazy wake's 100 ms against the eager
   wake's 73 ms is that fault cost).
   First boot is 2.4 s for 224 billion raw meter units, under the 30 s event limit with room,
   but not under the Free plan's 10 ms.
5. **Hub-to-hub delivery**: out of scope (Addendum A).
6. **Rows per delivery**: a drain crank writes 12–15 rows (the manifest, the Meter section's
   chunk, the dirty page, its edge summary, the free segment, and the one slot the crank
   allocated) in 18–19 statements, and reads about 50; a delivery is two such cranks today, so
   about 30 rows written and 100 read per inbound frame on a heap that stays put, plus whatever
   the delivery itself dirties.
   The section re-encoding cost the review warns of does not show on the drain crank, which
   touches only the Meter section; a crank that defines a function rewrites the Functions
   section whole (1.5 MB on this vat, two chunk rows).
   These are per-commit figures from the spike's per-crank commits; under the collection a
   commit would also re-encode every section, although it writes only those whose digest
   changed.
7. **The value cap**: local workerd accepted everything; the backend asserts 2,000,000 B per
   value itself, and the vat's largest section (Functions, 1,548,529 B) rides under it in two
   chunks.

The acceptance suite's figures (§7.1) say what the ABI costs at the statement level: 44,250
statements in 4.3 s for the metamorphic part, about 0.1 ms per statement including the
encoding both ways, so the host boundary is not where the wake goes.

### 7.6 Re-measurement on the product crates (2026-11-26)

On 2026-11-26 `run.py` measured again, in local workerd, on the code that ships rather than on
the spike's private copies.
Two kinds of record came out of it.
The harness module, now built over `ironhorse_store_do::DoStore` and the core's `Worker`, ran
the acceptance suite, a fresh boot of the SES bundles (`boot.js`, 591,324 B, and
`worker-peer.js`, now 1,469,942 B) and cold wakes of the result, three runs of each.
The product mode served `rust/thixotrope-ironhorse-wasm` itself from a Durable Object through
the unmodified `host-abi.mjs`, with every commit decided by `commits`: a fresh opening to ready in
one `transactionSync`, an eval, a `deliver`, a close, then wakes after `ctx.abort()`, three runs
after the ABI's last change, with every check the command makes passing in all three.

The records do not measure the quantities of §7.1–§7.4 under the same names
(`rust/engine/wasm-worker-spike/README.md`, "What the measurements mean").
A request now includes the collection and the finalizer cascade and commits nothing; the heap is
committed at a fresh open (the bare machine), once after the boot files, and at close.
So "request" below is a crank without a commit, "wake to first reply" is instantiate plus resume
(or open) plus that request, with no commit in it, and a close's commit is measured apart.
The machine was shared with other work while the runs were taken, so the latencies are noisy:
the tables give medians and the spread where it is wide; the row and byte counts are medians too,
and varied little or not at all.

Harness on the product crates, acceptance suite (three runs per part, all passing; a fourth run,
taken after the module's ABI last changed, also passed all eight):

| Part | Wall time (median of 3) | Rows read | Rows written | Statements |
|---|---|---|---|---|
| sparse | 256 ms | 1,525 | 433 | 682 |
| checkpoint | 33 ms | 676 | 99 | 269 |
| resume | 16 ms | 242 | 92 | 148 |
| commit | 57 ms | 942 | 208 | 435 |
| edits | 48 ms | 531 | 101 | 273 |
| lazy | 51 ms | 366 | 184 | 249 |
| boundary | 84 ms | 726 | 276 | 444 |
| metamorphic | 3,769 ms | 140,929 | 17,140 | 47,248 |

Product module, SES boot and wake (medians; three fresh openings, nine wakes per mode):

| Step | Wall time | Rows read / written | Bytes bound / returned | Linear memory after |
|---|---|---|---|---|
| Instantiate | 2–3 ms | — | — | 7,405,568 B (7.1 MiB) |
| Fresh opening to ready, one `transactionSync` | 2,551 ms (2,204–2,983) | 58 / 2,993 | 7,069,662 / — | 90,046,464 B (85.9 MiB) |
| of which `ih_open` (the bare machine's commit) | 16 ms | 12 / 108 | 38,641 / — | 7,733,248 B |
| of which `ih_boot` of `boot.js` | 1,144 ms | 0 / 0 | — | 30,474,240 B |
| of which `ih_boot` of `worker-peer.js` | 1,308 ms | 0 / 0 | — | 90,046,464 B |
| of which `ih_ready` (the boot commit) | 77 ms | 46 / 2,885 | 7,031,021 / 288 | 90,046,464 B |
| An eval request on the booted worker | 22 ms | 0 / 0 | — | 90,046,464 B |
| A `deliver` request with one outbound frame | 20 ms | 0 / 0 | — | 90,046,464 B |
| `ih_close` after those requests | 31 ms | 153 / 154 | 1,850,665 / 288 | 90,046,464 B |
| Eager wake: open | 94 ms | 1,539 / 0 | — / 7,112,142 | — |
| Eager wake: first request | 13 ms | 0 / 0 | — | 26,476,544 B (25.3 MiB) |
| Eager wake to first reply | 111 ms (81–140) | — | — | — |
| Eager wake: close after one request | 12 ms | — / 4 | 285 / — | — |
| Lazy wake: open | 46 ms | 941 / 0 | — / 6,370,968 | — |
| Lazy wake: first request | 21 ms | 278 / 0 | — | 17,891,328 B (17.1 MiB) |
| Lazy wake to first reply | 68 ms (57–104) | — | — | — |
| Lazy wake: close after one request | 11 ms | — / 4 | 285 / — | — |

The durable write after each committing call (`ctx.storage.sync()`) is outside these times: 45 ms
(median) after the fresh opening and 3 ms (median) after a wake's close.
The module is 9,818,085 B uncompressed and 3,948,604 B at gzip level 9.
The harness's fresh boot gives the heap's geometry: 173,682 slots in 679 pages and 1,703,945
bytes of chunks at epoch 2, with a meter of 288,320,824,136 raw units; exported, it is a
7,004,628-byte container.
Its wakes of that heap agree with the product module's: a lazy resume reads 941 rows and leaves
363 of 679 pages resident, 475 after the request, and an eager one reads 1,539 rows; the wakes to
first reply took a median of 101 ms lazily and 87 ms eagerly over nine wakes each.

Where the quantities are the same as §7's, they compare as follows:

- The acceptance suite is the same instrument, run part by part inside one `transactionSync`, now
  against the product store and a newer engine: the metamorphic part's 47,248 statements in
  3,769 ms against 44,250 in 4,269 ms is the same order, about 0.1 ms per statement.
  The row counts differ slightly because the suite and the engine have changed since.
- An empty instance holds 7,405,568 B of linear memory, as the spike's did.
- `boot.js` is the same source: its boot took a median of 1,144 ms against 1,404 ms in §7.2, now
  with the collection and the finalizer cascade included.

Nothing else compares directly.
`worker-peer.js` grew from 1,224,240 B to 1,469,942 B, and the booted heap now has 173,682 slots
in 679 pages against §7.2's 163,701 in 640, after a collection §7.2's crank never made.
The boot commit is one commit of 2,885 rows after both boot files, where §7.2 had two per-crank
checkpoints of 1,397 and 1,333 rows.
§7.3's wake totals included a checkpoint and these do not.
A lazy resume now reads fewer rows than an eager one (941 against 1,539) and leaves 363 of 679
pages resident, where §7.3's lazy resume of the boot heap read more rows than its eager one and
left 631 of 640 pages resident; the heap and the engine both changed between the two
measurements, and these records do not say which change accounts for it.
The counter vat of §7.3 and the synthetic heaps of §7.4 were not re-measured.

---

## 8. Phases

The base design's §8 has four phases: measure, relay, native workers, hybrid placement.
This plan's Phase 0 is its Phase 0; Phases 1–4 split its Phase 2 (the worker on the platform) by
component, and Phase 5 is the rest of that Phase 2 with Addendum A's protocols; the relay and the
hybrid placement are not this plan's.
The review's prerequisites are folded in.

| Phase | What | Size | Go/no-go | Status (2026-11-26) |
|---|---|---|---|---|
| **0a Spike** (this document) | `DoStore`, the ABI, the host, the suite, local measurements | done | — | Landed with this document, under `rust/engine/wasm-worker-spike/`; since 2026-11-26 a workerd harness for the product crates and the product module (§7.6) |
| **0b Deployed measurement** | The same harness on a Workers Paid account: production stack depth against the 25 recursion families, `memory.grow` behaviour at the cap, CPU per crank against computrons, the 2 MB cap's error text, cold wake with the object evicted for real | S (the harness exists; the Worker needs `new_sqlite_classes`, the module as a static import, and a route per measurement) | Decides blocker 1 (stack) and 2 (memory) for real | Blocked: no deployment access |
| **1 Core crate** | `thixotrope-ironhorse-core` out of `main.rs`; the native worker rebuilt on it; the wasm cdylib as a second shell (moved to Phase 4, which builds it with a script of its own; `rust/engine/scripts/build-wasm.py` builds only engine-workspace crates) | M | Both shells pass the worker's own tests and the suite | Landed: `rust/thixotrope-ironhorse-core`, and `rust/thixotrope-ironhorse-worker` rebuilt on it; the native worker's and the core's tests run in CI's Ironhorse worker job; the wasm shell's gate is Phase 4's |
| **2 Store crate** | `ironhorse-store-do` in `rust/engine` from the spike's `DoStore`, with the suite as its test, the value cap, the stamp, and a failure row for quarantine | S–M | Suite green under local workerd and under the Node shell | Landed: `rust/engine/ironhorse-store-do` and `rust/endo/ironhorse-store-do-rusqlite`; all eight suite parts green on real SQLite, in memory or on disk, and four of them again with 97-byte section chunks and four through the `wire` encoding with every number bound as REAL; all eight green under local workerd (§7.6); not run under a Node shell |
| **3 Profile** | The platform-neutral profile (§6.2) in `ironhorse-runtime.js` and the native worker; a heap written natively resumes under wasm and back, gated by B7's differential | M (plus B7, costed elsewhere) | A counter vat round-trips native → wasm → native with identical results and computrons | Deferred: Phase 4 keeps the engines' heaps apart instead (§6.3) |
| **4 Local wasm engine** | The Node shell over `node:sqlite` with its native launcher (§6.3), chosen by pointing `THIXOTROPE_IRONHORSE_WORKER` at the launcher; the daemon's `wasm` platform is not part of it | M | The 13 test files of `packages/thixotrope/test/ironhorse/` pass unchanged under both engines | Landed: `rust/thixotrope-ironhorse-lease`, `rust/thixotrope-ironhorse-wasm-launcher`, the module `rust/thixotrope-ironhorse-wasm` with `build.py --stage`, `packages/thixotrope/src/ironhorse/wasm/host-abi.mjs` and `shell.mjs`, the identity change in `ironhorse-runtime.js`, the lanes `test:ironhorse:wasm-module` and `test:ironhorse:wasm`, and the CI job `test-thixotrope-ironhorse-wasm`; the gate is met (55 tests per engine, re-run on the final tree, §6.3) |
| **5 Durable Object worker** | The hub and delivery protocols of Addendum A, with the review's blockers 7–11 resolved; the ceiling profile and admission of B8 | L | Addendum A §12's tests plus the review's acceptance gates | Blocked on the review's blockers 7–11 |

Phases 1 and 2 are independent of each other; Phase 4 consumes both, since its cdylib is the core
over `DoStore`.
None of them waits on the deployed measurement; Phase 3 waits on B7, Phase 5 on everything.

---

## 9. Risks and open questions

| Risk | Where it stands |
|---|---|
| The platform's host stack (review blocker 1) | Phases 1–3 of the stack refactor landed; the trapped-Proxy ceilings wait on B10 of `STACK-DEPTH-REFACTOR.md`. Only a deployed measurement shows production's stack. |
| 128 MB per isolate, shared (blocker 2) | The spike's baseline is 7.1 MiB of linear memory with the 4 MiB shadow stack; §7 has the heaps' figures. `WASM-MEMORY.md` now gives the ceilings for a 128 MB isolate (4 MiB of chunks, 262,144 slots) on the declared admission widths, and the engine halts with `HostAllocationFailed` when the host allocator refuses; the Durable Object worker's ceiling profile (Phase 5) applies them. |
| Lazy resume cost (blocker 3) | Measured in §7.3; the engine fixes the review lists decide "go" on latency. |
| Instance reuse after a trap (blocker 4) | The spike's host dropped the instance after any exception. The core latches a worker dead after a failed crank; the product module poisons itself after a caught unwind, and its ABI makes a trap or a JavaScript exception the same to the host as that poison (§4.2); `DoStore::record_failure` is the store's half of the failure row for quarantine, which no host writes yet. |
| Unstable toolchain (blocker 5) | Accepted for now (WASM-BLOCKERS B1's status: option 1 adopted, the unstable feature accepted); the build is pinned to 1.91.1 with `RUSTC_BOOTSTRAP`, not a nightly channel (`scripts/build-wasm.py`). |
| Heaps across builds (blocker 6) | §6.2's profile plus B7, deferred with Phase 3; until then each engine refuses a state directory the other wrote (§6.3). |
| Commit cost: a touched section is re-encoded whole | Measured in §7 for per-crank commits; the Functions section of a real vat is 1.5 MB, so a commit after a function was defined rewrites it. The worker now commits only after boot and at close, but every crank's collection marks every section dirty, so each commit re-encodes and hashes all of them. Incremental section encoding is the fix; WASM-BLOCKERS B8 records this per-checkpoint re-encoding as what remains after the streaming writer. |
| Rows written per commit (billing) | Measured in §7 for the spike's per-crank commits, which wrote the manifest, the Meter section and the dirty pages' summaries at least. The worker no longer commits per crank, so what a Durable Object pays in rows follows the commit cadence Phase 5 chooses (§4.4); §7.6 has the product's commits at boot (2,993 rows for the fresh opening) and at close (4 rows after one request on a woken heap). |
| Module size against the platform's script-size limit | The module measured in §7.6 was 9,818,085 B uncompressed and 3,948,604 B at gzip level 9; the reproducible build is 9,814,373 B uncompressed. Local workerd enforces no script-size limit, and the repository's Cloudflare designs state none, so whether the module fits a deployed Worker is an open question for Phase 5, not a result. |
| Linear memory against the 128 MB isolate | 90,046,464 B (85.9 MiB) after the SES boot, 25.3 MiB after an eager wake and 17.1 MiB after a lazy one (§7.6), against the 128 MB per isolate, wasm memory included, of the base design's limits table and the review's blocker 2. Local workerd enforces no memory limit, so this too is an open question for Phase 5. |
| The module's bytes and the build's location | Resolved for the module: `build.py` builds with `trim-paths = "all"` and fails if the checkout's root, `CARGO_HOME` or the toolchain's sysroot occurs in the module, and builds from three checkout locations, another `CARGO_HOME` and a relocated toolchain gave one SHA-256 (`7c8488167b9f35af76770c2c85d317ab05caa7b46edd0ac4826696415ff206e0`, 9,814,373 B). Residual: a `CARGO_TARGET_DIR` outside the checkout is not covered, and the launcher, a native binary also pinned in the identity, is not reproducible in this sense. |
| Node is outside the pinned identity | The launcher runs whichever Node `THIXOTROPE_NODE` or `PATH` names, drops `NODE_OPTIONS` and passes `--disable-sigusr1` (§6.3); putting Node and V8 in the identity waits for Phase 3. |
| Which changes run the wasm lane in CI | `test-thixotrope-ironhorse-wasm` is selected (`IRONHORSE_WASM_INPUTS` in `scripts/ci-changes.py`) by any non-Markdown path under `packages/thixotrope/`, the module, launcher, lease, core and native worker crates, `rust/engine/ironhorse-store-do`, `rust/engine/scripts/build-wasm.py`, `.node-version`, the root `ava-endo-lockdown.config.mjs`, and the root and engine Cargo configuration. Other engine crates and the package's transitive JavaScript dependencies do not select it, since the native lane runs for them and scheduled and dispatched runs select every job; whether that saving is worth a regression the native lane cannot see is an open cost decision. |
| `wasm32-unknown-unknown` entropy | Commit tokens must come from the host (§6.1), and since `935798807` the engine refuses its default source there, so a worker that forgets cannot pair a copy of a store; hash-map iteration order is fixed per build, which is good for determinism and bad for anything that needs randomness, so the engine must take all its entropy through an explicit source. |

---

## Prompt

The task card this document answers, as dispatched:

> Produce a plan, with evidence from a spike, for running the Thixotrope worker on wasm, so the
> user can decide whether and how to build it.
> Blocker B5 in `rust/engine/WASM-BLOCKERS.md` lists why `rust/thixotrope-ironhorse-worker` does
> not build for `wasm32-wasip1`; `designs/thixotrope-on-cloudflare.md` §6 proposes a store port
> (`ironhorse-store-do`) and §8 Phase 0 names the measurements that decide go/no-go.
> Neither has been checked against the current code or measured.
>
> Deliverable 1, the plan as a design document: the worker split (host-neutral core and host
> shells; what replaces the kernel lease and the thread's stack); the store port (verify every row
> of §6.2 against the current `ironhorse-store-sqlite` code and size each of §6.3's six required
> changes; new crate or refactor behind a SQL-execution trait, with a recommendation); the
> host-import ABI (`exec`, `tx`, blob copy, error codes for JS exceptions, `extern "C-unwind"`,
> reentrancy, trap handling); the daemon side (`engine_for_spawn_request("wasm", …)`, a local
> wasm engine as a determinism cross-check); the profile (a platform-neutral runtime profile so a
> heap can move between the native and the wasm build); sized phases mapped onto §8 with go/no-go
> criteria and the numbers from the spike.
>
> Deliverable 2, the spike under `rust/engine/wasm-worker-spike/`: a minimal `HeapStore` over a
> host-import ABI, enough to run the `store_suite` metamorphic-determinism and checkpoint-lock
> parts against a SQLite-backed Durable Object in local workerd; Phase 0 measurements local
> workerd can give (cold-wake latency across heap sizes with the two real heaps plus synthetic
> heaps, commit cost and rows written per crank, linear memory after resume and after a crank;
> lazy resume should cost by pages touched, not heap size). Do not deploy anything to Cloudflare.
