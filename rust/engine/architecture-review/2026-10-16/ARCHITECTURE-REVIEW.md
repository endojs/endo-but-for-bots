# IronHorse architecture review, 2026-10-16

| | |
|---|---|
| Published | 2026-10-16 |
| Reviewed commit | [`61cd656cb`](https://github.com/endojs/endo-but-for-bots/commit/61cd656cb) (`61cd656cb8d9c3c1c50334eb78bfa0dc8eb1657c`) |
| Scope | `rust/engine` (eleven crates); `rust/endo/src/ironhorse_engine.rs` and `rust/endo/ironhorse-store-sqlite`; `rust/thixotrope-ironhorse-worker`; the `c/moddable` oracle pin; the test262 harness, its committed baseline and its CI |
| Lenses | sanity and correctness; duplicated code; skipped features and aborted conditions; performance and memory overhead; test262 conformance; ontological consistency |
| Findings | 206 distinct verified findings: 1 critical, 33 high, 80 medium, 92 low (174 from thirteen region maps and 32 from the ontology pass, less 19 same-defect merges, plus 19 from the coverage review) |
| test262 | 82.2% of the pinned corpus passes by test262's own assertions as the harness runs it (93.5% of core ECMA-262), 82.9% (94.4%) run as one Script per case; 76.7% agrees with XS |
| Independence | Conducted without reading the 2026-09-06 or 2026-09-20 reviews or `rust/engine/reviews/` |
| Revisions | none |

This review's analysis is a snapshot of the commit above.
Read every citation against that commit, not against the current tree:

```sh
git show 61cd656cb:rust/engine/ironhorse-vm/src/interp/eval.rs | sed -n '323,380p'
```

The [companion README](README.md) indexes the lens reports and region maps and records the
method.

## Conclusions

1. **IronHorse is a substantially complete ECMAScript engine.**
   Judged by test262's own assertions on the pinned corpus, it passes 93.5% of core ECMA-262
   (standard features, excluding `intl402/`, Annex B and Temporal) and 82.2% of the whole corpus;
   the `language/` tree passes 94.3%.
   Run as one Script per case, as standard test262 hosts run it, 376 more cases pass: 94.4% of core
   ECMA-262 and 82.9% of the corpus.
   The large gaps are Temporal (31.8% of cases carrying the feature), `intl402/` (23.4%), Annex B
   (22.8%), modules beyond a single self-contained body (786 cases unsupported), and 452 RegExp
   cases that one matcher limit halts.
2. **The harness reports a different number, and the CI gate cannot see Temporal or Intl.**
   The published categories record agreement with the XS oracle (76.7%), under labels that read as
   test262 verdicts.
   XS has neither Temporal nor Intl, so 6,104 of the 6,632 Temporal cases and 3,093 of the 3,357
   `intl402` cases never reach a pass or fail column, and 371 "IronHorse failures" are cases
   IronHorse passes.
3. **One critical finding: the `Function` constructor runs injected code at construction
   (CMP-1).**
   On the deployed thixotrope worker, which runs the SES shim, that turns the shim's own
   validation step into a compartment escape.
   This review reproduced it independently.
4. **The resource contract is not met.**
   The meter is meant to bound work and the slot and chunk ceilings to bound memory.
   Neither holds against a guest that chooses its operations: no collection runs within a crank,
   so the ceilings bound cumulative allocation rather than the live set; seven findings show
   host-side state that no ceiling counts (error frames, function and promise rows, bound
   arguments, registry cells, compiled regexps, compiler memory, the value stack); and sixteen
   operations charge orders of magnitude less than the work they do.
   This is the review's largest theme (theme 3), with most of its high findings.
5. **Determinism is good, with one exception.**
   No reviewer found order-sensitive hash iteration, float, address or time dependence in a
   consensus path.
   The exception is lazy intrinsic installation, where state that is not persisted decides
   whether a machine-wide install pass runs, so a resumed machine can diverge from its live twin
   (BOOT-1).
6. **A few host panics and aborts are reachable.**
   `var a = 1 << 31; --a;` panics the host (CORE-1), panics escape both Endo entry points without
   a rewind (INT-2), and crafted containers or damaged store rows panic rather than refuse.
   The coverage review added two more high findings of this kind: `new` on a bound constructor
   whose target lives in another code segment runs the caller's bytecode (COV-1), and rendering a
   crank's completion value is unbounded host work that can abort the host after the meter has
   stopped (COV-3).
7. **The 16-bit property-key namespace is spent by ordinary array code and never reclaimed.**
   Write, reflective and generic-array paths intern integer indices as permanent names, so a
   long-lived vat that uses holey arrays eventually loses the ability to mint keys (NOBJ-1).
8. **Plain objects are cheap; everything around them is not.**
   A slot is 24 bytes against XS's 32, but per-object state lives in SipHash side tables: a
   pending promise costs about 1.5 KB (node: 57 B), a closure about 430 to 490 B (105 B), an array
   item 55.6 B (6.8 B), a Map entry 127 B (37 B), an indexed property about 234 B.
   Memory is never returned to the host after a collection.
9. **Duplication is structural rather than verbatim.**
   Only 3.9% of normalized source lines sit in exact clones, but fourteen families of parallel
   tables and hand-copied algorithms exist, and several high findings are copies that drifted.
10. **The ontology is sound in shape and loose in use.**
    The `Halt` taxonomy, the persistence ledger and the version identifiers have the right
    categories, but no single classifier applies them: one condition is classified differently at
    different sites, and the test262 report inherits that.
    `Slot` doubles as a value and a property record, so attribute flags leak into values (ONT-3,
    NOBJ-NEW-1); no gate identifies the persisted bytecode ISA (ONT-21); and built-in accessors
    exist only as opcode interceptions, so the engine's own Temporal natives cannot see them
    (ONT-6).

## test262 conformance

| Measure | Cases | Pass | Pass % |
|---|---:|---:|---:|
| Whole corpus, IronHorse's own verdict | 51,976 | 42,714 | 82.2 |
| Standard features only | 49,418 | 42,299 | 85.6 |
| Core ECMA-262 (standard features; no `intl402/`, `annexB/`, Temporal) | 42,115 | 39,386 | 93.5 |
| Stage-3 proposal features | 2,558 | 415 | 16.2 |
| Agreement with XS (the harness's "covered") | 51,976 | 39,860 | 76.7 |

| Tree | Cases | Pass | Fail | Unsupported | Not run | Pass % |
|---|---:|---:|---:|---:|---:|---:|
| `built-ins` | 23,809 | 19,306 | 3,749 | 459 | 295 | 81.1 |
| `language` | 23,724 | 22,375 | 374 | 941 | 34 | 94.3 |
| `intl402` | 3,357 | 785 | 2,538 | 34 | 0 | 23.4 |
| `annexB` | 1,086 | 248 | 803 | 0 | 35 | 22.8 |

Both whole-tree sweeps ran at this commit with the repository's `full-run.sh`, one gated on the
XS oracle and the committed shards (no drift: the gate passed), one with the oracle gate off.
The harness runs each case's includes as a separate setup Script.
Re-run as one Script, as standard test262 hosts do, 376 cases scored as failures pass: 362 are the
split-Script artifact of T262-2, 11 are completion-value coercion and 3 are the async latch of
COV-9.
Counting them gives 43,090 passes (82.9%) for the whole corpus, 42,675 (86.4%) for standard
features and 39,762 (94.4%) for core ECMA-262
([`probes/coverage-review/writer/one-script-passes.txt`](probes/coverage-review/writer/one-script-passes.txt)).
The [test262 lens](lenses/test262-conformance.md) has the method, the per-area and per-feature
tables, how the harness's categories map onto the verdict, and the harness findings.

## Architecture as built

This section describes IronHorse as built at commit `61cd656cb`, as a frame for the findings.
It condenses the "Architecture as built" sections of the thirteen region maps
(`maps/<region>.md`); where a verification pass corrected a map, the correction is used.
Finding IDs such as CORE-5 point into the maps, with the merged ledger's final severity (all
thirteen maps verified).
All paths are repository-relative.

### 1. Workspace and size

IronHorse is an independent Cargo workspace of eleven crates (`rust/engine/Cargo.toml:7-21`),
consumed by path from the outer `rust/` workspace.
The release profile sets `overflow-checks = true` (`rust/engine/Cargo.toml:31`), so guest-reachable
integer overflow is a Rust panic, not a wrap (CORE-1, high).
Counts are git-tracked `.rs` lines; "src" includes in-file `#[cfg(test)]` modules.

| Crate | src | tests/ | Responsibility | Production |
|---|---:|---:|---|---|
| `ironhorse-meter` | 1,217 | 0 | Frozen cost weights, XS default keys, SHA-256 digest, release `ironhorse-meter-9` | yes |
| `ironhorse-text` | 206 | 0 | `SymbolName`: canonical CESU-8 names, lone surrogates included | yes |
| `ironhorse-unicode` | 177 | 51 | XS identifier delta tables, scanned linearly | yes |
| `ironhorse-regexp` | 19,920 | 1,763 | Port of XS `xsre.c`; about 11,900 lines are generated Unicode tables | yes |
| `ironhorse-compile` | 24,019 | 7,677 | Lexer, parser, scoper, coder: XS bytecode plus a symbols atom | yes |
| `ironhorse-vm` | 113,884 | 37,095 | Values, arenas, interpreter, built-ins (33,598), realm, collector, snapshot rows | yes |
| `ironhorse-runtime` | 197 | 498 | `SourceCompiler` adapter over the compiler | yes |
| `ironhorse-snapshot` | 32,236 | 22,542 | Container codec, validation, side-table ledger, stores, checkpoints | yes |
| `ironhorse-262` | 13,587 | 27,303 | test262 runner, XS differential, reports, expectation ratchet | no |
| `ironhorse-fuzz` | 7,510 | 15 | Fuzz logic; 14 cargo-fuzz targets in a nested `fuzz/` project | no |
| `xs-oracle` | 1,174 | 112 | Pinned Moddable XS (45 C files) and `csrc/xs_shim.c` behind FFI | no |
| `rust/endo/src/ironhorse_engine.rs` | 2,621 | in file | Daemon seam: ephemeral `Machine`, `PersistentMachine` | yes |
| `rust/endo/ironhorse-store-sqlite` | 2,323 | 3,630 | SQLite `HeapStore` | yes |
| `rust/thixotrope-ironhorse-worker` | 490 | 0 | NDJSON crank worker | yes |

**Dependency direction** (`rust/engine/CRATE-GRAPH.md`).
The leaves are `meter`, `text` and `unicode`.
`regexp` uses `meter` and `unicode`; `compile` uses all three leaves plus `regexp`.
`vm` uses `meter`, `text`, `regexp`, the ICU4X normalizer and segmenter, and an optional software
`libm` (`rust/engine/ironhorse-vm/Cargo.toml:16-25`).
It does not use the compiler: it owns the `SourceCompiler` trait
(`rust/engine/ironhorse-vm/src/interp.rs:261`) and links `compile` only in tests.
`runtime` joins `compile` and `vm`, `snapshot` builds on `vm`, and `xs-oracle` is linked only by
the 262 and fuzz crates and by optional `parity` features.
Endo links `vm` (features `consensus`, `store-integrity`), `compile`, `runtime`, `snapshot` and the
SQLite store (`rust/endo/Cargo.toml:7-36`); the worker omits `runtime`
(`rust/thixotrope-ironhorse-worker/Cargo.toml:8-11`).

**Development-only code.**
Besides the three dev crates, `rust/engine/wasm-worker-spike` is a standalone root in no CI lane;
`rust/engine/wasm-worker-spike/src/session.rs:24-202` copies the worker loop verbatim.
`rust/engine/stack-lanes` is live stack-measurement CI, and `rust/engine/stack-depth-prototypes`
holds six patches that no longer apply (INT-14, low).

### 2. Values and memory

| Structure | As built | Location |
|---|---|---|
| `Slot` | 24 B: `next: SlotIndex(u32)`, `id: u16`, `flag: u8`, `kind: Kind(u8)`, `value: Payload(16 B)`; XS uses 32 B | `rust/engine/ironhorse-vm/src/value.rs:620-629` |
| `Kind` | 15 variants; repeats the `Payload` discriminant (CORE-11, medium) | `rust/engine/ironhorse-vm/src/value.rs:459-535` |
| `Payload` | `None`, `Boolean`, `Integer(i32)`, `Number(f64)`, `String`, `Reference`, `At(u16, u32)`, `BigInt` | `rust/engine/ironhorse-vm/src/value.rs:565-580` |
| Slot arena | `Vec<Cell<Slot>>`, LIFO free list, `Vec<bool>` mark bitmaps, dirty-page bitmaps; about 26 B per slot; never shrinks (MEM-7, medium) | `rust/engine/ironhorse-vm/src/value.rs:829-868` |
| Chunk arena | One `Vec<u8>` of `[u32 len][payload]` blocks; in-band holes, best-fit `BTreeMap` index | `rust/engine/ironhorse-vm/src/value.rs:1717`, `:2066` |
| Ceilings | 1,000,000 slots and 256 MiB of chunks; refusal unwinds to `Halt::HeapExhausted` | `rust/engine/ironhorse-vm/src/value.rs:14-15`, `:1226` |
| Dirty geometry | 256-slot pages and 64 KiB chunk extents, shared with the store | `rust/engine/ironhorse-vm/src/value.rs:168-172` |

The same `Slot` type carries plain values on the stack and in side tables, where `next` and `id`
are dead weight; `id` is variously a key, an argument count, a binding name or a marker.

**Strings.**
Guest strings are immutable, never-interned chunks of big-endian UTF-16
(`rust/engine/ironhorse-vm/src/interp/strings.rs:9-23`; NVAL-17, low).
`+` decodes, joins, re-encodes and appends a fresh chunk
(`rust/engine/ironhorse-vm/src/interp/strings.rs:130-142`), so with no in-crank collection an
append loop exhausts the ceiling at about 16,400 appends (NVAL-3, high).

**Side tables.**
State that XS keeps in slots lives in about 46 SipHash `HashMap<SlotIndex, _>` tables on
`Interp`, keyed by the owner; 54 fields of `rust/engine/ironhorse-vm/src/interp/state.rs` carry a
`Tracked<T>` dirty mask (`rust/engine/ironhorse-vm/src/snapshot_dirty.rs:72`).
Functions, accessors, private elements, promises, saved frames, arrays, collections, regexps and
Intl and Temporal records live there; capture sorts by owner, so hash order stays out of snapshots.
Only array items, index properties, collection entries and Segmenter results are charged to the
chunk ceiling (`rust/engine/ironhorse-vm/src/interp/side_ledger.rs:15-34`).
Function records, promises, saved activations, bound arguments, error frames, FinalizationRegistry
cells and DisposableStack records sit outside every ceiling (MEM-3, FN-2, FN-3, NOBJ-6, high).

**Properties.**
An object is a `Kind::Instance` slot whose payload is its prototype and whose `next` heads a
newest-first chain of property slots (`rust/engine/ironhorse-vm/src/value.rs:466-475`).
A property slot takes its value's kind and keeps attributes in `flag`; accessor pairs live in a
side table, and function `length` and `name` are synthesized from `FuncInfo`.
Lookup scans 8 nodes (`rust/engine/ironhorse-vm/src/value.rs:1340-1352`), then `PropertyIndex`
rescans up to 32 and on a miss indexes the whole chain
(`rust/engine/ironhorse-vm/src/property_index.rs:103-158`).
The unpersisted, unmetered index is dropped by a delete and rebuilt whole (PROP-3, high).
Measured cost is about 49 B per property on small objects and 234 B on indexed ones.

**Key namespace.**
A key is a `u16`: string names count up in the persisted, never-shrinking `symbol_names` and
symbol keys count down (`rust/engine/ironhorse-vm/src/interp/property/keys.rs:183-205`).
Guest minting stops 1,024 ids short of exhaustion (`rust/engine/ironhorse-vm/src/interp.rs:352`)
with a catchable `RangeError` (`rust/engine/ironhorse-vm/src/interp/property/keys.rs:54-72`).
Reads carry indices as `ReadKey::Index`, but write, reflective and generic-array paths intern
decimal index names (PROP-1, NOBJ-1, high).
The lifetime budget of about 64.4k ids also absorbs eval identifiers, JSON keys and collected
symbols (PROP-2, medium).

**Elements.**
Arrays keep `ArrayData { length, items: BTreeMap<u32, Slot> }` in a side table
(`rust/engine/ironhorse-vm/src/bulk.rs:171-185`), as do integer keys of ordinary objects.
No array is contiguous: access is O(log n) at 55.6 B per item, charged 32 (NOBJ-15, medium).

**Collection.**
The one exact collector, `Interp::collect_garbage`
(`rust/engine/ironhorse-vm/src/interp/gc.rs:110`), runs only at quiescence.
It marks through `GcHooks`, iterates an ephemeron fixpoint, sweeps, and compacts chunks within
64 KiB extents (`rust/engine/ironhorse-vm/src/gc.rs:167`).
It charges no computrons and scans pair-keyed tables per owner (MEM-2, high).
The paged `partial_collect` and `generational_collect`
(`rust/engine/ironhorse-snapshot/src/machine.rs:1625-1809`) run only in tests and benches.
No collection runs inside a crank (`rust/engine/RECLAMATION.md:63`) and allocation pressure never
triggers one, so total allocation past a ceiling halts the crank (MEM-1, medium).

| Host | When it collects |
|---|---|
| endo ephemeral `Machine` | Before every evaluation (`rust/endo/src/ironhorse_engine.rs:740`) |
| endo `PersistentMachine` | Every `collect_every` cranks; default 0, never (`rust/endo/src/ironhorse_engine.rs:922-929`, `:1474-1475`) |
| thixotrope worker | Never: `rust/thixotrope-ironhorse-worker/src/main.rs` calls no collector (INT-1, high) |
| any host | `Compartment::collect` on request (`rust/engine/ironhorse-vm/src/compartment.rs:1244`) |

### 3. Compilation

| Stage | As built | Location |
|---|---|---|
| Lexer | Decodes the source up front at 12 B per character; 168 B per `Lexeme`; validates regexp literals under the meter | `rust/engine/ironhorse-compile/src/lexer.rs:146-182` |
| Parser | Transliterated `xsSyntaxical.c` on a node stack; boxed 80 B nodes; deterministic budgets of 1,024 stack units and depth 2,048 | `rust/engine/ironhorse-compile/src/parser.rs:155-164` |
| Scoper | Explicit-stack hoist and bind passes; scope arena; paged per-node tables | `rust/engine/ironhorse-compile/src/scoper/walk.rs` |
| Coder | About 40 B per opcode record; XS-hashed symbol table, at most 65,534 names | `rust/engine/ironhorse-compile/src/coder.rs:297-371` |
| Serializer | `optimize` and three passes, charged before they run | `rust/engine/ironhorse-compile/src/coder.rs:5981-6124` |

`compile_parser_with` (`rust/engine/ironhorse-compile/src/coder.rs:1237-1299`) chains the stages
for the Script, Module and Eval goals.
With no FormalParameters or FunctionBody goal, `Function(...)` compiles a concatenated eval
program (`rust/engine/ironhorse-vm/src/interp/eval.rs:323-376`), so injected statements run
(CMP-1, critical; FN-9 is the same defect).
Errors and meter refusals unwind, so the crate needs `panic=unwind`
(`rust/engine/ironhorse-compile/src/lib.rs:29-30`).

**Bytecode format.**
The format is XS's: one buffer per compile unit with nested functions inline, plus a CESU-8
symbols atom of 16-bit ids; the VM's tables cover XS's 246 opcodes
(`rust/engine/ironhorse-vm/src/opcode.rs:256-259`).
The `differential_compile` fuzz target and `rust/engine/ironhorse-262/src/compile_diff.rs`
compare the compiler's bytes with XS's.
The VM relinks each unit's symbol ids onto the machine's name table before running it
(`rust/engine/ironhorse-vm/src/interp/link.rs:20-71`).

**Metering.**
One `ParseMeter` charges 0.25 computron per source byte before decoding, one per token, and 1/16
per scoper or coder work unit.
Cover-grammar clones go unmetered (CMP-5, medium), and compile-time host memory is 220 to 345
times the source, uncharged against the heap ceilings and allocated infallibly (CMP-2, high).

**The `SourceCompiler` seam.**
The VM owns linkage, nested invocation, realm identity and metering; the compiler owns source to
bytecode (`rust/engine/ironhorse-vm/src/interp.rs:250-261`).
`ironhorse-runtime` implements it; the worker carries a private copy that drops the direct-eval
context (`rust/thixotrope-ironhorse-worker/src/main.rs:17-116`; INT-3, medium).
The VM maps `Syntax` to a catchable `SyntaxError`, `Unsupported` to an uncatchable
`NotImplemented` halt, and a compiler panic to `EngineInvariant`
(`rust/engine/ironhorse-vm/src/interp/eval.rs:104-127`).

### 4. Execution

**Activation.**
The running frame is a set of flat `Interp` registers (`stack`, `locals`, an `id_map` hash map,
`args`, `this_val`, `env`), which `enter_call` moves into a `CallerState` of about 216 B
(`rust/engine/ironhorse-vm/src/interp/frames.rs:323-452`).
JS calls, accessors and generator resumes run in place
(`rust/engine/ironhorse-vm/src/interp.rs:2220-2245`); native callbacks recurse through
`dispatch_at` (`rust/engine/ironhorse-vm/src/interp/dispatch.rs:197-216`).
A user call costs about 1,600 instructions of SipHash and five allocations (CORE-7, medium).
Captured bindings are boxed one by one and copied into `locals` on every call
(`rust/engine/ironhorse-vm/src/interp/environment.rs:529-596`).

**Dispatch.**
`dispatch_at_inner` (`rust/engine/ironhorse-vm/src/interp/dispatch.rs:218-1172`) consults the host
meter every 4,096 instructions and checks the step limit, slot ceiling and key-space latch.
It then decodes the opcode, ticks the meter, decodes again for the length
(`rust/engine/ironhorse-vm/src/opcode.rs:1074-1105`) and runs one `match`.
Backward branches, call entry and `END` also consult the meter, as in XS.

**Exceptions and suspension.**
`CATCH` pushes a `CatchJump`; `raise_js` unwinds `call_stack` eagerly
(`rust/engine/ironhorse-vm/src/interp/unwind.rs:67-81`).
`suspend_activation` moves an activation into a `SavedFrame`
(`rust/engine/ironhorse-vm/src/interp/suspend.rs:21-68`); four copied drivers resume it
(FN-19, low).
Each async call nests a `dispatch_at`, which caps async nesting at 126 levels (FN-14, medium).
`for await` over a sync iterable lacks CreateAsyncFromSyncIterator (CORE-2, FN-1, high).

**Promise jobs.**
Jobs form one FIFO `VecDeque` drained after the script
(`rust/engine/ironhorse-vm/src/interp/natives/promise.rs:861-883`), with 15 native reaction kinds.
Compartment evaluation never pumps; `Machine::run_promise_jobs` does
(`rust/engine/ironhorse-vm/src/compartment.rs:1356`).
Adoption, `finally`, async-generator return and the `await` fast path take a different number of
jobs than the spec (FN-4, FN-5, FN-7, FN-8, medium).

**Metering and admission.**
The meter is XS's 16.16 fixed point (`rust/engine/ironhorse-vm/src/meter.rs`) over frozen weights.
Dispatch charges every opcode, and the regexp matcher one computron per step
(`rust/engine/ironhorse-regexp/src/matcher.rs:125-128`).
Natives use about fifteen verbs that blur three budgets (meter, chunk ceiling, host allocator):
`tick_*` accrues unchecked, `charge_and_check` consults the host first
(`rust/engine/ironhorse-vm/src/meter.rs:276`), and `admit_scratch` checks the ceiling but reserves
nothing (`rust/engine/ironhorse-vm/src/interp/admission.rs:265`).
Work charged far below its cost includes string search (NVAL-1), BigInt (NVAL-2), TypedArray sort
(NOBJ-2), Set methods (NOBJ-3), intrinsic installation (BOOT-3) and collection (MEM-2), all high.
Intl and Temporal have no charge site beyond result-string allocation.

**Depth budgets.**
Native re-entry draws on `NATIVE_DEPTH_LIMIT = 2048` weighted units, 16 per heavy frame
(`rust/engine/ironhorse-vm/src/interp.rs:409-425`).
The 4,096-slot XS stack model (`rust/engine/ironhorse-vm/src/interp.rs:328`) is checked only at
user-frame entry, so a spread into a native callee grows the host stack unboundedly (CORE-5, high).
Engine threads are sized by `NATIVE_STACK_BYTES`, 8 MiB in release builds
(`rust/engine/ironhorse-vm/src/lib.rs:107-111`).

**Halts.**
`Halt` (`rust/engine/ironhorse-vm/src/interp.rs:1631-1731`) has 14 variants:

| Class | Variants |
|---|---|
| Completion | `Return`, `Throw { value, rendered }` |
| Resource stop | `MeterAbort`, `HeapExhausted`, `HostAllocationFailed`, `StepLimit`, `StackOverflow`, `ReentryLimit` |
| Profile decline | `NotImplemented` (unported) and `Refused` (deliberate), labels in `rust/engine/ironhorse-vm/src/halt_labels.rs` |
| Fault | `EngineInvariant`, `Decode`, `Panic(PanicKind)` |
| Host reentry | `MachineBusy` |

`is_panic` groups resource stops with faults (`rust/engine/ironhorse-vm/src/interp.rs:1796-1811`).
`run_shared_outcome` converts only the two private memory payloads; any other panic re-raises into
the embedder (`rust/engine/ironhorse-vm/src/interp.rs:2983-2991`; INT-2, medium).
One condition often gets different classes at different sites (NVAL-9, NOBJ-10, BOOT-9).

### 5. Built-ins

**Routing.**
Constructors are `Native` ids (`rust/engine/ironhorse-vm/src/interp/native_ids.rs:1141`) that
`call_native_inner` sends to five families: intl, temporal, buffer, promise and core
(`rust/engine/ironhorse-vm/src/interp/natives/dispatch.rs:12`).
Methods are about 396 `NativeMethod` variants
(`rust/engine/ironhorse-vm/src/interp/native_ids.rs:55`), routed by an exhaustive list
(`rust/engine/ironhorse-vm/src/interp/natives/dispatch.rs:2144-2621`).
Each method call charges one heavy frame, and a brand check is a side-table `contains_key`.
`Date`, `TemporalPlain`, `TypedArrayReadonly` and `Atomic` carry positional `u8` op codes whose
meaning is list order in `rust/engine/ironhorse-vm/src/interp/boot.rs`.

**Lazy intrinsics.**
`Interp::new` (`rust/engine/ironhorse-vm/src/interp/boot.rs:60-106`) creates every intrinsic object
but records prototype members in four rosters instead of installing them (about 797 slots).
A member exists once its name is interned at or below a persisted floor and an install pass has
run (`rust/engine/ironhorse-vm/src/interp/link.rs:143-185`, `:384-1196`, `:1502-1537`).
A pass runs on every novel computed string key, own-keys and prevent-extensions, and on define
while the unpersisted `pending_surfaces` names the holder
(`rust/engine/ironhorse-vm/src/interp/link.rs:1578-1653`).
That gate makes a resumed machine diverge from its live twin (BOOT-1, high).
The passes are unmetered per key (BOOT-3, high; BOOT-4, medium).
`Machine::new` installs and hardens everything, at tens of milliseconds (BOOT-6, medium).

**GET_PROPERTY brand shortcuts.**
The `o.k` opcode probes the regexp, Temporal, Intl.Locale, Collator and DisposableStack tables
before ordinary lookup and answers from internal state
(`rust/engine/ironhorse-vm/src/interp/dispatch/property_read.rs:44-299`).
These are the only implementations of RegExp `source` and `flags`, Temporal and Locale fields,
`Collator.prototype.compare` and `disposed`.
`o[k]`, `Reflect.get` and descriptors therefore disagree with `o.k` (CORE-3, RGX-2, NVAL-4, NOBJ-9,
medium), and every `o.k` read pays for the probes (CORE-8, medium).

**Intl and Temporal data.**
Intl is a frozen profile of hand tables, `ironhorse-intl-2026a`
(`rust/engine/ironhorse-vm/src/intl_profile.rs:4`); ICU4X only normalizes and segments.
Collation is NFC, lowercase and code-point order (NVAL-5, medium).
Time zones are a 23-row fixed-offset table at standard time, shared with `Intl.DateTimeFormat`
(`rust/engine/ironhorse-vm/src/interp/temporal.rs:1409-1494`; NVAL-6, high).
Temporal follows an older proposal (NVAL-7, medium).
Local time is UTC, `Date.now()` is 0 (`rust/engine/ironhorse-vm/src/interp/natives/date.rs:50`),
and `Math.random` is absent.
`Math` uses the platform libm unless `consensus` enables `deterministic-math`
(`rust/engine/ironhorse-vm/Cargo.toml:52-54`).

### 6. Realm, compartments, modules, host API

| Concept | As built | Location |
|---|---|---|
| `Machine` | One `Interp`, one frozen intrinsic graph, many compartments | `rust/engine/ironhorse-vm/src/compartment.rs:874-884` |
| `Realm` | The machine's single Realm: intrinsic roots, lockdown flags, default global | `rust/engine/ironhorse-vm/src/interp/realm.rs:22-27` |
| `CompartmentEnvironment` | Global object, binding history, `globalLexicals`, global-name filter, module graph, compiler handles; about 76 slots | `rust/engine/ironhorse-vm/src/interp/realm.rs:43-98` |
| Host `Compartment` | Counter id, endowments, host module graph; environment made at first execution | `rust/engine/ironhorse-vm/src/compartment.rs` |
| Guest `Compartment` | Honours `globals` and `globalLexicals`, drops `modules` and `name`; only `globalThis` and `evaluate` | `rust/engine/ironhorse-vm/src/interp/natives/compartment.rs:51-180` |

"Environment" names five things: the compartment environment, the `with`/eval register, the
`EnvReference` kind, the closure environment instance, and `global_env` (a global object).
ECMA's function Environment Record is not reified.
The global object's `[[Prototype]]` is null; bare-name lookup patches around it (PROP-7, medium).

**Modules.**
The MODULE opcode runs one self-contained module body and halts `NotImplemented` on imports,
re-exports, `import()`, `import.meta` and top-level await
(`rust/engine/ironhorse-vm/src/interp/dispatch.rs:4843-4945`).
`rust/engine/ironhorse-vm/src/module.rs` models CyclicModuleRecord over primitive values, but the
interpreter never consults it (BOOT-7, medium).
The guest `Compartment` lacks `import`, `importNow` and `ModuleSource` (BOOT-8, medium).

**Host API.**
`rust/engine/ironhorse-vm/src/lib.rs` is `#![forbid(unsafe_code)]` and exports `Interp`, the raw
`Slot` and arena types, `Machine` and `Compartment`.
Host callables are named ABI services with scoped `HostCallContext` access
(`rust/engine/ironhorse-vm/src/interp/host.rs`); endo registers none
(`rust/endo/src/ironhorse_engine.rs:1307-1311`).

### 7. Persistence

One logical image has two encodings, kept byte-identical by export and import
(`rust/engine/ironhorse-snapshot/src/store.rs:2597-2643`).

| Encoding | As built | Location |
|---|---|---|
| Container | `XS_M` atom of `[size][FourCC][payload]` atoms in a canonical order of 38 tags; format 26 written, 1 to 26 read | `rust/engine/ironhorse-snapshot/src/format.rs:185`, `:246-254` |
| Slot record | 20 B on the wire; NaNs canonical; `HEAP` includes free records, `BLOC` is the raw chunk arena | `rust/engine/ironhorse-snapshot/src/slot_codec.rs:9-34` |
| Paged store | 256-slot pages, 64 KiB extents, free-list segments, page-edge summaries, 34 small sections, manifest at schema 38 | `rust/engine/ironhorse-snapshot/src/store.rs:437-495` |

**Codecs.**
One macro roster of 34 sections declares capture, gates, restore, codec, atom and slot-visit
class (`rust/engine/ironhorse-snapshot/src/snapshot_roster.rs:12-2817`).
VM rows carry `ROW_SCHEMA_VERSION = 6` (`rust/engine/ironhorse-vm/src/snapshot_api.rs:11`), and
`SIGN` binds a container to the boot fingerprint.

**Gates and validation.**
The persist gate requires quiescence, then refuses linking modules, the `$262` host, live guest
compartments and unpersistable functions (`rust/engine/ironhorse-vm/src/interp/persist.rs:578-766`).
The streamed bytes are a function of arena history, free records included.
`read_machine` (`rust/engine/ironhorse-snapshot/src/image.rs:5359-5442`) checks atoms, version and
signature, decodes, range-checks references, runs the gate chain and, from format 16, requires
canonical re-encoding; a `RestoreSession` then admits 25 row sets
(`rust/engine/ironhorse-vm/src/interp/restore.rs:47-345`).
HEAP record contents and meter counters are not validated at adoption (SNI-1 to SNI-4, medium).
The side-table ledger (`rust/engine/ironhorse-snapshot/src/sidetable.rs`) classes each VM table as
serialized, boot-derived or never stored; nothing is pending.

**Checkpoints and stores.**
`checkpoint_to_store_core` (`rust/engine/ironhorse-snapshot/src/machine.rs:1046-1243`) checks
quiescence and epoch pairing, then commits dirty pages, extents, sections and free segments.
The shared-Machine path re-extracts and hashes the whole small state every time (SNS-1, medium),
and each bulk table is one section (SNS-2, medium).
`HeapStore` (`rust/engine/ironhorse-snapshot/src/store.rs:1449-1616`) offers point reads and one
verified batch commit; content is trusted and never checksummed.
`FileStore` rewrites the whole file and renames it; `SqliteHeapStore` uses WAL,
`synchronous=FULL` and one transaction per commit
(`rust/endo/ironhorse-store-sqlite/src/lib.rs:287-496`, `:1106-1264`).
Lazy resume faults pages in on demand (`rust/engine/ironhorse-snapshot/src/machine.rs:1434-1532`),
and damaged rows panic untyped (SNS-4, medium).
Migration walks schemas 5 to 38 over manifest and small state, then writes once by
compare-and-swap (`rust/engine/ironhorse-snapshot/src/store.rs:1679-1741`).

### 8. Embedding and verification

| Lifecycle | As built | Production caller |
|---|---|---|
| Ephemeral endo `Machine` (`rust/endo/src/ironhorse_engine.rs:680-814`) | Per evaluation: discard jobs, collect, fresh meter, Eval goal, new compartment; no rewind | `endor run -e ironhorse` (`rust/endo/src/bin/endor.rs:143-151`), on the main thread |
| `PersistentMachine` (`rust/endo/src/ironhorse_engine.rs:987-1852`) | SQLite store; checkpoints each crank; rewinds on any non-completing halt | None: tests and a test-only trait |
| Thixotrope worker (`rust/thixotrope-ironhorse-worker/src/main.rs`) | Standalone `Interp` and `StoreSession`; Script goal; checkpoints each crank; any halt is fatal | The worker binary |

The Eval and Script goals give the two embedders different top-level semantics (INT-9, low).
Raw `Slot` coordinates escape through `Halt::Throw` and unhandled-rejection reports.

**test262.**
`endot-ih` is differential: each verdict is agreement with the pinned XS 8.3.1 oracle, which has
no Intl and no Temporal (`rust/engine/ironhorse-262/src/xst.rs:1524`).
Each case runs a setup Script and a body Script on both engines
(`rust/engine/ironhorse-262/src/lib.rs:602`), and reasons map to six categories by prefix
(`rust/engine/ironhorse-262/src/report.rs:143`).
The nightly sweep gates 51,976 files against 1,930 committed shards; PR CI gates subsets.
Of the 51,976 files, 76.7% agree with XS; judged by test262's own assertions 82.2% pass, and
93.5% of the core ECMA-262 cases do (`lenses/test262-conformance.md`).
The categories conflate the two (T262-1, medium), and the split Scripts cause 724 artifact
failures (T262-2, medium).

**Fuzzing and oracle.**
Fourteen cargo-fuzz targets run daily (`.github/workflows/ironhorse-deep-fuzz.yml`).
Every behavioural differential runs the VM on XS-compiled bytecode; the shipped pipeline is
fuzzed only for panics (INT-6, medium).
`xs-oracle` builds 45 XS C files with two UB-removing overlays and a shim that serializes machine
creation with a mutex (`rust/engine/xs-oracle/csrc/xs_shim.c:293-311`).

### Where the code departs from its documentation

- `rust/engine/ARCHITECTURE.md:268-269`: "paged collection" in production; the daemon calls
  `full_collect` (`rust/endo/src/ironhorse_engine.rs:1657`).
- `rust/engine/ARCHITECTURE.md:127`: the worker owns the shared Machine; it drives a standalone
  `Interp` (`rust/thixotrope-ironhorse-worker/src/main.rs:5`).
- `rust/engine/ARCHITECTURE.md:27`: embedders install `ironhorse-runtime`; the worker has its own
  adapter (INT-13).
- `rust/engine/ARCHITECTURE.md:349-353`: names guest string and symbol keys as the namespace's
  draw; omits index keys and never-reused symbol ids (PROP-1, PROP-2).
- `rust/engine/ironhorse-vm/src/lib.rs:13-14`: each Compartment retains a Realm; there is one Realm
  per machine.
- `rust/endo/src/ironhorse_engine.rs:694`: a fresh Realm per evaluation; only the global is fresh
  (INT-4).
- `rust/engine/ironhorse-vm/src/value.rs:455-456`: `Kind` mirrors XS order; only for 0 to 5 and 10,
  and `Kind` is persisted.
- `rust/engine/ironhorse-vm/src/property_index.rs:2`: only long chains indexed; any chain past 32
  nodes is (PROP-3).
- `rust/engine/ironhorse-vm/src/interp/dispatch/iteration.rs:74-75`: `for await` awaits values; it
  does not (CORE-2).
- `rust/engine/ironhorse-vm/src/interp/suspend.rs:1152-1156`: describes XS's `constructor` check;
  the fast path never reads `constructor` (FN-5).
- `rust/engine/ironhorse-vm/src/interp/realm.rs:247-248`: no guest Compartment; one exists
  (BOOT-8).
- `rust/engine/ironhorse-snapshot/src/format.rs:286`: `VERS` begins `ENDR`; the magic is `IRON`.
- `rust/engine/ironhorse-snapshot/src/store.rs:26`: 32 small-state sections; there are 34 since
  schema 37.
- `rust/engine/ironhorse-vm/src/interp/persist.rs:561-563`: O(dirty) checkpoint gate; its scans are
  O(heap) (SNS-3).
- `rust/engine/ironhorse-262/src/report.rs:102-106`: Skipped means never attempted; most Skipped
  rows ran (T262-1).
- `rust/engine/ironhorse-262/src/xst.rs:33-36`: mirrors XS's `gxFeatures`; skips tail calls, which
  XS implements (T262-8).
- `rust/engine/ironhorse-vm/src/interp/metering.rs:86-92`: claims per-site oracle agreement for the
  key-allocation remainder; it is charged on every creation under a non-default name, where XS
  pays it once per name (COV-18).
- `rust/engine/ironhorse-vm/src/interp/dispatch/environment.rs:251-261`: cites an
  `oracle_loses_with_reference` exclusion that exists nowhere in the repository's history (COV-4).

## Findings by theme

Each theme states the defect class, then lists its findings with their verified final
severity.
A finding's full write-up, probe and recommendation are in its lens report and its region
map; the [finding index](#finding-index) lists every finding.
Where two maps found the same defect, the theme lists the primary ID and names the other.

### 1. Compartment isolation on the SES-shim path

| ID | Severity | Finding |
|---|---|---|
| CMP-1 (same defect: FN-9) | critical | `Function`, `GeneratorFunction`, `AsyncFunction` and `AsyncGeneratorFunction` concatenate parameter and body text and evaluate the result as one program |

`create_dynamic_function` (`rust/engine/ironhorse-vm/src/interp/eval.rs:323-380`) builds
`(<head> anonymous(<params>\n) {\n<body>\n})` and evaluates it, with no FormalParameters or
FunctionBody goal.
A body such as `}); <code>; (function(){` runs `<code>` at construction time.
On IronHorse-native compartments that is a spec divergence: each compartment's `Function` is
homed to its own global.
On the deployed thixotrope worker it is an escape.
The worker bundles the ordinary `ses` shim
(`packages/thixotrope/scripts/bundle-ironhorse-worker.mjs:14`), and the shim's compartment
`Function` validates guest text by calling the start compartment's original `Function` on the
parameters alone and on the body alone (`packages/ses/src/make-function-constructor.js:47-50`).
On IronHorse those validation calls run the injected statements against the start-compartment
global, where the worker's host functions are bound.
Reproduced by this review:

```text
ironhorse-xst: Error: validated | validated | leak1=start-compartment-only | leak2=start-compartment-only
node:          Error: body:SyntaxError | params:SyntaxError | leak1=undefined | leak2=undefined
```

Until the compiler gains FormalParameters and FunctionBody goals (or the assembled source is
checked to be exactly one function expression whose spans match the inputs), the SES shim on
IronHorse is not a sandbox.

The native compartment path (a host driving a bare `Interp`, without `Machine::new`'s frozen
graph) has two isolation gaps of its own, found by the coverage review:

| ID | Severity | Finding |
|---|---|---|
| COV-5 | medium | Functions created before the first guest `Compartment` stay unhomed for life: called from a child compartment they read and write the child's globals, even after `lockdown()` |
| COV-16 | low | A compartment's own `eval`, `Function` and `Compartment` are never frozen, even when it is created after lockdown, including on the frozen `Machine::new()` |

BOOT-8 (theme 7) records what the guest `Compartment` surface lacks.

### 2. Determinism: lazy intrinsic installation

| ID | Severity | Finding |
|---|---|---|
| BOOT-1 | high | A resumed machine diverges from its live twin: the unpersisted `pending_surfaces` set gates a machine-wide install pass on the define path |
| BOOT-3 | high | Every novel runtime string key runs a whole-roster install pass: about 130 to 290 µs of unmetered host work per key |
| BOOT-2 | medium | Lazily installed members are observably absent on paths that intern a name without an install pass |
| BOOT-4 | medium | Every computed string-key operation runs about 70 allocating hash lookups of catch-up |
| PROP-4 | medium | The same catch-up costs about 9 to 10 µs per `o[k]`, 10 to 50 times a static read |
| BOOT-5 | medium | Crank relink cost grows with the never-shrinking name table |

Built-in prototype members are recorded in rosters at boot and installed when their name is
first interned at or below a persisted floor (`rust/engine/ironhorse-vm/src/interp/link.rs`).
The define path runs the machine-wide install pass only while the holder is in
`pending_surfaces` (`rust/engine/ironhorse-vm/src/interp/property/ordinary.rs:260-265`), a set
that is deliberately not persisted.
A machine that has completed a holder and its twin restored from a snapshot therefore take
different paths for the same guest operation.
Live and resumed machines differ in both result and computrons.
Pass 2 rated it high rather than critical because the shipped consensus configurations freeze
the intrinsics first (`Machine::new` hardens them, and a frozen holder returns early from the
install pass), so the divergence needs an extensible roster holder, as on a bare `Interp`.
The comments that justify not persisting the set (`completing a complete surface again changes
nothing`) are false, and nothing else prevents a future configuration from reaching it.
The design note that the most recent commits added (`designs/ironhorse-intrinsic-fault-in.md`)
proposes the persisted per-holder bit the fix needs.

### 3. Resource bounds that do not bound

The engine's contract is that the meter bounds work and the slot and chunk ceilings bound
memory.
Four families of findings break it.

**3a. No reclamation within a crank.**
The only exact collector runs at quiescence (`rust/engine/ironhorse-vm/src/interp/gc.rs:6-14`),
and allocation pressure never triggers it, so the ceilings bound cumulative allocation, not
the live set.

| ID | Severity | Finding |
|---|---|---|
| INT-1 | high | The thixotrope IronHorse worker never collects at all, so garbage is checkpointed and a long-lived vat eventually halts every large crank |
| NVAL-3 | high | `s += c` exhausts the 256 MiB chunk ceiling after about 16,400 appends: flat strings, four copies per `+` |
| MEM-1 | medium | A crank whose total allocation exceeds a ceiling halts uncatchably: 499,449 `{a: i}` objects, 166,483 closures |
| CORE-6 | medium | String literals and closures allocate per evaluation; garbage-only loops exhaust the heap |
| FN-12 | medium | Each `await` of a non-promise allocates a capability that cannot be reclaimed within the crank |

**3b. Host memory outside every ceiling.**
The side ledger charges only arrays, index properties, collections and Intl segments to the
chunk ceiling (`rust/engine/ironhorse-vm/src/interp/side_ledger.rs:13-31`).

| ID | Severity | Finding |
|---|---|---|
| FN-2 | high | Error frame capture: 20 errors at depth 200 pin about 390 MiB of host memory |
| FN-3 | high | Function, promise, activation and bound-argument tables; one bound function can hold 24 MB |
| MEM-3 | high | Bound arguments, DisposableStack records, FinalizationRegistry cells: 185 MiB held by 3,116 slots under the 128 MB profile |
| NOBJ-6 | high | FinalizationRegistry cells: 12 million registrations reach 372 MB RSS and complete |
| RGX-4 | high | Compiled RegExp programs; `\p{RGI_Emoji}` under `v` compiles to 257,716 bytes per instance |
| CMP-2 | high | Compile-time host memory is 220 to 345 times the source, allocated infallibly |
| CORE-5 | high | Spread into a native call grows the value stack without bound; the XS stack model is checked only at user-frame entry |
| COV-3 | high | Every crank renders its completion value, and every uncaught throw, into an unbounded host `String` outside both ceilings; arrays that share children render exponentially, after the meter has stopped |

**3c. Work charged far below its cost.**
Each of these lets a guest buy orders of magnitude more host time per computron than ordinary
code (the reviewers' baseline was about 42 ns per computron), so a computron budget sized for a
time slice no longer bounds wall time.

| ID | Severity | Operation | Shape |
|---|---|---|---|
| MEM-2 | high | collection over accessor, private-field and WeakMap state | quadratic, unmetered; 32k getter objects make one collection take 27 s |
| MEM-4 | high | TypedArray `fill`, `reverse`, element stores, default `sort` | 16M-element fill: 3.5 s for 282 computrons |
| NOBJ-2 | high | TypedArray default `sort` | insertion sort, Θ(n²) for O(n) computrons |
| MEM-5 | high | WeakMap/WeakSet `delete`, FinalizationRegistry `unregister` (same defect: NOBJ-4 b, c) | O(n) per call charged O(1) |
| NOBJ-3 | high | Set `union`/`intersection`/`difference`/`symmetricDifference`, `groupBy` | linear-list dedupe, O(n·m) unmetered |
| NOBJ-4 | high | dense `splice`, `Array.prototype.toString` fallback | about 27,000 times the baseline per computron at n = 200k |
| NVAL-1 | high | `String.prototype.includes`, `indexOf`, `lastIndexOf` | naive O(n·m) scan; `includes` charges a constant |
| NVAL-2 | high | BigInt `*`, `/`, `%`, decimal rendering and parsing | quadratic work, linear charge applied after the work |
| RGX-5 | high | every RegExp `exec` | re-encodes the whole subject, uncharged; global loops O(n·m) |
| BOOT-3 | high | first use of a computed string key | whole-roster install pass |
| PROP-3 | high | `delete` then insert on an object with more than 32 properties | property index rebuilt whole, unmetered |
| NOBJ-5 | medium | default `Array.prototype.sort` | copies both operands' strings per comparison |
| CORE-10 | medium | block exit through `UNWIND`/`CATCH` | O(frame bindings) inside one metered dispatch |
| CMP-5 | medium | cover-grammar conversions | deep clone per nesting level, unmetered |
| FN-16 | low | `for-in` | four unmetered copies per yielded key |
| NVAL-15 | low | `JSON.stringify` replacer array | O(n²) dedupe |
| COV-6 | medium | appending a closure capture | O(k²) chain walks for O(k) computrons per closure of k captures |
| COV-3 | high | rendering the crank's completion value | O(2^n) for an n-level DAG of arrays, after the meter stops |

**3d. Limits reported as uncatchable halts.**
A deterministic, guest-reachable limit should surface as a catchable error.
These surface as host stops that end the crank:

| ID | Severity | Finding |
|---|---|---|
| RGX-1 (same defect: T262-7) | high | A greedy regexp over more than 65,536 iterations halts `HeapExhausted`: `/^a+$/.test('a'.repeat(66000))`; 452 test262 cases |
| FN-10 | medium | User-function argument limit about 2,025, halting uncatchably |
| NOBJ-10 (same defect: FN-13) | medium | Hard 1,000,000-step caps in iterator loops and Promise combinators halt `StepLimit` |
| FN-14 | medium | 126 async or about 50 to 70 `yield*` levels halt |
| NVAL-13 | medium | JSON nesting beyond 2,048 levels halts `ReentryLimit` |
| NOBJ-11 | medium | 2^24 length caps halt `Refused` on sparse Arrays |
| CMP-3 | medium | Lexical declarations in class static blocks halt `NotImplemented` through eval and `Function` |
| CMP-8 | medium | Flat chains past about 2,040 terms and nests past about 90 levels are refused |
| NVAL-9 (same defect: ONT-7) | medium | One "too large" condition is classified five different ways, several uncatchable |

### 4. The 16-bit property-key namespace

| ID | Severity | Finding |
|---|---|---|
| NOBJ-1 (same defect: PROP-1, ONT-2) | high | Generic, reflective and write paths intern every integer index as a permanent property name |
| PROP-2 (same defect: ONT-34) | medium | The roughly 64.4k lifetime budget is never reclaimed: collected symbols, eval identifiers, JSON keys |
| BOOT-5 | medium | Relink cost grows with the name table |
| INT-4 | low | The ephemeral endo `Machine` shares one key table across "fresh" realms; exhaustion reports as `Decode(InvalidSymbols)` |
| CMP-11 | low | One compile unit may use at most 65,534 distinct names |

Keys are `u16` ids into a persisted, monotone name table.
Reads keep array indices as `ReadKey::Index`, but writes, reflective operations, Proxy traps and
generic `Array.prototype` methods intern the decimal string.
A persistent vat that runs ordinary holey-array code accumulates index names until guest key
minting throws `RangeError`, permanently.

### 5. Host panics and containment

| ID | Severity | Finding |
|---|---|---|
| CORE-1 | high | `x--` on the integer −2,147,483,648 panics (`dispatch.rs:3913-3921`; release builds keep `overflow-checks`) |
| INT-2 | medium | Guest-reachable panics escape `Machine::eval` and `PersistentMachine::eval` without a rewind; a caller that survives the unwind can commit partial writes |
| SNS-4 | medium | Damaged row content under a lazy fault is an untyped `String` panic |
| SNI-2 | medium | A crafted chunk offset gives wrong answers and then a host panic |
| SNI-3 | medium | A crafted meter index panics on the first dispatched instruction |
| CORE-14 | low | A crafted `*_4` instruction length overflows on wasm32 |

`run_shared_outcome` converts only the two memory payloads into halts and re-raises every other
panic (`rust/engine/ironhorse-vm/src/interp.rs:2983-2991`).
CORE-1 needs only `var a = 1 << 31; --a;`.

### 6. Wrong guest-visible results

**Language and async semantics.**

| ID | Severity | Finding |
|---|---|---|
| CORE-2 (same defect: FN-1) | high | `for await` and async `yield*` over sync iterables lack `%AsyncFromSyncIteratorPrototype%`: values are not awaited, user iterables throw; about 115 test262 files |
| NOBJ-NEW-1 | high | Array fast paths copy a `const` binding's non-writable flag into the stored element: `out.push(v)` of a `const` local makes `out[0]` non-writable |
| ONT-3 | high | `Function.prototype.apply` copies frozen array elements' attribute flags into the callee's `arguments` object and rest array (the same `Slot`-as-record root as NOBJ-NEW-1) |
| ONT-5 | medium | Promise jobs record no realm or environment: a reaction handler with no home environment runs against whichever compartment the pump is in |
| NOBJ-8 | high | `AsyncDisposableStack.prototype.disposeAsync` neither awaits disposers nor propagates rejections |
| CMP-4 | medium | `for (using … of …)` disposes the last resource twice and swallows a throwing disposer |
| CMP-6 | medium | With parameter expressions, a body `var` that redeclares a parameter shares its binding |
| COV-1 | high | `new` on a bound function whose target lives in another code segment enters the target's body offset in the caller's bytecode: an uncatchable halt or the wrong code runs |
| COV-4 | medium | Object environments skip SetMutableBinding's HasProperty re-check and global references resolve after the right-hand side, so a deleted binding never raises the strict `ReferenceError`; the comment cites an oracle exclusion that does not exist |
| COV-10 | low | `await` in a module-level class heritage halts `EngineInvariant` instead of the top-level-await refusal |
| COV-15 | low | Direct eval takes its early-error context from XS's flags, not PerformEval: `eval('super()')` in a derived constructor and `eval('new.target')` in methods throw `SyntaxError` |
| T262-2 (same defect: ONT-15) | medium | Top-level `let`/`const`/`class` are not shared across Scripts (GlobalDeclarationInstantiation) |
| FN-4, FN-5, FN-7, FN-8 | medium | Promise adoption, the `await` fast path, async-generator completion and native `finally` take a different number of ticks than the spec |
| FN-6 | medium | `Promise.any` with synchronously rejecting thenables rejects with an empty `errors` array |

**Property model and objects.**

| ID | Severity | Finding |
|---|---|---|
| ONT-6 (same defect: CORE-3, RGX-2, NVAL-4, NOBJ-9) | high | RegExp, Temporal, `Intl.Locale`, `Collator.compare` and `disposed` accessors exist only as `GET_PROPERTY` interceptions: `o[k]`, `Reflect.get`, `in`, descriptors and the engine's own Temporal natives see nothing |
| CORE-4 (same defect: PROP-7, ONT-17) | medium | The global object's `[[Prototype]]` is null; identifier resolution consults a hard-wired `%Object.prototype%` |
| PROP-5 | medium | A Proxy's callability is recomputed per call |
| PROP-6 | medium | `%Object.prototype%` is not an immutable-prototype object |
| PROP-8 | medium | Built-in iterators reuse one result object with non-writable fields |
| COV-2 | high | In strict code, a computed-key write whose `[[Set]]` is rejected (frozen, sealed, non-writable, getter-only, non-extensible) completes silently |

**Built-ins, Intl and Temporal.**

| ID | Severity | Finding |
|---|---|---|
| NVAL-6 | high | Time zones are fixed offsets at standard time: DST ignored, valid summer offsets rejected, all but 22 IANA zones refused |
| NVAL-5 | medium | `Intl.Collator` and `localeCompare` are not UCA |
| NVAL-7 | medium | Temporal is an outdated, lax subset (43.9% of `built-ins/Temporal`), unmetered |
| NVAL-8 | medium | Locales reported as supported are formatted with English data |
| NVAL-10, NVAL-11, NVAL-12 | medium | `JSON.parse` accepts `\u+XYZ`; `parseInt` and `Number('0x…')` double-round; `Math.fround`, `hypot`, `round` wrong on reachable inputs |
| ONT-12 | medium | `parseInt('-0')` returns +0: of three copies of the f64-to-integer fold, only `parse_int`'s omits the −0 guard |
| ONT-13 | medium | Same-type TypedArray construction routes raw element bytes through Number slots, canonicalizing NaN payloads |
| NOBJ-12 | medium | `%TypedArray%.prototype.toSorted`, `toReversed` and `with` are missing |
| NOBJ-13 (same defect: ONT-9) | medium | Symbols as weak keys are refused, two different ways |
| COV-8 | low | Non-unicode `/i` canonicalization equates 27 Greek iota-subscript pairs |
| COV-12 | low | `%StringIteratorPrototype%` does not exist; string iterators share `%ArrayIteratorPrototype%` |
| COV-19 | low | `using` and `DisposableStack.prototype.use` accept primitives, and the async forms fall back to `@@dispose` when `@@asyncDispose` is present but not callable |

### 7. Features skipped or refused

| ID | Severity | Feature |
|---|---|---|
| BOOT-7 | medium | Modules: only self-contained bodies; `import`, re-exports, `import()`, `import.meta` and top-level await halt `NotImplemented` (786 test262 cases unsupported) |
| BOOT-8 | medium | Guest `Compartment` lacks `import`, `importNow` and `ModuleSource` and drops `modules` |
| NOBJ-14 (T262-4; same defect: ONT-11) | medium | `Atomics.wait`, `notify`, `waitAsync` halt `Refused` before validation |
| CMP-3 | medium | Lexical declarations in class static blocks |
| FN-18 (T262-8) | low (medium as T262-8) | Proper tail calls (XS implements them; the harness skips the 35 cases) |
| CMP-12 | low | Annex B sloppy syntax refused with a "(strict code)" message |
| T262-9 | low | `$262.createRealm`, `evalScript`, `agent`, `gc` and `IsHTMLDDA` are absent (`cross-realm` passes 1%) |
| COV-11 | low | `RegExp.prototype.compile` is present but a no-op (21 test262 cases) |
| COV-13 | low | `%IteratorPrototype%[@@dispose]` and `%AsyncIteratorPrototype%[@@asyncDispose]` are missing |
| COV-14 | low | The `Error.prototype.stack` setter performs none of the error-stack-accessor proposal's checks |

The [skipped-features lens](lenses/skipped-features.md) inventories every refusal site, with
spec status, test262 cases affected and effort.

### 8. Persistence

| ID | Severity | Finding |
|---|---|---|
| SNI-1 | medium | A crafted container with a prototype cycle is adopted; lookups then spin inside one instruction |
| SNI-4 | medium | HEAP record shapes and own-property cycles are not validated |
| SNI-5 | medium | Duplicate-atom detection is O(n²) and runs before every gate |
| SNI-6 | medium | The FUNC gate re-walks every function body: O(rows × body) |
| SNI-7 | medium | Eager restore peaks near 4.7 times the container size |
| SNI-8 | medium | Freed slot records are written into every container forever |
| SNS-1 | medium | Shared-Machine checkpoints re-extract, encode and hash the whole small state every time |
| SNS-2 | medium | Each bulk side table is one section, so an O(1) change rewrites the table |
| SNS-3, SNS-5 to SNS-13 | low | Store bookkeeping, classification and backend details (see the map) |

Containers "can come from elsewhere" and must be validated before adoption
(`rust/engine/ARCHITECTURE.md:236`); SNI-1 to SNI-4 show validation weaker than restore assumes.
Pass 2 lowered them from high to medium: a container is host-supplied, not guest input (a guest
cannot build a prototype or own-property cycle), and no production daemon path adopts
containers; only import tooling, the surgery example and the wasm spike do.
They remain contract violations for any host that imports a container it did not write.

### 9. Performance and memory overhead

| ID | Severity | Finding | Measured |
|---|---|---|---|
| MEM-6 (NOBJ-15) | medium | Per-object state in SipHash side tables and per-array `BTreeMap`s | pending promise about 1.5 KB, closure about 430 B, array item 55.6 B; node 57, 105 and 6.8 B |
| CORE-11 | medium | `Slot` carries two type tags | 24 B where 16 would do |
| CORE-12 (FN-15) | medium | Every function instance allocates a dead default prototype; its name is stored three times | |
| MEM-7 | medium | Memory is never returned after collection | 75 to 185 MB retained at boot-size live sets |
| CORE-7 | medium | User-call overhead | about 1,600 instructions of SipHash and five malloc/free pairs per call |
| CORE-8 | medium | Every `o.k` read builds a `SymbolName` for `"disposed"` and probes about 13 side tables | |
| CORE-9 | medium | No integer fast path for `+`, `-`, `*`, `<`; every opcode decoded twice | |
| FN-11 | medium | Per-activation `id_map` hash map, copied inside every `try` | |
| BOOT-6 | medium | `Machine::new` rebuilds and hardens the realm; a shared restore builds two more machines only to validate | 38 to 90 ms (load-dependent) and about 523 KB per machine |
| PROP-10 | low | Key lookups allocate and SipHash | |
| MEM-8 | low | Chunk compaction never coalesces across extents | |

The [performance and memory lens](lenses/memory-performance.md) ranks the opportunities.

### 10. Duplicated code

The mechanical clone scan finds little verbatim copying: 3.9% of normalized source lines are
in exact clones and 6.8% in literal-normalized clones.
The structural duplication is larger and has already produced bugs: parallel built-in
registration tables (BOOT-10: five to nine lists per method), hand-copied `[[Get]]`/`[[Set]]`
walks and by-index twins (PROP-11, which is how PROP-1 arose), four suspension drivers (FN-19),
three GetSubstitution implementations (RGX-7), persistence validation repeated across decoder,
roster and restore (SNI-11), per-row GC knowledge written three times (MEM-9), and compiler/VM
numeric helpers copied across crates (CMP-13), including `number_to_ecma_string`
(`rust/engine/ironhorse-compile/src/parser.rs:2357` and `rust/engine/ironhorse-vm/src/value.rs:3062`).
One copy has drifted from its source without anyone noticing: `DEFAULT_KEYS`, the hand-kept copy
of XS's boot key table that decides key-allocation charges, matches neither configuration of the
oracle build it says it was generated from (COV-17, low).
The [duplication lens](lenses/duplication.md) lists 14 families with sizes and divergence.

### 11. Ontological consistency

The ontology lens asked whether each concept the engine names is defined once, named the same
way everywhere and classified the same way at every site, and whether the engine's model
matches ECMA-262's where a guest can tell.
Six finders, each over one modality, produced 44 candidates; 34 remained after merging, 32
survived two-pass verification and 2 were refuted.
Eight of the survivors are the same defects that region maps found (ONT-2, ONT-7, ONT-8, ONT-9,
ONT-11, ONT-15, ONT-17, ONT-34); ONT-6 became the primary for the brand-shortcut defect, because
its verifiers established consequences the region verifiers had not tested.

| ID | Severity | Finding |
|---|---|---|
| ONT-6 | high | Built-in accessors exist only as `GET_PROPERTY` interceptions; the engine's own Temporal conversions throw (`Temporal.PlainYearMonth.from(plainDate)`), `'flags' in re` is false, and 86 of the 88 `built-ins/RegExp` failures follow |
| ONT-3 | high | `Slot` conflates a JS value with a property record, so `apply` carries frozen elements' attribute flags into `arguments` |
| ONT-5 | medium | Jobs record no realm or environment |
| ONT-12, ONT-13 | medium | Integer folding and TypedArray copying lose `-0` and NaN payloads |
| ONT-19 | medium | `EnvironmentId` and `HostRootId`, documented as stable lineage identifiers, are raw slot indices that collection reuses, in one forgeable number space |
| ONT-21 | medium | No gate identifies the persisted bytecode ISA; the alphabetical opcode enum renumbers on any insertion |
| ONT-1, ONT-10, ONT-25, ONT-26, ONT-27, ONT-28 | low | Halt and refusal classes misapplied: the regexp state cap reported as `HeapExhausted`; `Halt::Decode` covering compiler gaps, panics, relink refusals and malformed bytecode; deliberate refusals filed as `NotImplemented`; `HostAllocationFailed` treated as deterministic; no "unsupported" ledger class; README naming the wrong halt |
| ONT-20, ONT-22, ONT-32, ONT-33 | low | Version identifiers that do not identify what they claim: `INTL_DATA_VERSION` hashes only the ICU lockfile graph; `ROW_SCHEMA_VERSION` fingerprints two files while most rows are bare tuples; `VERS` does not identify content for formats 25 and 26; the migration ladder sits behind a gate that moves with every built-in |
| ONT-14, ONT-16, ONT-29 | low | Spec-model gaps: shared constructors compile against the calling compartment; `Compartment.prototype.evaluate` is a strict eval program, not a Script; module records lack `[[EvaluationError]]` |
| ONT-23, ONT-24, ONT-30, ONT-31 | low | Vocabulary and documentation: "completed" and "crank" mean two things; "Realm" names three; one sentinel has three documented meanings; the identifier table gives format 24, store 36 and row 5 where the code has 26, 38 and 6 |

Three patterns run through these.
The `Halt` taxonomy has the right shape but no single classifier, so the same condition is
classified differently at different sites, and the test262 report inherits the confusion.
The `Slot` type serves as both a value and a property record, so attribute flags leak into
values (ONT-3, NOBJ-NEW-1), and indices and names share one key space (NOBJ-1).
And the identity scheme for persisted state misses facts that change what a resumed heap means:
the bytecode ISA, most row shapes, and in-tree Intl behaviour.

ONT-4 was refuted for a reason that matters to the whole method.
Its evidence came from a modified copy of the engine that a verifier built into the audit's
shared Cargo target directory; Cargo keys a path package by its workspace-relative path, so the
repository's own probes linked the copy's artifacts until a clean build replaced them.
The [coverage review](COVERAGE.md) re-ran in a fresh target directory the region verifications'
Rust probes that ran while the reverted copy was present, and records the outcome; JS probes
ran on the repository's own release build and were never exposed.
ONT-18 was refuted because the thixotrope worker runs SES lockdown first, which removes the
reported consequence.
The [ontology lens](lenses/ontological-consistency.md) has the glossary, every entry and the
refutations.

### 12. The verification apparatus

| ID | Severity | Finding |
|---|---|---|
| T262-1 | medium | The test262 report's categories record agreement with XS under labels that read as test262 verdicts |
| T262-5 (same defect: ONT-8) | medium | "Infrastructure — not an IronHorse gap" holds IronHorse gaps and failures, and is the default for unknown reasons |
| INT-6 | medium | The fuzz lane never compares the shipped compile-then-run pipeline with anything |
| T262-10 | low | The expectation list's mode column is wrong for 1,189 files |
| INT-7, INT-8 | low | The compiler fuzz targets never see calls or exceptions; the compile differential decides "oracle rejected" from error text |
| COV-9 | low | The async unhandled-rejection latch turns IronHorse passes into run-skips, which this review's own verdict then scored as failures (3 cases) |
| COV-7 | low | BigInt literals are rejected as property names in object literals, class elements, accessors and binding patterns |

The nightly expectation gate is consistent and currently green.
What it gates is agreement with XS, which has no Temporal and no Intl, so 6,104 of the 6,632
Temporal cases and 3,093 of the 3,357 `intl402` cases never reach a pass/fail column.
The shards also accept, as expected failures, 45 cases that IronHorse fails and XS passes, for
which no finding existed until the coverage review (COV-2, COV-4, COV-12, COV-13); that class
should be a triage queue rather than a baseline.

## Program of work

The order follows consequence first and cost second.
Each step names the findings it closes; effort is S (days), M (one to three weeks) or L (more).
Steps that change persisted bytes need a format or schema bump and a migration or refusal, as
`rust/engine/ironhorse-snapshot/src/versions.rs` prescribes.

### Step 1: close the escape and the panics (S)

1. Give `CreateDynamicFunction` real FormalParameters and FunctionBody goals, or require the
   assembled source to be exactly one function expression whose parameter and body spans match
   the inputs; add regressions for the body-close, parameter-close, comment-span and comma shapes
   in all four constructor kinds.
   Tell the SES maintainers that the shim on IronHorse is not a sandbox until this lands.
   Closes CMP-1 (FN-9).
2. Replace the decrement boundary test with `checked_sub` (CORE-1); bound `*_4` instruction
   lengths on 32-bit targets (CORE-14).
3. Strip binding attributes from every slot an array fast path stores (NOBJ-NEW-1), and read
   element values through `array_item_value` wherever a record is copied into a value, as
   `apply` and `arguments` construction do not (ONT-3).
4. Contain panics at `Machine::eval` and `PersistentMachine::eval`: catch, rewind to the last
   checkpoint, and poison the machine (INT-2); type the lazy-fault panic (SNS-4).
5. Guard bound construction across code segments: compare the target's segment with the active
   one in `enter_construct_bound` and fall back to the cross-segment entry, as the call and
   apply trampolines already do (COV-1).
6. Treat crank-boundary rendering as budgeted host work: cap the rendered length, count visited
   elements, render only on request, and stub non-Error thrown objects (COV-3).
7. Stop branching on unpersisted state in the define path: derive a holder's completeness from
   persisted data, or persist the per-holder bit that `designs/ironhorse-intrinsic-fault-in.md`
   proposes (BOOT-1).

### Step 2: make the bounds bound (M)

1. Charge every retained host-side row to the side ledger at a declared width, with fallible
   reservation: function, promise, activation and error rows, bound arguments, disposal records,
   finalization cells, compiled RegExp programs (FN-2, FN-3, MEM-3, NOBJ-6, RGX-4).
   Bound the value stack at native call entry (CORE-5) and compile-time memory (CMP-2).
   Keep a tail pointer for environment captures so closure creation is linear (COV-6).
2. Adopt one rule for natives: charge work proportional to what will be done, before or in
   bounded strides during the work, through a host-consulting charge.
   Replace the quadratic algorithms rather than charging for them: TypedArray sort and fill
   (NOBJ-2, MEM-4), Set methods and `groupBy` (NOBJ-3), weak deletes and `unregister` (MEM-5),
   dense `splice` (NOBJ-4), string search (NVAL-1), BigInt multiply, divide and rendering (NVAL-2),
   per-exec subject encoding (RGX-5), whole-roster install passes (BOOT-3), property-index
   rebuilds (PROP-3), and collector table scans (MEM-2).
3. Add a regression gate that measures host nanoseconds per computron for each native family
   against the interpreter baseline, so the next amplification is caught by CI rather than by a
   review.
4. Turn deterministic, guest-reachable limits into catchable errors: the regexp state cap
   (RGX-1), argument, nesting and step caps (FN-10, FN-14, NOBJ-10, NVAL-13, NOBJ-11), and
   unported syntax reached through `eval` (CMP-3); unify the "too large" classifications
   (NVAL-9).

### Step 3: reclaim within a crank and stop minting keys (L)

1. Allow collection at dispatch-loop safepoints when an allocation would cross a ceiling, with
   the interpreter's live state as roots, so ceilings bound the live set (MEM-1, CORE-6, FN-12);
   make the thixotrope worker collect (INT-1); add a rope or in-place append for string
   concatenation (NVAL-3).
2. Give the write, reflective and generic-array paths an index key form so integer indices never
   reach the name table (NOBJ-1); reuse collected symbol ids (PROP-2); decide whether 16-bit
   keys are a profile limit to keep (and document honestly) or a format to widen.

### Step 4: conformance gaps with the most users (M to L)

1. `%AsyncFromSyncIteratorPrototype%` for `for await` and async `yield*` (CORE-2).
2. The global declarative environment record for Script-goal lexical declarations (T262-2).
3. Promise and async tick ordering (FN-4, FN-5, FN-7, FN-8, FN-6), `disposeAsync` (NOBJ-8),
   `for (using …)` (CMP-4), parameter-scope `var` (CMP-6).
   Throw on rejected strict computed-key writes (COV-2) and re-check bindings in object
   environment records (COV-4).
   On the native compartment path, home pre-existing functions when compartments are enabled and
   freeze each compartment's evaluators after lockdown (COV-5, COV-16).
4. Replace the `GET_PROPERTY` brand shortcuts with real prototype accessors and methods (ONT-6,
   with CORE-3, RGX-2, NVAL-4, NOBJ-9; also RGX-3 and CORE-8), as the ArrayBuffer, TypedArray and
   DataView getters already are; give the global object its prototype (CORE-4) and make
   `%Object.prototype%` immutable-prototype (PROP-6).
   Record a realm or environment on each promise job (ONT-5).
5. Modules: imports, re-exports, `import()`, `import.meta` and top-level await on the existing
   `module.rs` model (BOOT-7, 786 test262 cases); the guest `Compartment` module surface (BOOT-8).
6. Smaller standard gaps: class static block lexicals (CMP-3), TypedArray change-by-copy
   (NOBJ-12), symbols as weak keys (NOBJ-13), single-agent Atomics (NOBJ-14), proper tail calls in
   strict code (FN-18), and the numeric and parsing defects (NVAL-10 to NVAL-16, CMP-7).
   The coverage review's low conformance items belong here too: COV-7, COV-8, COV-10, COV-11,
   COV-12, COV-13, COV-14, COV-15 and COV-19.
7. Intl and Temporal: a frozen tzdb snapshot under `INTL_DATA_VERSION` (NVAL-6), current
   Temporal (NVAL-7), real collation and locale data (NVAL-5, NVAL-8).

### Step 5: memory and speed (M)

Ranked in the [performance and memory lens](lenses/memory-performance.md).
The largest are contiguous array storage (NOBJ-15, MEM-6), moving hot per-object state out of
SipHash side tables (MEM-6, PROP-10), dropping the dead default prototype per function (CORE-12),
the call path (CORE-7, FN-11), a 16-byte `Slot` (CORE-11, a format change), integer fast paths
(CORE-9), returning memory after collection (MEM-7), and checkpoint cost proportional to change
(SNS-1, SNS-2, SNS-3, SNI-6, SNI-7, SNI-8).

### Step 6: the instruments (S to M)

1. Report test262 as two orthogonal columns, IronHorse's verdict and agreement with XS, and gate
   Temporal and Intl on the verdict (T262-1, T262-5, T262-10); give `ironhorse-xst` `print` and
   faithful error rendering (T262-11); add `$262.evalScript`, `global` and `gc` (T262-9); skip only
   real multi-agent Atomics cases (T262-4) and stop skipping tail calls (T262-8).
   Stop the async unhandled-rejection latch from turning passes into skips (COV-9), and treat the
   shards' "IronHorse failed a harness assertion the oracle passed" rows as a triage queue, not an
   accepted baseline: 45 of them had no finding until the coverage review.
2. Fuzz the shipped compile-then-run pipeline differentially (INT-6, INT-7, INT-8).
3. Validate containers as completely as the contract says (SNI-1 to SNI-5).
4. Apply the ontology lens's recommendations: one exhaustive halt and refusal classifier used
   by every site and by the harness (ONT-1, ONT-7, ONT-10, ONT-25, NVAL-9); a gate that
   identifies the bytecode ISA (ONT-21), a row-schema fingerprint over every persisted row
   (ONT-22), an identifier for in-tree Intl semantics (ONT-20), and stable environment and root
   identifiers (ONT-19); and corrected identifier documentation (ONT-31).

### Step 7: consolidate duplicated structure (M)

Generate the built-in registration tables from one source (BOOT-10), keep one `[[Get]]`/`[[Set]]`
walk (PROP-11), one suspension driver (FN-19), generated persistence validation (SNI-11) and GC
visitation (MEM-9), and a shared numeric crate for the compiler and VM (CMP-13).
Several high findings above arose where copies drifted, so this step is risk reduction, not
tidiness.

## What this review did not do

The [companion README](README.md#what-the-review-did-not-do) lists the limits of the method, and
each map lists what its reviewer did not read.
In short: the Hardened JavaScript suites and SES-mode test262 were not run; the `endo` crate was
not built (the daemon seam was exercised through its exact engine and store calls); XS memory
was estimated rather than measured; and `packages/` was reviewed only where CMP-1 depends on the
SES shim.
This review records no comparison with earlier reviews, which it did not read.

## Finding index

Every verified finding, ordered by final severity.
"Verification" is pass 1's verdict and, for findings pass 2 examined, its outcome.
Rows marked "Same defect as" were merged into the primary ID.

| ID | Severity | Verification | Finding | Source |
|---|---|---|---|---|
| CMP-1 | critical | confirmed; pass 2 upheld | Dynamic Function constructors concatenate parameter and body text and evaluate the result as one program, so injected code runs at construction time (SES escape on the shim path) | [compile](maps/compile.md) |
| FN-9 | critical | confirmed-with-corrections | Same defect as CMP-1. Function/GeneratorFunction constructors execute injected statements (no single-function check) | [vm-functions-async](maps/vm-functions-async.md) |
| BOOT-1 | high | confirmed; pass 2 lowered critical->high | Resumed machine diverges from its live twin: unpersisted pending_surfaces gates the machine-wide install pass on the define path | [vm-boot-realm-modules](maps/vm-boot-realm-modules.md) |
| BOOT-3 | high | confirmed-with-corrections; pass 2 upheld | Every novel runtime string key runs a whole-roster install pass: ~130-290 us of unmetered host work per key | [vm-boot-realm-modules](maps/vm-boot-realm-modules.md) |
| CMP-2 | high | confirmed-with-corrections; pass 2 upheld | Compile-time host memory is ~220-345x the source, uncharged against heap ceilings and allocated infallibly | [compile](maps/compile.md) |
| CORE-1 | high | confirmed; pass 2 upheld | `x--` on the Integer -2147483648 panics the host (unchecked i32 subtraction in DECREMENT) | [vm-core-dispatch](maps/vm-core-dispatch.md) |
| CORE-2 | high | confirmed-with-corrections; pass 2 upheld | `for await` / async `yield*` over a synchronous iterable has no CreateAsyncFromSyncIterator: values are not awaited, rejections are not thrown, custom sync iterables throw | [vm-core-dispatch](maps/vm-core-dispatch.md) |
| CORE-3 | high | downgraded | Same defect as ONT-6. GET_PROPERTY brand shortcuts answer `o.k` from internal state, bypassing [[Get]]; they are the only implementation of the RegExp, Temporal, Intl.Locale, Collator.compare and DisposableStack.disposed accessors, which are absent from the prototypes | [vm-core-dispatch](maps/vm-core-dispatch.md) |
| CORE-5 | high | confirmed; pass 2 upheld | Spread into a native call grows the host value stack without bound: the XS stack geometry is checked only at user-frame entry and resume | [vm-core-dispatch](maps/vm-core-dispatch.md) |
| FN-1 | high | confirmed-with-corrections; pass 2 upheld | Same defect as CORE-2. for await and async yield* over sync iterables lack %AsyncFromSyncIteratorPrototype%: values not awaited, user sync iterables rejected | [vm-functions-async](maps/vm-functions-async.md) |
| FN-2 | high | confirmed-with-corrections; pass 2 upheld | Error frame capture is unmetered host memory outside both heap ceilings (O(depth x name length) per error) | [vm-functions-async](maps/vm-functions-async.md) |
| FN-3 | high | confirmed-with-corrections; pass 2 upheld | Function, promise, activation and bound-argument side tables escape the heap ceilings | [vm-functions-async](maps/vm-functions-async.md) |
| INT-1 | high | confirmed; pass 2 upheld | The thixotrope IronHorse worker never collects garbage, so every crank's garbage is checkpointed and a long-lived vat is permanently bricked | [integration-fuzz-oracle](maps/integration-fuzz-oracle.md) |
| MEM-2 | high | confirmed; pass 2 upheld | Collection time is quadratic in guest-controlled accessor/private/WeakMap state and is not metered | [vm-memory-gc-meter](maps/vm-memory-gc-meter.md) |
| MEM-3 | high | confirmed; pass 2 upheld | Retained host storage outside every ceiling: bound arguments, DisposableStack records, FinalizationRegistry cells and per-row side-table state grow without ledger charge | [vm-memory-gc-meter](maps/vm-memory-gc-meter.md) |
| MEM-4 | high | confirmed; pass 2 upheld | TypedArray natives do unmetered superlinear work: whole-prefix dirty marking per element store, no per-element charge in fill/reverse, O(n^2) default sort with 24-byte Slot scratch | [vm-memory-gc-meter](maps/vm-memory-gc-meter.md) |
| MEM-5 | high | confirmed; pass 2 upheld | WeakMap/WeakSet delete and FinalizationRegistry.prototype.unregister are O(n) per call and charged O(1) | [vm-memory-gc-meter](maps/vm-memory-gc-meter.md) |
| NOBJ-1 | high | confirmed; pass 2 upheld | Generic Array write paths intern every element index as a persistent u16 property name, exhausting the vat's key space | [vm-natives-objects](maps/vm-natives-objects.md) |
| NOBJ-2 | high | confirmed; pass 2 upheld | Same defect as MEM-4 (sort). %TypedArray%.prototype.sort is an insertion sort: Theta(n^2) host work with O(n) computrons | [vm-natives-objects](maps/vm-natives-objects.md) |
| NOBJ-3 | high | confirmed; pass 2 upheld | Set.prototype union/intersection/difference/symmetricDifference and Map/Object.groupBy deduplicate through linear lists: O(n*m) unmetered host work | [vm-natives-objects](maps/vm-natives-objects.md) |
| NOBJ-4 | high | confirmed-with-corrections; pass 2 upheld | Parts (b) and (c): same defect as MEM-5. Per-call O(n) host work charged O(1): dense splice rebuild, WeakMap/WeakSet delete, FinalizationRegistry unregister/cleanup, Array.prototype.toString fallback scan | [vm-natives-objects](maps/vm-natives-objects.md) |
| NOBJ-6 | high | confirmed; pass 2 upheld | FinalizationRegistry cells are charged to no ceiling; repeated register grows host memory past the heap ceiling | [vm-natives-objects](maps/vm-natives-objects.md) |
| NOBJ-8 | high | confirmed-with-corrections; pass 2 upheld | AsyncDisposableStack.prototype.disposeAsync neither awaits disposers nor propagates their rejections | [vm-natives-objects](maps/vm-natives-objects.md) |
| NOBJ-9 | high | confirmed-with-corrections | Same defect as ONT-6. DisposableStack/AsyncDisposableStack `disposed` is an opcode name special case, not a prototype accessor | [vm-natives-objects](maps/vm-natives-objects.md) |
| NOBJ-NEW-1 | high | confirmed; pass 2 upheld | NEW (found while verifying NOBJ-5): array fast paths copy a const binding's DONT_SET flag into the stored element, making it non-writable | [vm-natives-objects](maps/vm-natives-objects.md) |
| NVAL-1 | high | confirmed; pass 2 upheld | String.prototype.includes runs an unmetered O(n*m) search; indexOf/lastIndexOf charge 1 raw unit (1/65536 computron) per compared unit | [vm-natives-values](maps/vm-natives-values.md) |
| NVAL-2 | high | confirmed-with-corrections; pass 2 upheld | BigInt *, /, %, String(bigint) and BigInt(string) do quadratic work for linear (or zero) charge applied after the work; `*` is uncapped while `**`, `<<`, asIntN are capped | [vm-natives-values](maps/vm-natives-values.md) |
| NVAL-3 | high | confirmed-with-corrections; pass 2 upheld | String append in a loop exhausts the 256 MiB chunk ceiling after ~16,400 single-character appends: flat strings, four copies per +, no intra-crank collection | [vm-natives-values](maps/vm-natives-values.md) |
| NVAL-4 | high | confirmed-with-corrections; pass 2 lowered high->medium | Same defect as ONT-6. Temporal getters and Intl.Collator.prototype.compare exist only on the static GET_PROPERTY opcode path; computed access, Reflect.get, Proxies and descriptors see undefined | [vm-natives-values](maps/vm-natives-values.md) |
| NVAL-6 | high | confirmed; pass 2 upheld | Time zones are fixed offsets at standard time: DST ignored by Temporal and Intl.DateTimeFormat, valid summer offsets rejected, all but 22 named IANA zones refused | [vm-natives-values](maps/vm-natives-values.md) |
| PROP-1 | high | confirmed-with-corrections; pass 2 upheld | Same defect as NOBJ-1. Integer indices (and non-index strings compared by ownKeys) are interned into the permanent 16-bit name table by write, reflective and generic paths | [vm-property-model](maps/vm-property-model.md) |
| PROP-3 | high | confirmed-with-corrections; pass 2 upheld | PropertyIndex is dropped and fully rebuilt after every delete on a long chain: O(N) unmetered host work per delete+insert (~2.6 ms at N=8000 for ~10 computrons) and ~210 B/property | [vm-property-model](maps/vm-property-model.md) |
| RGX-1 | high | confirmed-with-corrections; pass 2 upheld | Benign long greedy matches (and huge quantifier bounds) halt the whole machine with an uncatchable HeapExhausted | [regexp](maps/regexp.md) |
| RGX-2 | high | confirmed-with-corrections; pass 2 lowered high->medium | Same defect as ONT-6. RegExp.prototype accessors (source/flags/global/...) are an id-keyed GET_PROPERTY special case, not properties | [regexp](maps/regexp.md) |
| RGX-4 | high | confirmed-with-corrections; pass 2 upheld | Compiled RegExp programs live outside the chunk-heap ceiling; \p{RGI_Emoji} compiles to 257,716 bytes per instance | [regexp](maps/regexp.md) |
| RGX-5 | high | confirmed-with-corrections; pass 2 upheld | Every exec re-decodes and re-encodes the whole subject without charging it: unmetered O(n) work per exec, O(n*m) global loops | [regexp](maps/regexp.md) |
| T262-7 | high | confirmed-with-corrections; pass 2 lowered high->medium | Same defect as RGX-1. A greedy regexp loop of more than 65,536 iterations halts the program with HeapExhausted; 904 test262 case/modes are filed as an Ironhorse "limit" | [test262-harness](maps/test262-harness.md) |
| BOOT-2 | medium | downgraded | Lazily installed intrinsic members are observably absent on paths that intern a runtime name without an install pass | [vm-boot-realm-modules](maps/vm-boot-realm-modules.md) |
| BOOT-4 | medium | confirmed | Every computed string-key operation runs ~70 allocating hash lookups in the global catch-up, making o[k] ~10x slower than o.k | [vm-boot-realm-modules](maps/vm-boot-realm-modules.md) |
| BOOT-5 | medium | confirmed-with-corrections | Crank relink cost grows with the never-shrinking name table (tens of ms per crank at 50,000 runtime keys) | [vm-boot-realm-modules](maps/vm-boot-realm-modules.md) |
| BOOT-6 | medium | confirmed-with-corrections | Machine::new rebuilds and hardens the whole realm each time (tens of ms); a shared-machine restore builds two more reference Machines only to validate | [vm-boot-realm-modules](maps/vm-boot-realm-modules.md) |
| BOOT-7 | medium | confirmed-with-corrections | Module execution is limited to self-contained module bodies; ModuleGraph is an unconnected host-side model with no errored state | [vm-boot-realm-modules](maps/vm-boot-realm-modules.md) |
| BOOT-8 | medium | confirmed-with-corrections | Guest Compartment lacks import/importNow and ModuleSource, drops the modules option, and lockdown omits the compartment-global Date/Math template; realm.rs still says no guest Compartment exists | [vm-boot-realm-modules](maps/vm-boot-realm-modules.md) |
| CMP-3 | medium | downgraded | Class static blocks: direct declarations are refused (uncatchable halt through eval/Function/Compartment.evaluate) and all blocks of a class share one scope | [compile](maps/compile.md) |
| CMP-4 | medium | confirmed; pass 2 lowered high->medium | for (using ... of ...) disposes the last resource twice and swallows a throwing per-iteration disposer | [compile](maps/compile.md) |
| CMP-5 | medium | confirmed | Cover-grammar conversions deep-clone subtrees per nesting level without charging the meter | [compile](maps/compile.md) |
| CMP-6 | medium | confirmed | With parameter expressions, a body var that redeclares a parameter shares the parameter's binding | [compile](maps/compile.md) |
| CMP-7 | medium | confirmed-with-corrections | Non-decimal and legacy-octal numeric literals are rounded once per digit; sloppy 08.5 / 09e1 are rejected | [compile](maps/compile.md) |
| CMP-8 | medium | confirmed | Deterministic nesting caps refuse valid flat chains past ~2,040 terms and nests past ~89-90 cascade levels | [compile](maps/compile.md) |
| CORE-4 | medium | downgraded | The global object (and every Compartment global) has a null [[Prototype]]; bare-name resolution patches around it, so the global's inherited names get two answers | [vm-core-dispatch](maps/vm-core-dispatch.md) |
| CORE-6 | medium | downgraded | Garbage-only loops exhaust the heap inside one crank: string literals and closures allocate per evaluation and no collection runs mid-crank | [vm-core-dispatch](maps/vm-core-dispatch.md) |
| CORE-7 | medium | confirmed | User-function call overhead: about 1,600 x86 instructions of SipHash per call, about 5 malloc/free pairs, and a per-frame Rc<HashMap> id_map | [vm-core-dispatch](maps/vm-core-dispatch.md) |
| CORE-8 | medium | confirmed | Every ordinary `o.k` read builds a heap SymbolName for "disposed" and SipHashes it, after about a dozen brand-table probes | [vm-core-dispatch](maps/vm-core-dispatch.md) |
| CORE-9 | medium | confirmed | No Integer/Number fast path in `+`, `-`, `*`, `<`; the dispatch prologue decodes every opcode twice | [vm-core-dispatch](maps/vm-core-dispatch.md) |
| CORE-10 | medium | confirmed-with-corrections | UNWIND and CATCH make block exit O(frame bindings): one metered dispatch can hide hundreds of thousands of instructions | [vm-core-dispatch](maps/vm-core-dispatch.md) |
| CORE-11 | medium | confirmed | Slot carries two type tags (Kind and the Payload discriminant): 24 bytes where 16 would do; mark vectors use a byte per bit | [vm-core-dispatch](maps/vm-core-dispatch.md) |
| CORE-12 | medium | confirmed | Every arrow, method and plain function instance allocates and then discards a default prototype, and stores its name three times | [vm-core-dispatch](maps/vm-core-dispatch.md) |
| FN-4 | medium | confirmed-with-corrections | Resolving with a native promise skips NewPromiseResolveThenableJob: settles one tick early and never reads `constructor` | [vm-functions-async](maps/vm-functions-async.md) |
| FN-5 | medium | confirmed-with-corrections | await fast path omits PromiseResolve's `constructor` check (subclass instances, broken promises); comment claims otherwise | [vm-functions-async](maps/vm-functions-async.md) |
| FN-6 | medium | confirmed | Promise.any with synchronously rejecting thenables rejects with an empty `errors` array | [vm-functions-async](maps/vm-functions-async.md) |
| FN-7 | medium | confirmed | Async generator completion awaits its return value a second time (one extra tick, one extra capability) | [vm-functions-async](maps/vm-functions-async.md) |
| FN-8 | medium | confirmed | Native Promise.prototype.finally path settles one tick early and constructs fewer species promises | [vm-functions-async](maps/vm-functions-async.md) |
| FN-10 | medium | confirmed | User-function argument limit is about 2,025 (arguments double-counted) and halts uncatchably; native callees accept millions | [vm-functions-async](maps/vm-functions-async.md) |
| FN-11 | medium | confirmed-with-corrections | Per-activation id_map Rc<HashMap>: two extra mallocs per call, a whole-map copy inside every try, redundant with locals[i].id | [vm-functions-async](maps/vm-functions-async.md) |
| FN-12 | medium | confirmed | Each await of a non-promise allocates a capability that cannot be reclaimed within the crank (about 330k awaits exhaust the heap) | [vm-functions-async](maps/vm-functions-async.md) |
| FN-13 | medium | confirmed-with-corrections | Same defect as NOBJ-10. Hard 1,000,000-element caps in Promise combinators, IterableToList and collection constructors halt as StepLimit | [vm-functions-async](maps/vm-functions-async.md) |
| FN-14 | medium | confirmed | Async and generator nesting halts uncatchably at 126 async levels or 50-70 yield* levels | [vm-functions-async](maps/vm-functions-async.md) |
| FN-15 | medium | confirmed | Same defect as CORE-12. Arrows, methods and async functions allocate a dead .prototype (plus a constructor slot) per creation; the name is stored three times | [vm-functions-async](maps/vm-functions-async.md) |
| INT-2 | medium | downgraded | Guest-reachable engine panics are not contained by either endo IronHorse entry point; a caller that survives the unwind commits the failed crank's partial effects | [integration-fuzz-oracle](maps/integration-fuzz-oracle.md) |
| INT-3 | medium | confirmed | The thixotrope worker's private SourceCompiler drops the direct-eval context: eval('super.x'), eval('new.target') and eval('this.#x') throw SyntaxError | [integration-fuzz-oracle](maps/integration-fuzz-oracle.md) |
| INT-6 | medium | confirmed | The fuzz lane never compares the shipped compile-then-run pipeline's behaviour with anything; every behavioural differential runs XS-compiled bytecode | [integration-fuzz-oracle](maps/integration-fuzz-oracle.md) |
| MEM-1 | medium | confirmed; pass 2 lowered high->medium | Allocation never triggers a collection: a crank whose total allocation (not live size) exceeds the slot or chunk ceiling halts uncatchably | [vm-memory-gc-meter](maps/vm-memory-gc-meter.md) |
| MEM-6 | medium | confirmed | Per-object state lives in SipHash side tables and BTreeMap array items: ~1.5 KB per pending promise, ~430 B per closure, 56 B per array item | [vm-memory-gc-meter](maps/vm-memory-gc-meter.md) |
| MEM-7 | medium | confirmed | Memory is never returned: slot vector, free list, chunk vector and side-table maps keep peak capacity after collection | [vm-memory-gc-meter](maps/vm-memory-gc-meter.md) |
| NOBJ-5 | medium | confirmed-with-corrections; pass 2 lowered high->medium | Default Array.prototype.sort copies both operands' full UTF-16 strings on every comparison, charged only length*BUILTIN_METERING up front | [vm-natives-objects](maps/vm-natives-objects.md) |
| NOBJ-10 | medium | confirmed-with-corrections | Hard-coded 1,000,000-step iterator caps: uncatchable StepLimit halts in many built-ins, silent truncation in groupBy | [vm-natives-objects](maps/vm-natives-objects.md) |
| NOBJ-11 | medium | confirmed-with-corrections | 2^24 'oversized-array-like' caps halt with Refused on sparse real Arrays; sort reserves O(length) scratch before reading | [vm-natives-objects](maps/vm-natives-objects.md) |
| NOBJ-12 | medium | confirmed-with-corrections | %TypedArray%.prototype.toSorted, toReversed and with are missing (ES2023 change-array-by-copy) | [vm-natives-objects](maps/vm-natives-objects.md) |
| NOBJ-13 | medium | confirmed-with-corrections | Symbols as weak keys/targets are refused, as a catchable TypeError on method paths but an uncatchable Refused halt in the WeakMap/WeakSet constructors | [vm-natives-objects](maps/vm-natives-objects.md) |
| NOBJ-14 | medium | confirmed | Atomics.wait, notify and waitAsync halt with Refused before any validation, including non-blocking spec outcomes | [vm-natives-objects](maps/vm-natives-objects.md) |
| NOBJ-15 | medium | confirmed-with-corrections | Same defect as MEM-6 (array items). Array element storage is a BTreeMap per array: 55.6 B per item host versus 32-64 B charged, O(log n) access, per-call rebuilds | [vm-natives-objects](maps/vm-natives-objects.md) |
| NVAL-5 | medium | confirmed-with-corrections; pass 2 lowered high->medium | Intl.Collator / localeCompare are not UCA: accents sort after z, case ties are upper-first, base sensitivity does not ignore accents, numeric compares only the first digit run | [vm-natives-values](maps/vm-natives-values.md) |
| NVAL-7 | medium | confirmed-with-corrections | Temporal is an outdated, lax subset (~44% plain-host test262 pass), effectively invisible to the oracle gate, and unmetered | [vm-natives-values](maps/vm-natives-values.md) |
| NVAL-8 | medium | confirmed-with-corrections | Intl 'frozen profile' is a set of disagreeing hand tables: locales reported as supported are formatted with English data | [vm-natives-values](maps/vm-natives-values.md) |
| NVAL-9 | medium | confirmed-with-corrections | The same 'too large' or 'not modelled' condition is classified five different ways; several are uncatchable halts where engines throw RangeError or return a value | [vm-natives-values](maps/vm-natives-values.md) |
| NVAL-10 | medium | confirmed | JSON.parse and JSON.rawJSON accept \u+XYZ escapes (u32::from_str_radix accepts a leading '+') | [vm-natives-values](maps/vm-natives-values.md) |
| NVAL-11 | medium | confirmed | parseInt, and Number() on 0x/0o/0b strings, double-round by accumulating digits in f64 | [vm-natives-values](maps/vm-natives-values.md) |
| NVAL-12 | medium | confirmed-with-corrections | Math.fround (integer fast path), Math.hypot (3+ args) and Math.round (\|x\| in [2^51, 2^52) halves) return wrong values | [vm-natives-values](maps/vm-natives-values.md) |
| NVAL-13 | medium | confirmed | JSON parse/stringify nesting beyond 2048 levels is an uncatchable ReentryLimit halt despite heap-allocated stacks; stringify re-copies output once per nesting level | [vm-natives-values](maps/vm-natives-values.md) |
| PROP-2 | medium | downgraded | The ~64.4k lifetime property-key budget is monotone: collected symbols' ids, eval identifiers and JSON keys are never reclaimed | [vm-property-model](maps/vm-property-model.md) |
| PROP-4 | medium | confirmed-with-corrections | Every computed string-key operation runs the lazy-intrinsic global catch-up, ~9-10 µs per o[k] (~10-50x a static read) | [vm-property-model](maps/vm-property-model.md) |
| PROP-5 | medium | confirmed-with-corrections | Proxy [[Call]] presence is recomputed per call: apply trap runs for a proxy over a non-callable target, and a revoked function proxy reports typeof 'object'/not callable | [vm-property-model](maps/vm-property-model.md) |
| PROP-6 | medium | confirmed-with-corrections | %Object.prototype% is not an immutable-prototype exotic object | [vm-property-model](maps/vm-property-model.md) |
| PROP-7 | medium | confirmed-with-corrections | Same defect as CORE-4. The global object's [[Prototype]] is null instead of %Object.prototype% | [vm-property-model](maps/vm-property-model.md) |
| PROP-8 | medium | confirmed-with-corrections | Built-in Array/Map/Set/String iterators reuse one {value, done} result object with non-writable, non-configurable fields (XS parity, spec divergence) | [vm-property-model](maps/vm-property-model.md) |
| RGX-3 | medium | confirmed-with-corrections | exec/match result own properties index/input/groups/indices exist only if the program text interned those names | [regexp](maps/regexp.md) |
| SNI-1 | medium | confirmed; pass 2 lowered high->medium | Crafted container with a prototype cycle is adopted; prototype walks then spin forever inside one instruction, past an armed meter | [snapshot-image-codec](maps/snapshot-image-codec.md) |
| SNI-2 | medium | confirmed; pass 2 lowered high->medium | HEAP chunk offsets are only range-checked; a crafted string offset gives wrong answers and then a host panic | [snapshot-image-codec](maps/snapshot-image-codec.md) |
| SNI-3 | medium | confirmed; pass 2 lowered high->medium | METR counters are not validated at decode; a crafted meter index panics the host on the first dispatched instruction | [snapshot-image-codec](maps/snapshot-image-codec.md) |
| SNI-4 | medium | confirmed-with-corrections; pass 2 lowered high->medium | HEAP record shape is not validated: kind/payload mismatches and own-property cycles are adopted; a cyclic own chain makes integrity operations grow host memory without bound | [snapshot-image-codec](maps/snapshot-image-codec.md) |
| SNI-5 | medium | confirmed-with-corrections | Duplicate-atom detection in AtomReader::parse is O(n^2) and runs before every other gate | [snapshot-image-codec](maps/snapshot-image-codec.md) |
| SNI-6 | medium | confirmed-with-corrections | FUNC gate (and VM restore) walks every function row's body afresh, so read cost is O(rows x body) | [snapshot-image-codec](maps/snapshot-image-codec.md) |
| SNI-7 | medium | confirmed | Eager container restore peaks near 4.7x the container size because of avoidable whole-image copies | [snapshot-image-codec](maps/snapshot-image-codec.md) |
| SNI-8 | medium | confirmed-with-corrections | Freed slot records are written into every container forever; after a garbage burst they dominate the bytes | [snapshot-image-codec](maps/snapshot-image-codec.md) |
| SNS-1 | medium | confirmed | Shared-Machine (daemon) checkpoints extract, encode and SHA-256 the entire small state every time | [snapshot-store](maps/snapshot-store.md) |
| SNS-2 | medium | confirmed | Bulk side tables are one section each, so an O(1) change rewrites the whole table on every checkpoint | [snapshot-store](maps/snapshot-store.md) |
| SNS-4 | medium | confirmed-with-corrections | Damaged row content under a lazy fault is an untyped String panic that escapes every store-fault catch, including the daemon's | [snapshot-store](maps/snapshot-store.md) |
| T262-1 | medium | confirmed-with-corrections; pass 2 lowered high->medium | The score conflates the XS differential with test262's verdict: 15,205 case/modes are attributed to the wrong column | [test262-harness](maps/test262-harness.md) |
| T262-2 | medium | confirmed; pass 2 lowered high->medium | Setup and body are separate Scripts, and neither engine shares top-level let/const/class across Scripts: 724 case/modes fail as a harness artifact | [test262-harness](maps/test262-harness.md) |
| T262-4 | medium | confirmed-with-corrections | Same defect as NOBJ-14. Atomics pre-skips over-capture single-agent cases and hide that the engine refuses wait/notify/waitAsync as an uncatchable halt | [test262-harness](maps/test262-harness.md) |
| T262-5 | medium | confirmed-with-corrections | The "infrastructure, not an Ironhorse gap" category holds Ironhorse gaps and failures (173 case/modes), and unknown reasons default into it | [test262-harness](maps/test262-harness.md) |
| T262-8 | medium | confirmed | Same defect as FN-18. The feature skip list drops tail-call-optimization, which the XS oracle implements, while claiming to mirror XS's list | [test262-harness](maps/test262-harness.md) |
| BOOT-9 | low | downgraded | Key-space exhaustion is reported as four different halt/error classes depending on entry path | [vm-boot-realm-modules](maps/vm-boot-realm-modules.md) |
| BOOT-10 | low | confirmed | Parallel hand-maintained tables: one built-in method touches 5-9 lists, a constructor about 12 | [vm-boot-realm-modules](maps/vm-boot-realm-modules.md) |
| BOOT-11 | low | confirmed-with-corrections | Duplicated and (practically) dead code in the linker and runtime adapter | [vm-boot-realm-modules](maps/vm-boot-realm-modules.md) |
| BOOT-12 | low | confirmed | Engine internals and test hooks exposed in the public API; heap endowments refused late and as NotImplemented; ModuleId indexes unchecked | [vm-boot-realm-modules](maps/vm-boot-realm-modules.md) |
| CMP-9 | low | confirmed | A "use strict" directive does not re-check a numeric token already scanned in sloppy mode | [compile](maps/compile.md) |
| CMP-10 | low | confirmed | \u{...} escapes in identifiers wrap modulo 2^32 instead of failing past U+10FFFF | [compile](maps/compile.md) |
| CMP-11 | low | confirmed | One compile unit may use at most 65,534 distinct symbol names; the error reports line 0 | [compile](maps/compile.md) |
| CMP-12 | low | confirmed-with-corrections | Annex B sloppy-mode syntax is refused or ignored, and the refusal says '(strict code)' in sloppy code | [compile](maps/compile.md) |
| CMP-13 | low | confirmed | Numeric and lexical helpers are copied verbatim across crates; identifier classification scans its table linearly | [compile](maps/compile.md) |
| CORE-13 | low | confirmed | Malformed-bytecode invariants are filed as skip-eligible Halt::NotImplemented instead of EngineInvariant | [vm-core-dispatch](maps/vm-core-dispatch.md) |
| CORE-14 | low | confirmed | A crafted *_4 instruction length overflows usize on wasm32, panicking in instruction_len, dispatch and snapshot restore | [vm-core-dispatch](maps/vm-core-dispatch.md) |
| FN-16 | low | confirmed | for-in materializes a fresh, unmetered chunk (four copies) for every named key it yields | [vm-functions-async](maps/vm-functions-async.md) |
| FN-17 | low | confirmed | Unreachable guards are registered as NotImplemented declines, so an engine bug would be scored as a skip | [vm-functions-async](maps/vm-functions-async.md) |
| FN-18 | low | confirmed | Proper tail calls are not implemented although XS reuses the frame for RUN_TAIL | [vm-functions-async](maps/vm-functions-async.md) |
| FN-19 | low | confirmed-with-corrections | Four near-identical suspension drivers and five overlapping frame records (already diverged: SavedFrame drops this_captures) | [vm-functions-async](maps/vm-functions-async.md) |
| INT-4 | low | downgraded | The ephemeral endo Machine documents a fresh Realm per evaluation but shares a never-reclaimed key table; one evaluation can deny every later one, and the denial is reported as malformed bytecode | [integration-fuzz-oracle](maps/integration-fuzz-oracle.md) |
| INT-5 | low | downgraded | The embedding classifies Halt four different ways, and documents a refusal channel nothing produces | [integration-fuzz-oracle](maps/integration-fuzz-oracle.md) |
| INT-7 | low | confirmed | gen_compile_program re-reads its arm-selector byte, so the compiler targets never see calls or exceptions and expression depth collapses to 1 or 5 | [integration-fuzz-oracle](maps/integration-fuzz-oracle.md) |
| INT-8 | low | confirmed | compile_differential_check decides 'the oracle rejected' from the run's error text, and its documented finding IronhorseRejected is ignored by the target | [integration-fuzz-oracle](maps/integration-fuzz-oracle.md) |
| INT-9 | low | confirmed-with-corrections | The top-level goal of a crank differs between the embedders, with guest-visible consequences, and nothing names it | [integration-fuzz-oracle](maps/integration-fuzz-oracle.md) |
| INT-10 | low | confirmed | The oracle's 256-byte error buffer has no length or truncation flag, producing a false test262 failure | [integration-fuzz-oracle](maps/integration-fuzz-oracle.md) |
| INT-11 | low | confirmed-with-corrections | The -Wclobbered warnings xs_shim.c emits are false positives, but they appear on every oracle build despite the harness's warning-clean claim | [integration-fuzz-oracle](maps/integration-fuzz-oracle.md) |
| INT-12 | low | confirmed | `endor run -e ironhorse` runs the engine on the process main thread, outside the NATIVE_STACK_BYTES contract | [integration-fuzz-oracle](maps/integration-fuzz-oracle.md) |
| INT-13 | low | confirmed | The compiler adapter and its error mapping exist in many hand-maintained copies; two are verbatim, and the copies have already diverged in behaviour | [integration-fuzz-oracle](maps/integration-fuzz-oracle.md) |
| INT-14 | low | confirmed-with-corrections | stack-depth-prototypes/ patches no longer apply to HEAD, and the README does not record their base commit | [integration-fuzz-oracle](maps/integration-fuzz-oracle.md) |
| MEM-8 | low | confirmed | Extent-local chunk compaction never coalesces adjacent dead crossing blocks; the full compactor is test-only | [vm-memory-gc-meter](maps/vm-memory-gc-meter.md) |
| MEM-9 | low | confirmed | Per-row GC knowledge is hand-written three times (chunk walk, slot walk, root walk) with no field-coverage check | [vm-memory-gc-meter](maps/vm-memory-gc-meter.md) |
| NOBJ-7 | low | downgraded | ArrayBuffer transfer/resize always allocate a fresh chunk and copy twice through a host Vec | [vm-natives-objects](maps/vm-natives-objects.md) |
| NOBJ-16 | low | confirmed | Set.prototype.intersection re-checks membership in `this` after calling other.has, which the spec does not do | [vm-natives-objects](maps/vm-natives-objects.md) |
| NOBJ-17 | low | confirmed | Map/Set iterators and forEach stop after clear() (XS purge model) although delete follows the spec's emptied-entry model | [vm-natives-objects](maps/vm-natives-objects.md) |
| NVAL-14 | low | confirmed | Date.parse normalizes illegal field values in conforming ISO strings instead of returning NaN | [vm-natives-values](maps/vm-natives-values.md) |
| NVAL-15 | low | confirmed | JSON.stringify replacer-array dedupe is O(n^2) and not charged per comparison | [vm-natives-values](maps/vm-natives-values.md) |
| NVAL-16 | low | confirmed | String.fromCharCode's ToUint16 saturates for \|n\| >= 2^63 (`n.trunc() as i64`) | [vm-natives-values](maps/vm-natives-values.md) |
| NVAL-17 | low | confirmed | The empty string is not interned: every empty result appends an uncharged 4-byte chunk, contrary to the doc comment | [vm-natives-values](maps/vm-natives-values.md) |
| PROP-9 | low | confirmed | Proxy getOwnPropertyDescriptor: IsExtensible(target) runs after ToPropertyDescriptor(trapResult) | [vm-property-model](maps/vm-property-model.md) |
| PROP-10 | low | confirmed-with-corrections | Key/name lookups allocate per call (by-value Into<SymbolName>, String round-trips) and hash with SipHash | [vm-property-model](maps/vm-property-model.md) |
| PROP-11 | low | confirmed | Ordinary [[Get]]/[[Set]] walks and the per-index twins are hand-copied ('keep the two in step') | [vm-property-model](maps/vm-property-model.md) |
| PROP-12 | low | confirmed | 'Array-index property' has two key spellings and several storages; is_ordinary_object is a homonym of the ECMA term | [vm-property-model](maps/vm-property-model.md) |
| RGX-6 | low | downgraded | Catastrophic backtracking is unbounded unless a meter is armed; run_bounded's step limit does not count matcher steps | [regexp](maps/regexp.md) |
| RGX-7 | low | confirmed | Three independent GetSubstitution implementations and two identical range-membership binary searches | [regexp](maps/regexp.md) |
| SNI-9 | low | confirmed-with-corrections | Accepted-but-meaningless degrees of freedom break 'one machine, one container encoding' | [snapshot-image-codec](maps/snapshot-image-codec.md) |
| SNI-10 | low | confirmed | Persistence-refusal error reports every admission refusal as a pending side table, conflating policy, unrepresentable and not-yet-carried | [snapshot-image-codec](maps/snapshot-image-codec.md) |
| SNI-11 | low | confirmed | Persistence validation and plumbing are repeated across the decoder, the roster gate and the VM restore | [snapshot-image-codec](maps/snapshot-image-codec.md) |
| SNS-3 | low | downgraded | The checkpoint persist gate scans all functions and promise reactions on every checkpoint | [snapshot-store](maps/snapshot-store.md) |
| SNS-5 | low | confirmed | Page-edge summaries, the SQLite edge_pairs index and gen_dirty are maintained on every commit for collectors only tests call | [snapshot-store](maps/snapshot-store.md) |
| SNS-6 | low | confirmed | Every SQLite point read re-reads and decodes the manifest and prepares two uncached statements | [snapshot-store](maps/snapshot-store.md) |
| SNS-7 | low | confirmed-with-corrections | Migration ladder steps are tested only on stores synthesized by the current build; every real-bytes fixture stops at the boot gate | [snapshot-store](maps/snapshot-store.md) |
| SNS-8 | low | confirmed | check_succession classifies batch-side defects (cadence, counters, schema stamp, non-canonical sections) as a Poisoned store | [snapshot-store](maps/snapshot-store.md) |
| SNS-9 | low | confirmed | FileStore: single writer documented but not enforced; each commit loads the durable header twice with unbuffered 4- and 12-byte reads | [snapshot-store](maps/snapshot-store.md) |
| SNS-10 | low | confirmed | SQLite schema creates a side_tables table on every open that nothing reads or writes | [snapshot-store](maps/snapshot-store.md) |
| SNS-11 | low | confirmed | Daemon open decodes, and canonically re-encodes, the whole small state twice before the first crank | [snapshot-store](maps/snapshot-store.md) |
| SNS-12 | low | confirmed-with-corrections | A store whose schema this build cannot read classifies Poisoned, while a container version it cannot read classifies Refused | [snapshot-store](maps/snapshot-store.md) |
| SNS-13 | low | confirmed | SQLite backend spells stored-content damage and permanent configuration refusals as Io, so they classify Transient | [snapshot-store](maps/snapshot-store.md) |
| T262-3 | low | downgraded | An Ironhorse hang in a module-goal case is attributed to the oracle | [test262-harness](maps/test262-harness.md) |
| T262-6 | low | downgraded | A compiler panic on a positive case is a skip, not the Fail the harness prescribes for negative cases | [test262-harness](maps/test262-harness.md) |
| T262-9 | low | confirmed | $262 exposes only detachArrayBuffer; the module oracle exposes no $262 | [test262-harness](maps/test262-harness.md) |
| T262-10 | low | confirmed-with-corrections | The expectation list's mode column is wrong for 1,189 files, so case/mode totals are not comparable | [test262-harness](maps/test262-harness.md) |
| T262-11 | low | confirmed | ironhorse-xst is not a faithful eshost "xs" host | [test262-harness](maps/test262-harness.md) |
| T262-12 | low | confirmed-with-corrections | Dead and legacy code, a second classifier with different semantics, and 4.4 MB of unreferenced baseline data | [test262-harness](maps/test262-harness.md) |
| T262-13 | low | confirmed | Resume identity is coarse, and a quarantine is permanent for a run identity | [test262-harness](maps/test262-harness.md) |
| T262-14 | low | confirmed | Two compile-error classifiers disagree about which failures are SyntaxErrors | [test262-harness](maps/test262-harness.md) |
| T262-15 | low | confirmed | Documentation and code disagree on the sweep's shape and scope | [test262-harness](maps/test262-harness.md) |

### Ontology findings

| ID | Severity | Category | Finding | Source |
|---|---|---|---|---|
| ONT-2 | high | type-encoding | Same defect as NOBJ-1. Array indices are interned as 16-bit property-name keys on the generic Array paths, so `new Array(70000).fill(0)` throws and leaves the realm unable to mint names or run new code | [ontological-consistency](lenses/ontological-consistency.md) |
| ONT-3 | high | type-encoding | Slot conflates a JS value with a property/element record: Function.prototype.apply copies frozen array elements' attribute flags into the callee's arguments object and rest array | [ontological-consistency](lenses/ontological-consistency.md) |
| ONT-6 | high | spec-model | Built-in accessor properties are implemented as GET_PROPERTY opcode interceptions, not prototype accessors (RegExp, Temporal, Intl.Locale, Intl.Collator.compare, DisposableStack.disposed), while ArrayBuffer/TypedArray/DataView use real accessors | [ontological-consistency](lenses/ontological-consistency.md) |
| ONT-5 | medium | spec-model | Jobs record no realm or environment: a reaction handler with no home environment runs against whichever compartment the pump happens to be in | [ontological-consistency](lenses/ontological-consistency.md) |
| ONT-7 | medium | taxonomy | Same defect as NVAL-9. 'Result too large' is one condition classified three ways at three thresholds: Refused at private 2^24 caps (pad, generic join, String.raw, RegExp replace, BigInt), catchable RangeError above 2^31-1 (reserve_units), HeapExhausted at the configured chunk ceiling; is_panic and the test262 report then split them again | [ontological-consistency](lenses/ontological-consistency.md) |
| ONT-8 | medium | taxonomy | Same defect as T262-5. test262 module-path classification: 'a real compile rejection' is defined three ways (a module-path regexp resource stop is credited as a covered SyntaxError), and every module:* run-skip family is unclassified and defaults to Infrastructure, so 164 IronHorse module gaps, and any module compiler panic, are reported as 'not an IronHorse gap' | [ontological-consistency](lenses/ontological-consistency.md) |
| ONT-9 | medium | taxonomy | Same defect as NOBJ-13. Symbol as a weak key: Refused (uncatchable) via the WeakMap/WeakSet constructors, catchable TypeError via set/add/WeakRef/register | [ontological-consistency](lenses/ontological-consistency.md) |
| ONT-11 | medium | taxonomy | Same defect as NOBJ-14. No Agent [[CanBlock]] model: Atomics.wait/notify/waitAsync are uncatchable Refused halts before argument validation, and the harness files 109 single-agent cases and both CanBlockIsFalse cases as needing threads | [ontological-consistency](lenses/ontological-consistency.md) |
| ONT-12 | medium | type-encoding | parseInt returns +0 for negative zero: the f64-to-slot integer fold is written three times and only the parse_int copy omits the -0 guard | [ontological-consistency](lenses/ontological-consistency.md) |
| ONT-13 | medium | type-encoding | Same-type TypedArray construction pushes raw element bytes through Number slots, canonicalizing NaN payloads, which breaks the spec's byte-copy rule and the engine's own 'raw bytes are not Numbers' rule | [ontological-consistency](lenses/ontological-consistency.md) |
| ONT-15 | medium | spec-model | Same defect as T262-2. No global declarative record: Script-level let/const/class do not persist, GlobalDeclarationInstantiation's lexical checks are missing, and globalLexicals is a separate record from script lexicals | [ontological-consistency](lenses/ontological-consistency.md) |
| ONT-17 | medium | spec-model | Same defect as CORE-4. Global object has a null [[Prototype]] while identifier resolution consults a hard-wired %Object.prototype%, so HasBinding is not HasProperty(globalObject) | [ontological-consistency](lenses/ontological-consistency.md) |
| ONT-19 | medium | identity-versioning | EnvironmentId and HostRootId are documented as stable lineage identifiers but are raw slot indices that collection reuses, and the two id kinds share one forgeable number space | [ontological-consistency](lenses/ontological-consistency.md) |
| ONT-21 | medium | identity-versioning | The persisted bytecode ISA (opcode numbering and widths) is identified by no gate; the XS-derived alphabetical enum renumbers on any opcode insertion | [ontological-consistency](lenses/ontological-consistency.md) |
| ONT-34 | medium | identity-versioning | Same defect as PROP-2. Symbol property-key ids are bump-allocated and never returned after GC proves them dead, so garbage symbols permanently consume the shared 16-bit key space | [ontological-consistency](lenses/ontological-consistency.md) |
| ONT-1 | low | synonym-homonym | Halt::HeapExhausted (documented as the configured slot/chunk heap ceiling) also names the regexp engine's fixed match-state profile (65,536 states / 64 MiB) and a >2^31-1 quantifier-bound parse check, so long greedy matches halt uncatchably and 452 test262 cases are misfiled as anonymous 'ironhorse-aborted-limit' | [ontological-consistency](lenses/ontological-consistency.md) |
| ONT-10 | low | taxonomy | `Halt::Decode` / `parse-or-decode` conflates compiler gaps, compiler panics, guest-caused relink refusals and malformed bytecode, and the harness files them all as coverage gaps | [ontological-consistency](lenses/ontological-consistency.md) |
| ONT-14 | low | spec-model | The start compartment's eval/Function and the shared function-family constructors have no home realm and compile against the calling compartment, unlike ECMA-262, XS and SES; ARCHITECTURE.md and compartment.rs still describe the pinned default-realm model, and xs_departures.rs records no departure | [ontological-consistency](lenses/ontological-consistency.md) |
| ONT-16 | low | spec-model | Guest Compartment.prototype.evaluate is a strict eval program, not the Script its doc and the adopted XS model say: top-level var/function/let vanish | [ontological-consistency](lenses/ontological-consistency.md) |
| ONT-20 | low | identity-versioning | No persisted identifier covers guest-visible engine semantics: SIGN/METR accept a heap across native or in-tree Intl behaviour changes, and INTL_DATA_VERSION, documented as identifying the in-tree Intl profile, hashes only the ICU lockfile graph | [ontological-consistency](lenses/ontological-consistency.md) |
| ONT-22 | low | identity-versioning | ROW_SCHEMA_VERSION's gate fingerprints only snapshot_rows.rs and intl_data.rs while 10-13 public capture/restore rows are bare tuples in persist.rs/restore.rs; format 26 already added a field to the ArrayBuffers row as 'encoding-only' with no row release | [ontological-consistency](lenses/ontological-consistency.md) |
| ONT-23 | low | synonym-homonym | 'completed' / 'crank' means 'END reached and job queue drained' in the docs, but Compartment evaluation reports completed=true and is_quiescent()=true with promise jobs still pending | [ontological-consistency](lenses/ontological-consistency.md) |
| ONT-24 | low | synonym-homonym | 'Realm' names three different things; the VM crate docs say each Compartment has a Realm and the graph is always frozen, but intrinsics are shared and can be unfrozen | [ontological-consistency](lenses/ontological-consistency.md) |
| ONT-25 | low | taxonomy | Deliberate host-policy refusals ('compartment:heap-endowment', 'eval:no-compiler') are classified Halt::NotImplemented (implementation gap) while sibling provenance and missing-service checks are Halt::Refused; the surrounding code and prose call them refusals | [ontological-consistency](lenses/ontological-consistency.md) |
| ONT-26 | low | taxonomy | Store-side halt mapping sends every non-invariant halt, including the non-deterministic HostAllocationFailed, to `StoreFailure::Refused` ('deterministic, retry is a busy-loop') | [ontological-consistency](lenses/ontological-consistency.md) |
| ONT-27 | low | taxonomy | The side-table ledger has no 'unsupported' class: guest_compartments, refused at persist, is filed as a SATELLITE and SideTable::pending() reports nothing left to carry | [ontological-consistency](lenses/ontological-consistency.md) |
| ONT-28 | low | taxonomy | README names the native-recursion halt as Halt::StackOverflow; the code emits ReentryLimit, and the harness classifies the two sides of that stop asymmetrically | [ontological-consistency](lenses/ontological-consistency.md) |
| ONT-29 | low | spec-model | Module record model lacks [[EvaluationError]]: a failed evaluation leaves modules 'Evaluating' forever, re-import silently succeeds, and snapshot admission is permanently refused | [ontological-consistency](lenses/ontological-consistency.md) |
| ONT-30 | low | doc-code-drift | One sentinel, three documented meanings: docs disagree with each other and with the code about which environment an unhomed function, a compartment evaluate, and lockdown's reach use | [ontological-consistency](lenses/ontological-consistency.md) |
| ONT-31 | low | doc-code-drift | Identifier documentation gives stale values: ARCHITECTURE.md's 'current value' table says format 24 / store 36 / row 5 (code: 26 / 38 / 6), the row contract still documents a FromAsync refusal, designs/README.md says store 36, and the harness reports a 'version-4 meter pin' | [ontological-consistency](lenses/ontological-consistency.md) |
| ONT-32 | low | identity-versioning | The VERS stamp does not identify container content for formats 25 and 26: an older stamp carrying WeakRef, FinalizationRegistry or resizable-buffer state is accepted, so one machine has several canonical encodings | [ontological-consistency](lenses/ontological-consistency.md) |
| ONT-33 | low | identity-versioning | The store-schema migration ladder sits behind the boot-fingerprint gate, which moves with every new built-in, so its steps run only on states the tests synthesize | [ontological-consistency](lenses/ontological-consistency.md) |

### Coverage findings

| ID | Severity | Lens | Finding | Source |
|---|---|---|---|---|
| COV-1 | high | correctness | `new` on a bound cross-segment target runs the caller's bytes | [coverage](COVERAGE.md) |
| COV-2 | high | correctness | Strict computed-key writes drop a rejected `[[Set]]` silently | [coverage](COVERAGE.md) |
| COV-3 | high | correctness | Crank completion and uncaught-throw rendering is unbounded, unmetered host work | [coverage](COVERAGE.md) |
| COV-4 | medium | correctness | Object environments skip the HasProperty re-check; globals resolve late | [coverage](COVERAGE.md) |
| COV-5 | medium | correctness | Functions created before the first guest `Compartment` stay unhomed for life | [coverage](COVERAGE.md) |
| COV-6 | medium | memory-performance | Closure-capture append is O(k²) host work for O(k) computrons | [coverage](COVERAGE.md) |
| COV-7 | low | test262-conformance | BigInt literals are rejected as property names | [coverage](COVERAGE.md) |
| COV-8 | low | correctness | Non-unicode `/i` canonicalization equates 27 Greek iota-subscript pairs | [coverage](COVERAGE.md) |
| COV-9 | low | test262-conformance | The async unhandled-rejection latch turns passes into skips, then failures | [coverage](COVERAGE.md) |
| COV-10 | low | correctness | `await` in a module-level class heritage halts `EngineInvariant` | [coverage](COVERAGE.md) |
| COV-11 | low | skipped-features | `RegExp.prototype.compile` is present but a no-op | [coverage](COVERAGE.md) |
| COV-12 | low | ontological-consistency | `%StringIteratorPrototype%` does not exist | [coverage](COVERAGE.md) |
| COV-13 | low | skipped-features | The iterator prototypes lack `@@dispose` and `@@asyncDispose` | [coverage](COVERAGE.md) |
| COV-14 | low | skipped-features | The `Error.prototype.stack` setter performs none of the proposal's checks | [coverage](COVERAGE.md) |
| COV-15 | low | correctness | Direct eval takes its early-error context from XS's flags, not PerformEval | [coverage](COVERAGE.md) |
| COV-16 | low | correctness | A compartment's own `eval`, `Function` and `Compartment` are never frozen | [coverage](COVERAGE.md) |
| COV-17 | low | duplication | `DEFAULT_KEYS` has drifted from the oracle build's key table | [coverage](COVERAGE.md) |
| COV-18 | low | correctness | The key-allocation remainder is charged per creation, not per name | [coverage](COVERAGE.md) |
| COV-19 | low | correctness | `using` and `use()` accept primitives; async forms fall back to `@@dispose` | [coverage](COVERAGE.md) |
