# Compiling Ironhorse to WebAssembly: blockers

Investigation date: 2026-09-23, against `f9cbcfc4`; revised 2026-09-24 after adversarial review.
Toolchain: the pinned Rust 1.91.1 (LLVM 21.1.2), targets `wasm32-wasip1` and
`wasm32-unknown-unknown`.
Hosts:

- Node.js 22.22.2 (V8, through `node:wasi`).
- Wasmtime 49.0.0 (through the `wasmtime` Python bindings).
- Headless Chromium 141.0.7390.37 (through Playwright), on the page's main thread and in a
  dedicated Web Worker.
- Local workerd 1.20260923.1 (V8 15.4.80.5), in a request handler and in a SQLite-backed
  Durable Object.
  These runs come from the verification of the Cloudflare design
  ([review](../../designs/thixotrope-on-cloudflare-review.md)); local workerd enforces no CPU or
  memory limits.

The motivating target is [Thixotrope on Cloudflare](../../designs/thixotrope-on-cloudflare.md):
Ironhorse compiled to wasm inside Durable Objects, which run on workerd.
[Cloudflare-specific considerations](#cloudflare-workerd-specific-considerations) follow the
browser section.

Every claim below was checked by building and running something unless it is marked
*inferred*.
The [appendix](#appendix-reproduction) has the commands for the Node, Wasmtime and Chromium runs.
The workerd harness and the divergence audit's crafted-store probes were not kept.

## Summary

Six of the eight runtime library crates already build for both wasm targets unchanged.
The one that does not, `ironhorse-compile`, is blocked on purpose: it refuses `panic=abort`,
the only panic strategy stable Rust offers on wasm.
`ironhorse-runtime` fails only because it depends on it.

With unwinding turned on through an unstable toolchain feature, the whole compile-and-run
pipeline works on both targets and in all four hosts.
Heap exhaustion, compiler budget refusal, and `eval`-time `SyntaxError`s are contained, as they
are natively.
A `wasm32-unknown-unknown` build needs **no imports at all**.

It is **not** yet deterministic across targets, even with `consensus` on.
An audit confirmed 27 sites where native x86_64 and wasm32 behave differently (B7).
Most give the same guest program a different answer or a different computron count.
The rest are host-side: a checkpoint that aborts on wasm32, a crafted store, error values, a
WASI panic, and a restore that follows hash order.
Examples are allocating near a heap ceiling, growing arrays or side tables past wasm32's
allocation limits, and one three-line program that crashes the wasm32 engine outright.
The probes that stay clear of those sites and of the host limits in B3 and B8 matched native
exactly.

What stands in the way, in order of severity:

| # | Blocker | Layer | Kind |
|---|---------|-------|------|
| B1 | Stable Rust cannot link a wasm artifact with `panic=unwind`; the engine requires unwinding, including for guest-catchable errors | toolchain / engine | **hard** |
| B7 | Heap admission, unadmitted host allocations, `usize` arithmetic and snapshot decoding depend on the target, so native and wasm32 diverge in results and metering; one tiny program crashes wasm32 | engine | **hard (consensus)** |
| B3 | The native-recursion budget assumes an 8 MiB stack; smaller wasm stacks overflow **before** the budget halts, sometimes on programs the engine accepts natively | engine / host | configuration for Wasmtime and Node, **hard in browsers and workerd** |
| B8 | The ceilings do not bound memory: up to 4–5× the chunk ceiling for a running string heap and about 6× while a snapshot of it is written, unbounded for arrays and side tables; a cap that fails `memory.grow` makes programs trap or halt early with `HeapExhausted` where native completes or halts later, and Cloudflare documents replacing the whole isolate, but whether production fails `memory.grow` first is not known | engine / host | **hard under a 128 MB cap** |
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
Three public modules do touch the OS:

- `ironhorse-snapshot`'s documented `FileStore` (`store_file.rs`) uses `std::fs` and
  `std::process::id()`.
  On `wasm32-wasip1`, `begin_store_session` into a `FileStore` panics with "unsupported",
  because `getpid` is unavailable.
- `ironhorse-snapshot`'s `machine` module: `MachineSnapshot::suspend_to_cas` and
  `resume_from_cas` use `std::fs`, and the CAS temporary name uses `std::process::id()`
  (`machine.rs:114`), so `suspend_to_cas` also panics on `wasm32-wasip1`.
- `ironhorse-vm`'s hidden `source_scan` module (`source_scan.rs:11`) uses `std::fs`.

All three build, but only `MemoryStore` or a host-imported store is usable on wasm.

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

- **Heap exhaustion is contained** (Node, Wasmtime, Chromium, workerd).
  `var a=[]; for(;;) a.push({x:a.length})` under `set_slot_ceiling(20_000)` halts with
  `HeapExhausted`, and a fresh `Interp` in the same instance then runs `1+1` to `2`.
- **Compiler budget refusal is contained** (Node, Wasmtime), when the host calls
  `compile_atoms_with_budget` at top level.
  The same `Refused` unwind inside a guest `eval` under an armed meter was **not** exercised.
  The probe meant for it hit the parser's tree-depth limit instead.
- **Early errors through `eval` are contained** (Node, Wasmtime): the `Poisoned` cases above.
- **`eval` and `Function` work** (Node, Wasmtime), including the compiler-budget
  `SyntaxError`s.
  Chromium and workerd ran only the `eval-deep` family case, which exercises `eval` and its
  compiler-budget `SyntaxError`s but neither `Function` nor a `Poisoned` unwind.

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

## B7: native and wasm32 diverge wherever accounting or allocation depends on the host

A consensus build must give the same result and the same computrons on every target.
An audit of the engine for native-versus-wasm32 divergence confirmed 27 distinct sites.
Each guest-visible site was reproduced by running the same program on the native probe and on
the wasm32 probe under Wasmtime, both with `consensus`, and comparing the full output line.
The snapshot and store findings used crafted inputs or host calls.
It found them through five lenses: host-layout charges, casts, overflow points, floating point,
and snapshots.
The sites fall into four families.
Floating point is not among them.
With `consensus`, 13 of the 15 floating-point candidates were false positives, and the other two
are latent issues listed below.

### Admission charged by Rust memory layout

Deterministic heap admission sometimes measures Rust memory rather than guest data.
`admit_scratch` and its siblings (`ironhorse-vm/src/interp/admission.rs:106`, `:208-216`,
`:223`) charge `capacity * size_of::<T>()` against the chunk ceiling.
The RegExp compiler and matcher do the same against their own byte budgets.
For any `T` that contains `usize`, a `Vec` header or a pointer, native and wasm32 charge
different amounts, so a program near a ceiling halts on one target and completes on the other.

| Site | Element type (native / wasm32 bytes) | Program | Native | wasm32 |
|---|---|---|---|---|
| `natives/regexp.rs:1012` | `usize` (8 / 4) | `var s='a'.repeat(16*1024*1024); var f='b'.repeat(64*1024*1024); /z/.test(s)` | `HeapExhausted`, 20,972,860 | `Return false`, 37,750,079 |
| `natives/regexp.rs:1393` | `usize` (8 / 4) | `'a'.repeat(30000000).replaceAll('a','c').length` | `HeapExhausted`, 14,013,699 | `Return 30000000`, 30,000,936 |
| `natives/regexp.rs:1490` | `(Slot, usize, usize)` (40 / 32) | 134.1M-unit filler, then `'a'.repeat(5000).replace(/a/g,'b').length` | `HeapExhausted` | `Return 5000` |
| `natives/json.rs:591`, `:708` | `Vec<u16>` (24 / 12) | 134.2M-unit filler, then `JSON.stringify(new Array(1000)).length` | `HeapExhausted`, 33,553,334 | `Return 5001` |
| `natives/json.rs:1095` | `JsonSource` (40 / 32) | `var f='b'.repeat(134186000); var t='['+'1,'.repeat(999)+'1]'; JSON.parse(t, function(k,v){return v}).length` | `HeapExhausted`, 33,549,846 | `Return 1000`, 33,563,123 |
| `natives/json.rs:1204` | `(ReadKey, JsonSource)` (48 / 40) | `var f='b'.repeat(134142000)`, then the same reviver parse of a 1,000-member object, `typeof` its result | `HeapExhausted`, 33,570,307 | `Return object`, 33,583,878 |
| `ironhorse-regexp/src/compile.rs:953`, `:955-962`, `:1366-1375`, `:1717` | `Node` (64 / 40), `Vec<u32>` headers (24 / 12) | `new RegExp('a'.repeat(420000)).test('a')` | `HeapExhausted`, 288,772 | `Return false`, 321,730 |
| `ironhorse-regexp/src/matcher.rs:129`, `:190-193` | `State` (40 / 24), `AssertionData` (16 / 8) | `new RegExp('()'.repeat(129)+'a*$').test('a'.repeat(62500))` | `HeapExhausted`, 202,597 | `Return true`, 203,696 |

For `new RegExp` and RegExp literals, guest `try`/`catch` cannot hide the difference.
The regexp compiler's limit becomes an uncatchable `HeapExhausted` natively.
Top-level literals become a compile-time `RegExpResourceLimit` natively but compile on wasm32.
A wasm32 snapshot that holds such a `RegExp` is refused when restored natively, with
`Corrupt("regexp side table: persisted source does not compile")`
(`ironhorse-snapshot/src/snapshot_roster.rs:950`).
`json.rs:1199` (`(ReadKey, usize)`, 16 / 12) is masked today by a stricter check before it.

The fix is to charge a fixed, declared width per element type instead of `size_of::<T>()`.
Use the audited 64-bit widths, with a compile-time assertion on 64-bit targets, so native
thresholds do not move.

### Unadmitted host allocations

Some guest-driven storage is never admitted against a ceiling at all.
Its only bound is host memory, and wasm32 has less of it.
Rust's `Vec` also refuses any single allocation larger than `isize::MAX` bytes, which is
2 GiB on wasm32.
Past these limits wasm32 aborts: an allocation failure or a "capacity overflow" panic becomes a
trap.
At the same point native completes, or halts deterministically.

| Site | Program | Native | wasm32 |
|---|---|---|---|
| Map and Set entries (`ironhorse-vm/src/bulk.rs:479`) | `var m=new Map(); for (var i=0;i<N;i++) m.set(i,i); m.size`, N = 2^25 + 1 | `Return 33554433` | capacity-overflow panic, trap |
| Array items (`bulk.rs:242`) | 80 × `JSON.parse` of a 1,000,000-element array, all kept | `Return 80:1000000` (4.4 GiB RSS) | allocation failure, trap |
| `Intl.Segmenter` segments (`interp/locale.rs:308`) | 8 × `seg.segment()` of a 32M-unit string, all kept | `Return 8` (6.6 GiB RSS) | allocation failure, trap |
| `Intl.ListFormat` (`natives/dispatch.rs:1967`, `intl.rs:757`) | 2,000 references to one 1.1M-unit string, then a number | catchable `TypeError` | allocation failure, trap |
| Typed-array `join`, typed-array and array `toLocaleString` (`natives/buffer.rs:558`, `:287`, `natives/array.rs:4482`) | a long separator or long elements | `HeapExhausted` | capacity-overflow panic, trap |
| `Function` constructor (`interp/eval.rs:226`, then `ironhorse-compile/src/lexer.rs:167`) | `Function(s,s,…,'')` with a 268.8M-code-point assembled source | `Return function12` | `EngineInvariant("eval:compiler-invariant")` |

The same sites break native resource accounting too.
Under the default ceilings the native process reached about 4–6.6 GiB of RSS in these repros.
With a slot ceiling of 50,000, one million Map entries, Set entries, array items or indexed
properties still succeed.
The fix is to admit side-table and array-item storage, and guest-amplified host copies, against
the ceilings before allocating.

### Arithmetic on the host's `usize`

- **`advance_string_index` (`natives/regexp.rs:301`)** computes `i + 1` in `usize`.
  With `lastIndex = 2**32 - 1` that overflows on wasm32 only.
  With overflow checks on, as the workspace `release` profile and the default `dev` profile both
  have them, it panics; with them off, `subject[i]` panics out of bounds instead, so a
  three-line guest program crashes the wasm engine either way:

  ```js
  var re = /(?:)/gu; var n = 0;
  re.exec = function () { if (n++) return null; this.lastIndex = 4294967295; return ['']; };
  re[Symbol.replace]('x', 'Q')
  ```

  Native returns `"Qx"`.
  `@@match`, `String.prototype.replace` and `matchAll` reach the same line.
- **`JSON.stringify` output sizing (`natives/json.rs:163`)** converts a `u64` to `usize` before
  checking the result limit.
  A nested array whose computed output crosses 2^32 units throws a catchable
  `RangeError: result too large` natively, but halts with `HeapExhausted` on wasm32.

### Snapshots and stores

- **Checkpointing needs several copies of the heap** (`ironhorse-snapshot/src/machine.rs:163`).
  A machine with 16 million Map entries runs identically on both targets.
  Natively it then checkpoints into a 640 MB snapshot.
  On wasm32 the encoder's doubling buffer fails to allocate 1 GiB and aborts.
  `snapshot_image` first copies the arenas into a `MachineImage`, and `encode_heap` then builds
  the HEAP payload in two more buffers before copying it into the output.
  Encoding each atom straight from the live arenas into the sink, whether a file, a hasher or
  one exact pre-sized buffer, removes the copies; pre-sizing the output buffer alone does not.
- **`manifest.chunk_len` is truncated** (`ironhorse-snapshot/src/store.rs:605`, narrowed with
  `as usize` at `machine.rs:1379`, `store.rs:2931`, `store.rs:3262`).
  A crafted store with `chunk_len = 2^32 + 65536` makes every chunk allocation halt natively.
  On wasm32 the same store resumes as if it held 65,536 bytes and answers guest programs.
  Decoding should refuse any `chunk_len` above the 32-bit chunk address space.
- **Duplicate Intl bound-function rows restore by hash order**
  (the gate at `ironhorse-snapshot/src/snapshot_roster.rs:1762` accepts them, and
  `ironhorse-vm/src/interp/persist.rs:1985` keeps both).
  The same crafted snapshot gave `false,true,false` in 7 of 12 native runs and
  `true,false,false` in the other 5, because the `compare` getter picks a row by `HashMap`
  iteration order (`interp/dispatch/property_read.rs:291-294`).
  This was measured natively and on `wasm32-wasip1`; on `wasm32-unknown-unknown`, whose hash
  keys derive from addresses, the pick is fixed for a given build and history (*inferred*).
  Decoding should refuse duplicate owners.
- **The CAS and file-store temporary names use `std::process::id()`**
  (`ironhorse-snapshot/src/machine.rs:114`, `store_file.rs:135`, `:730`), which panics on WASI.
- **Error values differ by width.**
  An overflowing HEAP, STAC or manifest count is refused on both targets, with different
  `Corrupt` messages (`ironhorse-snapshot/src/image.rs:957`, `:4630`, `store.rs:639`).

### Latent: host limits the ceilings can outrun

- **Embedder-raised ceilings.**
  With a chunk ceiling above about 1 GiB, the chunk arena's amortized doubling asks for more
  than `isize::MAX` on wasm32 before memory runs out (`ironhorse-vm/src/value.rs:2222`).
  At a 1.5 GiB ceiling, 17 kept 32M-unit strings return natively and halt on wasm32.
  A single scratch buffer over 2 GiB fails the same way: at a 3.5 GiB ceiling,
  `'a'.repeat(1100000000)` returns natively and halts on wasm32 in `reserved_vec`
  (`interp/admission.rs:236`).
  The slot arena has the same wall, and where it falls depends on the arena's capacity history,
  which no snapshot records: a fresh wasm32 arena stops at 2^26 slots and a restored one at
  59,244,544, so two wasm32 replicas can disagree.
  Under `consensus`, `set_chunk_ceiling` and `set_slot_ceiling` should refuse any value that
  some target cannot honor, whatever the history.
  The `isize::MAX` wall alone allows at most 2^30 bytes of chunks and 44,739,242 slots
  (`floor((2^31 - 1) / 48)`), but wasm32's 4 GiB address space binds sooner.
  At a 2^30 chunk ceiling, B8's 1M-unit doubling program halts natively and traps on wasm32 when
  `units_to_be16` cannot allocate 1 GiB.
  At 2^29 both targets halt identically, but with the slot ceiling at 44,739,242, 44,000,000
  kept objects take 3.23 GB of wasm32 linear memory, and the same doubling after them traps on
  wasm32 again.
  The two caps must be chosen together, so that both arenas' worst-case footprint (B8) fits in
  4 GiB with room left for a checkpoint, which holds several more copies of the heap until the
  encoder streams (see "Checkpointing needs several copies of the heap" above).
  The 44,000,000 kept objects above run identically on both targets, but checkpointing them
  aborts on wasm32 at 4.11 GB of linear memory, when the encoder cannot allocate 880 MB, while
  native writes the 880 MB snapshot.
  At a 2^29 chunk ceiling, writing a 503 MB snapshot of strings took wasm32 from 1.10 GB to
  3.11 GB of linear memory.
- **`json_escape_string` (`natives/json.rs:81`)** sizes its output in `usize`, but no guest can
  build a large enough string on wasm32 today.
- **The host floating-point environment.**
  A shared library that sets flush-to-zero or a different rounding mode in MXCSR changes native
  results.
  Wasm is not immune: under the same `LD_PRELOAD`, the wasm32 probe gave the same altered
  results in Wasmtime and in Node, whose generated code runs under the host thread's MXCSR.
  A self-test inside the engine, run on the executing thread at every entry and on every target,
  can refuse such a host.
- **The platform `Math` provider is the default** for every crate except the two shipping
  binaries (B4).
- **`ironhorse-store-sqlite` narrows stored `i64` keys without range checks**
  (`rust/endo/ironhorse-store-sqlite/src/lib.rs:855` and siblings).
  A crafted database could alias rows differently by width; the crate does not build for wasm
  today.

### Fix prototypes

Three of the audit's fixes, which cover 11 of the 27 sites, are kept as two patches in
[`determinism-prototypes/`](determinism-prototypes/):
- fixed per-element admission widths, with the matcher's charges pinned the same way;
- the `advance_string_index` overflow;
- the `JSON.stringify` output sizing.

With both patches applied, eight of the repros above print exactly the native line on wasm32.
Patched native output is byte-identical to unpatched native output, so native thresholds do
not move.
A control repro in the RegExp compiler, which neither patch touches, still diverges.
The `ironhorse-vm` and `ironhorse-regexp` test suites pass, except for one source-mutation test
whose anchor line the JSON patch rewrites.

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
| *Accepted:* 64 nested `async` calls (half the allowance, which is 126) | completes | ok | ok | ok | **trap** | ok | ok |
| *Accepted:* 511 nested blocks; a 990-deep `?:` chain | completes | ok | ok | ok | **trap** | ok | ok |
| Self-containing `join` / `String(a)`, deep `RegExp`, a backtracking `RegExp`, copied Iterator setter, 91 parens, 256-deep render | as native | ok | ok | ok | ok | ok | ok |

The rows marked *Accepted* matter most.
On an undersized stack, programs the engine **accepts** natively fail too; it is not only the
programs it was going to halt anyway.
The table's accepted rows all pass at Wasmtime 1 MiB, but they are not the worst accepted
programs.
[STACK-DEPTH-REFACTOR.md §1.3](STACK-DEPTH-REFACTOR.md#13-what-traps-today) measures more:
- eight heavy re-entry ceilings trap at 1 MiB, and two of them still trap at 1.5 MiB;
- some accepted programs trap even at 2,097,152 B, such as a 4 KB chain of 2,038 tagged
  templates, and `JSON.stringify` of objects nested to the native ceiling;
- 41 nested `eval`s compiling such a chain need 3,281,859 B.

A second batch covered the file's remaining 17 cases: `[[Set]]`, `[[HasProperty]]`,
`[[Delete]]`, `[[GetOwnProperty]]`, `[[GetPrototypeOf]]`, `[[SetPrototypeOf]]`,
`[[IsExtensible]]` and `[[PreventExtensions]]` chains, the index-key variants, `Reflect.get`,
the Proxy prototype cycle, the `instanceof` cycle, bound-call trampolines, and the
`Symbol.toStringTag` Iterator setter.
All of them passed at Wasmtime 2,000,000 B, but:

- At Wasmtime 512 KiB, `[[Set]]`, `[[HasProperty]]`, `[[Delete]]`, the index `[[Get]]`,
  `[[HasProperty]]` and `[[Delete]]` chains, `Reflect.get` and the Proxy prototype cycle trap.
- At Wasmtime 1 MiB, only the Proxy prototype cycle still traps.
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
Rust state at the moment of the trap is not rolled back, so the instance must be discarded.
In local workerd, an exception inside a transaction rolled SQL back while a JS stand-in for the
cached vat kept the change, and the next crank committed the mismatch
([Cloudflare review](../../designs/thixotrope-on-cloudflare-review.md), blocker 4).
The guest controls how deep it recurses, so on an undersized stack a guest can turn a
deterministic `ReentryLimit` into a host-dependent failure.
That is a determinism break across hosts, not just a crash.

### Options

- **Require minimum stacks** where the embedder controls them, and document them next to
  `NATIVE_STACK_BYTES`:
  - `-zstack-size` ≥ 4 MiB: the worst accepted composition measured needs 2,611,856 bytes of
    shadow stack (STACK-DEPTH-REFACTOR.md
    [§1.2](STACK-DEPTH-REFACTOR.md#12-two-stacks-on-wasm-and-the-host-limits)).
    The figures in this report used 8 MiB.
  - Wasmtime `max_wasm_stack` ≥ 2 MiB for the families above, on a host thread whose own
    stack is comfortably larger.
    Some accepted programs need more than 3 MiB (see above), so 2 MiB is a floor, not a bound.
    The wasmtime-py 49 `Config` class has no `async_stack_size` property, and `max_wasm_stack`
    above 2,097,152 bytes panics the process with "max_wasm_stack size cannot exceed the
    async_stack_size" unless that limit is raised first.
    From Python, `wasmtime._ffi.wasmtime_config_async_stack_size_set(cfg.ptr(), n)` raises it,
    and STACK-DEPTH-REFACTOR.md §1.3 measured its 2.26–3.28 MB cases that way; the Rust API has
    `Config::async_stack_size`.
  - Node `--stack-size` ≥ 1,551 KiB for the 25 cases (1,518 KiB with TurboFan pinned, 1,551 KiB
    under the worst measured tier mix), more for accepted compositions (1,680 KiB measured),
    plus margin.
- **Browsers and workerd** cannot raise the stack, so there the frames must shrink or leave the
  call stack.
  Candidates include:
  - moving the deep walkers (JSON, `flat`, Proxy forwarding, re-entrant dispatch) onto
    explicit heap stacks
  - bounding the compiler's AST recursion the same way
  - shrinking the heavy `dispatch_at` and `call_native` frames

  [STACK-DEPTH-REFACTOR.md](STACK-DEPTH-REFACTOR.md) maps every recursion
  family and ranks these refactors.
  Lowering `NATIVE_DEPTH_LIMIT` for wasm alone would not work: the limit is release-versioned
  and changes acceptance, so native and wasm workers could no longer share a release.

## B8: the ceilings do not bound memory

The default ceilings (1,000,000 slots, a 256 MiB chunk arena, `value.rs:10-13`) bound the
engine's own arenas, not the process's memory.
Measured:

- Doubling a 1M-unit string (`var s='x'.repeat(1<<20); for(;;) s=s+s;`) until it reaches the
  256 MiB chunk ceiling left Wasmtime's linear memory at 18,516 pages (1.21 GB), and native
  peak memory (RSS) at 1.08 GB.
  Doubling from `'a'` halts at 9,908 pages (649 MB).
- The same doubling stopped at 64 million code units completes normally with 945 MB of linear
  memory; `'a'.repeat(64*1024*1024)` needs 414 MB.
- Array items and the Map, Set and Intl side tables are not admitted at all (B7).
  Ten million `a.push(0)` calls grew linear memory to 583 MB while the chunk arena held 12 KB.
  Native repros reached about 4–6.6 GiB of RSS under the default ceilings (B7).

So for heaps dominated by strings the running footprint is up to 4–5× the chunk ceiling
(doubling a large string is the worst case measured while running; push loops of strings halted
at 2.1–2.2×), and for heaps dominated by arrays or side tables no ceiling bounds it.
A whole-heap snapshot adds several copies (B7), and the worst-case footprint must count them:
under the default ceilings, writing a 252 MB snapshot of strings took wasm32 from 557 MB to
1.56 GB of linear memory, 5.8× the chunk ceiling, and at 2^29 the same pattern reached 3.11 GB.
The Thixotrope worker's per-crank `checkpoint_to_store` copies only the dirty chunk extents and
slot pages, but it re-encodes each changed section, such as all arrays' items or all Maps'
entries, whole (`ironhorse-snapshot/src/machine.rs:1029-1034`).
On the string heap above, its batch fit in memory the crank had already freed, and linear memory
grew to 787 MB only because the in-memory store kept its own copy.
For arrays and Maps it costs as much as a whole-heap snapshot or more, on every crank that
changes them: before the store copied anything, checkpointing 500,000 kept array items took
wasm32 from 40 MB to 122 MB, where writing their snapshot reached 92 MB, and 500,000 Map entries
from 78 MB to 224 MB, where their snapshot reached 208 MB.
Ceilings that admit array items and side tables must leave room for that re-encoding.

Wasm linear memory never shrinks.
On a host that enforces its memory cap by failing `memory.grow`, as Wasmtime's store limits do,
growth fails before the engine's deterministic `HeapExhausted` whenever the cap is below that
footprint.
An infallible allocation then aborts and traps, as `units_to_be16` does in the 1M-unit doubling
program, and as array items do.
A fallible one, such as the chunk and slot arenas' growth or `reserved_vec`, halts with a
`HeapExhausted` that the embedder cannot tell from a deterministic one.
Under a 128 MiB Wasmtime memory limit, a loop that keeps 40 strings of 1M units halted that way
at 2,359,889 computrons, where native and uncapped wasm32 return `40` at 10,488,433.
Either way the outcome depends on the host; a distinct halt for host allocation failure, which
the embedder never commits, would make the second case visible.
Cloudflare's 128 MB isolate cap is far below the default footprint, and the documentation
describes a different enforcement: the isolate is replaced (see the Cloudflare section).
Ceilings for these hosts must be set so that the *worst-case* footprint fits, and the ratio
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
Wasmtime 49 then loads and runs the `exnref` module with its default `Config`; exceptions are
enabled by default.
At the default 512 KiB `max_wasm_stack`, the meter probe's refused `eval` traps in the
recursive drop of its partial tree (B3); with 1 MiB it matches native.
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
  Among the 42 B3 cases the main thread fails only the `JSON.stringify` ceiling (cold).
  It also traps accepted compiler chains and deep-object `JSON.stringify`
  ([STACK-DEPTH-REFACTOR.md §1.3](STACK-DEPTH-REFACTOR.md#13-what-traps-today)).
  A dedicated **Web Worker has a smaller stack**.
  17 of 42 cases trap there, including an accepted 2,016-layer Proxy chain.
  `--js-flags=--stack-size=4000` fixed the main thread but not the Worker.
  The Worker's limit is a Blink constant, `kWorkerMaxStackSize = 500 * 1024`, not the V8 flag
  (see STACK-DEPTH-REFACTOR.md
  [§1.2](STACK-DEPTH-REFACTOR.md#12-two-stacks-on-wasm-and-the-host-limits)); a page could not
  pass the flag anyway.
  This is a real tension.
  Long cranks belong in a Worker so they do not freeze the page, and the Worker is where the
  stack is smallest.
  In practice, browser support depends on the refactors in B3.
- **A trap poisons the instance, cumulatively.**
  After a stack-overflow `RangeError`, the same instance accepted another call and returned
  `2` for `1+1`, so nothing in the platform forces the embedder to notice.
  But a trap skips function epilogues, so the shadow-stack pointer is not restored, and each
  trap leaks shadow stack.
  In workerd (request handler and Durable Object) a loop of trap, then `1+1`, kept working for
  10 iterations; on the 11th, and from then on, even `1+1` trapped (Node: the 12th).
  No destructors run either, so any `RefCell` borrowed at the trap stays borrowed
  (*inferred* for the browser).
  The embedder must discard the instance after **any** trap and restore from a snapshot.
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
  As on Cloudflare, ceilings alone are not enough: array items and side tables must also be
  admitted against them (B7, B8).
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
  Both assume the host thread's default floating-point environment (B7, latent issues).
  The build must not enable `relaxed-simd`, whose results are implementation-defined.
  rustc does not enable any SIMD for these targets by default.
  B7 applies unchanged.
  Only Chromium was measured.
- **Download size.**
  The module is 6.9 MB before `wasm-opt` and compression, including ICU normalizer and
  segmenter data.

## Cloudflare (workerd)-specific considerations

Everything in the browser section about V8 applies, because workerd embeds V8.
The following was measured in local workerd 1.20260923.1 (V8 15.4.80.5), in a request handler
and in a SQLite-backed Durable Object.
Local workerd enforces no memory or CPU limit (`NullIsolateLimitEnforcer`,
`src/workerd/server/server.c++:3305`), so production limits are cited from the Cloudflare
documentation, not measured.

- **The module must be bundled.**
  `new WebAssembly.Module(bytes)`, `WebAssembly.compile(bytes)` and
  `WebAssembly.instantiate(bytes)` all fail with "Wasm code generation disallowed by embedder"
  (`src/workerd/jsg/setup.c++:623-627`).
  `WebAssembly.instantiate` of a module bundled with the Worker succeeds.
  The browser advice to use `compileStreaming` does not apply.
- **Exception handling.**
  Both encodings load by default.
  With `--no-wasm-legacy-eh`, the legacy build fails at startup ("Invalid opcode 0x06") while the
  `exnref` build runs, so `exnref` is the encoding to ship (B2).
- **The stack cannot be raised** (B3).
  - 18–24 of the 25 B3 cases match native, depending on V8's tier state: fresh instances
    matched 24 and one run after natural tier-up 23, in a request handler or a Durable Object.
    With TurboFan pinned (`--no-liftoff`), a request handler matched 18; the 7 that trap
    include the accepted 2,016-layer Proxy chain
    ([STACK-DEPTH-REFACTOR.md §1.3](STACK-DEPTH-REFACTOR.md#13-what-traps-today)).
  - The `JSON.stringify` ceiling traps in both.
  - The Proxy `[[Call]]` chain passes on a cold run and traps after V8 tiers up: `--liftoff-only`
    passed 6 of 6 runs, `--no-liftoff` trapped 6 of 6.
  - `JSON.stringify` first traps at depth 1,529 under Liftoff (the same with an explicit
    `--stack-size=984`, V8's default) and at 1,343–1,376 after tier-up.
    Native accepts 2,000.
  - Every case passes with `--stack-size=2000`, but that is a `v8Flags` setting of self-hosted
    workerd ("Use at your own risk", `workerd.capnp:70`).
    The Cloudflare documentation describes no stack setting for Workers.

  So on Cloudflare, as in browsers, the stack refactors in
  [STACK-DEPTH-REFACTOR.md](STACK-DEPTH-REFACTOR.md) are required, not optional.
- **A trap poisons the instance, cumulatively** (see the browser section).
  In a Durable Object this is a guest-triggerable wedge: an embedder that caches the instance
  across events will fail every event after about ten traps, until the object is evicted.
  Each trap also grows linear memory by about 4.1 MiB, since nothing frees what the trapped
  call allocated (*inferred*): under Node 22 the same module grew from 11.25 MiB to 52.56 MiB
  over ten `JSON.stringify` traps.
- **Unwinding across the JS boundary needs `extern "C-unwind"`.**
  If the host calls back into wasm from a Durable Object's transaction callback, the call
  re-enters wasm from JS; a host can avoid that by running the whole crank inside one callback.
  A Rust unwind crossing an `extern "C"` export or import aborts (`RuntimeError: unreachable`).
  With `extern "C-unwind"` on both, an outer `catch_unwind` receives the original payload and the
  transaction rolls back.
  A JS exception thrown by an import (for example `sql.exec`) is not caught by `catch_unwind`.
  Through an `extern "C"` import it also skips Rust destructors, so a `RefCell` borrowed at that
  moment stays borrowed and later calls trap (local workerd).
  Through an `extern "C-unwind"` import the destructors run (Node 22, both EH encodings).
  Host imports should catch JS exceptions and return error codes.
- **Memory** (B8).
  An instance starts at 11,468,800 bytes of linear memory, 8 MiB of it the shadow stack (about
  7 MB with the 4 MiB shadow stack B3 recommends).
  Under the default ceilings, the slot ceiling halts at 66,912,256 bytes of linear memory.
  A string push loop halts at the chunk ceiling at 599,392,256 bytes, with the same computrons
  natively; string doubling reaches 1.21 GB (B8).
  Cloudflare's 128 MB limit is per isolate, "including the JavaScript heap and WebAssembly
  allocations", and one isolate can host several Durable Objects (Workers limits and Durable
  Object in-memory-state documentation).
  Past the limit, the runtime "lets in-flight requests complete and creates a new isolate for
  subsequent requests" (Workers limits), which resets every Durable Object in the isolate.
  No halt inside the engine reports that, and local workerd enforces no limit, so whether
  production also fails `memory.grow` first, as a capped Wasmtime does, is not known.
  Ceilings for Cloudflare must be set well below the defaults, but ceilings alone are not
  enough: array items and side tables must also be admitted against them first (B7, B8).
  The instance should be recycled when its linear memory passes a threshold, since it never
  shrinks.
- **CPU.**
  Computrons do not bound CPU time uniformly: 14.55 million per second on a tight loop against
  0.119 million per second on `indexOf` over a 2 MB string (Node).
  Nothing can preempt a synchronous wasm call.
  A crank that exceeds the per-event CPU limit (30 s by default) resets the object instead of
  halting (*inferred* from the documentation; local workerd enforces no CPU limit).
- **Speed.**
  A RegExp-backtracking workload ran 1.5–2.7× slower than native, on a contended host
  (indicative only).
  The first evaluation in a fresh isolate took 78–174 ms under Liftoff, and later ones 3–19 ms.
- **Size.**
  The module is 6.9 MB raw, 3.2 MB with gzip and 2.6 MB with Brotli.
  Workers allow 64 MiB uncompressed, and global scope must finish within 1 second.

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

- Restoring a wasm32-written Thixotrope heap natively.
  At the engine level, the B7 audit restored snapshots in both directions: a 45-feature heap
  restored with identical results and computrons, but a wasm32 snapshot holding a `RegExp` that
  only wasm32 compiles is refused natively (B7).
  In the other direction, the Cloudflare verification imported two natively written Thixotrope
  heaps into a wasm32 instance under Node.
  They were a 7.65 MB SES boot heap and a 17.27 MB counter vat, and each resumed lazily and
  eagerly and ran `1+1` and the outbound drain.
  It had to pass the native profile string, because Thixotrope's runtime profile hashes the
  worker executable (`packages/thixotrope/src/ironhorse-runtime.js:117-129`) and resume requires
  an exact signature match (`ironhorse-snapshot/src/format.rs:437-438`).
  The engine's boot fingerprints already match between native and wasm builds, so moving heaps
  between builds needs a platform-neutral profile and the B7 fixes.
  See also the B7 decode hazards.
- Performance beyond the one workload measured in the Cloudflare section (1.5–2.7× native).
- Firefox and Safari.
- `wasm32-wasip2` and the component model, `wasm64`, and `wasm32-wasip1-threads`.
- An abort-mode build (B1 option 3) was not built.
- Production Cloudflare: its stack size, memory enforcement and CPU enforcement cannot be
  measured in local workerd.

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
