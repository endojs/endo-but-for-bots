# Plan: applying the Porffor findings

This plan orders the work that [PORFFOR-FINDINGS.md](PORFFOR-FINDINGS.md) rates "apply now" or
"apply later".
Citations follow that document's conventions: Porffor paths (`compiler/...`) are at Porffor commit
`c9af40c8c6913e04d491412ae9fe0f34b97b51df`, and Ironhorse paths (`rust/engine/...`,
`designs/...`) are at this repository's commit `0368767778a232c38721ff8a1e88d8f68272624d`.
Line numbers will drift as the tree moves; re-locate a site by its quoted text before editing it.
Expected wins are the survey's measurements or estimates from 2026-11-22, not promises.

## Rules that apply to every item

### Invariants

Every change must preserve all four of these exactly.
A change that cannot is out of scope for this plan and needs a meter or format release instead.

1. **Identical computrons, including where the meter is checked.**
   The same `tick_*` calls with the same arguments in the same order, one `tick_code` and one
   `n_dispatched` per opcode (`rust/engine/ironhorse-vm/src/interp/dispatch.rs:304-305`), and
   `check_meter` at the same positions: every 4096 dispatches
   (`rust/engine/ironhorse-vm/src/interp/dispatch.rs:222-228`), backward branches (`:1003`), call
   entry (`:2840`) and native return (`:2561`).
   Those positions decide where a `MeterAbort` lands.
2. **Identical slot and chunk allocation sequence.**
   Allocation is metered (`rust/engine/ironhorse-vm/src/meter.rs:227`, `:248`) and becomes the
   heap image, so no fast path may allocate a slot or chunk the slow path does not, skip one it
   does, or reorder them.
   Host-side scratch (`Vec`, `String`) is free to change.
3. **Identical snapshot bytes.**
   Rows stay byte-identical under `IRONHORSE_FORMAT_VERSION` 24, `STORE_SCHEMA_VERSION` 36 and
   `ROW_SCHEMA_VERSION` 5 (`rust/engine/ARCHITECTURE.md:386-388`).
   Any new cache, flag or index is derived, is not persisted, and is rebuilt (or starts empty) on
   restore, following `property_index` (`rust/engine/ironhorse-vm/src/property_index.rs:1-2`).
4. **Identical observables.**
   Results, thrown errors and their messages, property order, `typeof`, and halts
   (`StepLimit`, `StackOverflow`, decode errors at the same pc).

Two engineering constraints sit beside them:

- No `unsafe` (`rust/engine/ironhorse-vm/src/lib.rs:1`) and no relaxing `overflow-checks`
  (`rust/engine/Cargo.toml:30-31`); use `wrapping_*`/`checked_*` where the arithmetic is proven.
- Fast paths in `dispatch_at_inner` stay register-sized, with the slow half
  `#[inline(never)]`, because that function's frame is gated
  (`rust/engine/STACK-DEPTH-REFACTOR.md:863`).

### Acceptance gates

Run from `rust/engine` unless noted.
An item lands only if all of these pass:

| Gate | Command or check |
|---|---|
| Computron goldens | `cargo test --locked --release -p ironhorse-vm --test golden_computrons` (fixture `ironhorse-vm/tests/fixtures/computrons.tsv`) |
| Compiler byte identity | the diff touches nothing under `ironhorse-compile/`, and `cargo test --locked -p ironhorse-compile --test coder_byte_identity` still passes |
| Snapshot identity | `cargo test --locked --release -p ironhorse-snapshot --test state_golden --test metamorphic_determinism --test streaming_identity` |
| Engine unit and integration tests | `cargo test --locked -p ironhorse-vm` and `cargo test --locked -p ironhorse-262` |
| Native stack heights | `python3 benches/stack_height.py --check` (fails past 2% or 256 B, `rust/engine/benches/README.md:155-156`) |
| Lints | `cargo +1.88.0 clippy --locked --workspace --no-deps -- -D warnings` and `cargo +1.88.0 fmt --manifest-path rust/engine/Cargo.toml --all -- --check` from the repository root, as CI runs them |
| Performance | the Phase 0 A/B protocol on the item's target workloads and on the whole roster |

