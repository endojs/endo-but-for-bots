# Compiling Ironhorse to WebAssembly: blockers

Investigation date: 2026-09-23, against `f9cbcfc4`.
Toolchain: the pinned Rust 1.91.1 (LLVM 21.1.2), targets `wasm32-wasip1` and
`wasm32-unknown-unknown`.
Hosts:

- Node.js 22.22.2 (V8, through `node:wasi`).
- Wasmtime 49.0.0 (through the `wasmtime` Python bindings).
- Headless Chromium 141.0.7390.37 (through Playwright), on the page's main thread and in a
  dedicated Web Worker.

Every claim below was checked by building and running something unless it is marked
*inferred*.
The [appendix](#appendix-reproduction) has the commands.

## Summary

The engine is closer to wasm than its build suggests.
Six of the eight runtime library crates already build for both wasm targets unchanged, with no
OS dependencies.
The one that does not, `ironhorse-compile`, is blocked on purpose: it refuses `panic=abort`,
the only panic strategy stable Rust offers on wasm.
`ironhorse-runtime` fails only because it depends on it.

With unwinding turned on through an unstable toolchain feature, the whole
compile-and-run pipeline works on both targets and in all three hosts.
Every probe program that completes produces results and computron counts **byte-identical** to
a native build, provided the `consensus` feature is on.
Heap exhaustion, meter refusal, compiler budget refusal, and `eval`-time `SyntaxError`s are all
contained, as they are natively.
A `wasm32-unknown-unknown` build needs **no imports at all**.

What stands in the way, in order of severity:

| # | Blocker | Layer | Kind |
|---|---------|-------|------|
| B1 | Stable Rust cannot link a wasm artifact with `panic=unwind`; the engine requires unwinding, including for guest-catchable errors | toolchain / engine | **hard** |
| B2 | Wasm exception-handling encoding: LLVM emits the legacy form by default, and Wasmtime accepts only the standard `exnref` form | toolchain / host | configuration |
| B3 | The native-recursion budget assumes an 8 MiB stack; default wasm stacks overflow **before** the budget halts, sometimes on programs the engine accepts natively | engine / host | configuration for Wasmtime and Node, **hard in browsers** |
| B4 | Default-feature builds diverge between native and wasm in `Math` results and therefore in metering | engine features | configuration (use `consensus`) |
| B5 | The worker binary depends on threads, `flock`, bundled C SQLite and POSIX files | worker | port work |
| B6 | No CI builds or runs the engine on wasm; the one WASI test script is not wired in | CI | process |

[Browser-specific considerations](#browser-specific-considerations) follow the blockers.

## What builds today, unmodified

`cargo build --release -p <crate> --target <t>` on the stable pinned toolchain:

| Crate | `wasm32-unknown-unknown` | `wasm32-wasip1` |
|-------|:---:|:---:|
| `ironhorse-meter` | ok | ok |
| `ironhorse-text` | ok | ok |
| `ironhorse-unicode` | ok | ok |
| `ironhorse-regexp` | ok | ok |
| `ironhorse-vm` | ok | ok |
| `ironhorse-snapshot` | ok | ok |
| `ironhorse-compile` | **fails** (`compile_error!`) | **fails** |
| `ironhorse-runtime` | **fails** (depends on compile) | **fails** |

These eight crates use no `std::fs`, `std::thread`, `std::time`, `std::env`, `std::process` or
networking outside test code.
Only the `ironhorse-262` harness does.
`Date.now` does not read a host clock.
`HashMap` seeding works on both targets.
On `wasm32-unknown-unknown` std falls back to address-derived keys, and on WASI it imports
`random_get`.
Numbers are NaN-canonicalized at `Slot::of` (`ironhorse-vm/src/value.rs`).
In the probe, NaN results from `0/0`, `Infinity - Infinity`, `Math.sqrt(-1)` and a
reinterpreted `0xfff8…01` all read back as `00 00 00 00 00 00 f8 7f` through a `Float64Array`
on both targets.

## B1: unwinding is required, and stable wasm cannot provide it

### What the engine uses unwinding for

`ironhorse-compile/src/lib.rs` refuses the build outright:

```rust
#[cfg(panic = "abort")]
compile_error!("ironhorse-compile requires panic=unwind to contain budget refusal");
```

The compiler is not the only crate that relies on unwinding; it is the only one that says so.
Outside test code the runtime crates have 23 `catch_unwind` sites.
Four private control transfers use `resume_unwind` as a non-local exit:

- **`ironhorse-vm` `HeapExhausted`** (`value.rs`) is raised from the "infallible" arena
  allocators and admission checks, 10 raise sites.
  Through them it is reachable from roughly 320 `.alloc(`-style call sites (a grep count).
  `Interp::run` catches it at the crank boundary and returns `Halt::HeapExhausted`.
- **`ironhorse-compile` `Refused`** (`meter.rs`) is the parse meter's budget stop.
- **`ironhorse-compile` `Poisoned`** (`coder.rs`, `Coder::report_kind`) is how the coder
  reports an early error, "the same control transfer" as XS's `longjmp` out of
  `fxReportParserError`.
- **`ironhorse-regexp` `CompileStop::{Budget, Resource}`** (`compile.rs`, 14 raise sites) is
  the pattern compiler's work and state ceilings.

`ironhorse-runtime` also wraps every `eval` and `Function` compilation in `catch_unwind`, so
that a compiler panic becomes `Halt::EngineInvariant("eval:compiler-invariant")` rather than
killing the host.
`ironhorse-vm` and `ironhorse-regexp` have no `compile_error!` guard.
They build under `panic=abort`, and their refusals would then abort instead of halting.

Most of these paths end in a halt the guest cannot catch (`MeterAbort`, `HeapExhausted`,
`EngineInvariant`).
**`Poisoned` does not.**
Coder-detected early errors reach the guest as catchable `SyntaxError`s through `eval`.
This probe gives the same result natively and on wasm:

```js
try { eval('a: a: 1') } catch (e) { e.message }      // "duplicate label a"
try { eval('({a = 1})') } catch (e) { e.message }    // "invalid initializer"
```

Unwinding is therefore guest-observable.
Under `panic=abort`, a guest could crash the instance with a `SyntaxError` it meant to catch.

### Why stable Rust cannot provide it

Both wasm targets have `"panic-strategy": "abort"`, and the prebuilt `std` for them is compiled
that way.
Passing `-C panic=unwind` on stable flips `cfg(panic)`, so every library crate, including
`ironhorse-compile`, *compiles*.
The final link then fails:

```text
error: the crate `panic_unwind` does not have the panic strategy `unwind`
```

The std source says the same in `library/unwind/src/wasm.rs`: the `throw` path is taken "only
if the user explicitly opts in to wasm exceptions, via -Zbuild-std with -Cpanic=unwind".
`-Zbuild-std` is nightly-only.

### Verified workaround

The following links and runs on the pinned 1.91.1 toolchain once `rust-src` is installed:

```sh
RUSTC_BOOTSTRAP=1 \
RUSTFLAGS="-C panic=unwind -C target-feature=+exception-handling" \
cargo build -Zbuild-std=std,panic_unwind --release --target wasm32-wasip1
```

`RUSTC_BOOTSTRAP=1` stands in for a nightly toolchain.
rustc warns that `exception-handling` is an unstable target feature.

The probe then shows:

- **Heap exhaustion is contained** (Node, Wasmtime, Chromium).
  `var a=[]; for(;;) a.push({x:a.length})` under `set_slot_ceiling(20_000)` halts with
  `HeapExhausted`, and a fresh `Interp` in the same instance then runs `1+1` to `2`.
- **Meter refusal is contained** (Node).
  `for(;;){}` with a refusing meter halts with `MeterAbort`.
- **Compiler budget refusal is contained** (Node, Wasmtime).
  `compile_atoms_with_budget` over a large source returns `Err` at raw 1000.
- **`eval` works** (Node, Wasmtime, Chromium).
  `eval`, `Function`, and the compiler-budget `SyntaxError`s behave as they do natively.
  The coder's early errors above were checked in Node.

### Options

1. **Ship with `-Zbuild-std` and wasm EH.**
   This is proven here.
   It costs an unstable toolchain feature in the build of an artifact that is meant for
   consensus, and a std rebuilt from the version-pinned `rust-src`.
   Hosts must also support wasm exception handling (see B2).
2. **Replace the unwind transfers with `Result` propagation.**
   This makes the engine panic-strategy-agnostic, and it would also let the native build use
   `panic=abort`.
   It is expensive.
   `HeapExhausted` is the dominant cost: the arena allocators are infallible by contract, and
   making them fallible touches hundreds of call sites.
   `Poisoned` is the subtle cost: the coder's own doc comment explains that returning instead
   of stopping was tried once and failed, because "the eighty-odd `panic!`/`unreachable!`/
   `expect` sites" would all need guarding.
3. **`panic=abort` for the uncatchable halts only.**
   This first requires `Poisoned` to become a `Result` (part of option 2).
   After that, the remaining transfers all end in uncatchable halts, so an abort-mode build
   could treat any trap as a fatal crank.
   The host would drop the instance and restore from the last committed snapshot.
   The worker already exits without committing on a fatal halt.
   What is still lost (*inferred*, not built):
   - The **halt classification**.
     `resume_unwind` bypasses the panic hook, so an abort-mode trap carries no message.
     The host can infer `MeterAbort` because its own meter callback refused.
     It cannot tell `HeapExhausted` from an engine bug.
   - **In-process reuse** of the `Interp` or `Machine` after a refusal.
   - **Containment of compiler panics** inside `eval`.

Option 1 is the only route that works without engine changes.
Option 3 needs the `Poisoned` refactor first.
Option 2 lifts the constraint for good.

## B2: which exception-handling encoding the host supports

LLVM 21 emits the **legacy** wasm EH instructions (`try`/`catch`) by default.
Wasmtime 49 rejects such a module even with `wasm_exceptions` enabled:

```text
Invalid input WebAssembly code at offset 5431: legacy_exceptions feature required for try instruction
```

Adding `-C llvm-args=-wasm-use-legacy-eh=false` to the same `RUSTFLAGS` emits the standard
`exnref` form (`try_table`).
Wasmtime then runs the probes, containment included.
Node 22.22.2 and Chromium 141 ran **both** encodings without flags.

Wasmtime needs `exnref`, so `exnref` is the natural default for a build shared by Wasmtime and
browsers.
Legacy EH matters only for older browser engines, which were not tested here.
Whichever is chosen, the flag must be in `RUSTFLAGS` so that `-Zbuild-std` compiles std with
the same encoding.

## B3: the native-recursion budget outruns wasm stacks

`NATIVE_DEPTH_LIMIT = 2048` (`interp.rs`) bounds host recursion by a counter, so the halt depth
is deterministic.
The budget is sound only on a stack that can hold it.
`NATIVE_STACK_BYTES` states 8 MiB (release) and 32 MiB (debug), and the worker spawns a thread
of exactly that size.
On wasm there are two stacks, and **both** can bind:

- **The linear-memory shadow stack** is set at link time.
  Rust's wasm targets default to 1 MiB with `--stack-first`, so an overflow traps
  (`memory access out of bounds`) instead of corrupting data.
  At 1 MiB, the 10,000-layer Proxy `[[DefineOwnProperty]]` case overflows it in Node and in
  Chromium.
  `-C link-arg=-zstack-size=8388608` fixes that.
  Every figure below uses that 8 MiB shadow stack unless marked otherwise.
- **The host engine's call stack** is where wasm frames themselves live.
  The host sizes it: V8's `--stack-size` defaults to 984 KiB, and Wasmtime's `max_wasm_stack`
  defaults to 512 KiB.
  In a browser it is not configurable at all (see below).

The repository's own ceiling cases (`ironhorse-vm/tests/native_recursion_budget.rs`), plus
their within-budget twins, were rerun on each host.
The table below shows every case that did not match native.
Anything not listed matched native exactly: the same `Halt`, result and computrons.
**No host ever produced a different answer; the only failure mode is a trap.**

| Case | Native | Node default | Chromium main | Chromium Worker | Wasmtime 512 KiB (default) | Wasmtime 1 MiB | Wasmtime 2,000,000 B |
|---|---|---|---|---|---|---|---|
| `JSON.stringify`, 10,000 nested arrays | `ReentryLimit` | **trap** | **trap** | **trap** | **trap** | **trap** | ok |
| Proxy `[[DefineOwnProperty]]` / `[[Call]]`, 10,000 layers | `ReentryLimit` | ok | ok | **trap** | **trap** | **trap** | ok |
| 10,000 nested sync `async` calls | `ReentryLimit` | ok | ok | ok | **trap** | **trap** | ok |
| Other Proxy methods (`[[Get]]`, `[[OwnPropertyKeys]]`, `[[Construct]]`), 10,000 layers | `ReentryLimit` | ok | ok | **trap** | **trap** | ok | ok |
| `JSON.parse` 10,000 nested arrays / objects; reviver deepening its holder | `ReentryLimit` | ok | ok | **trap** | **trap** | ok | ok |
| `flat(Infinity)` over a self-containing array | `ReentryLimit` | ok | ok | **trap** | **trap** | ok | ok |
| 10,000 nested `forEach` callbacks | `ReentryLimit` | ok | ok | ok | **trap** | ok | ok |
| `eval` of 5,000 nested parens and braces (compiler budget) | catchable `SyntaxError`s | ok | ok | ok | **trap** | ok | ok |
| *Accepted:* 2,016-layer Proxy `[[Get]]` | completes | ok | ok | **trap** | **trap** | ok | ok |
| *Accepted:* 63 nested `forEach` (the documented allowance) | completes | ok | ok | ok | **trap** | ok | ok |
| *Accepted:* 64 nested `async` calls | completes | ok | ok | ok | **trap** | ok | ok |
| *Accepted:* 511 nested blocks; a 990-deep `?:` chain | completes | ok | ok | ok | **trap** | ok | ok |

The rows marked *Accepted* matter most.
On an undersized stack, programs the engine **accepts** natively fail too; it is not only the
programs it was going to halt anyway.

In Node the `JSON.stringify` case passes from `--stack-size=1300` upward (1100 still traps).
Wasmtime needs `max_wasm_stack` of about 2 MB, and its bindings then also require raising
`async_stack_size`, because `max_wasm_stack` cannot exceed it.
Chromium's main thread passes everything with `--js-flags=--stack-size=4000`.
The **Worker does not improve at all** with that flag: its limit is the worker thread's own OS
stack.

A host stack overflow is **not** contained, even with unwinding enabled.
It surfaces as a host trap (`RangeError: Maximum call stack size exceeded` in V8,
`wasm trap: call stack exhausted` in Wasmtime), and no Rust destructors run.
The guest controls how deep it recurses, so on an undersized stack a guest can turn a
deterministic `ReentryLimit` into a host-dependent trap.
That is a determinism break across hosts, not just a crash.

Options:

- **Require a minimum stack** where the embedder controls it, and document it next to
  `NATIVE_STACK_BYTES`: `-zstack-size` ≥ 8 MiB, Wasmtime `max_wasm_stack` ≥ 2 MiB, and Node
  `--stack-size` ≥ 1300 plus margin.
- **Browsers** cannot raise the stack, so there the frames must shrink or leave the call stack.
  The heaviest light frame is the `JSON.stringify` walker, "the heaviest" per the doc comment on
  `LIGHT_FRAME_COST`.
  Moving the deep walkers (JSON, `flat`, Proxy forwarding, re-entrant dispatch) onto explicit
  heap stacks removes the dependence on host stack size altogether.
  Lowering `NATIVE_DEPTH_LIMIT` for wasm alone would not work: the limit is release-versioned
  and changes acceptance, so native and wasm workers could no longer share a release.

## B4: default features diverge from native in results and metering

Without `consensus`, `ironhorse-vm` computes `Math.*` with the platform libm: glibc natively,
wasi-libc on WASI.
The probe applies 22 `Math` functions to 400 inputs and hashes the string forms of the
results:

| Build | native hash / computrons | wasm hash / computrons |
|---|---|---|
| default features | `1006434603` / 4,410,817 | `-1595503651` / 4,410,427 |
| `features = ["consensus"]` | `-416448200` / 4,410,687 | `-416448200` / 4,410,687 |

The default build diverges in results.
Because guest control flow follows those results (here, the hashing loop's length), the
computron counts diverge too.
With `consensus` (pure-Rust `libm`, `force-soft-floats`) the two targets agree exactly.
The worker already enables `consensus`.
Any wasm build must as well, and it must keep `cost-calibration` off.

## B5: the worker binary is not wasm-ready

`thixotrope-ironhorse-worker` fails to build for `wasm32-wasip1`.
Beyond B1, it has these problems:

- **Bundled SQLite (C).**
  `libsqlite3-sys` 0.28 (`rusqlite` 0.31, pinned to match `rust/endo`) compiles
  `sqlite3.c` with the host's headers and fails (`bits/libc-header-start.h`).
  It needs a WASI C sysroot such as wasi-sdk.
  Its build script also applies its WASI defines (`SQLITE_THREADSAFE=0`, emulated
  `mman`/`signal`/`getpid`, optional WASI VFS) only when `TARGET == "wasm32-wasi"`.
  Rust retired that target name, so on `wasm32-wasip1` the defines are silently skipped.
  WAL mode also relies on shared-memory locking that WASI preview 1 lacks
  (*inferred*, not built).
- **`rustix::fs::flock`** is `cfg`-excluded on `target_os = "wasi"`.
  The worker's kernel lease, `--lock-state` helper and shared `ACTIVE_LEASE_PATH` lease all
  use it.
- **`std::thread::Builder::spawn`** with `stack_size(NATIVE_STACK_BYTES)` in `main`.
  `wasm32-wasip1` has no threads.
  The stack must come from the link (`-zstack-size`) and the host (B3) instead.
- **File paths** (the heap database, the boot files and the state directory) need WASI
  preopens.

The snapshot store seam already abstracts the backend (`ironhorse_snapshot::store`, with
`MemoryStore` in tree).
A wasm worker could therefore keep persistence on the host side, behind an imported store,
rather than compile SQLite into the module.
The daemon has no wasm host yet: `engine_for_spawn_request("wasm", …)` is rejected
(`rust/endo/src/engine.rs`), and `endor.rs`'s module docs list `-e wasm` only as a future
engine.

## B6: no wasm coverage in CI

The only wasm job, `build-wasm`, builds `rust/ocapn_noise`.
`rust/engine/scripts/test-snapshot-wasi.py` runs the snapshot's 32-bit overflow refusals on
`wasm32-wasip1`, and it passes locally (2/2).
No workflow invokes it, even though
`architecture-review/2026-09-06/ARCHITECTURE-REVIEW.md` states that those refusals "run on
32-bit WASI in CI".
Nothing stops the currently clean crates from gaining a wasm-incompatible dependency.

A cheap first gate is `cargo build --target wasm32-unknown-unknown` for the six crates that
build today, plus the existing WASI script.

## Browser-specific considerations

Everything above applies in a browser.
The following is specific to it, measured in headless Chromium 141 unless marked otherwise.
Firefox and Safari were not available to test.

- **Target.**
  `wasm32-unknown-unknown` is the natural target.
  The cdylib imports nothing, so it needs neither a WASI shim nor `wasm-bindgen`.
  A small `extern "C"` surface (allocate, evaluate, read result) was enough to drive it.
- **The stack is the main problem** (B3).
  A page cannot configure it.
  The main thread behaves like Node's default: only the `JSON.stringify` ceiling traps.
  A dedicated **Web Worker has a smaller stack**: 11 of the 25 cases trap there, including an
  accepted 2,016-layer Proxy chain.
  This is a real tension.
  Long cranks belong in a Worker so they do not freeze the page, and the Worker is where the
  stack is smallest.
  In practice, browser support depends on the "explicit heap stacks" option in B3.
- **A trap does not poison the instance.**
  After a stack-overflow `RangeError`, the same instance accepted another call and returned
  `2` for `1+1`.
  Rust state at the moment of the trap is not rolled back: no destructors ran, borrows were not
  released, and the shadow-stack pointer is not restored (*inferred*).
  The embedder must discard the instance after **any** trap and restore from a snapshot.
  Nothing in the platform enforces this.
- **Synchronous compilation is capped.**
  Chromium refuses `new WebAssembly.Module(bytes)` on the main thread above 8 MB
  ("WebAssembly.Compile is disallowed on the main thread, if the buffer size is larger than
  8MB").
  The module is 6.9 MB today and was accepted, but debug info or more ICU data would cross the
  cap.
  Use `WebAssembly.compileStreaming` or `WebAssembly.compile`, or compile in a Worker.
- **Exception handling.**
  Chromium 141 accepted both the legacy and the `exnref` encodings (B2).
  Older browser engines may accept only the legacy form (*inferred*).
- **Memory.**
  Desktop headless Chromium grew a memory to the full 4 GiB.
  Mobile browsers typically cap lower (*inferred*).
  The default ceilings (1,000,000 slots, 256 MiB of chunks) are far below either.
  A failed `memory.grow` ends in `handle_alloc_error` and a trap.
- **No threads.**
  The engine is single-threaded, so it needs no `SharedArrayBuffer` and no cross-origin
  isolation headers (COOP/COEP).
- **Content Security Policy.**
  Compiling wasm needs `'wasm-unsafe-eval'` (or `'unsafe-eval'`) in `script-src`.
  That matters for extension and strict-CSP deployments (*inferred*, standard behavior).
- **Persistence.**
  There is no SQLite.
  The store seam (B5) would be backed by IndexedDB or the Origin Private File System.
  OPFS synchronous access handles are available only in Workers (*inferred*).
- **Cross-browser determinism.**
  Scalar wasm floating point is deterministic except for NaN bit patterns, which the engine
  canonicalizes, and `consensus` removes the platform libm.
  The build must not enable `relaxed-simd`, whose results are implementation-defined.
  rustc does not enable any SIMD for these targets by default.
  Only Chromium was measured.
- **Download size.**
  The module is 6.9 MB before `wasm-opt` and compression, including ICU normalizer and
  segmenter data.

## Not blockers (verified)

- **32-bit `usize`.**
  Every probe that completed matched native bit for bit.
  The snapshot decoders' 32-bit overflow refusals pass on WASI.
  The default ceilings fit in wasm32's 4 GiB.
- **Host imports.**
  The `wasm32-wasip1` module imports only `random_get`, `args_*`, `environ_*`, `fd_write` and
  `proc_exit`, and most of those come from the probe's own `main`.
  The `wasm32-unknown-unknown` cdylib imports **nothing**.
- **ICU** (`icu_normalizer`, `icu_segmenter` with compiled data) builds and runs:
  `'Å'.normalize('NFC')` gives length 1.

## Not investigated

- Restoring a snapshot taken natively on wasm, and the reverse.
  The image format is explicit big-endian atoms, so this is expected to work, but it was not
  tested.
- Performance relative to native.
- Firefox and Safari.
- `wasm32-wasip2` and the component model, `wasm64`, and `wasm32-wasip1-threads`.
- An abort-mode build (B1 option 3) was not built.

## Appendix: reproduction

A standalone probe crate (outside the workspace; copy `rust-toolchain.toml` and `Cargo.lock`
from `rust/engine`) depends on `ironhorse-vm` (with `consensus` for B4), `ironhorse-compile`
and `ironhorse-runtime`.
It compiles one source string, links intrinsics, installs `IronhorseSourceCompiler`, runs it,
and prints `halt`, `result` and `computrons`:

```rust
let (code, symbols) = ironhorse_compile::compile_atoms_with(src, false)?;
let mut vm = ironhorse_vm::Interp::new();
vm.link_intrinsics(&ironhorse_vm::parse_symbols(&symbols));
vm.set_source_compiler(std::rc::Rc::new(ironhorse_runtime::IronhorseSourceCompiler));
let out = vm.run(&code);
```

Two shapes were built:

- A `bin` for `wasm32-wasip1`, run under Node and Wasmtime.
- A `cdylib` for `wasm32-unknown-unknown` that exports `alloc`, `eval(ptr, len)` and
  `out_ptr`, run in Chromium.

Toolchain setup and builds:

```sh
rustup target add wasm32-wasip1 wasm32-unknown-unknown   # in rust/engine (1.91.1)
rustup component add rust-src
# B1, the stable failure:
RUSTFLAGS="-C panic=unwind" cargo build --release --target wasm32-wasip1
# B1 workaround; for exnref (Wasmtime) add -C llvm-args=-wasm-use-legacy-eh=false:
RUSTC_BOOTSTRAP=1 \
RUSTFLAGS="-C panic=unwind -C target-feature=+exception-handling -C link-arg=-zstack-size=8388608" \
  cargo build -Zbuild-std=std,panic_unwind --release --target wasm32-wasip1
```

Running each host:

- **Node:** `node:wasi` (`new WASI({version: 'preview1', …})`, as in
  `scripts/test-snapshot-wasi.py`), with `--stack-size=N` for B3.
- **Wasmtime:** `pip install wasmtime`, with `Config.wasm_exceptions = True` and
  `Config.max_wasm_stack` for B3.
- **Chromium:** Playwright's `chromium.launch({executablePath: '/opt/pw-browsers/chromium'})`
  on a page served over HTTP.
  The page compiles with `WebAssembly.compile`, uses a fresh instance per case, and repeats
  each case in a dedicated Worker.

The B3 sources are copied verbatim from `ironhorse-vm/tests/native_recursion_budget.rs`, plus
the within-budget twins (2,016 layers, 63 and 64 levels, 511 blocks, a 990-deep `?:` chain).
