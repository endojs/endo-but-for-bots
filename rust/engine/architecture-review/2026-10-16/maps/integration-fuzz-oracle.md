# Map: Embedding, fuzzing and the XS oracle

Reviewed commit `61cd656cb`.

## Scope

| Path | Lines | Notes |
|---|---:|---|
| `rust/endo/src/ironhorse_engine.rs` | 2,621 | the daemon's IronHorse seam: `Machine` (ephemeral), `PersistentMachine` (store-backed), `MachineError`, `ExecutionOutcome`, `run_script`, `run_worker`; tests start at :1881 |
| `rust/endo/src/engine/js_machine.rs` | 452 | `JsMachine` trait over xsnap and both IronHorse machine types |
| `rust/endo/src/bin/endor.rs` (engine selection only) | :81-150, :420-440 | `-e ironhorse` arms |
| `rust/thixotrope-ironhorse-worker/` | 490 + 44 + 13 | `src/main.rs`, README, Cargo.toml |
| `rust/engine/wasm-worker-spike/` | 1,371 Rust + 550 JS + 464 py | skimmed |
| `rust/engine/ironhorse-fuzz/src/` | 7,510 | `lib.rs` 4,503 (generators ~1,830, checks ~520, tests ~2,150), `snapshot.rs` 1,361, `store.rs` 409, `cranks.rs` 355, `regexp.rs` 347, `seeds.rs` 284, `comparison.rs` 217, `bin/write_seed_corpus.rs` 34 |
| `rust/engine/ironhorse-fuzz/fuzz/` | 116 manifest + 270 targets | 14 cargo-fuzz targets, 24 seeds each, own `[workspace]`, pinned nightly |
| `rust/engine/xs-oracle/` | `src/lib.rs` 1,174, `csrc/xs_shim.c` 1,199, `build.rs` 221, platform header 30, examples 207, tests 112 | |
| `rust/engine/scripts/` | 1,790 (21 files + `tests/`) | CI helpers |
| `rust/engine/stack-lanes/` | ~19,000 incl. JSON results | Phase-0 stack measurement lanes |
| `rust/engine/stack-depth-prototypes/` | 4,880 | six `.patch` files + README + bench |
| `rust/engine/phase-1b-handoffs/` | 358 | `F063.md`, `F149.md` |
| `.github/workflows/ironhorse-deep-fuzz.yml`, `ci.yml` fuzz job | 187 + ~150 | |

## What was read

- `ironhorse_engine.rs`: full read of :1-1880 (all production code); tests skimmed by name, :2240-2400 and :2560-2621 read.
- `js_machine.rs`: full read.
- `endor.rs`: the `worker`/`run` engine arms and `ironhorse_result_to_exit`.
- VM neighbours the seam depends on, targeted: `ironhorse-vm/src/compartment.rs:93-130, 700-1040, 1230-1485` (`execute`, `with_persistence`, `collect`, `pump`, `evaluate_compartment_with_symbols_continuing_meter_shared`); `interp.rs:225-334` (`SourceCompiler`, `EvalContext`), `:1620-1850` (`Halt`, `is_panic`), `:2933-3036` (`run_shared_outcome`); `interp/link.rs:1380-1460` (`relink_crank`); `lib.rs:90-111` (`NATIVE_STACK_BYTES`); `value.rs:1-45` (ceilings).
- `ironhorse-runtime/src/lib.rs`: full read (197 lines).
- `ironhorse-snapshot/src/machine.rs`: `checkpoint_to_store_core` (:1038-1130), `SharedStoreSession` (:3010-3070), `resume_shared_from_store_lazy_with` signature.
- Thixotrope worker `main.rs`: full read. `rust/thixotrope-xs-worker/src/main.rs:118-235` for the XS counterpart's eval. `packages/thixotrope/src/ironhorse-engine.js` ops (grep).
- `wasm-worker-spike`: README, Cargo.toml, `session.rs` diffed against the worker.
- `xs_shim.c`: full read. `xs-oracle/src/lib.rs`: :1-700 read (FFI wrappers), tests listed. `build.rs`: full read.
- `ironhorse-fuzz`: `lib.rs:1-300, 1830-2350` read closely, generators :300-1830 grep-driven, tests :2351-4437 sampled (sweep loops, roster test, compile smoke); `comparison.rs`, `regexp.rs:1-120`, `cranks.rs:1-230` read; `snapshot.rs`/`store.rs`/`seeds.rs` by function list only.
- All 14 `fuzz_targets/*.rs`, `fuzz/Cargo.toml`, `fuzz/rust-toolchain.toml`, `ironhorse-deep-fuzz.yml` full; `ci.yml` fuzz job by grep.
- `ironhorse-262/src/lib.rs:160-330, 740-790, 1009-1060`, `xst.rs:690-760, 895-925, 1110-1125, 1985-2000` (only where the fuzz crate duplicates or depends on them).
- `stack-lanes/README.md`, `stack-depth-prototypes/README.md`, both handoff notes' status lines; `scripts/` by CI reference count.
- The full test262 sweep report `rust/engine/target/test262-report/report.json` (queried for one finding).

## What was not read