### Keep or drop

Each item names a target workload and a threshold X.
The common rule: **keep the change if the target improves by at least X under the Phase 0
protocol and no other roster workload or gated fixture regresses beyond its recorded noise;
otherwise revert it and record it as a loss.**
Both outcomes go into `PORFFOR-RESULTS.md` with the raw numbers.
"Beyond noise" means a 3-run ratio above 1.25x, or a callgrind `Ir` increase above 2% on a
workload where wall time is inconclusive.

## Phase 0: instruments

Nothing in Phase 0 changes engine behaviour.

### 0.1 Commit the micro-bench roster

- File: `rust/engine/ironhorse-vm/tests/porffor_micro_bench.rs`, from the survey's scratch copy.
  It holds 21 workloads (13 top-level, 8 function-local twins), each with its expected result, and
  prints median time, computrons and dispatch count.
  The tests are `#[ignore]` so the default test run does not pay for them.
- Before committing: replace the "UNCOMMITTED survey bench" header with a description; make
  `MICRO_SAMPLES=0` exit cleanly instead of panicking, so a callgrind run does not include panic
  backtrace symbolisation; keep `MICRO_ONLY`, `MICRO_SAMPLES` and `MICRO_DISASM`.
- Have it assert the expected result, and print computrons and dispatches in a stable,
  machine-readable line, so an A/B can compare them mechanically.
- Gate: clippy and fmt only.

### 0.2 The A/B protocol

The host noise is large: single samples vary ±25-40% inside one process and run medians move
±2-20% (FINDINGS §B.2).
So:

1. Build A (the base commit) and B (the candidate) into separate target directories, with the same
   toolchain and profile.
2. **Interleave**: run A, then B, then A, then B, for at least three rounds, each a whole roster
   process with five samples per workload.
   Never run all of A and then all of B.
3. Compare medians of the per-round medians.
   With three rounds, treat only ratios beyond **1.25x** in either direction as signal, which
   matches `rust/engine/benches/run.py:176`.
4. Below that, use **callgrind instruction counts** as the low-noise tiebreak:

   ```sh
   MICRO_ONLY=<workload> MICRO_SAMPLES=0 \
     valgrind --tool=callgrind <roster binary> --ignored --nocapture
   ```

   on both binaries, comparing total `Ir`.
   `Ir` is not perfectly stable (random hash seeds change paths slightly), so require a change of
   at least 2% before calling it.
5. Confirm computrons and dispatch counts are equal between A and B for every workload.
   Any difference is a failure, whatever the timing says.
6. For changes that touch top-level code or calls, also run the gated fixtures
   (`dispatch_bench`, `reentry_bench`) interleaved in the same way.

Keep the raw outputs; `PORFFOR-RESULTS.md` cites them.

## Phase 1: zero-risk fast paths

These are survey candidates 1-4.
All four were prototyped together in a scratch copy with identical computrons
(FINDINGS §B.4), but each lands as its own commit with its own A/B, because the combined
measurement cannot split the credit.

### 1.1 Number fast paths in arithmetic, comparison, `+` and bitwise

- **Porffor:** T3 and T4, `compiler/render.js:5459-5463`, `:5500-5503`,
  `compiler/codegen.js:1217-1221`.
- **Ironhorse:** `rust/engine/ironhorse-vm/src/interp/coerce.rs:443` (`binary_arith`), `:544`
  (`relational`), `:1019` (`op_add`), `:474` (`binary_bit`); later `:676` (`equality`) and
  `rust/engine/ironhorse-vm/src/interp/dispatch.rs:3874` (`exec_increment`, already int-fast at
  `:3914`).
- **Design:**
  - At the top of each handler, test both stack slots for `Kind::Integer`/`Kind::Number` (and
    the matching `Payload`), and compute in place with the existing `apply_arith`
    (`rust/engine/ironhorse-vm/src/interp/numeric.rs:367`) or an `i32` operation.
  - `relational`: int/int compares as `i32`; number/number as `f64` with NaN false, exactly as the
    slow path does after coercion.
  - `binary_bit`: int/int for `& | ^ << >>`; `>>>` stays on the slow path because its result may
    be a number.
  - `op_add`: number/number goes straight to the arithmetic; anything involving a string, BigInt,
    symbol or reference stays on the existing path.
  - Where it measures better, overwrite `stack[n-2]` and pop once instead of truncate plus push.
  - Keep each fast path a few register-sized locals; move nothing into `dispatch_at_inner`.
