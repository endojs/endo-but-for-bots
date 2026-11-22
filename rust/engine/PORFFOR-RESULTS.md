# Results: wins and losses

This records what the Porffor campaign planned in [PORFFOR-PLAN.md](PORFFOR-PLAN.md) actually
shipped, what it tried and dropped, and what it designed and deferred.
Technique ids (T1-T25) and profile findings (E1-E13) are those of
[PORFFOR-FINDINGS.md](PORFFOR-FINDINGS.md).
Every number below was measured during the campaign; none is an estimate unless it says so.

## Provenance

- Base: `03687677` (the commit the findings and plan cite).
- Tip: `0d286eef`, the last code commit on branch `ccr-e08fb75d-kdywjp`; this document is the
  commit after it and changes no code.
- Host: a 4-core KVM guest (Intel Xeon @ 2.10GHz), Linux 6.18, 15 GB RAM.
  The first three phases ran while a second engineer built and benchmarked on the same host.
  The final measurements (base against tip, and the build-level experiment) ran with nothing
  else on the machine.
- Toolchain: rustc 1.91.1 (the engine's `rust-toolchain.toml`) for every build that was
  measured or tested; rustfmt and clippy 1.88.0, as CI pins them.
  Instruction counts with valgrind 3.22.0 (callgrind).
- Raw data: paths such as `raw-final/cg-base/` name the campaign's scratch directory, not
  files in this repository; the tables below carry every number they support.

## Method

- **Decisions were made by callgrind instruction counts (Ir).**
  One workload per valgrind process, `MICRO_ONLY=<workload> MICRO_SAMPLES=0`, so each count is
  one warm-up run of the roster test binary.
  Ir is whole-process: it includes compiling the workload and booting the realm, so the ratios
  slightly understate the interpreter-only gain.
- **Ir noise.**
  Hash seeds differ per process, so Ir is not bit-stable.
  Reruns of one binary agree within about 0.2% (for example `proto_method_fn` at the tip:
  1,477.8M, 1,477.8M, 1,485.6M), but single runs occasionally land 1.5-2% high (the same
  binary once read 1,506.6M).
  Every apparent regression above 1% was rerun before it counted; the tables use the median
  where a rerun exists.
- **Wall clock is supporting evidence.**
  Binaries were run interleaved, alternating which build goes first each round
  (`ab1.sh`, ABAB/BABA), each roster process reporting the median of five samples after a
  warm-up; tables report the median of the per-process medians and their minimum.
  Even on the idle guest, the per-process medians of one workload spread by 12-85% of their
  median (median spread 30% for the base, 41% for the tip, over 7 rounds), so a time ratio
  is signal only where it agrees with Ir.
- **Cost invariance was checked mechanically.**
  The roster prints computrons, dispatch count and raw meter index per workload; for every
  commit and every build variant these were diffed against the base build.
  They are identical for all 25 workloads everywhere, including the LTO and PGO builds.
- The roster is `ironhorse-vm/tests/porffor_micro_bench.rs`: 21 workloads from `4e6f22b9` plus
  four from `70e68b6b` (`proto_method_fn`, `array_fill_sum_fn`, `array_hole_fn`, `ctor_fn`).
  The base did not have the file; its binary was built from `03687677` with the tip's roster
  file copied in.

## Kept commits

The Ir column is the target workload's ratio against the commit's own predecessor, as measured
when the commit was made (phases 1 and 2 on the main line; the four property-access commits on
a parallel branch from `23550ede`, before they were cherry-picked onto `a4d84247`).
Sites are cited at `0d286eef`.

| Commit | Change | Technique | Target workload | Ir ratio | Changed site |
|---|---|---|---|---|---|
| `4e6f22b9` | micro roster, 21 workloads | infrastructure | - | - | `ironhorse-vm/tests/porffor_micro_bench.rs` |
| `10c91db4` | findings and plan | documentation | - | - | `PORFFOR-FINDINGS.md`, `PORFFOR-PLAN.md` |
| `b25b8971` | Number fast paths for arithmetic, bitwise, relational and `+` | T3, T4 | `int_loop_fn` | 0.569 (1.76x) | `ironhorse-vm/src/interp/coerce.rs:449` (`binary_arith`), `:499`, `:571`, `:1066` |
| `4c876960` | test the receiver before the name in the `disposed` read arm | profile finding E1 | `prop_getset_fn` | 0.698 (1.43x) | `ironhorse-vm/src/interp/dispatch/property_read.rs:202` |
| `42bf95dd` | skip the global catch-up roster while it is known empty | profile finding E2 (loosely T18) | `json` | 0.212 (4.72x) | `ironhorse-vm/src/interp/link.rs:1535` |
| `23550ede` | join two String operands of `+` on their stored payloads | T11 (its concatenation path only) | `string_concat` | 0.222 (4.50x) | `ironhorse-vm/src/interp/strings.rs:159` |
| `af8eab3b` | probe the symbol table with borrowed name bytes | profile finding (E12 family) | `json`; `array_rw_fn` | 0.902 (1.108x); 0.905 (1.104x) | `ironhorse-vm/src/symbols.rs:78`, `ironhorse-text/src/lib.rs:176` |
| `9039b94e` | seeded folded-multiply hasher for integer-keyed side tables | profile finding E3 | `method_calls_fn`; `map_set` | 0.759 (1.317x); 0.781 (1.280x), single-fold version | `ironhorse-vm/src/int_hash.rs:36`, `ironhorse-vm/src/interp/state.rs:91` and the other side tables |
| `16d2c31f` | step an Integer INCREMENT/DECREMENT inline | T4 | `empty_loop_fn` | 0.923 (1.083x) | `ironhorse-vm/src/interp/dispatch.rs:963`, `:3895` |
| `3c923cbf` | take a fixed-size opcode's length from its size | profile finding E7 | `empty_loop_fn`; `int_loop_fn` | 0.865 (1.156x); 0.880 (1.137x) | `ironhorse-vm/src/interp/dispatch.rs:322` |
| `069b449c` | finish the integer hasher with a shift, not a second fold | fix (stack gate) | all | 0.989-1.000 against the single fold | `ironhorse-vm/src/int_hash.rs:125` |
| `a4d84247` | keep `exec_increment` the only entry to its generic body | fix (control-transfer audit) | - | included above | `ironhorse-vm/src/interp/dispatch.rs:3937` |
| `70e68b6b` | four property and array access workloads | infrastructure | - | - | `ironhorse-vm/tests/porffor_micro_bench.rs` |
| `25086f23` | look up index-named keys without formatting the index | profile finding E4 (plan 2.2) | `array_fill_sum_fn`; `array_rw_fn` | 0.850 (1.18x); 0.856 (1.17x) | `ironhorse-vm/src/symbols.rs:147`, `ironhorse-vm/src/interp/property/keys.rs:563`, `ironhorse-vm/src/interp/property.rs:643` |
| `8803168e` | one own lookup per level in reads, direct own-data overwrites | profile findings E5, E9 (plan 2.3; T7's own-hit idea without a cache) | `prop_getset_fn` | 0.712 (1.40x) | `ironhorse-vm/src/interp/property/ordinary.rs:691`, `:917` |
| `6ac8bbed` | drop two redundant steps from property creation by `[[Set]]` | T10 (its exact part only) | `ctor_fn` | 0.815 (1.23x) | `ironhorse-vm/src/interp/property/ordinary.rs:232`, `:1131`, `ironhorse-vm/src/symbols.rs:159` |
| `0d286eef` | carry the receiver miss as a flag in `ordinary_set`'s walk | fix (stack gate after integration) | all | 0.999-1.000 against `6ac8bbed` | `ironhorse-vm/src/interp/property/ordinary.rs:963` |

### Integration of the two tracks

The property-access commits were developed on a branch from `23550ede` while the main line
gained `af8eab3b` and `9039b94e`, which also reworked `SymbolIds`.
They were cherry-picked in order (`70e68b6b`, `25086f23`, `8803168e`, `6ac8bbed`); the roster and
`8803168e` applied cleanly, and the two `symbols.rs` conflicts were resolved so that both
optimisations survive:

- `get` and `contains_key` keep the borrowed-bytes `impl SymbolLookup` argument, and
  `get_index` / `may_bind_index_name` sit beside them.
- The derived decimal-name index stays a `BTreeMap<u32, u16>`: its keys are guest-spelled
  index names, which the integer hasher's HashDoS argument (engine-allocated keys only) does
  not cover.
- The set of ids ever bound to a decimal name became an `IntSet<u16>`, because its keys are
  engine-assigned key ids like those of the other `u16`-keyed tables `9039b94e` converted.
  Measured against a `BTreeSet` build of the same tree: 0.996-1.000 in Ir on the six
  workloads that create or intern names (`raw-final/cg-var-btreeset/`), so the choice is about
  consistency, not speed.

The source audits that scan `src/` (`gc_visitation_registry`, `throw_construction_sites`,
`dispatch_loop_control_transfer`) pass on the integrated tree.
The overwrite fast path of `8803168e` does not overlap anything on the main line, which never
edited `property/ordinary.rs`; it sees only the hasher type of the side tables it touches.

The integrated tree failed one gate that neither track failed alone: the native stack-height
case `iter-setter.run` reached 184,279 B against a limit of 184,145 B (1.021x), deterministic
over four runs.
Its 118 re-entry levels each run `iterator_setter -> mop_set_inner -> ordinary_set ->
invoke_setter`; `ordinary_set`'s frame grew from 376 B to 392 B, and 118 x 16 B is the growth.
The main line had already moved the case to 1.010x and `6ac8bbed`'s `absent_on:
Option<SlotIndex>` added another 1.1% on its own branch.
`0d286eef` keeps the miss in a `bool` in that one walk and passes the same `Option` at the end,
which returns the case to 182,359 B (1.010x) without changing what the shortcut does.

## Final per-workload results, base `03687677` to tip `0d286eef`

Ir: one callgrind run per workload per build (`raw-final/cg-base/`, `raw-final/cg-tipfix/`);
for `proto_method_fn` at the tip, the median of four runs (`raw-final/noise-proto/`).
Time: 7 interleaved rounds (`raw-final/ab-base-tip/`).
Ratios are tip over base; below 1 is faster.

| workload | Ir base | Ir tip | Ir ratio | ms base median (min) | ms tip median (min) | time ratio |
|---|---:|---:|---:|---:|---:|---:|
| int_loop | 12,943M | 7,074M | 0.547 | 965.0 (874.3) | 494.4 (473.9) | 0.512 |
| float_arith | 4,478M | 2,393M | 0.534 | 326.8 (315.8) | 158.3 (127.5) | 0.485 |
| prop_getset | 7,479M | 3,478M | 0.465 | 617.1 (601.5) | 268.0 (235.5) | 0.434 |
| array_rw_push | 8,309M | 5,180M | 0.623 | 719.9 (692.4) | 482.7 (387.4) | 0.670 |
| string_concat | 652M | 125M | 0.192 | 55.3 (51.2) | 26.9 (21.5) | 0.487 |
| string_charcode | 2,874M | 1,854M | 0.645 | 222.1 (198.6) | 136.2 (126.9) | 0.613 |
| string_index | 2,089M | 1,489M | 0.713 | 147.2 (138.4) | 99.2 (92.8) | 0.674 |
| func_calls | 4,898M | 3,064M | 0.626 | 357.8 (333.5) | 203.9 (169.7) | 0.570 |
| closures | 4,726M | 2,849M | 0.603 | 337.7 (263.5) | 178.3 (161.5) | 0.528 |
| method_calls | 5,454M | 2,789M | 0.511 | 449.9 (394.6) | 200.6 (167.5) | 0.446 |
| map_set | 1,903M | 1,073M | 0.564 | 177.4 (147.3) | 85.6 (77.8) | 0.483 |
| typed_array | 4,265M | 2,753M | 0.646 | 345.0 (251.9) | 195.9 (186.9) | 0.568 |
| json | 3,788M | 626M | 0.165 | 284.4 (226.4) | 48.9 (45.8) | 0.172 |
| int_loop_fn | 4,615M | 2,233M | 0.484 | 336.6 (323.5) | 145.7 (125.4) | 0.433 |
| empty_loop_fn | 1,371M | 853M | 0.622 | 84.2 (78.1) | 51.1 (37.7) | 0.606 |
| prop_getset_fn | 4,990M | 1,683M | 0.337 | 410.1 (397.4) | 131.4 (101.9) | 0.320 |
| array_rw_fn | 4,065M | 2,379M | 0.585 | 337.2 (298.4) | 220.6 (186.1) | 0.654 |
| string_charcode_fn | 950M | 684M | 0.720 | 85.2 (59.3) | 53.5 (44.6) | 0.628 |
| func_calls_fn | 2,308M | 1,571M | 0.681 | 162.1 (122.4) | 98.5 (76.3) | 0.608 |
| method_calls_fn | 4,033M | 1,944M | 0.482 | 340.0 (292.2) | 131.1 (109.9) | 0.386 |
| typed_array_fn | 1,508M | 971M | 0.644 | 95.8 (82.4) | 64.7 (58.0) | 0.675 |
| proto_method_fn | 3,325M | 1,482M | 0.446 | 240.0 (222.5) | 97.4 (77.3) | 0.406 |
| array_fill_sum_fn | 1,960M | 1,158M | 0.591 | 166.9 (134.5) | 130.5 (81.8) | 0.782 |
| array_hole_fn | 1,938M | 1,089M | 0.562 | 144.6 (120.5) | 84.7 (58.5) | 0.586 |
| ctor_fn | 2,790M | 1,424M | 0.510 | 205.9 (155.3) | 92.1 (74.9) | 0.447 |
| geomean (25) | | | 0.514 (1.946x) | | | 0.507 (1.973x) |

Over the original 21 workloads alone the Ir geomean is 1.953x (phase 2 ended at 1.697x).
Best: `json` (6.05x Ir, 0.172 time), then `string_concat` (5.20x Ir; its time ratio, 0.487,
includes the quadratic copying the cost model does not charge, see side findings).
Least improved: `string_charcode_fn` (1.39x Ir) and `string_index` (1.40x Ir); in time,
`array_fill_sum_fn` (0.782).
No workload is slower in either measure.

The gated fixtures (`ironhorse-snapshot` `dispatch_bench` and `reentry_bench`), same 7 rounds:

| fixture metric | ms base median (min) | ms tip median (min) | time ratio |
|---|---:|---:|---:|
| dispatch_ms | 1633.5 (1494.0) | 838.3 (619.9) | 0.513 |
| slots_ms | 768.6 (659.6) | 329.8 (267.4) | 0.429 |
| chunks_ms | 41.2 (32.7) | 25.3 (20.5) | 0.614 |
| calls_ms | 1047.1 (784.2) | 606.8 (507.3) | 0.579 |
| recursion_ms | 346.8 (296.7) | 230.0 (177.7) | 0.663 |
| callbacks_ms | 728.0 (615.2) | 358.3 (299.6) | 0.492 |
| getter_ms | 1081.2 (981.9) | 522.6 (500.2) | 0.483 |

Geomeans: `dispatch_bench` 0.513 (1.95x), `reentry_bench` 0.550 (1.82x).

`python3 benches/run.py` (no flags, so candidate medians only, printed against the checked-in
`baseline.json` medians, which were measured at `3a30ab1e9` on another host): all 52 metrics
measured, no fixture failure, geomean 0.762 of the checked-in medians, lowest
`attached_detached_ms` 0.303, highest `gc_5000_sweep_ns_per_slot` 1.256, the only one above
the 1.25x floor (`raw-final/runpy-report.json`).
That comparison is historical context only.
Measured against the base on this host instead (`gc_bench`, 9 interleaved rounds,
`raw-final/ab-gc/`), the same metric is 0.648 (41.6 to 26.9 ns per slot), and no `gc_bench`
metric is slower than 1.042x (`slide_8000_front_ms`, inside the fixture's noise).
`baseline.json` was not rewritten.

## Losses and deferrals

Each item below was tried, or designed far enough to find what blocks it, and did not ship.

### T19: "no index keys on prototypes" flag (plan 3.1) - deferred

- Where the time is: after `25086f23` and `8803168e`, `uninterned_index_get_levels` was 203M Ir
  inclusive for the 187,500 hole reads of `array_hole_fn`, about 1,080 Ir per read and 13% of
  the workload; a hole walks `[]`, `Array.prototype` and `Object.prototype` with five side-table
  probes per level.
  The ceiling was about 1.15x on that workload, measured before the integer hasher made those
  probes cheaper, so the remaining win is smaller.
- Blocking invariant: a monotone flag is sound only if every way an object becomes a prototype
  (`setPrototypeOf`, the `__proto__` setter and literal, `Object.create`, class heritage,
  `Reflect.construct`'s `newTarget`, bound and derived constructors, restore) and every way an
  index appears on such an object (index store, array items of an array that is a prototype,
  String wrappers, typed arrays, Proxies, accessor promotion) sets it.
  One missed writer is a silent wrong `undefined`.
- Next step: a per-slot exotic-class tag set at allocation (one choke point), then re-measure.

### T10: exact per-key assignment-intercept bitset (plan 3.2) - deferred; its exact part shipped

- Design: a `Vec<u64>` bitset by key id, set when any object gets an accessor or a non-writable
  data property under that id, never cleared; `[[Set]]` creating a property would skip the
  prototype walk when the bit is clear and no exotic can answer the key.
- Blocking invariant: "non-writable under id" is broader than slot flags.
  Every function's synthesized `length`/`name`, String wrappers' `length` and indices, arrays'
  `length`, `ctor_prototype`, and every writer of `XS_DONT_SET`/`XS_GETTER_FLAG` (ordinary
  define, `set_own_unmetered_with_flag`, integrity operations, boot and lazy intrinsic installs,
  restore) would have to set the bit, and slot flags are written through `get_mut`, so there is
  no single place to hook without auditing each writer.
- What shipped instead (`6ac8bbed`): the duplicated receiver lookup and the per-creation key
  text, 1.23x on `ctor_fn`.
- Next step: the same exotic-class tag, plus a flag-writer audit.

### T7, T8, T23: GET_PROPERTY inline cache (plans 3.3, 3.4) - deferred, design recorded

- Profile target: on the property-access branch, before the integer hasher,
  `proto_method_fn` and `method_calls_fn` spent 22% and 17% of Ir in `hash_one`: about 13
  receiver-kind probes in `dispatch_get_property`, then `proxies`, `arrays`, `wrapper_data`,
  `functions` and `typed_arrays` per prototype level.
- Design that would be unobservable: a direct-mapped table of fixed size (for example 4,096 x
  24 B, allocated on first fill, which is T23), indexed by `(receiver SlotIndex, key id)` rather
  than `(code, pc)` so a stale entry for freed code is harmless and the dispatch loop is
  untouched; filled only for data-property hits with no getter or Proxy on the chain and no
  exotic level; validated by an epoch kept in `SlotArena`, bumped by allocation, free, sweep,
  compaction, restore and instance-record writes.
  A hit reads the slot's current value; neither path meters or allocates, so hit and miss cost
  the same.
- Blocking invariant: correctness needs "a live `SlotIndex`'s membership in the exotic side
  tables never changes once the object is observable" for about 15 tables (`arrays`,
  `wrapper_data`, `functions`, `proxies`, `typed_arrays`, `regexps`, four Temporal tables,
  `locales`, `collators`, `disposable_stacks`, `array_buffers`, `data_views`), or an epoch bump
  on every insert into them.
  The first is unproven: construction paths that run guest code between allocating an
  instance and registering it (`GetPrototypeFromConstructor` through a Proxy `newTarget`, for
  one) would each need auditing.
  Property-slot `id`/`next` rewrites through `get_mut` (index promotion, delete relinking) need
  the same audit.
- Next step: the per-slot exotic-class tag set at allocation, which makes both this cache and
  T19 simple; then re-measure, since the cheaper hasher already removed much of what the cache
  would skip.

### Direct global `var` access (plan 2.4, E6) - deferred

After the hasher, a global read is cheap `id_map`/`global_lexicals`/`global_props` probes plus
`mop_get` on the global object, whose cost is the ordinary get walk that the property-access
commits then reworked.
A direct read must also reproduce accessor, Proxy-global, compartment and TDZ behaviour.
`8803168e` already serves global `var` assignment through the overwrite path (`int_loop`
0.797 and `float_arith` 0.742 in Ir from that commit alone).
Next step: re-profile `int_loop` against `int_loop_fn` on the tip (7,074M against 2,233M Ir)
before designing a read path.

### Per-call allocation pooling (E8, T17's "no per-call allocation") - deferred with a bound

At `23550ede`, all malloc and free in `func_calls_fn` was 180M of 2,050M Ir (8.8%), four
allocations per call: the arguments `Vec`, the locals `Vec`, the `id_map` `Rc` and its table.
`id_map` is persisted as rows, so only the two `Vec`s are host-only, and pooling them could
remove at most about 4.4%, less after the hasher and loop-header commits shrank the denominator.
That is below the plan's keep threshold.
`reserved_vec`'s fallible reservation also sits under the allocation admission audit.

### Number equality and unary fast paths - not attempted

No roster workload has Number `==`/`===`, unary minus or `typeof` in its loop
(`string_index` compares Strings), and no profile showed them, so a fast path could not meet
the "target workload improves" rule.
Next step: add a workload that exercises them, then apply the `b25b8971` pattern.

### The first integer hasher: bucket spread, then the stack gate

1. A single folded multiply with no finish failed its own spread test: keys at strides of
   2^18-2^20 filled 1,208-2,284 of 4,096 buckets, where a uniform hash fills about 2,590
   (simulated over 40 seeds), because the low product bits depend only on the low key bits.
   Its Ir gains (`method_calls_fn` 1.317x, `map_set` 1.280x) are what the table above cites.
2. A second fold at `finish` spread uniformly (2,531-2,556 minimum over 40 seeds) at 0-2.3% Ir
   (median 0.9%), but failed the stack-height gate: `exec_run`'s frame grew from 360 B to
   392 B and two call-path frames by 32 B, so `function-call-63/64` rose to 1.024x
   (168,319 B to 172,287 B).
   Marking `finish` `#[inline]` or `#[inline(never)]` did not restore the frame; rotations were
   erratic in simulation (937-2,284 worst case).
   This version was pushed as `9039b94e`.
3. `state ^ (state >> 32)` (`069b449c`): minimum 2,442 buckets over 40 seeds, `exec_run` back to
   360 B, stack gate passes, at 0-1.1% Ir over the single fold.

### The three-word environment stamp (`42bf95dd`'s first version)

The first witness for "the global catch-up roster is empty" stored `(stamp, intrinsics.len,
binding_names.len)` in each compartment environment.
Environments move by value across guest re-entry, and the two extra words grew the eval and
promise recursion cases by 2.0-2.7% (`eval-direct-42` 193,911 B to 197,943 B,
`promise-exec-63` 225,131 B to 231,275 B; 8 failures, the same over three runs).
`#[inline(never)]` did not help.
The shipped one-word stamp keeps them within 0.3-0.5%.

### The mis-attributed JSON hot spot (plan 1.3)

The plan named `intern_implicit_key("toJSON")` as the caller that keeps re-running
`install_pending_intrinsics`.
It runs once in the `json` workload.
The hot caller is `to_read_key` (`ironhorse-vm/src/interp/property/keys.rs`), which ran the
install for every string key a native reads: 25,000 times, five per `stringify`.
The cost was `missing_environment_global_bindings` (a `SymbolName` allocation and SipHash per
intrinsic, a sort and a dedup), not the install itself.
The fix (`42bf95dd`) is placed accordingly.

### T11's premise (plan 3.5) - not started

The Porffor catalogue rates an ASCII bit for O(1) indexing on the premise that the engine
stores XS-style UTF-8 strings.
Ironhorse stores UTF-16BE (`ironhorse-vm/src/interp/strings.rs:9-17`), so indexing is already
O(1) and the bit could only speed conversions.
The same premise shaped the concatenation design: because storage is UTF-16BE, the decode and
re-encode `23550ede` removed was a byte-exact round trip, which is what made joining payloads
provably identical.
Plan 3.5 requires a profile first; no profile after `23550ede` showed a conversion worth a
derived bit, so it was not started.

### Smaller losses along the way

- `23550ede`'s first version moved the general concatenation body into
  `concat_add_generic`; it failed `tests/allocation_admission_audit.rs`, which exempts exactly
  that body's `Vec::with_capacity` inside `concat_add`, so the body stayed in place.
- `16d2c31f` added a test-only wrapper that called the outlined increment arm a second time;
  `tests/dispatch_loop_control_transfer.rs` failed two audits; `a4d84247` moved the body into
  `increment_generic`.
- Loop-header slimming beyond `3c923cbf` (folding `step_limit`, the bounded-run ceiling and the
  id-space latch into one armed flag) would save about 4 Ir per op but needs every writer of
  those fields to maintain the flag; not done.

### Build-level options (plan 4.1, T24) - not adopted

Measured on `0d286eef` with `CARGO_PROFILE_RELEASE_*` environment variables only (no file
edits), plus one PGO build: instrumented with `-Cprofile-generate`, trained on one run of the
micro roster (five samples per workload), merged with the toolchain's own `llvm-profdata`
(installed with `rustup component add llvm-tools`), rebuilt with `-Cprofile-use`.
`dispatch_bench` and `reentry_bench` were not in the training run, so they are the held-out
check.
No variant adds floating-point contraction or target-CPU flags.
Computrons, dispatch counts and raw meter index are identical to the base in every variant.
Ir: one callgrind run per workload (`raw-final/cg-<variant>/`); time: 5 interleaved rounds of
all six builds, rotating which goes first (`raw-final/ab-variants/`).
Ratios are against the default release profile.

| Variant | Ir geomean (25) | Ir best / worst | Time: roster | Time: `dispatch_bench` | Time: `reentry_bench` | Stack-height gate |
|---|---:|---|---:|---:|---:|---|
| `lto = "fat"` | 0.992 | 0.939 `int_loop_fn` / 1.033 `typed_array` | 0.954 | 0.879 | 0.976 | FAIL: 12 cases, up to 1.073x (`valueOf-127.run`) |
| `lto = "thin"` | 0.996 | 0.982 `json` / 1.017 `proto_method_fn` | 0.961 | 0.849 | 0.915 | FAIL: 11 cases, up to 1.035x |
| `codegen-units = 1` | 1.001 | 0.978 `int_loop_fn` / 1.020 `ctor_fn` | 0.966 | 0.898 | 0.986 | FAIL: 34 cases, up to 1.048x |
| fat LTO and `codegen-units = 1` | 0.973 | 0.923 `int_loop_fn` / 1.002 `prop_getset` | 0.943 | 0.832 | 0.935 | FAIL: 9 cases, up to 1.036x (`array-from-63/64.run`) |
| PGO, default profile otherwise | 0.831 | 0.726 `prop_getset` / 1.045 `array_fill_sum_fn` | 0.790 | 0.955 | 0.982 | FAIL: 414 of 430 cases, up to 2.594x (`parse-if-506.compile`) |

Every stack failure is a byte mark over the baseline's slack; no case changed its outcome.
The baseline records the default profile, so a new profile needs a new baseline measured
honestly, and the question the gate stands for is whether the depth budget
(`ironhorse-vm/src/interp.rs` and `STACK-DEPTH-REFACTOR.md`) still holds on the smallest
supported host stacks.

Verdict, against the plan's rule (roster geomean at least 10% better, no workload worse than
noise, stack heights within budget):

- LTO and codegen units: at most 2.7% in Ir (fat with one codegen unit), several workloads
  slightly worse, and wall-time gains of 3-17% that sit inside this host's noise; every variant
  grows some recursion frames by 2-7%.
  Not adopted.
  A profile change affects every consumer of the outer workspace, and the evidence is not
  there.
- PGO: 1.20x in Ir and 0.790 in time on the roster it was trained on, but 0.955 and 0.982 on the
  held-out fixtures, which is no signal; `array_fill_sum_fn` got slower (1.045 Ir, 1.141 time).
  The in-sample gain is real but does not transfer to code it was not trained on.
  It also multiplies native stack use (inlining hot callees into recursive frames: up to 2.6x
  on parser cases), which would need the depth budget re-derived, and it makes the shipped
  binary depend on a pinned training run.
  Not adopted.
- Next step if revisited: train on a broad corpus (test262 plus the fixtures), measure on
  held-out workloads, and re-baseline the stack gate against the native depth budget, not the
  old marks.

## Bisect hazard

`9039b94e`, `16d2c31f` and `3c923cbf` were pushed before their gate failures surfaced and were
fixed forward rather than rewritten:

- `9039b94e` fails the stack-height gate (the second fold, above); `069b449c` fixes it.
- `16d2c31f` fails `dispatch_loop_control_transfer`; `a4d84247` fixes it.
- `3c923cbf` sits on `16d2c31f` and inherits both failures.

Likewise `6ac8bbed` fails the stack-height gate on the integrated line (`iter-setter.run`,
above), fixed by `0d286eef`.
A bisect that uses these gates as its oracle must skip those commits.

## Gates

Run on the integrated tip, from `rust/engine` with `CARGO_INCREMENTAL=0` and
`RUST_MIN_STACK=33554432` (debug builds with `CARGO_PROFILE_DEV_DEBUG=line-tables-only` for
disk space; raw logs in `raw-final/gate-*.txt`):

| Gate | Result |
|---|---|
| CI `format-ironhorse`: comparison-resolution test, math-vector, lockfile-agreement, intl-profile, row-schema (`--base 03687677`), crate-graph and compiler-opcode scripts; `cargo +1.88.0 fmt --all -- --check`; standalone-root `rustfmt`; `ironhorse-store-sqlite` fmt | pass |
| `cargo +1.88.0 clippy --locked --workspace --exclude xs-oracle --exclude ironhorse-262 --exclude ironhorse-fuzz --no-deps -- -D warnings`, and the same `cargo +1.88.0 build` with `RUSTFLAGS=-D warnings` | pass |
| CI `test-ironhorse` (debug): runtime, meter, unicode, vm, snapshot, compile, regexp with `ironhorse-vm/store-integrity` | pass: 2,412 passed, 0 failed, 52 ignored (at `6ac8bbed` and again at `0d286eef`) |
| `cargo test -p ironhorse-text` | pass |
| deterministic-Math configuration (vm, snapshot); platform, provider and deterministic Math vector exports | pass (2,095 / 0 / 46; 1, 1, 1) |
| CI `test-ironhorse-calibration`: `cost-calibration` lib (354 / 0) and `golden_computrons`; `consensus` `golden_computrons` + `consensus_ceiling_caps` (3 / 0); the consensus/cost-calibration conflict check | pass |
| plain `golden_computrons` | pass |
| `python3 benches/stack_height.py --check` | pass at `0d286eef` (430 cases; largest 1.032x on `json-parse-obj-10k.run`, 128 B over the baseline and inside its 256 B slack); failed at `6ac8bbed` (above) |
| roster computrons, dispatch counts, raw meter index against `03687677` | identical, 25 of 25 |
| repo root: `cargo build --locked --release -p thixotrope-ironhorse-worker`, its tests (17 / 0), `ironhorse-store-sqlite` tests with `store-integrity` (128 / 0 / 4, release) | pass |

Not run, and open verification before merge:

- test262, both the committed expectation slices and the full lane.
- Anything that needs the XS oracle or Moddable sources, because the `c/moddable` submodule is
  not initialised here: workspace-wide clippy and build (`xs-oracle`, `ironhorse-262`,
  `ironhorse-fuzz`), the oracle-linked tests of `ironhorse-compile`/`ironhorse-regexp` with
  `parity`, `ironhorse-262`, `ironhorse-fuzz`'s tests and differential lanes, the SES realm
  profile tests, and the `endo` crate's ironhorse tests (its `xsnap` build script needs the
  Moddable sources).
- Fuzz lanes (pinned nightly plus `cargo-fuzz`), sanitizer lanes, the wasm32 builds and the
  cross-target stack lanes (wasm targets and Wasmtime not installed), the macOS and release
  matrix legs of `test-ironhorse`, the cross-platform Math vector comparison, and the yarn-driven
  thixotrope bundle tests.
- `benches/run.py --check-baseline` (it rebuilds and remeasures the pinned reference revision).

## Side findings

- **The two tracks' stack costs add up.**
  Each branch kept `iter-setter.run` within the 2% gate (1.010x and 1.011x) and their union did
  not (1.021x).
  A frame-size gate measured per branch does not compose; integrate, then gate.
- **Even an idle guest is noisy in wall time.**
  Per-process medians of one workload spread by 12-85% across seven rounds of one binary;
  callgrind Ir, reproducible to about 0.2%, decided everything.
- **PGO's inlining is incompatible with the stack contract as it stands.**
  See the build-level section: the gate is exactly the instrument that caught it.
- **Concatenation remains under-metered relative to its time** (FINDINGS section G):
  `string_concat` gained 5.2x in Ir but 2.05x in time, because the remaining cost is the
  quadratic copying of a growing string, which the meter charges linearly per `+`.
