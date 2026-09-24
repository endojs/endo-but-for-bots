# Compiling Ironhorse to WebAssembly: blockers

Investigation date: 2026-09-23, against `f9cbcfc4`; revised 2026-09-24 after adversarial review.
Toolchain: the pinned Rust 1.91.1 (LLVM 21.1.2), targets `wasm32-wasip1` and
`wasm32-unknown-unknown`.
Hosts:

- Node.js 22.22.2 (V8, through `node:wasi`).
- Wasmtime 49.0.0 (through the `wasmtime` Python bindings).
- Headless Chromium 141.0.7390.37 (through Playwright), on the page's main thread and in a
  dedicated Web Worker.

The motivating target is [Thixotrope on Cloudflare](../../designs/thixotrope-on-cloudflare.md):
Ironhorse compiled to wasm inside Durable Objects, which run on workerd (V8).
The findings for V8 and browsers apply there directly; workerd itself was not measured here.

Every claim below was checked by building and running something unless it is marked
*inferred*.
The [appendix](#appendix-reproduction) has the commands.

## Summary

Six of the eight runtime library crates already build for both wasm targets unchanged.
The one that does not, `ironhorse-compile`, is blocked on purpose: it refuses `panic=abort`,
the only panic strategy stable Rust offers on wasm.
`ironhorse-runtime` fails only because it depends on it.

With unwinding turned on through an unstable toolchain feature, the whole compile-and-run
pipeline works on both targets and in all three hosts.
Heap exhaustion, compiler budget refusal, and `eval`-time `SyntaxError`s are contained, as they
are natively.
A `wasm32-unknown-unknown` build needs **no imports at all**.

It is **not** yet deterministic across targets.
A guest program that allocates near the heap ceiling gets a different answer and a different
computron count on wasm32 than on native x86_64, even with `consensus` on (B7).
The probes that stay clear of that and of the host limits in B3 and B8 matched native exactly.

What stands in the way, in order of severity:

| # | Blocker | Layer | Kind |
|---|---------|-------|------|
| B1 | Stable Rust cannot link a wasm artifact with `panic=unwind`; the engine requires unwinding, including for guest-catchable errors | toolchain / engine | **hard** |
| B7 | Heap admission and snapshot decoding depend on pointer width, so native and wasm32 diverge in results and metering | engine | **hard (consensus)** |
| B3 | The native-recursion budget assumes an 8 MiB stack; smaller wasm stacks overflow **before** the budget halts, sometimes on programs the engine accepts natively | engine / host | configuration for Wasmtime and Node, **hard in browsers and workerd** |
| B8 | Memory use is 4–5× the chunk ceiling; a host memory cap turns deterministic `HeapExhausted` into a host-dependent trap | engine / host | configuration (ceilings), **hard under a 128 MB cap** |
| B2 | Wasm exception-handling encoding: LLVM emits the legacy form by default, and Wasmtime accepts only the standard `exnref` form | toolchain / host | configuration |
| B4 | Default-feature builds diverge between native and wasm in `Math` results and therefore in metering | engine features | configuration (use `consensus`) |
| B5 | The worker binary depends on threads, `flock`, bundled C SQLite and POSIX files; `FileStore` does not work on WASI | worker / store | port work |
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

The interpreter, compiler, RegExp and snapshot codec use no `std::thread`, `std::time`,
`std::env` or networking.
Two public modules do touch the OS:

- `ironhorse-snapshot`'s documented `FileStore` (`store_file.rs`) uses `std::fs` and
  `std::process::id()`.
  On `wasm32-wasip1`, `begin_store_session` into a `FileStore` panics with "unsupported",
  because `getpid` is unavailable.
- `ironhorse-vm`'s hidden `source_scan` module (`source_scan.rs:11`) uses `std::fs`.

Both build, but only `MemoryStore` or a host-imported store is usable on wasm.

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

`ironhorse-compile/src/lib.rs:31` refuses the build outright:

```rust
#[cfg(panic = "abort")]
compile_error!("ironhorse-compile requires panic=unwind to contain budget refusal");
```

The compiler is not the only crate that relies on unwinding; it is the only one that says so.
Outside test code the runtime crates have 23 `catch_unwind` sites.
Four private control transfers use `resume_unwind` as a non-local exit:

- **`ironhorse-vm` `HeapExhausted`** (`value.rs`) is raised from the "infallible" arena
  allocators and admission checks, 10 raise sites.
  Through them it is reachable from about 540 allocation call sites in `ironhorse-vm/src`
  (320 `.alloc(` and 220 more `.alloc_*(`, by grep).
  `Interp::run` catches it at the crank boundary and returns `Halt::HeapExhausted`.
- **`ironhorse-compile` `Refused`** (`meter.rs`) is the parse meter's budget stop.
- **`ironhorse-compile` `Poisoned`** (`coder.rs`, `Coder::report_kind`) is how the coder
  reports an early error, "the same control transfer" as XS's `longjmp` out of
  `fxReportParserError`.
- **`ironhorse-regexp` `CompileStop::{Budget, Resource}`** (`compile.rs`, 14 raise sites) is
  the pattern compiler's work and state ceilings.

The compile path also catches panics at each embedding site.
`ironhorse-runtime` does it for `eval` and `Function`, turning a compiler panic into
`Halt::EngineInvariant("eval:compiler-invariant")`.
The production worker does not use `ironhorse-runtime`; it wraps
`compile_atoms_goal_with_meter` in its own `catch_unwind`
(`thixotrope-ironhorse-worker/src/main.rs:121`).
`ironhorse-vm` and `ironhorse-regexp` have no `compile_error!` guard.
They build under `panic=abort`, and their refusals would then abort instead of halting.

Not everything that looks like a refusal unwinds.
The VM's own meter refusal is a returned `Step` (`dispatch.rs:48`, `admission.rs:40`), so
`MeterAbort` from guest execution is unaffected by the panic strategy.

Most of the unwind paths end in a halt the guest cannot catch (`HeapExhausted`,
`EngineInvariant`, or `MeterAbort` from compile-time budgets).
**`Poisoned` does not.**
Coder-detected early errors reach the guest as catchable `SyntaxError`s through `eval`.
This probe gives the same result natively, in Node and in Wasmtime:

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
- **Compiler budget refusal is contained** (Node, Wasmtime), when the host calls
  `compile_atoms_with_budget` at top level.
  The same `Refused` unwind inside a guest `eval` under an armed meter was **not** exercised.
  The probe meant for it hit the parser's tree-depth limit instead.
- **Early errors through `eval` are contained** (Node, Wasmtime): the `Poisoned` cases above.
- **`eval` and `Function` work** (Node, Wasmtime, Chromium), including the compiler-budget
  `SyntaxError`s.

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
   This needs two things first:
   - `Poisoned` becomes a `Result` (part of option 2).
   - The `compile_error!` is relaxed for wasm.

   After that, only `HeapExhausted`, the compile-time `Refused` and the regexp `CompileStop`
   would trap.
   Each ends in an uncatchable halt, so the host can drop the instance and restore from the
   last committed snapshot.
   The worker already exits without committing on a fatal halt.
   The halt classification is recoverable (*inferred*, not built):
   - `panic!`, `unreachable!`, `expect` and overflow checks still run the panic hook before
     aborting, so a hook that calls a host import can report them.
   - The `resume_unwind` sites bypass the hook.
     They could record a reason in a static that the host reads through an export after the
     trap, since a trapped instance remains callable (see the browser section).

   What is lost is in-process reuse of the `Interp` or `Machine` after a refusal, and
   containment of compiler panics inside `eval`.

Option 1 is the only route that works without engine changes.
Option 3 needs the `Poisoned` refactor first.
Option 2 lifts the constraint for good.

## B7: native and wasm32 diverge where accounting depends on pointer width

The engine's deterministic heap admission sometimes measures Rust memory rather than guest
data.
`admit_scratch` (`ironhorse-vm/src/interp/admission.rs:209-216`) charges
`capacity * size_of::<T>()` against the chunk ceiling.
`regexp_subject_bytes` (`interp/natives/regexp.rs:1011-1012`) admits a `Vec<usize>` of
code-unit offsets through it, so each element costs 8 bytes natively and 4 on wasm32.

A guest can observe the difference:

```js
var s = 'a'.repeat(16 * 1024 * 1024);
var f = 'b'.repeat(64 * 1024 * 1024);
/z/.test(s)
```

| Build (`consensus` on) | Halt | Result | Computrons |
|---|---|---|---|
| native x86_64 | `HeapExhausted` | — | 20,972,860 |
| wasm32 (Wasmtime; also Chromium) | `Return` | `false` | 37,750,079 |

A control with a 32 MiB filler agrees on both targets.
`(ReadKey, usize)` scratch in `json.rs:1199` has the same shape, though a stricter check
before it currently masks it.
There are 73 scratch-admission call sites, and an audit of every one for pointer-width
dependence is in progress.
The fix is to charge a fixed, specified width per element rather than `size_of::<T>()` for any
`T` that contains `usize` or pointers.

Snapshot restore has a related cross-target hazard (*from code, not run*).
`manifest.chunk_len` is a `u64` that decoding never bounds to 32 bits.
It is narrowed with `as usize` at `ironhorse-snapshot/src/store.rs:3262`, `machine.rs:1379`
and `store.rs:2931`; at `store.rs:2931` the narrowing happens before `.min(1 << 24)`.
The default chunk ceiling is 256 MiB, but embedders can raise it (`value.rs:10-13`).
A native heap with more than 4 GiB of chunks would then be silently truncated on a wasm32
restore instead of refused.
A `u32::try_from`-style refusal closes it.

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
  Every figure below uses that 8 MiB shadow stack.
- **The host engine's call stack** is where wasm frames themselves live.
  The host sizes it: V8's `--stack-size` defaults to 984 KiB, and Wasmtime's `max_wasm_stack`
  defaults to 512 KiB.
  In a browser it is not configurable at all.

### Measurements

The 25 cases below cover the families in `ironhorse-vm/tests/native_recursion_budget.rs`, each
at its ceiling, plus within-budget twins.
Wherever an entry says "ok", the host returned the same `Halt`, result and computrons as native.
The V8 columns are single runs of a **freshly started process** (see "V8 is not stable" below).

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
| Self-containing `join` / `String(a)`, deep `RegExp`, copied Iterator setter, 91 parens, 256-deep render | as native | ok | ok | ok | ok | ok | ok |

The rows marked *Accepted* matter most.
On an undersized stack, programs the engine **accepts** natively fail too; it is not only the
programs it was going to halt anyway.

A second batch covered the file's remaining 17 cases: `[[Set]]`, `[[HasProperty]]`,
`[[Delete]]`, `[[GetOwnProperty]]`, `[[GetPrototypeOf]]`, `[[SetPrototypeOf]]`,
`[[IsExtensible]]` and `[[PreventExtensions]]` chains, the index-key variants, `Reflect.get`,
the Proxy prototype cycle, the `instanceof` cycle, bound-call trampolines, and the
`Symbol.toStringTag` Iterator setter.
All of them passed at Wasmtime 2,000,000 B, but:

- At Wasmtime 512 KiB, `[[Set]]`, `[[HasProperty]]`, `[[Delete]]`, the index `[[Get]]`,
  `[[HasProperty]]` and `[[Delete]]` chains, and `Reflect.get` trap.
- At Wasmtime 1 MiB, the Proxy prototype cycle also traps.
- In the Chromium Worker, `[[Set]]`, `[[HasProperty]]`, `[[Delete]]`, the index
  `[[HasProperty]]` and `[[Delete]]` chains, and the prototype cycle trap.

In total **17 of 42 cases trap in a Chromium dedicated Worker**.
The compiler contributes too: its parser, scoper and coder recurse on the host stack up to
`TREE_DEPTH_LIMIT = 2048` (`ast.rs:166`).
That recursion is behind the Wasmtime 512 KiB traps of the nested-`eval`, nested-block and
`?:`-chain cases.

### V8 is not stable

V8's per-frame stack use depends on which compiler tier ran the code.
At `--stack-size=1300`, the `JSON.stringify` case passed 2 of 5 runs of the same build.
With `--liftoff-only` it passes at 1300.
With `--no-liftoff` (TurboFan only) it still traps at 1500 and first passes at 1600.
Under `--no-liftoff` at the default stack size, five cases trap rather than one:

- the Proxy `[[Call]]` chain
- `JSON.parse` of nested arrays and of nested objects
- the reviver
- `JSON.stringify`

A warmed process is worse than a cold one.
After a warm-up loop, the 10,000-level `JSON.parse` traps in default Node in 3 of 3 runs, while
a cold process passes it.
The same warmed case passed in Chromium's main thread.
Wasmtime compiles ahead of time and behaved identically on every run.

### Failures are traps or host crashes

In the recursion cases, no host ever returned a *different* answer.
The failures were:

- **Host traps**: `RangeError: Maximum call stack size exceeded` in V8, and
  `wasm trap: call stack exhausted` in Wasmtime.
- **Host process crashes.**
  Wasmtime runs wasm on the calling thread's own stack.
  With `max_wasm_stack = 2,000,000` on a Python thread with a 1 MiB stack, the
  `JSON.stringify` case kills the host with `SIGSEGV`.
  It works on 2 MiB and 8 MiB host threads.

A trap is not contained, even with unwinding enabled.
Rust state at the moment of the trap is not rolled back (*inferred*), so the instance must be
discarded.
The guest controls how deep it recurses, so on an undersized stack a guest can turn a
deterministic `ReentryLimit` into a host-dependent failure.
That is a determinism break across hosts, not just a crash.

### Options

- **Require minimum stacks** where the embedder controls them, and document them next to
  `NATIVE_STACK_BYTES`:
  - `-zstack-size` ≥ 8 MiB.
  - Wasmtime `max_wasm_stack` ≥ 2 MiB, on a host thread whose own stack is comfortably
    larger.
    The wasmtime-py 49 `Config` has no `async_stack_size` setter, and `max_wasm_stack` above
    2,097,152 bytes panics the process with "max_wasm_stack size cannot exceed the
    async_stack_size".
    From Python the usable margin above the measured 2,000,000-byte requirement is therefore
    about 5%; the Rust API can raise `async_stack_size`.
  - Node `--stack-size` ≥ 1600, the TurboFan figure, plus margin.
- **Browsers and workerd** cannot raise the stack, so there the frames must shrink or leave the
  call stack.
  Candidates include:
  - moving the deep walkers (JSON, `flat`, Proxy forwarding, re-entrant dispatch) onto
    explicit heap stacks
  - bounding the compiler's AST recursion the same way
  - shrinking the heavy `dispatch_at` and `call_native` frames

  [STACK-DEPTH-REFACTOR.md](STACK-DEPTH-REFACTOR.md) (in progress) maps every recursion
  family and ranks these refactors.
  Lowering `NATIVE_DEPTH_LIMIT` for wasm alone would not work: the limit is release-versioned
  and changes acceptance, so native and wasm workers could no longer share a release.

## B8: memory headroom is 4–5× the chunk ceiling

The default ceilings (1,000,000 slots, a 256 MiB chunk arena, `value.rs:10-13`) bound the
engine's own arenas, not the process's memory.
Measured:

- Doubling a string until it reaches the 256 MiB chunk ceiling left Wasmtime's linear memory
  at 18,516 pages (1.21 GB), and native peak memory (RSS) at 1.03 GB.
- A 64-million-code-unit string that completes normally used 945 MB of linear memory.

Wasm linear memory never shrinks.
On a host whose memory cap is below that footprint, `memory.grow` fails before the engine's
deterministic `HeapExhausted`.
The result is an allocator abort and trap, which again depends on the host.
Cloudflare's 128 MB isolate cap is far below the default footprint.
Ceilings for such a host must be set so that the *worst-case* footprint fits, and the ratio
must be measured per build.

Node's `node:wasi` is also unreliable at these sizes.
Above roughly 0.6 GB of linear memory it crashed the whole Node process with `SIGSEGV`: a
memory-pressure GC reached from `uvwasi_fd_write` crashes in
`InnerPointerToCodeCache::GetCacheEntry`.
Wasmtime ran the same modules correctly.
`scripts/test-snapshot-wasi.py` uses the same runner, which is fine for its small tests.

## B2: which exception-handling encoding the host supports

LLVM 21 emits the **legacy** wasm EH instructions (`try`/`catch`) by default.
Wasmtime 49 rejects such a module:

```text
Invalid input WebAssembly code at offset 5431: legacy_exceptions feature required for try instruction
```

Adding `-C llvm-args=-wasm-use-legacy-eh=false` to the same `RUSTFLAGS` emits the standard
`exnref` form (`try_table`).
Wasmtime 49 then runs the probes with its default `Config`, containment included; exceptions
are enabled by default.
Node 22.22.2 and Chromium 141 ran **both** encodings without flags.

Wasmtime needs `exnref`, so `exnref` is the natural default for a build shared by Wasmtime and
browsers.
Legacy EH matters only for older browser engines, which were not tested here.
Whichever is chosen, the flag must be in `RUSTFLAGS` so that `-Zbuild-std` compiles std with
the same encoding.

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
With `consensus` (pure-Rust `libm`, `force-soft-floats`) the two targets agree on this probe.
The worker already enables `consensus`, and the build already rejects `cost-calibration`
alongside it (`ironhorse-vm/src/lib.rs:25`).
Floating-point operations outside the `Math` provider are part of the B7 audit.

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
- **`FileStore` is not an alternative**: it panics on `wasm32-wasip1` (see
  [What builds today](#what-builds-today-unmodified)).

The snapshot store seam already abstracts the backend (`ironhorse_snapshot::store`, with
`MemoryStore` in tree).
A wasm worker can therefore keep persistence on the host side, behind an imported store.
That is the approach [Thixotrope on Cloudflare](../../designs/thixotrope-on-cloudflare.md)
proposes with Durable Object SQLite.
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
Nothing stops the currently clean crates from gaining a wasm-incompatible dependency, and
nothing catches B7-style divergence.

A cheap first gate is `cargo build --target wasm32-unknown-unknown` for the six crates that
build today, plus the existing WASI script.
The next step is a differential job that runs the same guest programs natively and on wasm32
(under Wasmtime) and compares results and computrons.
It should also run the recursion families under a fixed small `max_wasm_stack`.

## Browser-specific considerations

Everything above applies in a browser.
The following is specific to it, measured in headless Chromium 141 unless marked otherwise.
Firefox and Safari were not available to test.

- **Target.**
  `wasm32-unknown-unknown` is the natural target.
  The cdylib imports nothing, so it needs neither a WASI shim nor `wasm-bindgen`.
  A small `extern "C"` surface was enough to drive it: `alloc`, `set_ceiling`,
  `eval(ptr, len)` and `out_ptr`.
- **The stack is the main problem** (B3).
  A page cannot configure it.
  The main thread fails only the `JSON.stringify` ceiling (cold).
  A dedicated **Web Worker has a smaller stack**.
  17 of 42 cases trap there, including an accepted 2,016-layer Proxy chain.
  `--js-flags=--stack-size=4000` fixed the main thread but not the Worker.
  That suggests the Worker is limited by its thread's own OS stack (*inferred*); a page could
  not pass the flag anyway.
  This is a real tension.
  Long cranks belong in a Worker so they do not freeze the page, and the Worker is where the
  stack is smallest.
  In practice, browser support depends on the refactors in B3.
- **A trap does not poison the instance.**
  After a stack-overflow `RangeError`, the same instance accepted another call and returned
  `2` for `1+1`.
  Rust state at the moment of the trap is not rolled back (*inferred*): no destructors run, and
  borrows and the shadow-stack pointer are left as they were.
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
  The 8 MiB-shadow-stack runs used the legacy encoding only.
  Older browser engines may accept only the legacy form (*inferred*).
- **Memory** (B8).
  Desktop headless Chromium grew a memory to the full 4 GiB.
  Mobile browsers typically cap lower (*inferred*).
  The engine's default ceilings allow a footprint above 1 GB, so browser ceilings must be set
  from the memory cap, not left at the defaults.
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
  B7 applies unchanged.
  Only Chromium was measured.
- **Download size.**
  The module is 6.9 MB before `wasm-opt` and compression, including ICU normalizer and
  segmenter data.

## Not blockers (verified)

- **Host imports.**
  The `wasm32-wasip1` module imports only `random_get`, `args_*`, `environ_*`, `fd_write` and
  `proc_exit`, and most of those come from the probe's own `main`.
  The `wasm32-unknown-unknown` cdylib imports **nothing**.
- **The snapshot's 32-bit overflow refusals** pass on WASI (`test-snapshot-wasi.py`).
- **ICU** (`icu_normalizer`, `icu_segmenter` with compiled data) builds and runs:
  `'Å'.normalize('NFC')` gives length 1.
- **Casting edge cases.**
  21 typed-array, `ArrayBuffer`, `DataView`, `repeat`, `padEnd`, `join`, `Array` length and
  sparse-index cases at 2^29 to 2^32 gave identical results and computrons natively and on
  wasm32 (Wasmtime).

## Not investigated

- Restoring a snapshot taken natively on wasm, and the reverse (see the B7 decode hazard).
- Performance relative to native.
- Firefox, Safari and workerd.
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
- A `cdylib` for `wasm32-unknown-unknown` that exports `alloc`, `set_ceiling`,
  `eval(ptr, len)` and `out_ptr`, run in Chromium.

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
  Keep programs well below 0.6 GB of memory (B8).
- **Wasmtime:** `pip install wasmtime` (exceptions are on by default in 49), with
  `Config.max_wasm_stack` for B3.
  Run it on a host thread with more stack than `max_wasm_stack`.
- **Chromium:** Playwright's `chromium.launch({executablePath: '/opt/pw-browsers/chromium'})`
  on a page served over HTTP.
  The page compiles with `WebAssembly.compile`, uses a fresh instance per case, and repeats
  each case in a dedicated Worker.

The B3 sources are copied verbatim from `ironhorse-vm/tests/native_recursion_budget.rs`, plus
the within-budget twins (2,016 layers, 63 and 64 levels, 511 blocks, a 990-deep `?:` chain).