- **Invariants:** these opcodes charge nothing beyond dispatch, and the fast path never allocates.
  `-0`, NaN and the int-overflow-to-number rule come from the shared `apply_arith`.
  Coercion of a number is the identity, so no observable call (`valueOf`, `@@toPrimitive`) is
  skipped.
- **Expected win:** measured 0.45x on `int_loop_fn`, 0.66x on `typed_array_fn`, 0.81x on
  `float_arith`; about 350 → 20 Ir per int comparison.
- **Keep if:** `int_loop_fn` reaches at least 1.25x (ratio ≤ 0.80).

### 1.2 Reorder the `disposed` guard in `dispatch_get_property`

- **Porffor:** none; this is a profiling discovery (FINDINGS E1).
- **Ironhorse:** `rust/engine/ironhorse-vm/src/interp/dispatch/property_read.rs:197-200`, where
  `self.symbol_ids.get("disposed")` (allocating a `SymbolName` and hashing it,
  `rust/engine/ironhorse-vm/src/symbols.rs:25-26`) runs before the
  `disposable_stacks.contains_key` test.
- **Design:** test `obj.kind == Kind::Reference && disposable_stacks.contains_key(&inst)` first.
  Better, resolve the `disposed` id once at link time, as `length_id` already is
  (`rust/engine/ironhorse-vm/src/interp/dispatch/property_read.rs:19`), and compare `u16`s.
- **Invariants:** the guard is pure, so reordering changes no result, meter or allocation.
- **Expected win:** part of the combined 0.58x on `prop_getset_fn`; `SymbolIds::get` from this site
  is 27% of that workload's `Ir`.
- **Keep if:** `prop_getset_fn` `Ir` falls by at least 15%; wall time is expected to agree.

### 1.3 Short-circuit `install_pending_intrinsics` for `JSON.stringify`

- **Porffor:** none directly; FINDINGS E2.
- **Ironhorse:** `rust/engine/ironhorse-vm/src/interp/natives/json.rs:925` calls
  `intern_implicit_key("toJSON")` (`rust/engine/ironhorse-vm/src/interp/property/keys.rs:111-115`),
  which calls `install_pending_intrinsics` (`rust/engine/ironhorse-vm/src/interp/link.rs:1502`)
  whenever the id is above `installed_names_len`; that then runs
  `missing_environment_global_bindings` (`:313-335`, called at `:1522`) in full.
  `rust/engine/ironhorse-vm/src/interp/natives/date.rs:64` (`toISOString`) has the same shape.
- **Design:**
  1. First establish why `id > installed_names_len` stays true for a static key (the survey's
     hypothesis is that reserved static ids sit above the floor).
     Record the answer in the results file either way.
  2. Return early when no name was appended since the last pass and the environment's
     `binding_names` set has not changed, using a generation counter bumped where either changes.
  3. Precompute the intrinsic name ids once, so the scan is over `u16`s without `SymbolName`
     allocation.
- **Invariants:** the install is unmetered and only its no-op case gets cheaper; the persisted
  floor (`NFLR`, `rust/engine/ironhorse-vm/src/interp/property/keys.rs:105-110`) must keep the same
  value at the same points, and a resumed machine must install at the same read as its live twin.
- **Expected win:** about 70% of the `json` workload's `Ir`; estimated 3x on stringify-heavy code.
- **Keep if:** `json` reaches at least 1.5x and the snapshot gates pass.

### 1.4 String+String concatenation on the stored bytes

