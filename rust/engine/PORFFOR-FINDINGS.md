# Research findings: what Porffor teaches Ironhorse

Audience: engine maintainers deciding which interpreter speed-ups to try next.
Companion documents: [PORFFOR-PLAN.md](PORFFOR-PLAN.md) orders the work, and
`PORFFOR-RESULTS.md` will record the measured outcomes.

## Provenance

- **Porffor:** <https://github.com/CanadaHonk/porffor> at commit
  `c9af40c8c6913e04d491412ae9fe0f34b97b51df`, committer date 2026-11-16T23:22:25-08:00
  ("runtime/node: stream/consumers").
  Porffor paths below (`compiler/...`, `README.md`) are relative to that repository's root and
  valid at exactly that commit.
- **Ironhorse:** this repository at commit `0368767778a232c38721ff8a1e88d8f68272624d`,
  committer date 2026-11-17T03:58:38Z.
  Ironhorse paths are relative to this repository's root (`rust/engine/...`, `designs/...`).
  The measurements were taken on 2026-11-22 against that commit.
- **Website:** porffor.dev was unreachable from the research sandbox (DNS failure; the host is
  outside the session's allowed network), so the repository at the pinned commit is the only
  source.
  Nothing from the Porffor clone was built or executed; it was only read.
- **Which Porffor:** Porffor commit `785b15a7` ("rewrite", 2026-07-15) deleted the whole Wasm-era
  pipeline (`compiler/2c.js`, `opt.js`, `cyclone.js`, `pgo.js` and the rest).
  Only the current JS → tree IR → C compiler is cited here; nothing relies on the deleted files.
- **Measurement host:** a shared 4-core Linux x86_64 VM with 15 GB of memory, rustc 1.91.1, with
  another light agent running concurrently.
  There is no `perf` on the host, so profiles are valgrind 3.22 callgrind instruction counts
  (`Ir`).
- **XS oracle:** not measured.
  `c/moddable` is an uninitialised submodule in the sandbox, so `xs-oracle` cannot build without
  fetching Moddable.
  The last recorded comparison, `rust/engine/benches/results/1e-xs-microbenchmarks.json`, was taken
  on macOS arm64 at an older commit against the shim oracle (`rust/engine/xs-oracle/build.rs`), not
  a tuned xsnap.
  Its geometric mean is 1.235x XS, with properties at 1.17x, calls 0.96x and strings 0.79x.
  Do not read that as "Ironhorse runs at XS speed": the workloads are short and the oracle is not a
  production build.

Every `path:line` in this document was re-opened at the pinned commit while writing it:
Porffor citations with `git show c9af40c8:<path>` in the read-only clone, Ironhorse citations with
`git show 03687677:<path> | sed -n 'N,Mp'`.
Raw measurement files live in the research session's scratch directory and are not tracked; the
numbers below are copied from them unchanged.

## A. Two engines, two architectures

### Porffor

Porffor is an ahead-of-time compiler.
`README.md:23`: "Porffor is a 100% AOT compiled JS engine/runtime. There is nothing interpreted or
compiled just-in-time. Porffor compiles JS to C (with an IR inbetween)."
The pipeline is "AST -> IR tree -> C text (render.js), no lowering passes between"
(`compiler/ir.js:1-2`), and clang does the rest.
Its speed comes from three sources:

- whole-program static knowledge: type inference, unboxed locals, dead type-case pruning and
  closed-world builtin selection;
- an object model built for caching: hidden-class shapes, per-site inline caches and a
  megamorphic table, on by default (`compiler/prefs.js:1` lists `'ic'`);
- a C runtime whose generic helpers keep a tiny inline fast path and an out-of-line slow path.

### Ironhorse

Ironhorse is a bytecode interpreter that must behave as XS does, observably and in cost.
The constraints that decide what can transfer:

| Constraint | Where it is pinned | What it rules out |
|---|---|---|
| Byte-identical bytecode | `rust/engine/ironhorse-compile/tests/coder_byte_identity.rs:1-9` ("must equal `xs_oracle::run(src).bytecode` byte for byte") | Any compiler change: superinstructions, folding, peepholes, typed opcodes, inferred unboxing |
| No JIT and no cost-divergent fast paths | `designs/ironhorse-engine.md:399-401` ("no fast paths whose cost differs from the metered count") | Quickening in place; any cache whose hit charges differently from its miss |
| Computron determinism | `rust/engine/ironhorse-meter/src/lib.rs:15` (`COST_TABLE_VERSION = "ironhorse-meter-9"`), `rust/engine/ironhorse-vm/src/interp/dispatch.rs:304-305` (one `tick_code` and one `n_dispatched` per opcode), `rust/engine/ironhorse-vm/src/meter.rs:227` and `:248` (slot and chunk allocation are metered) | Changing which slots or chunks are allocated, or where `check_meter` runs (`rust/engine/ironhorse-vm/src/interp/dispatch.rs:222-228`, `:1003`) |
| Snapshot wire format | `rust/engine/ARCHITECTURE.md:386-388` (format 24, store 36, row 5), `rust/engine/ARCHITECTURE.md:59-60` (in-memory `Slot` layout is free; rows are encoded explicitly) | Shapes or any heap layout that leaks into rows (`rust/engine/ironhorse-vm/src/interp/snapshot_views.rs:12-16`, `rust/engine/ironhorse-vm/src/interp/persist.rs:2459`) |
| `forbid(unsafe_code)` | `rust/engine/ironhorse-vm/src/lib.rs:1`, `rust/engine/ironhorse-snapshot/src/lib.rs:1`, policy at `rust/engine/README.md:89` | NaN-boxing through pointer casts, computed goto, unchecked indexing |
| `overflow-checks = true` | `rust/engine/Cargo.toml:30-31` | Silent wrapping; every proven-safe arithmetic must say `wrapping_*`/`checked_*` |
| Native stack-frame gate | `rust/engine/STACK-DEPTH-REFACTOR.md:863` (`dispatch_at_inner` 4,592 B native, 10,832 B Cranelift), `rust/engine/benches/README.md:155-156` (fails past 2% or 256 B), `rust/engine/ironhorse-vm/src/interp.rs:409-425` (depth budget) | Large fast paths inlined into the dispatch loop |

So the Porffor lessons that transfer are the runtime ones: handler fast paths, derived side tables
that are never persisted, monotone "nothing unusual happened" flags, and build settings.
Anything that works by compiling differently does not.
Where Porffor already does something Ironhorse inherits from XS (interned key ids, `arguments`
decided at compile time), there is nothing to port.

## B. Baseline: where the time goes

### B.1 Existing gated fixtures

Three process runs, each the median of five samples.
"Spread" is (max - min) / 2 / median across process runs.

| metric | runs (ms) | median | spread | `benches/baseline.json` (other host, pin 3a30ab1e9) |
|---|---|---|---|---|
| dispatch_ms | 1640, 1211, 1368 | 1368 | ±16% | 1823 |
| slots_ms | 748, 721, 684 | 721 | ±4% | 743 |
| chunks_ms | 35, 39, 40 | 39.4 | ±6% | 40.3 |
| calls_ms | 1068, 997, 1045 | 1045 | ±3% | 1173 |
| recursion_ms | 350, 431, 384 | 384 | ±11% | 397 |
| callbacks_ms | 717, 703, 553 | 703 | ±12% | 772 |
| getter_ms | 1016, 1145, 822 | 1016 | ±16% | 1485 |

The module controls (`*_execution_bench`) are mostly 1-100 ms and move ±10-50% between runs.
The two largest are `DISPATCH_MODULE/descriptors` at 1072 ms ±8% and `DISPATCH_MODULE/proxy` at
603 ms ±8%.

### B.2 Micro roster

The roster (21 workloads, kept in scratch as `porffor_micro_bench.rs`; Phase 0 of the plan commits
it) runs each source with one warm-up and five samples per process and reports the median.
Plain names use top-level `var`s, which live on the global object; `_fn` names are the same loops
inside a function, using locals.

| workload | runs | median (ms) | spread | computrons | dispatched | ns/op |
|---|---|---|---|---|---|---|
| int_loop | 6 | 966.7 | ±5% | 29,500,034 | 29,000,031 | 33.3 |
| float_arith | 6 | 331.9 | ±20% | 9,525,048 | 9,300,044 | 35.7 |
| prop_getset | 6 | 618.3 | ±11% | 10,875,058 | 10,800,053 | 57.2 |
| array_rw_push | 6 | 696.2 | ±6% | 17,291,597 | 14,400,136 | 48.3 |
| string_concat (5k x `+= 'ab'`) | 6 | 54.4 | ±7% | 97,920 | 95,032 | 572 |
| string_charcode | 6 | 216.9 | ±12% | 6,100,057 | 6,000,053 | 36.2 |
| string_index | 6 | 156.7 | ±17% | 5,123,820 | 5,072,281 | 30.9 |
| func_calls | 6 | 364.7 | ±6% | 12,450,050 | 12,300,045 | 29.6 |
| closures | 6 | 341.5 | ±12% | 10,950,081 | 10,800,074 | 31.6 |
| method_calls | 6 | 406.2 | ±12% | 10,875,082 | 10,800,073 | 37.6 |
| map_set | 6 | 161.2 | ±7% | 3,188,714 | 3,100,068 | 52.0 |
| typed_array | 6 | 319.8 | ±2% | 8,650,525 | 8,400,507 | 38.1 |
| json | 6 | 285.9 | ±3% | 404,324 | 170,087 | 1681 |
| int_loop_fn | 3 | 326.6 | ±5% | 21,000,041 | 21,000,037 | 15.6 |
| empty_loop_fn | 3 | 89.1 | ±2% | 9,000,036 | 9,000,032 | 9.9 |
| prop_getset_fn | 3 | 388.0 | ±1% | 8,100,065 | 8,100,059 | 47.9 |
| array_rw_fn | 3 | 385.0 | ±15% | 12,716,576 | 10,000,117 | 38.5 |
| string_charcode_fn | 3 | 79.6 | ±25% | 4,000,056 | 4,000,052 | 19.9 |
| func_calls_fn | 3 | 165.4 | ±20% | 9,900,053 | 9,900,047 | 16.7 |
| method_calls_fn | 3 | 300.4 | ±3% | 9,600,082 | 9,600,073 | 31.3 |
| typed_array_fn | 3 | 106.6 | ±3% | 5,950,381 | 5,800,372 | 18.4 |

Noise: single samples inside one process range up to ±25-40%.
Medians across process runs move ±2-20%, ±5-12% typically.
Only effects above about 1.25x can be trusted from three runs on this host, which is also the
floor `rust/engine/benches/run.py:176` uses.
Computron and dispatch counts were bit-identical across every run of every binary.

The dispatch floor is about 10 ns per opcode (`empty_loop_fn`), and local integer code runs at
15-17 ns per opcode.
Code that touches top-level `var`s, object properties, arrays or calls runs at 30-57 ns per opcode.

### B.3 Profiles (callgrind, self `Ir`, panic symbolisation excluded)

| workload | Ir | top self-time functions |
|---|---|---|
| empty_loop_fn | 1.49 G (≈166 Ir/op) | dispatch_at_inner 53.1%, relational 10.7%, encoded_instruction_len 7.2%, to_number_value 7.1%, exec_increment 7.0%, to_primitive_with_hint 5.9% |
| int_loop_fn | 4.76 G | dispatch_at_inner 37.9%, to_number_value 13.4%, to_primitive_with_hint 9.2%, binary_bit 7.5%, binary_arith 6.1%, encoded_instruction_len 5.3%, relational 3.4%, to_numeric_integer_value 3.1%, op_add 2.5% |
| int_loop (global) | 13.0 G | dispatch_at_inner 16.6%, SlotArena::find_property 11.0%, hash_one 10.1%, exec_get_variable 6.3%, ordinary_get_own_descriptor 6.2%, to_number_value 4.9%, sip write 4.0%, ordinary_define_own_property 3.9%, exec_set_variable 3.3% |
| prop_getset_fn | 5.10 G | dispatch_at_inner 13.7%, hash_one 11.6%, find_property 10.7%, sip write 6.0%, dispatch_get_property 5.9%, `SymbolName: From<&str>` 5.0%, ordinary_get_own_descriptor 4.3%, SymbolName::from_units 3.5%, _int_free 2.7%, ordinary_define_own_property 2.6% |
| method_calls_fn | 4.15 G | dispatch_at_inner 18.9%, hash_one 14.0%, sip write 6.0%, find_property 4.7%, dispatch_get_property 3.6%, _int_free 3.3%, `SymbolName: From<&str>` 3.1%, ordinary_get_own_descriptor 2.9%, malloc 2.6% |
| array_rw_fn | 4.18 G | dispatch_at_inner 21.7%, hash_one 10.1%, array_item_set 4.8%, BTreeMap::get 4.4%, sip write 4.3%, ArrayData::store_item 3.5%, _int_free 2.9%, to_number_value 2.5% |
| func_calls_fn | 2.43 G | dispatch_at_inner 35.0%, hash_one 9.6%, encoded_instruction_len 5.0%, to_number_value 3.9%, enter_call 3.9%, exec_run 3.6%, sip write 3.3%, _int_free 2.9%, malloc 2.4% |
| string_charcode_fn | 1.05 G | dispatch_at_inner 33.2%, to_number_value 7.1%, to_primitive_with_hint 4.6%, exec_run 4.1%, binary_arith 3.7%, native_method_string 3.5%, relational 3.0% |
| typed_array_fn | 1.61 G | dispatch_at_inner 32.7%, hash_one 6.5%, to_number_value 5.3%, to_primitive_with_hint 4.6%, exec_at 3.1%, op_add 2.9%, typed_array_element_get 2.4% |
| map_set (global) | 1.99 G | hash_one 15.2%, dispatch_at_inner 11.7%, find_property 11.2%, sip write 7.0%, exec_get_variable 5.0%, ordinary_get_own_descriptor 4.7% |
| string_concat | 0.74 G | units_to_be16 40.6%, Vec::from_iter (be16_to_units) 27.1%, memcpy 14.2%, malloc/realloc ≈5% |
| json | 3.85 G | `SymbolName: From<&str>` 10.9%, _int_free 8.9%, from_units 7.8%, Vec::from_iter 7.3%, hash_one 6.4%, sip 6.1%, realloc 5.9%, malloc 5.1%; 72% inclusive under `install_pending_intrinsics` |

Cost families as a share of each workload's self time:

| workload | SipHash/hashbrown | malloc/free | SymbolName from &str | find_property | encoded_instruction_len | coercion helpers |
|---|---|---|---|---|---|---|
| empty_loop_fn | 0.1% | 4.2% | 0% | 0% | 7.2% | 13.0% |
| int_loop_fn | 0% | 1.1% | 0% | 0% | 5.3% | 25.7% |
| int_loop | 14.6% | 0.3% | 0% | 11.0% | 3.2% | 9.4% |
| prop_getset_fn | 18.8% | 12.9% | 9.9% | 10.7% | 2.1% | 4.3% |
| method_calls_fn | 22.6% | 13.8% | 6.2% | 4.7% | 2.9% | 2.8% |
| array_rw_fn | 16.7% | 11.8% | 4.7% | 0.6% | 2.9% | 4.6% |
| func_calls_fn | 17.2% | 10.8% | 0% | 0% | 5.0% | 6.6% |
| string_charcode_fn | 2.3% | 8.7% | 0% | 2.0% | 4.7% | 11.7% |
| typed_array_fn | 9.7% | 5.4% | 0% | 0% | 4.3% | 10.8% |
| map_set | 23.5% | 6.9% | 3.2% | 11.2% | 2.2% | 2.5% |
| string_concat | 1.3% | 9.4% | 0% | 0.8% | 0.2% | 0.2% |
| json | 12.5% | 44.2% | 23.1% | 0.7% | 0.1% | 0% |

In words, the time goes to:

1. generic coercion for int/int arithmetic and comparison (25.7% of `int_loop_fn`);
2. SipHash in about 50 `std::collections::HashMap` side tables keyed by `SlotIndex`
   (10-23% of property, call, array and Map workloads);
3. accidental `&str` → `SymbolName` allocation plus SipHash on hot paths, one per `o.x` read;
4. property get and set walks that repeat the same own lookup two to four times;
5. a `BTreeMap` for array elements;
6. per-call heap allocations (args `Vec`, locals `Vec`, `id_map` `HashMap`).

Per-operation attributions from the callgrind caller graphs:

- `SymbolIds::get` costs 1,143 Ir per call; 1.2 M calls come from `dispatch_get_property` in
  `prop_getset_fn` (27% of that workload) and 600 k from `method_calls_fn`.
- `a[i] = v` costs 1,133 Ir in `SymbolIds::get(index.to_string())`; each `push` costs about
  1,000 Ir in `array_new_index_writes_fast_safe`.
- `install_pending_intrinsics` runs 25,001 times in `json` (5 per `stringify`), at about 111 k Ir
  each: 2.77 G of the workload's 3.85 G Ir.
- Global `int_loop`: each `exec_get_variable` spends about 119 Ir in SipHash (5 M reads).
- `empty_loop_fn`: about 55 of the 166 Ir per opcode go to the loop-header checks, 20 Ir of it to
  `encoded_instruction_len`; one int `<` int costs 354 Ir in `relational`; `exec_increment` costs
  105 Ir; `to_primitive_with_hint` is not inlined and costs 22 Ir per call, four times per
  comparison.

### B.4 Proof-of-concept experiment

Three small edits were applied to a scratch copy of the engine (not to the tree):
the `disposed` guard reorder (E1 below), number fast paths in `binary_arith`, `relational`,
`op_add` and `binary_bit` (D1), and a String+String byte concatenation in `concat_add` (D2).
`golden_computrons` passed on the patched build.
The A/B alternated the two binaries over three rounds:

| workload | base (ms) | patched (ms) | ratio | computrons equal |
|---|---|---|---|---|
| int_loop_fn | 348.0 | 156.2 | 0.45x | yes |
| prop_getset_fn | 422.7 | 246.8 | 0.58x | yes |
| string_concat | 55.8 | 30.3 | 0.54x | yes |
| typed_array_fn | 104.0 | 68.6 | 0.66x | yes |
| string_charcode_fn | 81.3 | 59.6 | 0.73x | yes |
| method_calls_fn | 296.8 | 224.3 | 0.76x | yes |
| prop_getset | 586.0 | 450.3 | 0.77x | yes |
| func_calls_fn | 155.6 | 122.2 | 0.79x | yes |
| closures | 430.7 | 340.4 | 0.79x | yes |
| float_arith | 349.2 | 283.7 | 0.81x | yes |
| int_loop | 939.7 | 783.9 | 0.83x | yes |
| empty_loop_fn | 87.2 | 75.0 | 0.86x | yes |
| method_calls | 403.5 | 359.6 | 0.89x | yes |
| array_rw_fn | 367.5 | 329.0 | 0.90x | yes |
| string_index | 169.7 | 152.8 | 0.90x | yes |
| func_calls | 364.3 | 329.9 | 0.91x | yes |
| typed_array | 312.3 | 298.9 | 0.96x | yes |
| array_rw_push | 675.5 | 663.2 | 0.98x | yes |
| map_set | 155.5 | 155.1 | 1.00x | yes |
| json | 282.6 | 286.4 | 1.01x | yes |
| string_charcode | 194.7 | 232.1 | 1.19x (inside its ±12% baseline spread) | yes |

Two cautions.
First, the three edits were measured together, so the split of a combined win such as
`prop_getset_fn`'s 0.58x (which exercises both the arithmetic and the `disposed` guard) is
inferred from the profiles, not measured.
Second, the patched build was not run through the stack-height gate, test262 or the fuzz lane.

## C. Technique map

Verdicts: **apply now** (Phase 1 of the plan), **apply later** (a later phase, or after a
prerequisite), **does not transfer**.
"T" ids are the Porffor technique catalogue's numbering; "#n" refers to the survey's ranked
Ironhorse candidates, which section E describes.

| Porffor technique | Porffor citation (c9af40c8) | Ironhorse site (03687677) | Verdict and reason |
|---|---|---|---|
| T1 two-register value in flight, NaN-boxed at rest | `compiler/render.js:4342-4343`, `:4438-4442` | `rust/engine/ironhorse-vm/src/value.rs:565-629` (`Payload` enum plus a separate `kind` byte) | Apply later, as #13: keep hot temporaries as an unpacked pair and stop returning `Result<Slot, Step>` through memory. NaN-boxing itself is not needed: the layout is free but the wire record is separate (`rust/engine/ARCHITECTURE.md:59-60`). |
| T2 type tags with semantic bit flags | `compiler/types.js:1-4`, `compiler/codegen.js:5289-5291` | `rust/engine/ironhorse-vm/src/value.rs:459` (`Kind`), `rust/engine/ironhorse-vm/src/interp/dispatch/property_read.rs:15-19` (exotic class found by hash probes) | Apply later: a per-instance "exotic class" byte replaces up to about 15 side-table probes (#5 alternative). Not in `Slot`, which is free but hot. |
| T3 inline fast path, sentinel to out-of-line slow path | `compiler/render.js:5459-5463`, `:5474-5475`, `:5500-5503`, `compiler/codegen.js:1217-1221` | `rust/engine/ironhorse-vm/src/interp/coerce.rs:443`, `:544`, `:1019`, `:474` | **Apply now** (D1). |
| T4 integer fast paths inside double semantics | `compiler/render.js:4567-4572`, `:4575-4577` | `rust/engine/ironhorse-vm/src/interp/numeric.rs:367-413` (int arms already exist), `rust/engine/ironhorse-vm/src/value.rs:3042-3050` (`to_int32` via `rem_euclid`) | **Apply now** for int/int bitwise and compare (D1); apply later for the i64-cast `to_int32` on doubles. |
| T5 truthiness as one or two compares | `compiler/render.js:4509-4511` | `rust/engine/ironhorse-vm/src/interp/coerce.rs:424-432`, `rust/engine/ironhorse-vm/src/interp.rs:3652-3660` | Does not transfer: Ironhorse already matches on the payload in one `match`; `truthy` is 1.3% of `empty_loop_fn`. |
| T6 hidden-class shapes | `compiler/builtins/_internal_object.ts:186-188`, `:528-533` | `rust/engine/ironhorse-vm/src/value.rs:1325` (`find_property` over linked property slots), `rust/engine/ironhorse-vm/src/interp/snapshot_views.rs:12-16` | Does not transfer: it changes the heap layout, the slot allocation sequence that metering counts, and the snapshot rows. |
| T7 per-site inline caches | `compiler/builtins/_internal_object.ts:1333-1337`, `:1363-1365` | `rust/engine/ironhorse-vm/src/interp/dispatch.rs:553-557` (GET_PROPERTY charges only dispatch), `rust/engine/ironhorse-vm/src/property_index.rs:1-2` (precedent for a derived, unpersisted index) | Apply later (Phase 3), keyed by `(code, pc)` in a side table, with T8 validation and charging unchanged. |
| T8 prototype-chain cache with flag plus global epoch | `compiler/builtins/_internal_object.ts:565-580`, `:1356-1360`, `:1386-1387` | `rust/engine/ironhorse-vm/src/interp/property/ordinary.rs:711-733` (the get walk) | Apply later (Phase 3); the most portable caching idea because it needs no shapes. |
| T9 compile-time key hashing | `compiler/codegen.js:3407-3408`, `compiler/builtins/_internal_object.ts:56-59` | `rust/engine/ironhorse-vm/src/interp/dispatch/property_read.rs:9-13` (bytecode already carries a `u16` key id) | Does not transfer: XS-style interned ids are already better. Its hash-only identity is an anti-finding (F1). |
| T10 filter of keys that can intercept assignment | `compiler/render.js:4461-4462`, `compiler/builtins/_internal_object.ts:1116-1119`, `:1137-1142` | `rust/engine/ironhorse-vm/src/interp/property/ordinary.rs:794-808` (`set_in_place_walk`), `:974` | Apply later (Phase 3), as an exact bitset indexed by key id. |
| T11 Latin-1 ByteString plus UTF-16 String | `compiler/codegen.js:4692-4694`, `compiler/render.js:4752`, `:4917-4925` | `rust/engine/ironhorse-vm/src/interp/strings.rs:9-17` (strings are UTF-16BE), `:130-142` (`concat_add`) | The representation does not transfer (chunk bytes are the heap image). The memcpy concatenation is **apply now** (D2). An ASCII bit is apply later (Phase 3). |
| T12 in-place append builders for `s += x` | `compiler/render.js:4715-4718`, `:4882-4885`, `compiler/codegen.js:1056-1058` | `rust/engine/ironhorse-vm/src/interp/strings.rs:136-140`, `rust/engine/ironhorse-vm/src/meter.rs:248` | Does not transfer: a builder changes which chunks are allocated, and without compiler-inserted seals aliasing cannot be proven. |
| T13 monomorphic builtin dispatch by receiver type | `compiler/codegen.js:2307-2311`, `:2363` | `rust/engine/ironhorse-vm/src/interp/invoke.rs:371-378` (`call_native_method_in_place`) | Apply later, as #14: an identity check on the resolved callee, charging as the generic path does. Closed-world pruning does not transfer. |
| T14 TypeSwitch with whole-program pruning | `compiler/codegen.js:2621-2624`, `compiler/render.js:873-874` | `rust/engine/ironhorse-vm/src/interp/dispatch.rs:297-301` (opcode `match`) | Does not transfer: Ironhorse runs `eval`, `Function` and restored snapshots, so no type can be ruled out; a Rust `match` already gives the jump table. |
| T15 folding in IR constructors | `compiler/ir.js:187-191` | `rust/engine/ironhorse-compile/tests/coder_byte_identity.rs:1-9` | Does not transfer: bytecode must equal XS's. |
| T16 unboxed numeric locals and parameters | `compiler/semantic.js:218-219`, `compiler/codegen.js:6577-6581` | `rust/engine/ironhorse-compile/tests/coder_byte_identity.rs:1-9`, `designs/ironhorse-engine.md:399-401` | Does not transfer: needs different bytecode or quickening. |
| T17 calling convention: hidden params, register thunks | `compiler/render.js:357-360`, `compiler/codegen.js:486-488` | `rust/engine/ironhorse-vm/src/interp/frames.rs:340` (fresh args `Vec` per call) | Thunks do not transfer. "No per-call allocation" applies later, as #10 (a `Vec` pool). |
| T18 precompiled builtins, comptime feature flags | `compiler/builtins.js:883-887`, `compiler/precompile.js:543-545` | `rust/engine/ironhorse-vm/src/interp/link.rs:1502-1525` (`install_pending_intrinsics` recomputes instead of consulting a "nothing changed" flag) | Closed-world flags do not transfer; their runtime form, monotone "has X ever happened" flags, applies later as T10 and T19. |
| T19 "no index keys on prototypes" flag | `compiler/builtins/_internal_object.ts:182-184`, `compiler/builtins/array.ts:345-352` | `rust/engine/ironhorse-vm/src/interp/property/keys.rs:559-560`, `rust/engine/ironhorse-vm/src/interp/natives/array.rs:1617-1621` | Apply later (Phase 3), after the Phase 2 index-key fix. |
| T20 4 GiB arena, headerless size-class pages | `compiler/render.js:4385-4386`, `:2239-2241` | `rust/engine/ironhorse-vm/src/value.rs:2506` (`ChunkArena::alloc`), `:1226` (`SlotArena::alloc`) | Does not transfer: allocation order and chunk layout are metered and snapshotted. Only the "no temporary" lesson applies, inside D2. |
| T21 generational GC, wall-clock nursery sizing | `compiler/render.js:4185-4189` | `rust/engine/ironhorse-vm/src/gc.rs:102`, `designs/ironhorse-engine.md:998` | Does not transfer: wall-clock heuristics break determinism (F4). |
| T22 cheap exceptions, static messages, cold throws | `compiler/render.js:4704-4707`, `:4373` | `rust/engine/ironhorse-vm/src/interp/unwind.rs:86` (`catchable_type_error_msg(String)`) | Apply later, limited to `#[cold]` on throw constructors; lazy messages would change allocation. |
| T23 run-once code gets no caches | `compiler/codegen.js:5044-5045`, `compiler/render.js:4365-4369` | `rust/engine/ironhorse-vm/src/property_index.rs:1-2` ("Only long chains are indexed") | Apply later, as a design rule for T7: allocate cache entries lazily. |
| T24 PGO, LTO, strict FP | `compiler/index.js:152-153`, `:163-164`, `:195-196` | `rust/engine/Cargo.toml:30-31` (release profile sets only `overflow-checks`) | Apply later (Phase 4). |
| T25 partial inlining of a leading guard | `compiler/render.js:489-490` | `rust/engine/ironhorse-vm/src/interp/frames.rs:323` (`enter_call`) | Does not transfer: an interpreter must push a frame to run any bytecode. |

## D. Findings rated "apply now"

### D1. Number fast paths in arithmetic, comparison, `+` and bitwise (T3, T4)

Porffor gives every generic numeric helper a single combined both-numbers test and leaves the
spec algorithm out of line:

`compiler/render.js:5461-5463`
```c
${sti}jsval porf_sub(jsval a, jsval b) {
  if (porf_jv_is_num(a) && porf_jv_is_num(b)) return porf_box_num(a.val - b.val);
  return porf_box_num(porf_to_num(a) - porf_to_num(b));
```

Comparison returns a sentinel that sends only the coercing cases to the full algorithm:

`compiler/render.js:5500-5503`
```c
  if (!porf_cmp_numish(a) || !porf_cmp_numish(b)) return 3;
  const f64 x = porf_to_num(a), y = porf_to_num(b);
  if (x != x || y != y) return 2;
  return x < y ? -1 : x > y ? 1 : 0;
```

Ironhorse runs the full coercion on every operand, even two `Integer` slots:

`rust/engine/ironhorse-vm/src/interp/coerce.rs:450-454` (`binary_arith`)
```rust
        let a_value = self.stack[n - 2];
        let b_value = self.stack[n - 1];
        let a = self.to_number_value(code, a_value)?;
        let b = self.to_number_value(code, b_value)?;
        self.stack.truncate(n - 2);
```

`relational` does `to_primitive` on both operands before it looks at the kinds
(`rust/engine/ironhorse-vm/src/interp/coerce.rs:551-555`), and `op_add` does
`to_primitive_default` twice, then truncates, pushes both values back and re-enters
`binary_arith`:

`rust/engine/ironhorse-vm/src/interp/coerce.rs:1047-1050`
```rust
        self.stack.truncate(n - 2);
        self.push(a);
        self.push(b);
        self.binary_arith(code, ArithOp::Add)
```

`binary_bit` takes the same route through `to_numeric_integer_value`
(`rust/engine/ironhorse-vm/src/interp/coerce.rs:481-491`) before an `i32` operation that needs
none of it.
The integer arithmetic itself already exists, Porffor-style, in `apply_arith`
(`rust/engine/ironhorse-vm/src/interp/numeric.rs:367-413`), including an exact integer `%`
(`:401-412`).
The cost is in the coercion that precedes it.

Profile evidence: coercion helpers are 25.7% of `int_loop_fn` and 13.0% of `empty_loop_fn`.
One int `<` int costs 354 Ir in `relational`, and `to_primitive_with_hint` (not inlined, returning
`Result<Slot, Step>` through memory) costs 22 Ir per call, four calls per comparison.
In the experiment, a kind check on both stack slots ahead of the coercion cut `int_loop_fn` to
0.45x, `typed_array_fn` to 0.66x and `float_arith` to 0.81x, with identical computrons.

Why it is safe: these opcodes charge nothing beyond dispatch (arithmetic has no handler charge at
all), the fast path calls the same `apply_arith`, so `-0`, NaN and integer overflow to number are
unchanged, and coercion of a number is the identity.
The constraint it must respect is the frame gate: the slow half must stay out of line, which is
the T3 shape exactly.

### D2. String+String concatenation on the stored bytes (T11's concat path)

Porffor concatenates two narrow strings by copying their payloads into one fresh allocation:

`compiler/render.js:4921-4925`
```c
  if (a.type == ${TYPES.bytestring} && b.type == ${TYPES.bytestring}) {
    const u32 s = porf_bstr_new(la + lb);
    memcpy(MEM + s + 4, MEM + pa + 4, la);
    memcpy(MEM + s + 4 + la, MEM + pb + 4, lb);
    return porf_box((f64)s, ${TYPES.bytestring});
```

Ironhorse stores every string as UTF-16BE code-unit bytes
(`rust/engine/ironhorse-vm/src/interp/strings.rs:9-17`), so two strings can be joined by copying
bytes in exactly the same way.
Instead, `concat_add` decodes both operands to `Vec<u16>`, joins them in a third `Vec`, and
re-encodes:

`rust/engine/ironhorse-vm/src/interp/strings.rs:131-140`
```rust
        let ua = self.to_string_units_metered(a);
        let ub = self.to_string_units_metered(b);
        ...
        self.meter.tick_string((ua.len() + ub.len()) as u64);
        let mut joined = Vec::with_capacity(ua.len() + ub.len());
        ...
        let off = self.chunks.alloc(&units_to_be16(&joined));
```

That is four copies and three temporary allocations per `+`, through `str_units`
(`rust/engine/ironhorse-vm/src/interp/strings.rs:26-28`) and `units_to_be16`
(`rust/engine/ironhorse-vm/src/interp/text.rs:24`).

Profile evidence: `units_to_be16` (40.6%), `Vec::from_iter` in `be16_to_units` (27.1%) and
`memcpy` (14.2%) make up 82% of `string_concat`.
The experiment's byte concatenation measured 0.54x with identical computrons.

Why it is safe: the chunk bytes are identical (UTF-16BE of the same code units), the charge is the
same `tick_string(code units)`, and exactly one chunk is allocated in both versions.
What does not transfer from Porffor here is the narrow representation itself and the append
builders (T12), both of which change allocation.
The same decode and re-encode round trip appears in `alloc_str_text`
(`rust/engine/ironhorse-vm/src/interp/strings.rs:78-81`), `new_string_metered` (`:103-106`) and
`to_string_slot_metered` (`:155-165`).

## E. Findings from the Ironhorse profile itself

Most of the measured cost is not something Porffor points at; it is Ironhorse-specific plumbing
that the profiles exposed.
Where a Porffor technique offers a matching design, the row says so, but the discovery came from
callgrind, not from reading Porffor.

| # | Finding | Ironhorse site | Evidence | Porffor relation |
|---|---|---|---|---|
| E1 (#2) | Every `o.x` read evaluates `symbol_ids.get("disposed")` first: a `SymbolName` allocation plus SipHash, before a cheaper `disposable_stacks` test. | `rust/engine/ironhorse-vm/src/interp/dispatch/property_read.rs:197-200`, `rust/engine/ironhorse-vm/src/symbols.rs:25-26` | `SymbolIds::get` 1,143 Ir per call, 27% of `prop_getset_fn`; part of the combined 0.58x | None; plain profiling discovery. |
| E2 (#3) | `JSON.stringify` runs `install_pending_intrinsics` per value: `intern_implicit_key("toJSON")` finds the id above the floor every time, and `missing_environment_global_bindings` allocates, hashes and sorts on each call. | `rust/engine/ironhorse-vm/src/interp/natives/json.rs:925`, `rust/engine/ironhorse-vm/src/interp/property/keys.rs:111-115`, `rust/engine/ironhorse-vm/src/interp/link.rs:1502`, `:1522`, `:313-335`; same pattern at `rust/engine/ironhorse-vm/src/interp/natives/date.rs:64` | 25,001 calls, 2.77 G of 3.85 G Ir | Loosely T18's "decide once"; profiling discovery. Why the id stays above the floor is a hypothesis to verify first. |
| E3 (#5) | About 50 side tables keyed by `SlotIndex` use SipHash with `RandomState`. | `rust/engine/ironhorse-vm/src/interp/state.rs:566`, `:582`, `:1672`, `:1705`, `:2059`, `:2806`, `:91` | 10-23% of property, call, array and Map self time | None; profiling discovery. |
| E4 (#6) | Index stores and pushes stringify the index to look up a symbol. | `rust/engine/ironhorse-vm/src/interp/property.rs:643`, `rust/engine/ironhorse-vm/src/interp/property/keys.rs:559-560`, `rust/engine/ironhorse-vm/src/interp/natives/array.rs:1617-1619` | 1,133 Ir per `a[i] = v`; about 25% of `array_rw_fn` | T19 is the follow-on: once index keys are cheap, a "none on prototypes" flag removes the walk. |
| E5 (#7) | Overwriting an existing own data property takes the full OrdinarySet route, with three `find_property` calls and two descriptor builds. | `rust/engine/ironhorse-vm/src/interp/property/ordinary.rs:794-808`, `:1018-1028`, `:212`, `:226`, `:266` | About 1,400 Ir per `o.a = v` | T7's own-hit set cache is the general form; the direct fix needs no cache. |
| E6 (#8) | A global `var` read probes `id_map`, `global_lexicals` and `global_props`, then does `mop_get` on a global object with hundreds of properties. | `rust/engine/ironhorse-vm/src/interp/dispatch/environment.rs:91-113`, `:193` | `int_loop` is 2.1x slower than `int_loop_fn`; 119 Ir of SipHash per read | None; profiling discovery. |
| E7 (#9) | The loop header re-decodes the instruction length and tests four rare conditions on every opcode. | `rust/engine/ironhorse-vm/src/interp/dispatch.rs:222-334`, `rust/engine/ironhorse-vm/src/opcode.rs:1074` | About 55 of 166 Ir per op in `empty_loop_fn` | None. |
| E8 (#10) | Each call allocates an args `Vec`, moves locals and `id_map` aside, and probes `functions` several times. | `rust/engine/ironhorse-vm/src/interp/frames.rs:340`, `:383`, `:423`, `:437`, `rust/engine/ironhorse-vm/src/interp/dispatch.rs:1579` | 10.8% malloc/free and 17.2% hashing in `func_calls_fn` | T17's "no per-call allocation", by pooling rather than thunks. |
| E9 (#11) | A property read on a prototype hit calls `find_property` and then `ordinary_get_own_descriptor` on the same object. | `rust/engine/ironhorse-vm/src/interp/property/ordinary.rs:693`, `:712`, `:147` | Part of `find_property`'s 4.7-11% | T8 removes the walk entirely once a cache exists. |
| E10 (#12) | Array elements live in a `BTreeMap<u32, Slot>`. | `rust/engine/ironhorse-vm/src/bulk.rs:173-185`, `rust/engine/ironhorse-vm/src/interp/property.rs:188` | `BTreeMap::get` 4.4% of `array_rw_fn` | Porffor's dense element store; Ironhorse must keep the ascending row stream. |
| E11 (#13) | `Slot` is tagged twice and large `Result<_, Step>` values return through memory. | `rust/engine/ironhorse-vm/src/value.rs:565-629`, `rust/engine/ironhorse-vm/src/interp/coerce.rs:855-860` | About 30 Ir of prologue and epilogue per `to_primitive_with_hint` | T1's "unpacked pair in registers". |
| E12 (#15) | Static keys are compared as strings (`scalar_key_text`, `symbol_ids.get("compare")`, `"prototype"`). | `rust/engine/ironhorse-vm/src/interp/dispatch/property_read.rs:48`, `:287`, `rust/engine/ironhorse-vm/src/interp/dispatch/property_write.rs:41`, `rust/engine/ironhorse-vm/src/interp/property.rs:1767` | Small to medium | The inverse of T9: resolve to an id once. |
| E13 (#16) | `s[i]` builds two temporary `Vec`s before allocating its (metered, required) one-unit chunk. | `rust/engine/ironhorse-vm/src/interp/property/indexed.rs:1174-1182`, `rust/engine/ironhorse-vm/src/interp/strings.rs:113-121` | Small | None. |

## F. Anti-findings: Porffor shortcuts not to copy

- **F1. Key identity by 32-bit hash alone.**
  Dictionary lookup returns the first entry whose stored hash matches, and shape lookup does the
  same over descriptors; neither compares key contents
  (`compiler/builtins/_internal_object.ts:1183-1186`, `:309-311`).
  The encoding-insensitive hash adds structured collisions: a UTF-16 unit contributes its high
  byte only when that byte is nonzero (`compiler/builtins/_internal_object.ts:67-81`), so the
  one-unit String holding U+0100 hashes like the two-unit ByteString `"\x00\x01"` and the two keys
  alias.
  Ironhorse's interned ids are exact (`rust/engine/ironhorse-vm/src/symbols.rs:23-27`), and any
  cache added in Phase 3 must be keyed by id, never by a hash of the name.
- **F2. Spec shortcuts behind preferences.**
  `neverFallbackBuiltinProto` throws a TypeError instead of performing the dynamic lookup
  (`compiler/codegen.js:2359-2361`), and builtin-internal `==` skips coercion
  (`compiler/render.js:5533-5534`).
  Ironhorse's observables are XS's; a fast path may only be a faster way to the same answer.
- **F3. Closed-world pruning.**
  `lazyObjects` emits only the prototype methods the program names (`compiler/builtins.js:135-137`),
  and `typeUsed` drops BigInt cases when no BigInt is visible (`compiler/codegen.js:2621-2624`).
  Ironhorse runs `eval`, `Function` and snapshots made by other programs, so none of these facts
  hold.
- **F4. Wall-clock GC tuning.**
  The nursery doubles or halves on collection intervals measured in milliseconds
  (`compiler/render.js:4185-4189`).
  Any Ironhorse allocator or collector policy must be driven by counts, never by time.
- **F5. Conservative stack roots.**
  Porffor reserves arena offsets to avoid false roots from executable addresses
  (`compiler/render.js:2423-2424`).
  Ironhorse's roots are precise and snapshotted.
- **F6. Immortal metadata.**
  Shapes live forever (`compiler/render.js:3614`) and IC slots are static data
  (`compiler/codegen.js:5060-5061`).
  In a long-lived snapshotting engine an immortal cache grows without bound, so a Phase 3 cache
  must be bounded, derived, unpersisted and rebuilt empty on restore, as `property_index` is
  (`rust/engine/ironhorse-vm/src/property_index.rs:1-2`).
- **F7. Append builders that rely on compiler-proved aliasing.**
  `porf_str_append` extends a string in place until a compiler-inserted read seals it
  (`compiler/render.js:4715-4718`, `compiler/codegen.js:1056-1058`).
  Ironhorse cannot add seal opcodes, and growing a chunk in place would change the chunk
  allocation sequence that `tick_chunk_new` meters (`rust/engine/ironhorse-vm/src/meter.rs:248`).

## G. Side findings

- **`s += 'ab'` exhausts the heap.**
  Twenty thousand iterations of `s += 'ab'` at top level halt with `HeapExhausted` after about
  800 MB of garbage chunks, because nothing collects within a crank
  (`designs/ironhorse-engine.md:996-999`).
  The roster uses 5,000 iterations for that reason.
  This is consistent with the design, but it means quadratic string building is bounded by the
  heap ceiling rather than by the meter.
- **Concatenation is under-metered relative to its time.**
  `string_concat` charges 97,920 computrons for 54.4 ms, which is 572 ns per dispatched opcode
  against about 30 ns elsewhere.
  The charge is linear in the result length per `+`, but the copying is quadratic over the loop.
  That is an observation about the cost model's accuracy, to be handled with a meter release if at
  all; it is not a target for this work, and D2 deliberately keeps the charge unchanged.
- **Hash seeds move native stack marks.**
  `rust/engine/benches/stack_height.py:12-18` records that the standard library's random hash
  seeds change what runs at a case's deepest point, which is why the gate has slack.
  A deterministic hasher (E3) may narrow that variation; re-baseline only if the gate itself asks.
- **Corrections to the source reports.**
  The Porffor catalogue assumes XS-style UTF-8 strings when it rates the ASCII bit (T11) for
  O(1) indexing; Ironhorse stores UTF-16BE (`rust/engine/ironhorse-vm/src/interp/strings.rs:9-17`),
  so indexing is already O(1) and an ASCII bit can only help conversions.
  The survey's `ArrayRowView` note overstates the work: the view already yields an iterator
  (`rust/engine/ironhorse-vm/src/interp/snapshot_views.rs:24-27`); only its field type
  (`:15`) names the `BTreeMap`.