- `ironhorse_engine.rs` tests :1881-2240 and :2400-2560 (names only).
- `xs-oracle/src/lib.rs:700-1174` (unit tests), `examples/`, `tests/`.
- `ironhorse-fuzz/src/snapshot.rs`, `store.rs`, `seeds.rs` bodies; most generator bodies in `lib.rs:379-1830` (surveyed by grep for constructs only); most of the 2,150 lines of `lib.rs` tests.
- `wasm-worker-spike/src/{lib,host,store}.rs`, `host/worker.js`, `run.py`, `export-heap/`.
- `stack-lanes/` Python and JS lanes, `memory/`, results JSON; `stack-depth-prototypes/*.patch` contents (only `git apply --check`ed).
- `scripts/*.py` bodies.
- `designs/*.md` (only the thixotrope README's GC remark and the spike README).
- The `.github/workflows/ironhorse-sanitizers.yml` lane beyond the ignorelist.

## Architecture as built

**Two embedders, three IronHorse lifecycles.**

1. *Ephemeral* `endo::ironhorse_engine::engine::Machine` (`ironhorse_engine.rs:680-814`) wraps one `ironhorse_vm::Machine` (VM "machine" = one `Interp` in a `RefCell`, one shared frozen intrinsic Realm, many compartment environments; `compartment.rs:874-884`, `:1289`). Each `evaluate` (`:727-773`): `discard_promise_jobs` → `discard_unhandled_rejections` → full `collect()` → new `Meter` armed at `DEFAULT_METER_CHECK_INTERVAL` 10,000 with a host closure comparing against a fixed ceiling (`crank_limit`, default 1e8 computrons, `:457`, `:471`) → `compile_metered` (`:585-643`, the only `catch_unwind` on this path; Goal::Eval via `compile_atoms_with_meter`, `coder.rs:6904-6910`) → `new_compartment()` → `evaluate_compartment_with_symbols_continuing_meter_shared` (`compartment.rs:1319-1338`), which relinks the crank's symbol table onto the machine-wide one, runs, pumps jobs and renders. Compile halts (MeterAbort/HeapExhausted/HostAllocationFailed/compiler panic → `Halt::Panic(EngineFault{location: None})`) come back as an `Ok(EvalOutcome{completed:false})`; `eval`/`eval_strict` map a non-completion to `MachineError::MeterAbort{..}` or `MachineError::Halt(h)` (`refuse`, `:665-673`). Nothing is rewound: the next evaluation discards queued jobs and collects. Measured fixed cost: 0.47 ms prep vs 0.088 ms to run `1+1`; 76 slots per fresh compartment (probe INT-P8). Only production caller: `endor run -e ironhorse <file>` (`endor.rs:141-150` → `run_script`, `:823-844`), on the process main thread.
2. *Persistent* `PersistentMachine` (`:987-1852`): `Rc<RefCell<SqliteHeapStore>>` + `SharedStoreSession` + the start `Compartment`. `open` refuses cadence mismatches and pre-shared-profile stores (`:1138-1170`), migrates, then either boots and arms (`:1181-1199`) or resumes lazily and reattaches the meter host (`resume_shared`, `:1272-1340`). `eval` (`:1404-1622`) restores the crank meter from the machine, re-bases the absolute ceiling (`state.index>>16 + limit`), compiles under `compile_metered`, runs inside `catch_store_fault` (`:1071-1081`, which converts only the typed store-fault unwind and re-raises every other panic), checkpoints when `completed && checkpoint_due`, and on `!completed` rewinds to the last checkpoint (`rewind_to_last_checkpoint`, `:1351-1376`) before reporting. Every non-completing `Halt` (MeterAbort, HeapExhausted, HostAllocationFailed, EngineInvariant, Throw, NotImplemented, Refused, StackOverflow, ReentryLimit, Decode, MachineBusy) takes that rewind; a failed rewind yields `Poisoned` and later `SessionLost`. `collect` (`:1645-1723`) is the only operation wrapped in `catch_unwind` with rewind (`CollectionPanicked`). No production caller exists: `PersistentMachine` is reached only from tests and the test-only `JsMachine` trait (`js_machine.rs:18-31` says so). `run_worker` returns `Unavailable` (`:1860-1879`).
3. *Thixotrope worker* (`rust/thixotrope-ironhorse-worker/src/main.rs`): a standalone `Interp` + `StoreSession` (not the shared Machine), one NDJSON `eval` op per crank, Goal::Script top-level (`:131-133`), its own `SourceCompiler` copy (`:17-116`), `rearm_meter` per crank with the caller's budget (`:118-129`), checkpoint after every completed crank (`:329`), any halt is fatal (process exits; recovery = restart from the store). Runs on a `NATIVE_STACK_BYTES` thread (`:340-345`). Never collects (finding INT-1). The `wasm-worker-spike` (`rust/engine/wasm-worker-spike/`) is a standalone cargo root, not in any workspace or CI lane, "carries no production code" (its README) and contains the worker's crank loop byte-for-byte (`session.rs:24-202` ≡ `main.rs:17-195`, `diff -w` empty), so it inherits INT-1 and INT-3.

**Panic containment.** The VM catches panics in `run_shared_outcome` (`interp.rs:2973-2992`) but converts only resource stops (`resource_halt`) and re-raises everything else after clearing native depth and setting `last_crank_completed=false`; `Compartment::execute`, `with_persistence` and `pump` catch only to detach host callbacks, then `resume_unwind` (`compartment.rs:844-847`, `:959-962`, `:1394-1397`). Nothing in the VM or endo constructs `Halt::Panic(PanicKind::EngineFault)` for a runtime panic; the only production construction is the compiler wrapper (`ironhorse_engine.rs:637-640`). The VM machine stays usable after an unwound panic (probe INT-P1 A2/A3).

**Host exposure and value escape.** IronHorse in endo installs no host callables (`MachineRestorePolicy{host_callables: Default::default()}`, `:1307-1311`; `js_machine.rs:51-53` names the gap). Raw heap coordinates escape in `EvalOutcome::unhandled_rejection: Option<(SlotIndex, Slot)>` and `Halt::Throw{value: Slot}`; they are documented as valid only until the next collection (`:401-405`). `Machine::vm_machine()` (`:811-813`) hands out the whole VM, including the unmetered `run_promise_jobs`, so the "armed by default" property holds only for callers that do not use it.

**The XS oracle.** `xs-oracle` builds the pinned Moddable XS (45 C files, `build.rs:52-100`) with xsnap's defines, two checked source overlays that remove C undefined behaviour in numeric-literal and JSON number classification and in overlapping `snprintf` (`build.rs:140-190`), xsnap's platform layer, and `csrc/xs_shim.c`. Entry points: `xs_oracle_run{,_timed}` (fresh machine, `fxParseScript(mxProgramFlag | mxEvalFlag)` = XS `fx_eval`'s flags, i.e. indirect-eval semantics, then run + promise drain + `String(result)`), `xs_oracle_run_cranks`/`_scripts` (one machine, N scripts), `xs_oracle_compile_module`, `xs_oracle_run_module` (filesystem loader from `xst.c`), `xs_oracle_regexp` (`fxCompileRegExp`/`fxMatchRegExp` directly). Machine create/delete is serialized by a process mutex (`xs_shim.c:89`, `:293-311`) because XS's shared-cluster refcount is unsynchronized. FFI result struct `EndorOracleResult` (`:39-71`): malloc'd `code`/`symbols` (caller frees via `xs_oracle_free`, done by every Rust wrapper after copying), inline 16,384-byte `result` with `result_len`, inline 256-byte `error` with no length (INT-10), 256-byte `async_signal`. All `setjmp`-surviving locals that are written after `mxTry` are `volatile` (`script`, `crank_i`, `rendering_rejection`, `setupScript`).

**The `-Wclobbered` warning at `xs_shim.c:295`** is not undefined behaviour. C11 7.13.2.1p3 makes an automatic object indeterminate after `longjmp` only if it was *changed* between `setjmp` and `longjmp`. In all three callers (`xs_oracle_run_impl` :350-354, `xs_oracle_run_sources` :584-588, `xs_oracle_run_module` :908-912) `the` is assigned by `xs_oracle_create_machine` and `fxBeginHost` before `mxTry`, and never written inside the try. GCC reports the caller's variable at the inlined helper's declaration; marking the helper `__attribute__((noinline))` makes all three warnings disappear (probe INT-P9). The one remaining warning, `started` (`:342`), is written after `setjmp` but never read after `longjmp`. No consequence for the oracle or the test262 differential (INT-11 covers the hygiene).

**Fuzzing.** 14 cargo-fuzz targets (`fuzz/Cargo.toml`), all run daily for 300 s each by `ironhorse-deep-fuzz.yml` and briefly on PRs by `ci.yml`'s `fuzz-ironhorse`, both reading the roster from the manifest, both with `-s none`. Default `cargo fuzz run` (no `-O`) adds `-Cdebug-assertions`, so overflow checks are on, as in shipped builds. What the targets assert:

| Target | Generator | Pipeline under test | Assertion |
|---|---|---|---|
| `differential_source`, `differential_stage2b` | `gen_program`, `gen_stage2b_program` | IronHorse VM on **XS bytecode** | completion flag + `String(result)` vs XS |
| `differential_stage3_surface` | 19 surfaces (`STAGE3_SURFACES`, `lib.rs:2059-2155`) | VM on XS bytecode, symbols linked, armed vs unarmed | same + armed/unarmed equality |
| `differential_regexp_surface` | regexp programs | VM on XS bytecode | same |
| `differential_regexp` | ASCII-only patterns, no `u`/`v` | `ironhorse-regexp` vs `fxMatchRegExp` | captures |
| `differential_cranks` | crank sequences | `dual_run_cranks` | per-crank agreement |
| `differential_compile` | `gen_compile_program` | **ironhorse-compile** bytes vs XS bytes | byte identity; ignores `IronhorseRejected` |
| `guest_no_abort` | 5 generators + raw bytes | **ironhorse-compile → VM** | no panic only |
| `parser` | `gen_compile_program` + raw | parser | no panic |
| `bytecode_decoder`, `snapshot_decoder`, `utf16_boundary` | raw bytes | decoder / snapshot reader / UTF-16 | no panic (+ internal asserts) |
| `snapshot_roundtrip`, `store_decoder` | generated images/stores | snapshot / store | round-trip identity, export/adopt identity |

No target covers Proxy/Reflect, generators/async/await, classes/private names/`super`, `eval`/`Function`, WeakRef/FinalizationRegistry, modules (the oracle has `compile_module`/`run_module` but no target uses them), Intl/Temporal (XS has no Intl, so no oracle exists), Date, `harden`/`lockdown`/Compartment, host callables, or the `PersistentMachine` lifecycle. `JSON.parse` is covered (`gen_json_parse_program`).

**Directories asked about.**
- `stack-lanes/`: live. Phase-0 stack-height measurement lanes (native, Wasmtime, Node, workerd) plus `memory/` (the WASM-MEMORY measurements); `ironhorse-full-test262.yml:300-395` runs its unit tests and lanes; `ironhorse-compile/tests/recursion_bounds.rs` reads `sweep-pins.json`. Not dead weight, though ~6,000 lines of committed JSON results are data, not code.
- `stack-depth-prototypes/`: six evidence patches for `STACK-DEPTH-REFACTOR.md`; none applies to HEAD any more (INT-14). Dead weight as code; their value is the README's measurement table.
- `phase-1b-handoffs/`: two prose handoff notes (F063 "partially implemented; finding remains open", F149 "not implemented") from a phase whose `interp.rs` freeze has lifted. Documentation of deferred work, not code; they cite the earlier review and will rot.
- `wasm-worker-spike/`: evidence for `designs/thixotrope-wasm-worker.md`; standalone, not wired into any build or CI; duplicates the worker loop verbatim.
- `scripts/`: 20 of 21 files are referenced by a workflow (`snapshot-footprint.py` is a manual tool; `test-oracle-sanitizer-scope.sh` is called from `test-oracle-sanitizers.sh`).

## Candidate findings

### INT-1 — The thixotrope IronHorse worker never collects garbage, so every crank's garbage is checkpointed and a long-lived vat is permanently bricked

- **Lens(es):** 1 (resource bound / liveness), 4.
- **Proposed severity:** high.
- **Location:** `rust/thixotrope-ironhorse-worker/src/main.rs:118-180` (`eval`), `:308-334` (crank loop); same code at `rust/engine/wasm-worker-spike/src/session.rs:125-187`; ops in `packages/thixotrope/src/ironhorse-engine.js:259-296` (only `eval` and `close`).
- **Excerpt:**
  ```rust
  let outcome = m.run(&code);
  if !outcome.completed {
      return Err(crank_halted(&outcome.halt));
  }
  ...
  checkpoint_to_store(&mut session, &signature, &mut store)
  ```
- **Mechanism:**
  - The VM never collects on allocation pressure; collection is host-requested at a quiescent boundary only (no allocation-triggered call to `collect_garbage` exists outside tests).
  - The worker has no collect op and never calls a collector. `checkpoint_to_store_core` (`ironhorse-snapshot/src/machine.rs:1046-1130`) writes dirty pages and does not collect; resume does not collect either.
  - Unreachable objects therefore count against `DEFAULT_SLOT_CEILING` (1,000,000, `ironhorse-vm/src/value.rs:14`) forever, are written to SQLite, and are restored on every restart. The package README confirms "The collector does not force guest GC" (`packages/thixotrope/README.md:613`).
- **Scenario:** any vat that allocates about one million slots of short-lived objects over its whole life: four deliveries that each build and drop 50,000 small objects. From then on every crank that allocates more than the remaining headroom halts `HeapExhausted`. The worker exits as `fatal`, the supervisor restarts it from the same heap, and the same crank fails again: the vat is dead. Unlike XS, which collects when it runs out of slots, there is no recovery short of an external collection tool.
- **Evidence:** confirmed by probe, against the real worker binary (debug build) over its NDJSON protocol. `probes/integration-fuzz-oracle/worker_no_gc.py`:
  ```python
  GARBAGE = ("var keep = 0; for (var i = 0; i < 50000; i++) "
             "{ var o = { a: i, b: [i] }; keep = keep + 1; } keep")
  session("session 1", [GARBAGE] * 8)
  session("session 2 (restart)", ["'tiny crank'", GARBAGE])
  session("session 3 (restart)", ["var s = 0; for (var i = 0; i < 30000; i++) s += [i].length; s"])
  ```
  Output (`worker_no_gc.out`):
  ```
  [session 1] crank 1..4: {"op":"result","result":"50000"}
  [session 1] crank 5: {"message":"guest crank halted: HeapExhausted","op":"fatal"}
  heap file size after session 1: 29982720 bytes
  [session 2 (restart)] crank 1 ('tiny crank'...): {"op":"result","result":"tiny crank"}
  [session 2 (restart)] crank 2 (var keep = 0; ...): {"message":"guest crank halted: HeapExhausted","op":"fatal"}
  [session 3 (restart)] crank 1 (30000 one-element arrays): {"op":"result","result":"30000"}
  ```
  None of the 4 x 200,000 slots of garbage is reachable after its crank. All of it is still resident after a restart, and each further crank shrinks the remaining headroom.
- **Recommendation:**
  - Collect in the worker at a checkpoint boundary on a replica-visible cadence, as `PersistentMachine` does with `CadencePolicy::collect_every` and `collect()` (`ironhorse_engine.rs:1645-1723`).
  - At minimum, collect and retry once before declaring a `HeapExhausted` crank fatal. The retry is deterministic because collection runs at the same crank on every replica.
  - Add a worker test that runs N garbage cranks and then restarts.
- **Confidence:** confirmed by probe.

### INT-2 — Guest-reachable engine panics are not contained by either endo entry point; a caller that survives the unwind commits the failed crank's partial effects

- **Lens(es):** 1 (persistent-state integrity, host abort), 6(b).
- **Proposed severity:** high. It becomes critical as soon as any supervisor wraps `PersistentMachine::eval` in `catch_unwind`, as `inproc.rs:268-290` already does for xsnap runs.
- **Location:**
  - `rust/endo/src/ironhorse_engine.rs:1071-1081` (`catch_store_fault` re-raises without rewinding), `:1482-1521` (the only rewind paths in `eval`), `:727-773` (ephemeral path: no unwind boundary around execution), `:637-640` (the only production `Halt::Panic(EngineFault)`);
  - VM side: `ironhorse-vm/src/interp.rs:2983-2991`, `compartment.rs:844-847`.
- **Excerpt:**
  ```rust
  match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
      Ok(result) => result,
      Err(payload) => match ironhorse_snapshot::machine::store_fault_of(payload) {
          Ok(error) => Err(store_err(error)),
          Err(payload) => std::panic::resume_unwind(payload),
      },
  }
  ```
- **Mechanism:**
  - A Rust panic in the dispatch loop that is not a resource stop is re-raised by the VM with the heap mid-crank. One guest-reachable example is the `--` on `i32::MIN` overflow, `dispatch.rs:3917`, reported as CORE-1 in the vm-core-dispatch map.
  - `PersistentMachine::eval` neither rewinds nor latches anything on that path, so `self.session` keeps the half-run heap.
  - If the caller catches the unwind and calls `eval` again, the next crank runs on that heap. When it completes, the quiescence gate passes and the checkpoint persists the panicked crank's writes. This is exactly what the type's "no partial effect ever persists" contract (`:935-940`) forbids.
  - On the ephemeral path the panic escapes `Machine::eval` and `run_script`, so `endor run -e ironhorse` dies with a Rust panic (exit 101) instead of `endor[ironhorse]: engine fault: ...`.
  - `PanicKind::EngineFault`'s documentation says panics are "converted into this value at the thread/FFI boundary", but no such boundary exists for execution.
  - `collect()` is handled correctly (`:1647-1721`: `catch_unwind`, rewind, `CollectionPanicked`), which shows the intended pattern.
- **Scenario:** a supervisor thread catches worker panics so that one bad vat does not take the daemon down, and keeps the `PersistentMachine`. A guest delivery does `state.x = 2; ...; --i32min`. The next delivery commits `x = 2` although the delivery that wrote it never completed.
- **Evidence:** confirmed by probe.
  - `rust/endo` cannot be built in this checkout: `xsnap` `include_str!`s the generated `ses_boot.js`, `worker_bootstrap.js` and `daemon_bootstrap.js`, which are absent.
  - The probe therefore replays `ironhorse_engine.rs`'s exact VM and store calls (`Machine::evaluate` :734-771; `open` :1181-1199; `eval` :1408-1503; `resume_shared` :1281-1338) over `SqliteHeapStore`.
  - Source: `probes/integration-fuzz-oracle/rust_probe_int1_embedding_mirror.rs` (run as `rust/endo/ironhorse-store-sqlite/tests/zz_audit_integration_fuzz_oracle_1.rs`, then deleted). Core of part C:
  ```rust
  println!("C0 ... -> {}", pm.crank("globalThis.x = 1; 'x=1'"));
  let r = catch_unwind(AssertUnwindSafe(|| pm.crank("globalThis.x = 2; var a = 1 << 31; --a; 'unreached'")));
  let r = catch_unwind(AssertUnwindSafe(|| pm.crank("String(globalThis.x)")));
  // drop, reopen the SQLite file, resume_shared, crank again
  ```
  ```
  A0 1+1                  -> completed=true result="2" halt=Return
    [panic hook] panicked at rust/engine/ironhorse-vm/src/interp/dispatch.rs:3917:74: attempt to subtract with overflow
  A1 PANIC unwound out    -> true
  A2 1+1 afterwards       -> Ok("completed=true result=\"2\" halt=Return")
  C0 crank x = 1                -> completed=true result="x=1" halt=Return checkpoint=Ok(2)
    [panic hook] panicked at rust/engine/ironhorse-vm/src/interp/dispatch.rs:3917:74: attempt to subtract with overflow
  C1 crank x = 2; PANIC unwound -> true
  C2 next crank String(x)       -> Ok("completed=true result=\"2\" halt=Return checkpoint=Ok(3)")
  C3 reopened: crank String(x)  -> completed=true result="2" halt=Return checkpoint=Ok(4)
  ```
  The partial write `x = 2` from the crank that panicked is live (C2), checkpointed at epoch 3, and present after reopening the store (C3).
- **Recommendation:**
  - In `catch_store_fault`'s re-raise arm, and around `Machine::evaluate`'s execution, convert the payload to `Halt::Panic(PanicKind::EngineFault{message, location})`.
  - On the persistent path, `rewind_to_last_checkpoint` before returning `Err(MachineError::Halt(..))`, exactly as the halt path does.
  - If re-raising is preferred, set `self.session = None` before re-raising so that the next call meets `SessionLost` rather than a poisoned heap.
  - Pin the behaviour with a test using the `PANIC_AT_STEP` hook the VM already has.
- **Confidence:** confirmed by probe (exact call-sequence mirror; the `endo` crate itself could not be built here).

### INT-3 — The thixotrope worker's private `SourceCompiler` drops the direct-eval context: `eval('super.x')`, `eval('new.target')` and `eval('this.#x')` throw SyntaxError

- **Lens(es):** 1, 2, 5.
- **Proposed severity:** medium.
- **Location:** `rust/thixotrope-ironhorse-worker/src/main.rs:17-116` (no `compile_eval_units`), the copy at `rust/engine/wasm-worker-spike/src/session.rs:24-123`; the trait default at `ironhorse-vm/src/interp.rs:300-312`; the correct implementation at `ironhorse-runtime/src/lib.rs:105-125`.
- **Excerpt (trait default):**
  ```rust
  /// A compiler that does not override this compiles with the context's
  /// strictness alone, so `super`, `new.target` and private names in the
  /// eval'd source are SyntaxErrors there.
  fn compile_eval_units(&self, source: &[u16], context: &EvalContext, ...) {
      self.compile_source_units(source, context.strict, raw_budget, charge)
  }
  ```
- **Mechanism:**
  - The worker re-implements the compiler adapter instead of using `ironhorse_runtime::IronhorseSourceCompiler`, which its `Cargo.toml` does not depend on. It overrides only `compile_source` and `compile_source_units`.
  - The trait's default silently degrades a direct eval to a context-free Eval-goal compile.
- **Scenario:**
  - A guest class method using `eval("super.foo()")` or a private-field read inside `eval` works on the endo seam and on XS, but throws `SyntaxError: invalid super` in a thixotrope IronHorse vat.
  - The same program therefore behaves differently on the product's two engines.
- **Evidence:** confirmed by probe. The prior reviewer's probe 1 was re-run (`probes/integration-fuzz-oracle/rust_probe_int6.rs`, `probe_eval_context`, which copies the worker's `Compiler` verbatim):
  ```
  CASE class B { get x() { return 42; } } class C extends B { m() { return eval('super.x'); } } String(new C().m())
    runtime    : completed=true result="42"
    thixotrope : completed=false halt=Throw { ..., rendered: "SyntaxError: invalid super" }
  CASE var r; function F() { r = eval('new.target') === F; } new F(); String(r)
    runtime    : result="true"     thixotrope : "SyntaxError: invalid new.target"
  CASE class P { #x = 7; m() { return eval('this.#x'); } } String(new P().m())
    runtime    : result="7"        thixotrope : "SyntaxError: invalid private identifier"
  ```
  `ironhorse-xst` (which uses the runtime compiler) prints `Error: [42,true,7]` for `e1_eval_context.js`, the same as node.
- **Recommendation:**
  - Depend on `ironhorse-runtime` and delete both private copies (see INT-13).
  - Remove the trait default for `compile_eval_units`, so that a compiler which does not support the eval context must say so (`Unsupported`) rather than produce a different program.
- **Confidence:** confirmed by probe.

### INT-4 — The ephemeral `Machine` promises a "fresh Realm" per evaluation but shares a never-reclaimed key table: one evaluation can permanently deny every later one, and the denial is reported as malformed bytecode

- **Lens(es):** 1 (isolation / resource bound), 6(b)(d)(e).
- **Proposed severity:** medium. Latent: today `endor run` makes one evaluation per process. The root cause is PROP-2 / BOOT-9 in other maps; this is the embedding's consequence.
- **Location:**
  - `rust/endo/src/ironhorse_engine.rs:692-699, 717-726` (contract: "Each `evaluate` creates a fresh Realm"; "Each evaluation has a fresh Realm and meter");
  - `ironhorse-vm/src/compartment.rs:1289` ("The single Realm shared by all compartments of this Machine"), `:783-786` (relink error → `Halt::Decode(InvalidSymbols)`);
  - `rust/endo/src/engine/js_machine.rs:349` (`Decode` → `JsMachineErrorKind::Engine`).
- **Excerpt:**
  ```rust
  Some(names) => machine.relink_crank(&bytecode, names)
      .map_err(|_| Halt::Decode(crate::DecodeError::InvalidSymbols)),
  ```
- **Mechanism:**
  - Every evaluation's compartment shares the machine's u16 name table.
  - Names interned by one evaluation are never reclaimed, and the pre-evaluation `collect()` does not help.
  - Once the table is full, relinking any later evaluation that mentions a name the table lacks fails before execution. That failure is reported as `Halt::Decode(InvalidSymbols)`; `js_machine` classifies it as an engine fault ("malformed bytecode") and `describe_halt` as "bytecode decode error".
- **Scenario:** a host reuses one `Machine` for independent evaluations, which the `Machine`/`JsMachine` API invites. One evaluation does `for (i < 70000) o['n'+i] = i`. Every later evaluation that uses a new identifier halts, forever, and the supervisor is told the bytecode was malformed.
- **Evidence:** confirmed by probe (`rust_probe_int1_embedding_mirror.rs`, part B, same exact-call mirror as INT-2):
  ```
  B1 eval#1 intern 70000 names     -> completed=true result="RangeError: property key space exhausted at i=63896"
  B2 eval#2 o.anotherFreshName = 1 -> completed=false result="" halt=Decode(InvalidSymbols)
  B3 eval#3 JSON.parse new key     -> completed=false result="" halt=Decode(InvalidSymbols)
  B4 fresh Machine, same as eval#2 -> completed=true result="ok" halt=Return
  ```
- **Recommendation:**
  - Correct the docs: the evaluations share one Realm and get fresh compartment environments.
  - Either give each evaluation its own VM machine (48 ms boot, probe INT-P8) or reclaim names at the per-evaluation collection.
  - Map `RelinkError::TableFull` to a resource halt rather than `Decode` (BOOT-9).
- **Confidence:** confirmed by probe.

### INT-5 — The embedding classifies `Halt` four different ways, and documents a refusal channel nothing produces

- **Lens(es):** 6(b)(e).
- **Proposed severity:** medium.
- **Location:**
  - `ironhorse-vm/src/interp.rs:1796-1811` (`is_panic`);
  - `rust/endo/src/ironhorse_engine.rs:370-394` (`ExecutionOutcome::classify`), `:280-313` (`describe_halt`), `:185-193` and `:958-962` (`SymbolMismatch`);
  - `rust/endo/src/engine/js_machine.rs:87-122, 342-356` (`JsMachineErrorKind`, `classify`).
- **Excerpt:**
  ```rust
  other => {
      debug_assert!(false, "unexpected top-level halt at the Machine seam: {other:?}");
      ExecutionOutcome::Panicked(other)
  }
  ...
  MachineError::Halt(halt) => match halt {
      Halt::NotImplemented(_) | Halt::Refused(_) => JsMachineErrorKind::Unavailable,
      Halt::Decode(_) => JsMachineErrorKind::Engine,
      _ => JsMachineErrorKind::Halt,
  },
  ```
- **Mechanism:**
  - The same halt lands in different classes depending on which classifier sees it:

    | Halt | `is_panic` | `ExecutionOutcome` | `JsMachineErrorKind` | `describe_halt` |
    |---|---|---|---|---|
    | EngineInvariant, Panic(EngineFault) | panic | Panicked | **Halt** ("guest throw or resource stop", `js_machine.rs:90-93`) | defect |
    | HostAllocationFailed ("belongs to the host, not the program") | panic | Panicked | **Halt** | host limit |
    | Decode | panic (provisional) | Panicked | Engine | decode error |
    | NotImplemented / Refused | not panic | Panicked | Unavailable | gap / profile limit |
    | MachineBusy | not panic | **`debug_assert!(false)`** (a debug-build panic) | Halt | `halted: MachineBusy` (Debug fallback) |
    | HeapExhausted | panic | Panicked | Halt | `halted: HeapExhausted` (no arm) |

  - The `classify` doc says the only non-panic `Panicked` cases are `NotImplemented` and the catch-all; the code also includes `Refused` (`:380`).
  - `ExecutionOutcome` has no non-test caller.
  - `MachineError::SymbolMismatch` is documented as the channel for the remaining relink refusals (`:185-193`, `:958-962`), but it is never constructed. Relink failures arrive as `MachineError::Halt(Halt::Decode(InvalidSymbols))` (INT-4 evidence).
  - `Machine::new`'s doc says "Persistent workers use a standalone `Interp`; shared-Realm snapshots are not yet supported" (`:697-698`). `PersistentMachine` uses the shared session and refuses standalone stores (`:1152-1166`).
- **Scenario:**
  - A supervisor that terminates on `JsMachineErrorKind::Engine` and retries on `Halt` retries an engine invariant violation forever, and terminates a vat whose key table is full as if it had received malformed bytecode.
  - In a debug build, `ExecutionOutcome::classify(Halt::MachineBusy)` panics. `MachineBusy` is reachable from `Machine::evaluate`'s preparation on re-entry.
- **Evidence:** static, from the matches quoted.
- **Recommendation:**
  - Make one exhaustive classification function over `Halt` the source of truth: program-caused, host-caused or engine-defect, plus commit/discard.
  - Derive `is_panic`, `ExecutionOutcome` and `JsMachineErrorKind` from it.
  - Delete `SymbolMismatch` or produce it.
  - Give `describe_halt` explicit arms.
- **Confidence:** high.

### INT-6 — The fuzz lane never compares the shipped pipeline's behaviour with anything: every behavioural differential runs XS-compiled bytecode

- **Lens(es):** 5 (test coverage), 6(e).
- **Proposed severity:** medium.
- **Location:** `rust/engine/ironhorse-fuzz/src/lib.rs:1898-2028` (`differential_check*` all call `xs_oracle::run` and execute `oracle.bytecode`), `:2059-2155` (roster); `fuzz/fuzz_targets/guest_no_abort.rs` (the only target running `ironhorse-compile` output on the VM, asserting only "no panic").
- **Excerpt:**
  ```rust
  let oracle = match xs_oracle::run(source) { Some(o) => o, None => return Ok(()) };
  let ironhorse = ironhorse_vm::run_program_with_symbols(&oracle.bytecode, &oracle.symbols);
  ```
- **Mechanism:**
  - What ships is `ironhorse-compile` → VM. The fuzz lane checks:
    - the VM on XS's bytes, against XS;
    - the compiler's bytes, against XS's bytes, for four simple generators only (`differential_compile`);
    - the shipped pipeline for "no panic" only.
  - Where the compiler emits different bytes on purpose, the behaviour the product ships is compared with nothing, and the fuzz verdict certifies the VM on a byte stream the product never runs.
- **Scenario:**
  - Spread: the compiler implements `[...x]` with CreateDataProperty semantics; XS uses `[[Set]]` (an XS spec bug).
  - The fuzz surface `gen_stage3_spread_program` therefore exercises XS's spread opcodes on the VM.
  - A regression in the compiler's own spread lowering would be invisible to every behavioural target.
- **Evidence:** confirmed by probe.
  - `rust_probe_int4.rs`: per surface, the first 200 distinct programs from 20,000 random inputs. Shipped bytes equal XS bytes for 4,164 of 4,400 programs overall, but `gen_stage3_spread_program` matches **0/200** and `gen_stage3_collections_program` 177/200. (No result difference was found in the sampled programs.)
    ```
    gen_stage3_spread_program        n=200 byte-identical=  0 bytes-differ=200
    gen_stage3_collections_program   n=200 byte-identical=177 bytes-differ= 23
    TOTAL n=4400 byte-identical=4164 shipped-pipeline-result-differs=0
    ```
  - `rust_probe_int3.rs`, a spread with a setter on `Array.prototype[0]`:
    ```
    XS oracle                          : "false 0 hits=1"
    IronHorse VM on IronHorse bytecode : "true 1 hits=0"   (node: "true 1 hits=0")
    IronHorse VM on XS bytecode        : "false 0 hits=1"
    fuzz differential_check_with_symbols: Ok(())
    ```
    The same source produces two behaviours in IronHorse depending on the compiler, and the fuzz lane sees only the one that ships nowhere.
- **Recommendation:**
  - Add a "shipped pipeline vs XS" result differential for every surface, with an explicit allowlist of intended divergences (spread, and the XS spec bugs it corrects).
  - Alternatively, run each surface through both bytecodes and require the shipped one to agree with XS or with a pinned spec answer.
- **Confidence:** confirmed by probe.

### INT-7 — `gen_compile_program` re-reads its arm-selector byte, so the compiler targets never see calls or exceptions and expression depth collapses to 1 or 5

- **Lens(es):** 5 (coverage).
- **Proposed severity:** low. Test infrastructure, but it is the only generator of `differential_compile`, the generated half of `parser`, and selector 0 of `guest_no_abort`.
- **Location:** `rust/engine/ironhorse-fuzz/src/lib.rs:2243-2251`; `gen_program` `:157-162`; `gen_stage2b_program` `:273-281`.
- **Excerpt:**
  ```rust
  let mut b = Bytes::new(data);
  match b.choice(4) {
      0 => gen_program(data),          // re-reads data[0]: depth = 1 + data[0] % 8, data[0] % 4 == 0
      1 => gen_statement_program(data),
      2 => gen_stage2b_program(data),  // its choice(4) re-reads data[0] == 2 (mod 4): always closures
      _ => gen_object_program(&mut b),
  }
  ```
- **Mechanism:** the sub-generators get the original slice, not the advanced cursor.
  - Arm 2 always picks the closure sub-surface, so the doc's "object/call/closure/exception surface" (`:2240-2242`) loses calls and exceptions.
  - Arm 0's depth is drawn from a byte already constrained to `≡ 0 (mod 4)`, so it can only be 1 or 5.
  - `cranks.rs` uses the same pattern, but with moduli coprime to the sub-generators' (3 and 7 against 4 and 8), so it is not affected.
- **Scenario:** `try`/`catch`/`finally`/`throw` lowering and function-call coding are never byte-compared against XS by `differential_compile`, however long it runs.
- **Evidence:** confirmed by probe (`rust_probe_int5.rs`, 50,000 random inputs):
  ```
  gen_compile_program shapes: {"closure(stage2b)": 12378, "expression": 12786, "object": 12379, "statement": 12457}
  gen_stage2b_program shapes, same inputs: {"call": 12457, "closure": 12378, "exception": 12379, "object": 12786}
  max paren nesting, gen_compile_program expression arm: {0: 1414, 1: 6011, 2: 124, 3: 57, 4: 29, 5: 5151}
  max paren nesting, gen_program direct:                 {0: 5485, 1: 7510, 2: 6035, ..., 8: 4982}
  ```
- **Recommendation:** pass the cursor, or `&data[1..]`, to the sub-generators, and add a shape-coverage assertion like the stage-3 sweeps already have.
- **Confidence:** confirmed by probe.

### INT-8 — `compile_differential_check` decides "the oracle rejected" from the run's error text, and its documented finding `IronhorseRejected` is ignored by the target

- **Lens(es):** 5, 6(b)(e).
- **Proposed severity:** low.
- **Location:** `rust/engine/ironhorse-fuzz/src/lib.rs:2306-2307`, `:2285-2300` (docs), `:4400-4422` (smoke test); `fuzz/fuzz_targets/differential_compile.rs:1-7, 21-23`.
- **Excerpt:**
  ```rust
  // The oracle "accepted" (parsed) unless it aborted with a SyntaxError.
  let oracle_accepts = oracle.completed || !oracle.error.contains("SyntaxError");
  ```
- **Mechanism:**
  - `xs_oracle::run` *runs* the program, so a parse-valid program that throws a `SyntaxError` at run time is counted as an oracle rejection. IronHorse compiles it, the outcome is `OracleRejected`, and the target panics with a false trophy.
  - Separately, the enum doc (`:2285-2287`) and the function doc (`:2298-2300`) call `IronhorseRejected` (which includes caught coder panics) a finding. The target's header and the smoke test treat it as "valid, non-finding".
- **Scenario:** extending `gen_compile_program` with `JSON.parse` or `RegExp` constructors floods the target with false findings; a coder panic on a program XS accepts is silently passed.
- **Evidence:** confirmed by probe (`rust_probe_int3.rs`):
  ```
  compile_differential_check("JSON.parse('{')") = OracleRejected
  compile_differential_check("new RegExp('(')") = OracleRejected
  compile_differential_check("1 + 1") = Identical
  ```
- **Recommendation:**
  - Use `xs_oracle::compile_module`-style compile-only entries, or a shim compile-only script entry, to obtain XS's accept/reject decision.
  - Make the target fail on `IronhorseRejected` when the detail is a coder panic.
- **Confidence:** confirmed by probe.

### INT-9 — The top-level goal of "a crank" differs between the embedders, with guest-visible consequences, and nothing names it

- **Lens(es):** 6(a)(d), 1.
- **Proposed severity:** medium.
- **Location:**
  - `rust/endo/src/ironhorse_engine.rs:593` (`compile_atoms_with_meter` → `Goal::Eval`, `coder.rs:6904-6910`);
  - `rust/thixotrope-ironhorse-worker/src/main.rs:131-133` (`Goal::Script`), same in the spike;
  - `rust/thixotrope-xs-worker/src/main.rs:125-137` (xsnap `eval` = `xsCall1(xsGlobal, xsID("eval"), ..)`, `rust/endo/xsnap/src/lib.rs:145`);
  - `xs_shim.c:426-427` (oracle: `mxProgramFlag | mxEvalFlag`, the `fx_eval` flags, `xsGlobal.c:342`).
- **Mechanism:**
  - The endo seam and the oracle evaluate each crank as indirect-eval code, matching xsnap.
  - The thixotrope IronHorse worker evaluates each crank as a Script. Its XS twin evaluates as indirect eval (inside a `try` wrapper).
  - Strict-mode top-level `var`/`function` declarations therefore become globals on one engine and are local to the crank on the other. This is observable by the next crank and by `globalThis`.
- **Scenario:** a thixotrope boot or delivery script that begins with `'use strict'` and declares `function handler(){}` is visible to later cranks on the IronHorse worker but not on the XS worker. The two workers the package presents as interchangeable diverge.
- **Evidence:** confirmed by probe (`rust_probe_int6.rs`, `probe_goal`, re-run of the prior reviewer's probe 3), plus JS probe `e2_strict_script_var.js`:
  ```
  SEQ ["'use strict'; var counter = 41; function inc() { return ++counter; } 'defined'", "inc()"]
    endo (Eval goal)    crank 1: halt=Throw "ReferenceError: get inc: undefined variable"
    thixo (Script goal) crank 1: completed=true result="42"
  SEQ ["'use strict'; var g = 1; typeof globalThis.g"]
    endo (Eval goal) "undefined"     thixo (Script goal) "number"
  ```
  ```
  e2_strict_script_var.js:  ironhorse-xst (Script) -> Error: number
                            XS oracle (oracle_probe) -> error=Error: undefined
                            node vm.runInThisContext -> number; node (0,eval)(..) -> undefined
  ```
- **Recommendation:**
  - Name the crank goal as part of the embedder contract (an explicit `Goal` parameter on `Machine`/`PersistentMachine`), and pick the same one for both thixotrope workers.
  - Document that the oracle measures indirect-eval semantics, so Script-goal behaviour has no XS reference. This is the same gap the test262 harness map describes for its Script bodies.
- **Confidence:** confirmed by probe.

### INT-10 — The oracle's 256-byte error buffer has no truncation flag, producing a false test262 failure

- **Lens(es):** 5, 1.
- **Proposed severity:** low.
- **Location:** `rust/engine/xs-oracle/csrc/xs_shim.c:37, 48, 139-140` (`ENDOR_ERROR_MAX 256`, `strncpy(.., max - 1)`); `xs-oracle/src/lib.rs:33, 347` (no `error_len` / `error_truncated`, unlike `result_len` / `result_truncated` at `:37`, `:346`); consumers `ironhorse-262/src/lib.rs:772-775`, `xst.rs:1993-1996` (`oracle.error == ironhorse_error`).
- **Excerpt:**
  ```c
  strncpy(buf, the->stack->value.string, max - 1);
  buf[max - 1] = 0;
  ```
- **Mechanism:**
  - Any thrown value whose `String()` exceeds 255 bytes is truncated on the XS side only, so `error_agrees` is false.
  - In `xst` a positive test that both engines fail identically with a long `Test262Error` becomes `abort-value-differs` (a Fail) instead of `RunSkip("shared-test262-failure")`.
  - A cut inside a multi-byte UTF-8 sequence would also fail the comparison, because `from_utf8_lossy` inserts U+FFFD.
- **Scenario / test262:** `test/language/statements/with/set-mutable-binding-idref-compound-assign-with-proxy-env.js` is one of the 1,064 failures in the full sweep, and is caused entirely by this truncation.
- **Evidence:** confirmed from the sweep report (`rust/engine/target/test262-report/report.json`):
  ```
  ironhorse-failure fail; reason "abort-value-differs: oracle=\"Test262Error: Actual [has:p, get:Symbol(Symbol.unscopables), ..."
  oracle len 255, ironhorse len 286, ironhorse[:255] == oracle: True
  ```
  It is the only one of 327 `abort-value-differs` cases whose oracle string reached the cap.
- **Recommendation:** carry `error_len` like `result_len`, and compare by prefix when it exceeds the buffer (or enlarge the buffer to the result buffer's size).
- **Confidence:** confirmed (sweep data plus code).

### INT-11 — The `-Wclobbered` warnings at `xs_shim.c:295` are false positives, but they are emitted on every oracle build despite the file's "warning-clean" claim

- **Lens(es):** 6(e) (doc vs build), maintainability.
- **Proposed severity:** low.
- **Location:** `rust/engine/xs-oracle/csrc/xs_shim.c:293-304` (inlined into `:338`, `:571`, `:898`), `:342` (`started`); claim at `:212-215`.
- **Excerpt:** `static txMachine *xs_oracle_create_machine(const char *name) { txMachine *the; ...`
- **Mechanism:**
  - Not undefined behaviour; see Architecture. `the` is never written after `setjmp`.
  - The warning is GCC's inlining artefact, and the warning on `started` concerns a variable never read after `longjmp`.
  - Four `-Wclobbered` lines appear on every build, including CI and the sanitizer lane. That trains readers to ignore exactly the warning class that would flag a real clobber in this setjmp-heavy file.
- **Evidence:** confirmed by probe (`probes/integration-fuzz-oracle/clobber/`; gcc 13.3, `-O2 -Wall -Wextra` plus build.rs's defines):
  ```
  as-is:    xs_oracle_run_impl: 'started' (342), 'the' (295); xs_oracle_run_sources: 'the' (295); xs_oracle_run_module: 'the' (295)
  noinline: only 'started' (342)
  ```
- **Recommendation:** mark `xs_oracle_create_machine` `__attribute__((noinline))` (or declare the callers' `the` `volatile`) and drop `started` into the try block; then add `-Werror=clobbered` for `xs_shim.c`.
- **Confidence:** confirmed by probe.

### INT-12 — `endor run -e ironhorse` runs the engine on the process main thread, outside the `NATIVE_STACK_BYTES` contract

- **Lens(es):** 1.
- **Proposed severity:** low.
- **Location:** `rust/endo/src/ironhorse_engine.rs:823-844` called from `rust/endo/src/bin/endor.rs:141-146`; contract `ironhorse-vm/src/lib.rs:90-111`. Compare the worker (`main.rs:340-345`), `ironhorse_xst.rs:71` and the fuzz targets, which all spawn a thread of that size.
- **Mechanism:** the recursion budget is a bound only on a thread of at least `NATIVE_STACK_BYTES` (32 MiB in debug, 8 MiB in release). The main thread's size is set by the OS or by `ulimit -s`.
- **Scenario:** a debug `endor` binary, or a release one under `ulimit -s` below about 600 KiB, aborts with SIGSEGV/SIGABRT on `var a=[]; a[0]=a; a.join()` instead of halting `ReentryLimit`.
- **Evidence:** probe `rust_probe_int7.rs` (release; the VM's budget programs on threads of the given size):
  ```
  [8192 KiB] a.join / JSON.stringify(2040-nested) / forEach recursion -> ReentryLimit (all)
  [1024 KiB] same -> ReentryLimit (all)
  [512 KiB]  a[0]=a; a.join() -> rc=134 thread has overflowed its stack
  [256 KiB]  a.join, forEach recursion -> rc=134
  ```
  Release builds on default Linux/macOS/Windows main threads (8/8/1 MiB) are therefore safe in practice; debug builds (13 MiB measured, per the constant's doc) are not.
- **Recommendation:** run `run_script` on a `std::thread::Builder::new().stack_size(NATIVE_STACK_BYTES)` thread, as every other host does.
- **Confidence:** confirmed by probe (VM side); static for the endor call path.

### INT-13 — The compiler adapter and its error mapping exist in many hand-maintained copies; two copies are verbatim, and the copies have already diverged in behaviour (INT-3)

- **Lens(es):** 2, 6(a).
- **Proposed severity:** low. The behavioural consequence is INT-3.
- **Location:** see the duplication inventory, rows 1-3.
- **Excerpt (one of 11 production copies):**
  ```rust
  ironhorse_compile::ParseErrorKind::Lex(ironhorse_compile::LexError {
      kind: ironhorse_compile::LexErrorKind::RegExpHostAllocationFailed, ..
  }) => Err(ironhorse_vm::SourceCompileError::HostAllocationFailed),
  ```
- **Mechanism:**
  - The `ParseError` → {MeterAbort, HeapExhausted, HostAllocationFailed, Unsupported, Syntax} mapping is re-spelled at 11 production sites and 10 test sites.
  - `thixotrope-ironhorse-worker/src/main.rs:17-195` and `wasm-worker-spike/src/session.rs:24-202` are identical (`diff -w` empty, 179 lines).
  - `ironhorse-runtime` is the canonical adapter and is the only one with `compile_eval_units`.
- **Evidence:** `grep -rn LexErrorKind::RegExpHostAllocationFailed rust` lists 21 sites; the diff above.
- **Recommendation:**
  - Implement `From<ironhorse_compile::CompileError> for SourceCompileError` (or a `classify_parse_error` function) once, in `ironhorse-runtime`.
  - Make both workers depend on `ironhorse-runtime`, and have `compile_metered` call the same mapping.
- **Confidence:** high.

### INT-14 — `stack-depth-prototypes/` patches no longer apply; the directory is dead weight as code

- **Lens(es):** 2, maintainability.
- **Proposed severity:** low.
- **Location:** `rust/engine/stack-depth-prototypes/*.patch` (4,724 lines across six patches); README claims "All of them apply to the tree at the commit that added this directory".
- **Evidence:** `git apply --check --directory=rust/engine <patch>` at HEAD:
  ```
  a1-thin-native-dispatch.patch: patch failed: ironhorse-vm/src/interp/natives/dispatch.rs:1656
  a2-dispatch-split-table.patch: patch failed: ironhorse-vm/src/interp/dispatch.rs:249
  b1-b2-proxy-cursor-loops.patch: patch failed: ironhorse-vm/src/interp/frames.rs:89
  b3-b4-json-parse-and-flat.patch: patch failed: ironhorse-vm/src/interp/natives/json.rs:18
  d1a-compiler-outline-only.patch: patch failed: ironhorse-compile/src/coder.rs:995
  d1a-d1c-compiler-worklists.patch: patch failed: ironhorse-compile/src/ast.rs:521
  ```
  The checkout is shallow (50 commits), so the commit that added the directory cannot be determined here.
- **Recommendation:**
  - Record the base commit in the README, or move the patches to branches.
  - Keep the README's measurement table in `STACK-DEPTH-REFACTOR.md`.
  - Similarly fold `phase-1b-handoffs/` into issues; they are status notes about an expired phase.
- **Confidence:** confirmed.

## Duplication inventory

| # | Family | Copies (path:line) | Size | Note |
|---|---|---|---|---|
| 1 | `ParseError` → compile halt / `SourceCompileError` mapping | `rust/endo/src/ironhorse_engine.rs:598-641`; `ironhorse-runtime/src/lib.rs:51-80, 147-176`; `ironhorse-262/src/lib.rs:137, 402`; `thixotrope-ironhorse-worker/src/main.rs:47-64, 96-113, 144-164`; `wasm-worker-spike/src/session.rs:54-71, 103-120, 151-171`; plus 10 test copies (`ironhorse-vm/tests/{common/mod.rs:74, engine_unwind_boundaries.rs:57, surrogate_values.rs:131,180, ...}`, `ironhorse-snapshot/tests/{persist_gates.rs:187, dynamic_segments.rs:59}`) | 11 production + 10 test, ~15-25 lines each | one `From` impl |
| 2 | Worker `Compiler` + `eval` + `crank_halted` | `thixotrope-ironhorse-worker/src/main.rs:17-195` ≡ `wasm-worker-spike/src/session.rs:24-202` | 179 lines, verbatim | spike README says "unchanged" |
| 3 | `SourceCompiler` impls | worker (`main.rs:18-115`), spike (`session.rs:25-122`), `ironhorse-runtime/src/lib.rs:28-127` | 3 x ~100 lines | only the runtime copy has `compile_eval_units` (INT-3) |
| 4 | `compile_source` vs `compile_source_units` bodies | each of the three impls above | 2 x ~48 lines per impl | differ only in the entry called |
| 5 | Halt skip pre-check (registered NotImplemented/Refused, EngineInvariant, EngineFault) | `ironhorse-fuzz/src/lib.rs:1861-1891`; `ironhorse-262/src/lib.rs:1009-1035`; `xst.rs:907-925, 1254`; `test262.rs:142` | ≥4 sites | the fuzz copy bypasses `is_skip_eligible_label`, which claims to be "the one predicate every discard site consults" (`xst.rs:1115-1119`), so `HARNESS_NOT_IMPLEMENTED_LABELS` differ between the instruments |
| 6 | Differential check bodies | `ironhorse-fuzz/src/lib.rs:1898-1920, 1940-1986, 1993-2028` | 3 x ~25 lines | plus `differential_check_meter_v4` ≡ `differential_check_with_symbols` (`:1936-1938`), acknowledged at `:2037-2042` |
| 7 | Result comparison policy | fuzz `comparison.rs:5-21` (completion + result; **thrown value never compared**); `ironhorse-262/src/lib.rs:321-329, 772-775` (`observables_agree` compares thrown values) | 2 policies | see Ontology notes |
| 8 | Fuzz byte cursor `Bytes` | `ironhorse-fuzz/src/lib.rs:92-119`, `regexp.rs:20-45` | 2 x ~25 lines | identical `next`/`choice` |
| 9 | Seed-expansion loops in sweep tests | `ironhorse-fuzz/src/lib.rs` 26 loops at `:2993 ... 4406` | 26 x 5-9 lines | each with hand-picked constants; one helper would do |
| 10 | Crank meter + host setup | `ironhorse_engine.rs:1408-1433` (eval) and `:1670-1691` (collect notification) | 2 x ~16 lines | plus `resume_shared` `:1321-1327` |
| 11 | Rewind-or-`Poisoned` blocks | `ironhorse_engine.rs:1378-1387, 1510-1519, 1539-1545, 1604-1611, 1713-1720, 1809-1816` | 6 x ~8 lines | one helper with a `during` label |
| 12 | Oracle result copy-out | `xs-oracle/src/lib.rs:325-358` (`run`) vs `:391-427` (`outcome_from_raw`) | 2 x ~35 lines | `run` could call `outcome_from_raw` |
| 13 | Shim host-globals install | `xs_shim.c:384-417`, `:594-625`, `:936-949` | 3 x ~20-34 lines | `harden`/`lockdown`/`petrify`/`mutabilities` + `$262` |

## Skipped features and refusals inventory

| Site | What is refused or skipped | Spec / XS status | Should support? | Effort |
|---|---|---|---|---|
| `ironhorse_engine.rs:1860-1879` `run_worker` | `endor worker -e ironhorse` → `MachineError::Unavailable` | XS worker exists | yes, it is the integration's goal | large (envelope transport, host powers, SES boot) |
| `ironhorse_engine.rs:1307-1311`, `js_machine.rs:51-53` | no host callables (`define_function`, powers) | xsnap has them | yes | medium-large |
| `ironhorse_engine.rs:322-328` | `ExecutionOutcome` not wired to any delivery path | design item | yes, or delete | small |
| `thixotrope-ironhorse-worker/src/main.rs:17-116` | direct-eval context (`super`, `new.target`, `#x`) | ES2022 | yes | trivial (use `ironhorse-runtime`) |
| thixotrope worker / spike | garbage collection | XS collects automatically | yes | small (INT-1) |
| `ironhorse-fuzz/src/regexp.rs:7-9, 51` | regexp differential: no `u`/`v` flags, no named groups, ASCII-only subjects (the doc also says `i` is excluded, but `:63` generates it) | supported by both engines | yes | small-medium |
| `xs_shim.c:1167-1171` | `xs_oracle_regexp` ignores `subjectLen`; a NUL in the subject truncates it | - | yes, if subjects ever leave the ASCII alphabet | small |
| fuzz roster | no targets for Proxy/Reflect, generators/async, classes/private/`super`, `eval`/`Function`, WeakRef/FinalizationRegistry, modules (oracle entries exist unused), Date, harden/lockdown/Compartment, host API, `PersistentMachine` lifecycle | - | yes for all but Date/Intl | per surface: one generator + roster entry |
| XS oracle | no Intl (XS has none), so `intl402` cannot be differenced (0.7% covered in the sweep) | ECMA-402 | needs another oracle | large |
| `ironhorse-fuzz/src/lib.rs:1974-1976, 2006-2008` | comparison skipped when the oracle result exceeds 16 KiB | - | acceptable | - |
| `fuzz_targets/differential_compile.rs:21-23` | `IronhorseRejected` (including coder panics) not a finding | - | yes, for panics | trivial |
| `stack-depth-prototypes/` | six refactors not landed, patches stale | - | per report | - |

## Memory and performance opportunities

| Site | Waste | Magnitude | Fix |
|---|---|---|---|
| Thixotrope worker / wasm spike (INT-1) | unreachable objects retained, checkpointed, restored | unbounded: 30 MB SQLite after 4 cranks of 200k garbage slots; the vat dies at the 1M-slot ceiling | collect on a cadence |
| `ironhorse_engine.rs:734-740` ephemeral `evaluate` | full `collect()` before every evaluation, even of a trivial program | measured 0.47 ms prep vs 0.088 ms to run `1+1` (5.3x); 3,173 live boot slots; 76 slots per fresh compartment (probe INT-P8) | collect only when the previous evaluation allocated past a threshold, or reuse one compartment |
| `ironhorse_engine.rs:699-709` `Machine::new` | full boot per `endor run` | 48 ms measured (release) | acceptable for a CLI; snapshot the boot image if it is called often |
| `ironhorse_engine.rs:1443-1453, 1378-1387` | a compile or syntax error triggers `rewind_to_last_checkpoint` (lazy resume, claim, `release_unclaimed_roots`) although nothing in the machine was touched, and discards pending cranks | one full resume per rejected source (not measured; O(small state + faults)) | skip the rewind when compilation fails before `evaluate_*` runs |
| `interp/link.rs:1404-1418` (on the per-crank path of both persistent embedders) | `symbol_names.clone()` plus a linear `position` per crank name | O(crank names x table) per crank; BOOT-5 measured 130 ms at 50k keys | hash lookup; cross-reference BOOT-5 |
| `ironhorse-fuzz/src/lib.rs:1946-1963` | every symbols-mode fuzz input runs on IronHorse twice (unarmed and armed) plus XS | 2x VM time per iteration on 18 of 19 surfaces | sample the armed check (for example 1 in 8 inputs) |
| `xs-oracle` `EndorOracleResult` | 16,384 + 512 inline bytes per crank slot | ~17 KiB x crank count per multi-crank call | fine for a test oracle |

## Ontology notes

- **"Realm".** The endo docs say each ephemeral evaluation "creates a fresh Realm" (`ironhorse_engine.rs:694, 722`). The VM model, which matches ECMA-262 with shared intrinsics, is "The single Realm shared by all compartments of this Machine" (`compartment.rs:1289`); what is fresh is the compartment's global environment. The mislabel hides that the key table, symbol registry and intrinsic graph are shared (INT-4).
- **"Panic" means four things:**
  1. A Rust panic.
  2. `Halt::is_panic()`, which includes `MeterAbort`, `HeapExhausted` and `Decode`.
  3. `ExecutionOutcome::Panicked`, a superset that also includes `NotImplemented` and `Refused`.
  4. `Halt::Panic(PanicKind)`, whose only kind is `EngineFault`, never produced by the VM.

  "Panic-free" fuzz targets mean (1); supervisor docs mean (2) or (3).
- **"Refused / declined / unsupported / unavailable".**
  - `Halt::Refused` (profile limit) and `Halt::NotImplemented` (gap).
  - `MachineError::Refused(Refusal)` (store or profile mismatch).
  - `MachineError::Unavailable` and `JsMachineErrorKind::Unavailable`; the latter absorbs both Halt kinds.
  - `SourceCompileError::Unsupported`, `ParseErrorKind::Unsupported`.
  - The fuzz crate's "declined label" (`lib.rs:1882`).

  `MachineError::Refused` and `Halt::Refused` are homonyms for different authorities.
- **"Machine"** names `ironhorse_vm::Machine`, endo `Machine`, `PersistentMachine`, `xsnap::Machine`, XS `txMachine`, and the worker's `Interp`. `PersistentMachine` holds a VM `Machine`, while the thixotrope worker's "machine" is a bare `Interp`.
- **"Crank / evaluation / delivery"** are used interchangeably. The crank's goal (Eval or Script) is not part of the concept anywhere (INT-9).
- **"Poisoned"** names three different states: `MachineError::Poisoned` (rewind failed; the machine is lost), `StoreFailure::Poisoned` (stop using the store) and the VM's "poison latches" (`interp.rs:2984-2990`).
- **Outcome taxonomies are not disjoint and are applied differently** (INT-5 table). `CompileFuzzOutcome::IronhorseRejected` is a finding in two doc comments and a non-finding in the target and its test (INT-8).
- **Agreement policies differ between the two differential instruments.**
  - The fuzz comparator (`comparison.rs:5-21`) treats any two non-completions as agreement and never compares the thrown value.
  - The test262 harness's `observables_agree` compares it.
  - A probe over 237 both-abort fuzz samples found no current mismatch, so this is a latent weakness only.
- **Types not encoding distinctions.**
  - `EvalOutcome::unhandled_rejection: Option<(SlotIndex, Slot)>` and `Halt::Throw{value: Slot}` are raw coordinates whose validity depends on heap epoch. On the persistent path they cross a rewind into a discarded heap.
  - `MeterBounds` and `EvalOutcome` carry both "computrons" and raw 16.16 "meter_raw" as bare `u64`.
- **Docs vs code.**
  - `MachineError::SymbolMismatch` is documented and never constructed.
  - `Machine::new` says persistent workers use a standalone `Interp`, while `PersistentMachine` refuses standalone stores.
  - `ExecutionOutcome::classify`'s doc omits `Refused`.
  - `regexp.rs` says `i` is never generated, but it is.
  - The `xs_shim.c` header and comment at `:212-215` claim a warning-clean build (INT-11).
  - `stack-depth-prototypes/README.md` says the patches apply (INT-14).

## Leads that did not survive

- `-Wclobbered` at `xs_shim.c:295` as undefined behaviour: not UB, because `the` is never written after `setjmp`; the `noinline` variant removes the warning (INT-11 keeps the hygiene point).
- `xs_oracle_regexp` keeping `fxCompileRegExp`'s `code`/`data` chunks in unrooted C locals across `fxMatchRegExp`: the prior reviewer's probe (`regexp_main.c`, patterns up to 92 KB, and a variant with GC disabled, `variant/nogc.out`) shows identical, correct captures. The matcher does not allocate between compile and match.
- Fuzz builds without overflow checks (`fuzz/Cargo.toml` is its own workspace with no `[profile]`): plain `cargo fuzz run` without `-O` adds `-Cdebug-assertions`, which turns overflow checks on. Static, from cargo-fuzz's documented defaults; cargo-fuzz is not installed here.
- The prior reviewer's `ih_reject=13` in `gen_program`: XS also rejects these programs. In console mode XS emits a small SyntaxError-throwing stub, so the bytecode is non-empty; `compile_differential_check` classifies all of them as `BothReject` (probe `rust_probe_int2.rs`: 81 `BothReject` and 1,419 `Identical` in 1,500; 118 and 1,382 for `gen_compile_program`; no `IronhorseRejected`).
- The fuzz comparator ignoring thrown values hides current divergences: 237 both-abort samples across all surfaces, 0 thrown-value mismatches (`rust_probe_int2.rs`). Kept only as an ontology note.
- The ephemeral VM machine poisoned after an unwound panic: no; the next `evaluate` works (INT-P1 A2/A3).
- Release `endor run` overflowing on default main threads: 1 MiB suffices for the budget programs (INT-12 limits the claim to debug builds and small `ulimit -s`).
- Oracle `build.rs` overlays making the oracle diverge from shipped XS: they remove C UB in numeric classification and overlapping `snprintf` only. Note that the prior reviewer's `cbuild/oracle_probe` binary was built *without* the two overlays; the probes reused here (`e2`, `s1`) do not touch numeric literals outside int32 or RegExp diagnostics.
- `PersistentMachine` meter ceiling arithmetic (`(state.index >> 16).saturating_add(limit)`, `compile_allowance`): saturating and re-based per crank; no bypass found.
- `MachineError::Store` boxing and `Result` size on the hot path: as documented.
- `cranks.rs` generator byte reuse: same pattern as INT-7 but with coprime moduli, so every sub-shape stays reachable.

### Probe index (all under `../probes/integration-fuzz-oracle/`)

- INT-P1: `rust_probe_int1_embedding_mirror.rs` → `rust_probe_int1.out`. Covers INT-2 and INT-4; run from `rust/endo/ironhorse-store-sqlite/tests/`, debug; deleted. `endo_probe_unbuildable.rs` is the direct `endo`-crate version that could not be built.
- INT-P2: `rust_probe_int2.rs` → `rust_probe_int2.out` (compile classification; thrown-value agreement).
- INT-P3: `rust_probe_int3.rs` → `int3.out`. Covers INT-6 and INT-8.
- INT-P4: `rust_probe_int4.rs` (byte identity per surface; output in INT-6).
- INT-P5: `rust_probe_int5.rs` → `int5.out` (INT-7).
- INT-P6: `rust_probe_int6.rs`, a re-run of the prior reviewer's probes 1 and 3 (INT-3, INT-9).
- INT-P7: `rust_probe_int7.rs` → `int7.out` (INT-12).
- INT-P8: `rust_probe_int8.rs` (ephemeral per-evaluation cost).
- INT-P9: `clobber/` (INT-11).
- Worker: `worker_no_gc.py` → `worker_no_gc.out` (INT-1).
- JS probes `e1_eval_context.js`, `e2_strict_script_var.js`, `s1_spread_setter.js`, `s1b.js`, re-run on `ironhorse-xst`, node and the prior `cbuild/oracle_probe`.
- All temporary test files were deleted from the repository; `git status` is clean.