- **Porffor:** T11's narrow concatenation, `compiler/render.js:4917-4925`.
- **Ironhorse:** `rust/engine/ironhorse-vm/src/interp/strings.rs:130-142` (`concat_add`).
- **Design:**
  - When both operands are `Kind::String` with `Payload::String`, charge
    `tick_string(total code units)` exactly as now, then build the chunk from the two UTF-16BE
    payload slices.
  - Best is a `ChunkArena` method that copies arena to arena with no temporary; the
    proof-of-concept used one `Vec<u8>`, which is already a large win.
  - Other operand kinds keep the existing route.
  - Then apply the same treatment to `alloc_str_text` (`:78-81`), `new_string_metered`
    (`:103-106`) and `to_string_slot_metered` (`:155-165`) where the input is already UTF-16BE.
- **Invariants:** one chunk allocated, with identical bytes, and an identical charge.
  The arena method must respect the same address ceiling and allocation-failure path as
  `ChunkArena::alloc` (`rust/engine/ironhorse-vm/src/value.rs:2506-2508`).
- **Expected win:** measured 0.54x on `string_concat`; larger for long strings.
- **Keep if:** `string_concat` reaches at least 1.25x.

## Phase 2: side-table and key costs

These are survey candidates 5-8: larger edits, still without new caches.

### 2.1 A cheap hasher for `SlotIndex`- and `u16`-keyed tables

- **Porffor:** none (FINDINGS E3).
- **Ironhorse:** the side tables in `state.rs`, for example `functions`
  (`rust/engine/ironhorse-vm/src/interp/state.rs:566`), `bound_functions` (`:582`),
  `wrapper_data` (`:1672`), `arrays` (`:1705`),
  `typed_arrays` (`:2059`), `promise_functions` (`:2806`) and `id_map` (`:91`).
- **Design:** an in-crate, safe `BuildHasher` for integer keys (Fx-style multiply, or identity
  plus a mix), applied through a type alias so the change is mechanical.
  Arena indices are not attacker-chosen inputs; keep SipHash for `SymbolName` and other string
  keys.
- **Invariants:** `RandomState` order is already random per process, so nothing observable can
  depend on iteration order today.
  Audit every iteration over these maps (GC sweeps, the `snapshot_dirty::Tracked` wrapper, row
  writers, which already sort, for example `rust/engine/ironhorse-vm/src/interp/persist.rs:2451`)
  and confirm each still sorts or is order-insensitive.
- **Expected win:** hashing is 10-23% of self time in property, call, array and Map workloads;
  estimated 1.1-1.25x broadly.
- **Keep if:** `method_calls_fn` and `map_set` both improve by at least 10% in `Ir`, and no
  workload's wall time regresses beyond noise.
  A broad `Ir` win below 1.25x wall time is still a keep under the tiebreak rule.

### 2.2 Array index keys without `to_string` and a symbol lookup

- **Porffor:** related to T19, `compiler/builtins/_internal_object.ts:182-184`.
- **Ironhorse:** `rust/engine/ironhorse-vm/src/interp/property.rs:643` (every `a[i] = v`),
  `rust/engine/ironhorse-vm/src/interp/property/keys.rs:559-560` (`index_read_key_id`),
  `rust/engine/ironhorse-vm/src/interp/natives/array.rs:1617-1619` (per pushed element).
- **Design:** maintain a derived count of interned names that are canonical array indices,
  updated where names are interned.
  When it is zero, the lookup's answer is `None` without formatting; otherwise consult a
  `HashMap<u32, u16>` built alongside.
  Rebuild it from the name table on restore.
- **Invariants:** read-only and unmetered; the derived map is not persisted.
  The name table is positional and must not change.
- **Expected win:** about 25% of `array_rw_fn` (`SymbolIds::get` under these sites).
- **Keep if:** `array_rw_fn` `Ir` falls by at least 15%.

### 2.3 Overwrite an existing own writable data property in place

- **Porffor:** related to T7's own-hit set cache, `compiler/builtins/_internal_object.ts:2168-2170`.
- **Ironhorse:** `rust/engine/ironhorse-vm/src/interp/property/ordinary.rs:794-808`
  (`set_in_place_walk`), `:1018-1028` (`ordinary_set_on_receiver`), `:212`, `:226`, `:266`
  (`ordinary_define_own_property`).
- **Design:** when the receiver is the instance, the instance is ordinary (not a proxy, array,
  typed array or arguments object), and `find_property` hits a slot that has no accessor flag and
  no `XS_DONT_SET`, write `kind` and `value` through `slots.get_mut` and return.
  Everything else falls through unchanged.
- **Invariants:** an overwrite meters nothing on either path
  (`rust/engine/ironhorse-vm/src/interp/dispatch.rs:530-534`).
  `get_mut` keeps `snapshot_dirt` and `property_index.will_mutate`
  (`rust/engine/ironhorse-vm/src/value.rs:1305-1318`); do not bypass it.
  Sealed and frozen state lives in the flags, so honouring `XS_DONT_SET` covers it.
- **Expected win:** estimated 1.3-1.5x on `prop_getset_fn` and on methods that write `this.x`.
- **Keep if:** `prop_getset_fn` reaches at least 1.25x over the Phase 1 tree.

### 2.4 Direct global `var` access

- **Porffor:** none (FINDINGS E6).
- **Ironhorse:** `rust/engine/ironhorse-vm/src/interp/dispatch/environment.rs:91-113` (read) and
  `:193` (`dispatch_set_variable`), paired with `dispatch_eval_reference` (`:6`).
- **Design:** `environment.global_props` already maps id to `SlotIndex`.
  When the global object is not exotic and that slot is a plain data slot (no accessor flag, and
  for writes no `XS_DONT_SET`), read or write it directly; otherwise take the existing path.
- **Invariants:** global reads meter nothing beyond dispatch.
  `typeof` of an unresolvable name, accessors installed with `Object.defineProperty(globalThis,
  ...)`, a frozen global and `with`/eval environments (already split off by the `envref.kind`
  check) must behave exactly as now.
  Add tests for each before the change.
- **Expected win:** estimated 1.5-2x on script-level loops; `int_loop` is 2.1x slower than
  `int_loop_fn` today.
- **Keep if:** `int_loop` reaches at least 1.25x and `dispatch_ms`/`slots_ms` do not regress.

## Phase 3: Porffor-structural ideas

These add derived state.
Each must be bounded, unpersisted, empty or rebuilt on restore, and keyed by exact key ids, never
by hashes of names (FINDINGS F1, F6).
Order: T19 and T10 first (monotone flags, cheapest to prove), then T8, then T7, then T11.

### 3.1 T19: no index keys on prototypes

- **Porffor:** `compiler/builtins/_internal_object.ts:182-184`,
  `compiler/builtins/array.ts:345-352`.
- **Ironhorse:** the push path walks prototypes per element
  (`rust/engine/ironhorse-vm/src/interp/natives/array.rs:1617-1621`); hole reads fall to
  `index_read_key_id` (`rust/engine/ironhorse-vm/src/interp/property/keys.rs:559-560`).
- **Design:** a monotone `index_keys_on_prototypes: bool`, set when an index-shaped key is defined
  on any object that is, or later becomes, a prototype, and when a prototype carrying one is
  installed.
  While false, holes read as `undefined` and pushes skip the walk.
  Recompute on restore by scanning prototypes, or persist nothing and start conservative (`true`)
  until a scan clears it.
- **Invariants:** a flag that is wrongly false is a correctness bug, so enumerate every definer
  (`defineProperty`, ordinary set, `setPrototypeOf`, `Object.create`, class heritage) in tests.
- **Expected win:** on top of 2.2, the remaining prototype walk in `array_rw_push`.
- **Keep if:** `array_rw_push` improves by at least 10% in `Ir`.

### 3.2 T10: exact filter of keys that can intercept assignment

- **Porffor:** `compiler/render.js:4461-4462`, `compiler/builtins/_internal_object.ts:1137-1142`.
- **Ironhorse:** the set walk (`rust/engine/ironhorse-vm/src/interp/property/ordinary.rs:794-808`),
  which looks for setters and read-only properties up the chain when creating an own property.
- **Design:** a bitset indexed by key id, set whenever an accessor or a non-writable data property
  is defined under that id anywhere; never cleared.
  Proxies and other exotic receivers bypass it (per receiver, or a global "a proxy exists" bit).
  When the key's bit is clear, `obj.newKey = v` skips the walk.
  Rebuild on restore by scanning, since monotone bits snapshot trivially but must not enter rows.
- **Invariants:** creation still allocates the same property slot and charges the same.
- **Expected win:** not measured; constructor-heavy code (`this.x = v` creating properties).
  Add a roster workload for it in Phase 0 style before implementing.
- **Keep if:** the new workload improves by at least 1.25x.

### 3.3 T8: prototype-chain cache validated by a flagged-prototype epoch

- **Porffor:** `compiler/builtins/_internal_object.ts:565-580`, `:1356-1360`, `:1386-1387`.
- **Ironhorse:** the get walk (`rust/engine/ironhorse-vm/src/interp/property/ordinary.rs:711-733`)
  and its double own lookup (`:693`, `:712`).
- **Design:** a side table keyed by `(receiver's prototype SlotIndex, key id)` recording the
  holder's property slot (or "absent").
  Flag every prototype that enters an entry (a side bitset, not a `Slot` flag, so rows are
  unchanged).
  Bump a global epoch on any key add, delete, accessor change, flag change or prototype change of
  a flagged object.
  An own-property check on the receiver still runs first, because Ironhorse has no receiver shape
  to rule out shadowing.
- **Invariants:** reads are unmetered and the walk's getter calls must happen identically;
  a hit returns the same slot the walk would.
  Slot reuse after GC must invalidate (bump the epoch on sweep, or clear the table).
- **Expected win:** estimated 1.2x on `method_calls_fn` (prototype hit one level up).
- **Keep if:** `method_calls_fn` reaches at least 1.25x over the Phase 2 tree.

### 3.4 T7: inline caches keyed by bytecode offset

- **Porffor:** `compiler/builtins/_internal_object.ts:1333-1337`, `compiler/codegen.js:5044-5045`
  (no caches for run-once code, T23).
- **Ironhorse:** GET_PROPERTY and SET_PROPERTY
  (`rust/engine/ironhorse-vm/src/interp/dispatch.rs:553-557`,
  `:530-534`).
- **Design:** a side table keyed by `(code identity, pc)`, holding `(owner SlotIndex, key id) →
  property SlotIndex` for own hits and T8 entries for prototype hits.
  Allocate an entry on a site's second execution only, so module bodies do not fill it (T23).
  Bound its size and clear it on restore and on GC.
  The bytecode is untouched and nothing is persisted.
- **Invariants:** a hit must charge exactly what a miss charges (these opcodes charge only
  dispatch, so that is nothing), and must not change allocation.
  `designs/ironhorse-engine.md:399-401` forbids fast paths whose cost differs from the metered
  count; this one does not differ, but say so in the code.
- **Expected win:** not estimated by the survey; most of `find_property` (4.7-11%) on property
  workloads after 2.3 and 3.3.
- **Keep if:** `prop_getset_fn` and `method_calls_fn` each improve by at least 10% in `Ir` over
  the 3.3 tree; drop it if 3.3 already captured the win.

### 3.5 T11: an ASCII bit for strings

- **Porffor:** `compiler/codegen.js:4692-4694`, `compiler/render.js:4752`.
- **Ironhorse:** strings are UTF-16BE (`rust/engine/ironhorse-vm/src/interp/strings.rs:9-17`), so
  indexing is already O(1); the bit can only speed conversions, for example
  `SymbolName::from_units` (3.5% of `prop_getset_fn`) and `be16_to_units`.
- **Design:** a derived per-chunk "all code units below 0x80" bit, computed when the chunk is
  written and kept outside the chunk bytes.
- **Invariants:** chunk bytes and lengths unchanged; the bit is not persisted and is recomputed
  lazily after restore.
- **Expected win:** unknown; profile first, after Phase 1.4 has removed the concat round trip.
- **Keep if:** a string-heavy workload (`json`, or a new one) improves by at least 10% in `Ir`;
  otherwise do not start.

## Phase 4: build level

### 4.1 T24: PGO, LTO and codegen units

- **Porffor:** `compiler/index.js:152-153` (LTO), `:163-164` (PGO), `:195-196`
  (`-ffp-contract=off`).
- **Ironhorse:** `rust/engine/Cargo.toml:30-31`; the release profile sets only `overflow-checks`.
- **Design:** try `lto = "fat"` and `codegen-units = 1` in a separate profile first, then
  `-Cprofile-generate`/`-Cprofile-use` trained on the roster plus a test262 subset.
- **Determinism checks:**
  - Rust does not contract floating point by default, and there is no `mul_add` in
    `rust/engine/ironhorse-vm/src` today; keep it that way, add no `target-feature=+fma` or
    `target-cpu` flags, and run the full golden and test262 suites on the optimised build.
  - Computrons do not depend on code generation, but the native stack heights do: the
    stack-height baseline records the compiler, target and profile, and refuses a mismatch
    (`rust/engine/benches/stack_height.py:7-10`).
    A new release profile needs a new baseline measured honestly, and the depth budget
    (`rust/engine/ironhorse-vm/src/interp.rs:409-425`) must still hold on the smallest supported
    host stacks (`rust/engine/STACK-DEPTH-REFACTOR.md`).
  - PGO makes the shipped binary depend on a training run; pin the profile data and the training
    inputs, and make the build reproducible from them.
- **Expected win:** Porffor's own estimate is about 1% for LTO on its split builds; PGO is
  commonly 10-30% on interpreters, which is not measured here.
- **Keep if:** the roster geomean improves by at least 10% with no workload worse than noise, and
  stack heights stay within the existing depth budget.

## Deferred or rejected

| Item | Status | Reason |
|---|---|---|
| Loop-header slimming (survey #9, `rust/engine/ironhorse-vm/src/interp/dispatch.rs:222-334`) | Deferred until after Phase 1 | Estimated 15-25% on simple-op code, but it edits the meter-check and decode-error paths directly; the 4096-boundary positions, `StepLimit` values and failing pc must stay identical, and the frame gate is tight. |
| Call setup pooling and lazy `id_map` (#10, `rust/engine/ironhorse-vm/src/interp/frames.rs:340`) | Pooling deferred to after Phase 2; lazy `id_map` deferred indefinitely | Pooling is low risk; the lazy `id_map` is a persisted row (`rust/engine/ironhorse-vm/src/interp/persist.rs:2459`) and must reproduce shadowing and `UNWIND` pruning exactly. |
| Single own lookup in the get walk (#11) | Folded into 3.3 | T8 removes the same repeated lookups. |
| Dense array storage (#12, `rust/engine/ironhorse-vm/src/bulk.rs:173-185`) | Deferred | Medium risk; `side_charge` (`rust/engine/ironhorse-vm/src/bulk.rs:194`) must charge the same, and the row stream must stay ascending. |
| `Slot` double tag and `Result` plumbing (#13) | Deferred | Broad refactor for an estimated 5-10%. |
| Direct native-method dispatch (#14, T13) | After Phase 2 | Depends on the cheaper lookups; metering must match the generic path exactly. |
| Static key ids instead of strings (#15) | Opportunistic, any phase | Zero risk; do it when touching each site. |
| `s[i]` temporaries (#16) | Opportunistic | Small; the chunk itself must stay. |
| Shapes (T6), append builders (T12), arena redesign (T20), generational GC (T21) | Rejected | Change allocation sequence, heap image or determinism (FINDINGS F4, F7). |
| Any compiler change (T14-T16, T25) | Rejected | Bytecode must equal XS's (`rust/engine/ironhorse-compile/tests/coder_byte_identity.rs:1-9`). |
| Caching single-character strings or reusing chunks | Rejected | Changes allocation and metering. |
| Unchecked indexing, computed goto, turning off `overflow-checks` | Rejected | `forbid(unsafe_code)` and the release profile policy. |
| Re-pricing string concatenation (FINDINGS §G) | Out of scope | A meter release question, not an optimisation. |

## Results

Measured outcomes for every item attempted, wins and losses alike, with the A/B raw data and
callgrind counts, are recorded in `rust/engine/PORFFOR-RESULTS.md`.
