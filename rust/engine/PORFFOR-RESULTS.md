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

# Round 2

Round 2 followed [PORFFOR-ROUND2-PLAN.md](PORFFOR-ROUND2-PLAN.md) under ground rules the owner
changed between the rounds.
Everything above this heading is round 1 and is unchanged.
The security reading of the same rules is [SECURITY-SEAMS.md](SECURITY-SEAMS.md).

## The changed ground rules

Project owner direction, 2026-11-22 and 2026-11-23, quoted:

1. "XS is just a guide; the real spec is JavaScript and SES."
2. The threat model is malicious guest code, not a malicious Ironhorse operator or a malicious
   snapshot, "though we need to document this seam's security properties in detail".
3. "If the hash is a perf optimization technique that's not a security issue."
4. "Determinism, lockdown, and compartment sandboxing are mandatory. Computrons must approximate
   actual work done for the sake of preserving DoS resistance. This can be tightened later but
   should be set to realistic patterns."
5. Computron identity with earlier versions is no longer required: "the current gates are a
   too-strict version of our initial guard rails".

What changed in practice: a derived dispatch buffer that departs from XS's bytes became
admissible (rule 1), and a commit could have changed computrons under a new meter version
(rule 5).
None needed to: every round-2 commit is computron-identical to the round-1 tip on the roster
(computrons, dispatch count and raw meter index, 25 of 25, fusion on and off), and no
`ironhorse-meter` version was added.

## Provenance

- Base `03687677`; round-1 tip `0d286eef`; round-2 code tip `d5871aac0` (branch
  `ccr-e08fb75d-kdywjp`); this document is the commit after it and changes no code.
- Three tracks were built in parallel from `1122b115` (code-identical to `0d286eef`): A, the
  dispatch census and superinstructions (on the main line); B, the exotic-membership bits; C, dense
  array storage.
  C and then B were cherry-picked onto A.
- Host, toolchains and method as in round 1 (Provenance and Method above), with nothing else
  running for every number in the final tables.
  Ir is whole-process callgrind, one roster process per workload, except the calibration section,
  which counts only `Interp::run` (`--toggle-collect`).
  Time: 8 interleaved rounds of the three binaries, rotating which runs first, each roster process
  reporting the median of five samples after a warm-up; the tables give the median of the eight
  per-process medians.
- Binaries: base and round-1 tip are round 1's (`03687677` with the tip's roster file copied in,
  and `0d286eef`); the roster's workloads are unchanged since (round 2 only added the
  `MICRO_PLAIN` switch and `CENSUS` output).
  Round-1 Ir figures are round 1's runs (`raw-final/cg-base/`, `raw-final/cg-tipfix/`, with
  `proto_method_fn` at the tip the median of four reruns as in round 1); round-2 Ir and all times
  are new (`raw-r2final/`).

## Kept commits

The "Ir when made" column is the target workload's ratio against the commit's own predecessor in
its track; "Ir integrated" is the same workload against the previous commit on the integrated line
(`raw-r2final/cg-g-*`).
Sites are cited at `d5871aac0`.

| Commit | Change | Technique | Target workload | Ir when made | Ir integrated | Changed site |
|---|---|---|---|---|---|---|
| `2ef6265e2` | dispatch n-gram census, fusion switch, gate D skeleton | instruments (plan item 1) | - | - | - | `ironhorse-vm/src/cost.rs:123`, `:177`, `ironhorse-vm/src/interp/dispatch.rs:366`, `ironhorse-vm/src/interp/fuse.rs:147` |
| `4e6a5278e` | layout-preserving superinstructions over a derived dispatch buffer | superinstructions (plan item 2, A.4, B.4) | `empty_loop_fn`; `int_loop_fn` | 0.487; 0.720 | same (track A is the main line) | `ironhorse-vm/src/interp/fuse.rs:706` (`derive`), `:210` (`run_fused`), `:239` (`fusion_admits`), `ironhorse-vm/src/interp/dispatch.rs:170` (`fused_head!`) |
| `33ac5a288` | hold dense array items in a vector | dense element storage (plan item 4) | `array_fill_sum_fn`; `array_rw_fn` | 0.718; 0.767 | 0.671; 0.756 | `ironhorse-vm/src/bulk.rs:240` (`ArrayItems`), `:198-206` (transition rules) |
| `643d2967b` | decide an array's exotic own keys from the name bytes | profile finding (two `String`s per `array_own_descriptor` call) | `array_rw_fn`; `json` | 0.897; 0.963 | 0.891; 0.962 | `ironhorse-vm/src/interp/property/indexed.rs:1084`, `:1097` |
| `aa5eb8b8e` | bound array storage conversions per computron | test and diagnostics counter | - | - | 0.998-1.002 on all | `ironhorse-vm/tests/array_storage_work.rs:70`, `ironhorse-vm/src/bulk.rs:181` |
| `5d71c8b91` | skip exotic side-table probes on ordinary objects | exotic-membership superset bits (plan item 3) | `proto_method_fn`; `prop_getset_fn`; `ctor_fn`; `method_calls_fn` | 0.849; 0.876; 0.892; 0.924 | 0.833; 0.864; 0.892; 0.920 | `ironhorse-vm/src/exotic_bits.rs:197` (`ExoticTable`), `ironhorse-vm/src/interp/property/ordinary.rs:15`, `ironhorse-vm/src/interp/dispatch/property_read.rs:21`, `ironhorse-vm/src/interp/gc.rs:12` |
| `c3e9e775a` | compare every round-2 accelerator on against all off | differential gate | - | - | - | `ironhorse-snapshot/tests/optimised_differential.rs:192`, `ironhorse-snapshot/tests/exotic_bits_differential.rs:289`, `ironhorse-snapshot/tests/array_storage_differential.rs:451` |
| `d5871aac0` | state what a guest can and cannot do to the integer hasher | documentation (comment only) | - | - | - | `ironhorse-vm/src/int_hash.rs:16` |

Each track's write-up measured its commit against `1122b115` with the other tracks absent.
The gains compose: on the integrated line every target improved at least as much as in its own
track, because the earlier commits had already removed other work from the same workloads.

## Integration notes

- Order: C (`5ef3c75c`, `17c1b1e0`, `d6d488db`) then B (`4466be2e`), onto A's `4e6a5278e`.
  All four are separate commits with their original messages and trailers.
- C applied cleanly.
  Its first commit gained one sentence and one change: the store's unit test did not use
  `set_ceiling`'s `Result`, which the test build warned about; it now `expect`s it.
- B conflicted only in `ironhorse-vm/src/diagnostics.rs`, where C and B each added a re-export;
  both are kept.
  The hazards the write-ups listed did not materialise: C's code calls no `DerefMut`-only map method
  on the 16 retyped tables (`iter_mut`, `extend`, `drain`), C added no exotic table, A's new
  `state.rs` fields and `sidetable.rs` classifications sit in separate hunks from B's retyping, and
  `gc_visitation_registry` already knew `ExoticTable` from B's own commit.
- **Every integrated commit passed the per-commit gates on its own before the next was applied**:
  fmt, clippy 1.88 (`-D warnings`, also with `dispatch-census`), the release roster's costs
  against the round-1 tip (fusion on and off, 25 of 25), `benches/stack_height.py --check` (430
  cases), the debug vm and snapshot suites with `store-integrity` (2,109, 2,109, 2,110 and 2,115
  passing, 0 failing, 47 ignored at the four commits), and `golden_computrons` plain,
  `cost-calibration` and `consensus` (`raw-r2final/gate-{c1,c2,c3,b}/`).
  So the round-2 history is bisectable with these gates; the round-1 bisect hazard above still
  applies to the round-1 commits.
- The stack gate composed this time: per-track margins did not add up to a failure.
  The tightest cases on the integrated tip are `json-parse-arr-10k.run` and `jparse-arr-2017.run`
  at 6,871 B against a baseline of 6,615 B, exactly the 256 B slack, so the next frame growth on the
  JSON parse path fails the gate.

### Cross-track follow-ups done at integration

- **All accelerators together (`c3e9e775a`).**
  Gate D's plain side now switches all three accelerators off, and the other two differential
  tests each gained an all-off-versus-all-on case.
  Sensitivity, checked: an `ExoticTable::insert` that skips the `arrays` bit fails gate D's corpus
  test, whose two sides both had the bits on before, as well as the two differentials.
- **The `json` Ir blip.**
  Still present on the integrated tree: `ChunkArena::free_chunk_for` is 22.7M Ir self plus 5.2M in
  an out-of-line `LeafRange::perform_next_checked`, against 19.1M with the iterator inlined at the
  round-1 tip, about 1.4% of the workload.
  An `#[inline]` hint on `free_chunk_for` changed nothing (609.0M against 608.7M); no fix was
  committed.
  `json` is still 0.971 of the round-1 tip in Ir because `643d2967b` and the bits more than pay for
  it.
- **T19 with the bits.**
  Probing on each level of the index-keyed walk (`uninterned_index_get_levels`,
  `ironhorse-vm/src/interp/property/read_index.rs:60`) only the tables whose bit is set is safe by
  B's superset invariant alone, and was measured: `array_hole_fn` 915.6M to 895.9M (0.978).
  Below the keep bar; not committed.
  The profile shows why the full T19 would not do much better: the whole walk is 64.7M inclusive
  (7.1%), while the global read of `undefined` in `a[i & 7] === undefined` is 235.2M
  (`exec_get_variable`, 25.7%).
  Design recorded under round-3 candidates.

## Final per-workload results: base, round-1 tip, round-2 tip

Ir: whole process, one callgrind run per workload per build.
Time: 8 interleaved rounds (`raw-r2final/ab3/`).
Ratios below 1 are faster.

| workload | Ir base | Ir r1 | Ir r2 | r2/r1 | r2/base | ms base | ms r1 | ms r2 | time r2/r1 | time r2/base |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| array_fill_sum_fn | 1,960M | 1,158M | 663.0M | 0.573 | 0.338 | 168.1 | 106.1 | 42.1 | 0.397 | 0.250 |
| array_hole_fn | 1,938M | 1,089M | 915.7M | 0.841 | 0.472 | 143.1 | 78.0 | 63.2 | 0.810 | 0.442 |
| array_rw_fn | 4,065M | 2,379M | 1,543.2M | 0.649 | 0.380 | 359.5 | 218.2 | 106.6 | 0.488 | 0.296 |
| array_rw_push | 8,309M | 5,180M | 4,394.3M | 0.848 | 0.529 | 694.6 | 438.1 | 303.7 | 0.693 | 0.437 |
| closures | 4,726M | 2,849M | 2,782.9M | 0.977 | 0.589 | 320.1 | 180.3 | 187.9 | 1.042 | 0.587 |
| ctor_fn | 2,790M | 1,424M | 1,231.6M | 0.865 | 0.441 | 203.7 | 100.0 | 81.9 | 0.819 | 0.402 |
| empty_loop_fn | 1,371M | 853M | 415.5M | 0.487 | 0.303 | 86.2 | 48.3 | 24.0 | 0.497 | 0.278 |
| float_arith | 4,478M | 2,393M | 2,318.6M | 0.969 | 0.518 | 318.7 | 155.3 | 140.0 | 0.901 | 0.439 |
| func_calls | 4,898M | 3,064M | 2,985.3M | 0.974 | 0.609 | 336.5 | 204.4 | 198.9 | 0.973 | 0.591 |
| func_calls_fn | 2,308M | 1,571M | 1,424.9M | 0.907 | 0.617 | 160.0 | 92.4 | 88.4 | 0.956 | 0.552 |
| int_loop | 12,943M | 7,074M | 6,765.4M | 0.956 | 0.523 | 889.7 | 485.7 | 455.1 | 0.937 | 0.512 |
| int_loop_fn | 4,615M | 2,233M | 1,607.9M | 0.720 | 0.348 | 326.0 | 138.7 | 88.9 | 0.641 | 0.273 |
| json | 3,788M | 626M | 608.5M | 0.971 | 0.161 | 280.2 | 52.7 | 50.7 | 0.963 | 0.181 |
| map_set | 1,903M | 1,073M | 1,008.9M | 0.940 | 0.530 | 155.7 | 82.7 | 77.6 | 0.939 | 0.498 |
| method_calls | 5,454M | 2,789M | 2,592.4M | 0.930 | 0.475 | 425.3 | 180.4 | 180.2 | 0.999 | 0.424 |
| method_calls_fn | 4,033M | 1,944M | 1,675.1M | 0.862 | 0.415 | 309.7 | 136.0 | 113.9 | 0.838 | 0.368 |
| prop_getset | 7,479M | 3,478M | 3,211.0M | 0.923 | 0.429 | 598.5 | 270.2 | 248.1 | 0.918 | 0.415 |
| prop_getset_fn | 4,990M | 1,683M | 1,353.0M | 0.804 | 0.271 | 404.6 | 127.6 | 103.1 | 0.808 | 0.255 |
| proto_method_fn | 3,325M | 1,482M | 1,127.1M | 0.760 | 0.339 | 233.8 | 98.5 | 73.1 | 0.742 | 0.313 |
| string_charcode | 2,874M | 1,854M | 1,810.9M | 0.977 | 0.630 | 218.9 | 130.0 | 128.7 | 0.990 | 0.588 |
| string_charcode_fn | 950M | 684M | 586.4M | 0.857 | 0.617 | 78.5 | 42.8 | 42.6 | 0.996 | 0.543 |
| string_concat | 652M | 125M | 124.8M | 0.996 | 0.192 | 54.4 | 26.4 | 23.4 | 0.888 | 0.431 |
| string_index | 2,089M | 1,489M | 1,465.1M | 0.984 | 0.701 | 142.7 | 102.4 | 98.5 | 0.962 | 0.690 |
| typed_array | 4,265M | 2,753M | 2,688.5M | 0.976 | 0.630 | 317.2 | 189.6 | 190.1 | 1.003 | 0.599 |
| typed_array_fn | 1,508M | 971M | 885.4M | 0.912 | 0.587 | 105.5 | 67.4 | 52.3 | 0.776 | 0.496 |
| geomean (25) | | | | 0.854 | 0.439 | | | | 0.817 | 0.413 |

Round 2 over round 1: 0.854 in Ir geomean (1.17x), 0.817 in time (1.22x).
Base to round-2 tip: 0.439 in Ir (2.28x), 0.413 in time (2.42x); round 1 alone was 0.514
in Ir and 0.505 in time on this run.
No workload has more Ir than at the round-1 tip.
Most improved over round 1 in Ir: `empty_loop_fn` (0.487), `array_fill_sum_fn` (0.573),
`array_rw_fn` (0.649), `int_loop_fn` (0.720), `proto_method_fn` (0.760).
Least improved: `string_concat` (0.996), `string_index` (0.984), and `string_charcode`,
`closures` and `typed_array` (0.976-0.977), whose time is in property, call and string code that
round 2 did not target.
In time, `closures` reads 1.042 against an Ir ratio of 0.977, inside the per-process spread round 1
measured (12-85%); no workload is slower in Ir.

The gated fixtures (`ironhorse-snapshot` `dispatch_bench` and `reentry_bench`), same 8 rounds:

| fixture metric | ms base | ms r1 | ms r2 | r2/r1 | r2/base |
|---|---:|---:|---:|---:|---:|
| dispatch_ms | 1534.0 | 780.4 | 749.2 | 0.960 | 0.488 |
| slots_ms | 729.3 | 321.7 | 295.1 | 0.917 | 0.405 |
| chunks_ms | 42.1 | 23.9 | 22.2 | 0.928 | 0.527 |
| calls_ms | 987.6 | 562.8 | 541.6 | 0.962 | 0.548 |
| recursion_ms | 327.6 | 229.7 | 187.3 | 0.816 | 0.572 |
| callbacks_ms | 668.7 | 385.4 | 347.8 | 0.902 | 0.520 |
| getter_ms | 1044.8 | 520.7 | 474.9 | 0.912 | 0.455 |

Geomeans: `dispatch_bench` 0.935 of the round-1 tip and 0.471 of the base; `reentry_bench` 0.897
and 0.522.

## Losses and deferrals

Each was built or measured far enough to know why it did not ship.

- **Verify once at install (plan item 5).**
  Upper bound, measured with every per-op decode refusal deleted outright: `empty_loop_fn` 0.956
  of the superinstruction build, `int_loop_fn` 0.930; the keep bar was 5% on `empty_loop_fn`, and
  a sound version must also pay for a verified/unverified split and an audit of every pc producer.
  Fusion had already removed most of the dispatches whose headers it would have slimmed.
- **Meter loosening (charging fused code less, relaxing the cadence).**
  Charging less saves no host work: what a handler charges does not change what it executes.
  The only host work a loosened meter could remove is the near-boundary admission test; deleting
  it outright gave 0.941 (`empty_loop_fn`) and 0.955 (`int_loop_fn`), and it would widen the
  worst-case unchecked stretch, which a compliant version may not do, so a compliant version keeps
  the same test and saves about nothing.
- **T19, "no index keys on prototypes".**
  With the bits alone about 2% (0.978 measured above); the full skip is bounded by the 7.1% the
  walk costs.
- **GET_PROPERTY inline cache.**
  Validation needs a structure epoch, and every slot record write, value writes included, goes
  through `SlotArena::get_mut` (`ironhorse-vm/src/value.rs:1305`, 121 `slots.get_mut` call sites in
  28 files at the round-2 tip), so
  an epoch there is bumped by the very `this.x = ...` writes of the target loops and the cache
  would never hit.
  It needs a `set_value` (no epoch) versus structural-write split first.
- **In-place overwrite in `array_item_set` plus reading `push` arguments from the stack.**
  `array_rw_fn` 0.959 (1.043x), below the 1.05x bar; dropped.
- **The first superinstruction design**, which read every opcode from the derived buffer, cost
  about 7 Ir on every unfused op (an extra live slice and spills): 11 workloads regressed by
  0.5-1.8% while `empty_loop_fn` reached 0.513.
  The shipped design leaves the loop untouched and only head arms consult the derived byte.
- **Greedy pair fusion** fused `a; b` before seeing that `b; 3; *` was available, which cost
  `int_loop_fn` (0.750 against 0.720 with the pair yielding to the longer sequence).
  A statement-`n++` fusion (`get_local; inc; pull_local`) made the step handler slower (0.514
  against 0.487 on `empty_loop_fn`) and was reverted.
- **The `json` blip**: above, unresolved, about 1.4% of that workload.

## Metering calibration: host work per computron

Input for a future `ironhorse-meter` version, which the owner's rule 4 asks to approximate actual
work for realistic patterns.
**No meter change ships in this PR.**
Fusion only lowers host work per computron on the loops it fuses, so fused loops are
over-charged relative to other code, never under-charged; the same holds for every round-2 change,
since none changed a charge.

### The roster

Ir counts only `Interp::run` (`raw-r2final/cgrun-*`), so compile and boot are excluded; ns per
computron is the median roster sample time over the run's computrons, from the 8-round run.
Sorted by Ir per computron at the round-2 tip.

| workload | computrons | Ir/c base | Ir/c r1 | Ir/c r2 | ns/c base | ns/c r2 |
|---|---:|---:|---:|---:|---:|---:|
| json | 404,324 | 9361 | 1527 | 1488 | 693.0 | 125.4 |
| string_concat | 97,920 | 6579 | 1220 | 1212 | 555.4 | 239.4 |
| map_set | 3,188,714 | 593 | 335 | 314 | 48.8 | 24.3 |
| typed_array | 8,650,525 | 492 | 317 | 310 | 36.7 | 22.0 |
| string_charcode | 6,100,057 | 471 | 303 | 296 | 35.9 | 21.1 |
| prop_getset | 10,875,058 | 687 | 319 | 295 | 55.0 | 22.8 |
| string_index | 5,123,820 | 406 | 289 | 285 | 27.8 | 19.2 |
| ctor_fn | 4,802,901 | 582 | 296 | 255 | 42.4 | 17.0 |
| array_rw_push | 17,291,597 | 480 | 299 | 254 | 40.2 | 17.6 |
| closures | 10,950,081 | 431 | 260 | 254 | 29.2 | 17.2 |
| float_arith | 9,525,048 | 469 | 251 | 243 | 33.5 | 14.7 |
| func_calls | 12,450,050 | 393 | 246 | 239 | 27.0 | 16.0 |
| method_calls | 10,875,082 | 501 | 257 | 238 | 39.1 | 16.6 |
| int_loop | 29,500,034 | 438 | 240 | 229 | 30.2 | 15.4 |
| method_calls_fn | 9,600,082 | 421 | 202 | 174 | 32.3 | 11.9 |
| proto_method_fn | 6,600,204 | 503 | 223 | 170 | 35.4 | 11.1 |
| prop_getset_fn | 8,100,065 | 615 | 207 | 166 | 50.0 | 12.7 |
| typed_array_fn | 5,950,381 | 252 | 162 | 148 | 17.7 | 8.8 |
| array_hole_fn | 6,262,571 | 308 | 173 | 145 | 22.8 | 10.1 |
| string_charcode_fn | 4,000,056 | 236 | 169 | 145 | 19.6 | 10.7 |
| func_calls_fn | 9,900,053 | 232 | 158 | 143 | 16.2 | 8.9 |
| array_rw_fn | 12,716,576 | 319 | 186 | 121 | 28.3 | 8.4 |
| int_loop_fn | 21,000,041 | 219 | 106 | 76 | 15.5 | 4.2 |
| array_fill_sum_fn | 8,741,573 | 223 | 131 | 75 | 19.2 | 4.8 |
| empty_loop_fn | 9,000,036 | 152 | 94 | 46 | 9.6 | 2.7 |

Spread, round-2 tip: Ir per computron min 45.5, median 237.8, max 1488.2, max/median 6.26; ns per
computron min 2.7, median 15.4, max 239.4, max/median 15.51.
At the base: Ir per computron min 151.6, median 438.5, max 9360.8, max/median 21.35; ns per
computron min 9.6, median 32.3, max 693.0, max/median 21.48.
Round 1 and round 2 both narrowed the spread at the top (`json`, `string_concat`) and widened it
at the bottom (tight loops), because the cheapest code got cheaper fastest.

### Targeted patterns and the ranked under-charged list

Measured with a scratch harness (not committed) on the round-2 tip, release build: run-only Ir
(callgrind) and the median of five timed runs (`raw-r2final/cg-calib/`,
`raw-r2final/calib-time.txt`).
"x median" is against the roster median at the round-2 tip (238 Ir and 15.4 ns per
computron).

| Pattern | Computrons | Ir per computron | ns per computron | x median (Ir; ns) |
|---|---:|---:|---:|---|
| plain integer loop (reference) | 3,000,041 | 65 | 3.7 | 0.3; 0.2 |
| `push`/`pop` on a dense array | 11,324,472 | 81 | 6.2 | 0.3; 0.4 |
| `push`/`pop` on a holey array | 2,400,882 | 1,101 | 83.5 | 4.6; 5.4 |
| string grown by 5,000 appends of 8 characters | 66,573 | 6,198 | 1,280.6 | 26.1; 83.2 |
| `eval` of 3,000 distinct one-function sources | 465,013 | 6,705 | 526.8 | 28.2; 34.2 |
| `eval` of one source 3,000 times | 417,271 | 3,233 | 331.3 | 13.6; 21.5 |
| `a.length = 3` shrink, 0 named properties | 555,131 | 268 | 29.8 | 1.1; 1.9 |
| the same, 100 named properties | 556,858 | 4,048 | 279.9 | 17.0; 18.2 |
| the same, 1,000 named properties | 572,394 | 37,593 | 2,439.2 | 158.1; 158.4 |
| the same, 4,000 named properties | 624,184 | 157,834 | 11,446.6 | 663.7; 743.3 |

Ranked by host work per computron, highest first:

1. **`length` shrink on an array with many named properties.**
   `array_set_length` (`ironhorse-vm/src/interp/property/indexed.rs:209`) charges a constant
   `ARRAY_LENGTH_SET_METERING`, then on every shrink walks all own property slots and builds each
   one's key text to test for an index name (`:222-233`).
   With K named properties the host work per shrink is O(K) with an allocation per property:
   157,834 Ir per computron at K = 4,000, linear in K from 268 at K = 0.
   This is the largest gap found and is reachable with ordinary code.
2. **`eval` of source.**
   6,705 Ir per computron for distinct one-function sources, 3,233 for the same source repeated;
   every unit's bytecode (about 44 B per unit here) is retained for the realm's lifetime with no
   footprint charge,
   3,000 segments after 3,000 calls in both cases, plus a same-size dispatch buffer when it fuses
   (SECURITY-SEAMS Q1).
3. **Growing a string by concatenation.**
   6,198 Ir per computron for 5,000 appends of 8 characters; each `+` charges linearly while
   copying the whole string.
   The chunk ceiling bounds it per crank, because nothing collects within a crank: 20,000 appends
   halt with `HeapExhausted`.
4. **`JSON.stringify`/`parse`** (`json`): 1,488 Ir per computron, 6.3x the median.
5. **Generic `push`/`pop` on a holey array**: 1,101 Ir per computron against 81 for the
   same calls on a dense array (`dense_array_this` declines when `items.len() != length`).
6. **The integer hasher if its seed leaked.**
   Unmetered and not reachable without a leak (SECURITY-SEAMS 4.4).
   Measured with a std map whose keys all share one hash: a lookup costs 414 ns at 1,024 keys and
   39.5 us at 65,536 (199x and 8,053x a spread lookup), so a table of n keys costs O(n) per probe.

## Gates

Run on the integrated code tip `d5871aac0`, from `rust/engine` with `CARGO_INCREMENTAL=0` and
`RUST_MIN_STACK=33554432` (debug builds with `CARGO_PROFILE_DEV_DEBUG=line-tables-only`; logs
`raw-r2final/tip-*.txt`, `root-*.txt`):

| Gate | Result |
|---|---|
| CI `format-ironhorse`: comparison-resolution test, math-vector, lockfile-agreement, intl-profile, row-schema (`--base 03687677`), crate-graph and compiler-opcode scripts; `cargo +1.88.0 fmt --all -- --check`; standalone-root `rustfmt`; `ironhorse-store-sqlite` fmt | pass |
| `cargo +1.88.0 clippy --locked --workspace --exclude xs-oracle --exclude ironhorse-262 --exclude ironhorse-fuzz --no-deps -- -D warnings`, the same with `-p ironhorse-vm --features dispatch-census`, and `cargo +1.88.0 build` of those members with `RUSTFLAGS=-D warnings` | pass |
| CI `test-ironhorse` (debug): runtime, meter, unicode, vm, snapshot, compile, regexp with `ironhorse-vm/store-integrity` | pass: 2,435 passed, 0 failed, 52 ignored |
| `cargo test -p ironhorse-text` | pass (4) |
| deterministic-Math configuration (vm, snapshot); platform, provider and libm Math vector exports | pass (2,118 / 0 / 46; 1, 1, 1) |
| CI `test-ironhorse-calibration`: `cost-calibration` lib (365 / 0) and `golden_computrons`; `consensus` `golden_computrons` + `consensus_ceiling_caps` (3 / 0); the consensus/cost-calibration conflict check; `dispatch-census` cost unit tests (5 / 0) | pass |
| plain `golden_computrons` | pass |
| round-2 differentials: `optimised_differential` (gate D, 5), `exotic_bits_differential` (2), `array_storage_differential` (4) | pass (11 / 0) |
| lockdown, compartment and SES suites (inside the vm and snapshot runs above): `native_lockdown` 35, `guest_compartment` 24, `realms` 30, `hardened_js_boundary` 21, `ses_boot_intrinsics` 14, `ses_prelude_reach` 3, `lockdown_carry` 5 | pass, 132 / 0 |
| `python3 benches/stack_height.py --check` | pass (430 cases; tightest `json-parse-arr-10k.run` 1.039x, at the 256 B slack) |
| roster computrons, dispatch counts, raw meter index against `03687677` | identical, 25 of 25, fusion on and off |
| determinism: the roster twice in separate processes; each workload on a continuous machine and on one restored from a snapshot taken after a setup crank (scratch harness) | identical (25 of 25 each); computrons per run, dispatch count and raw meter equal across the restore |
| repo root: `cargo build --locked --release -p thixotrope-ironhorse-worker`, its tests, `ironhorse-store-sqlite` tests with `store-integrity` (release) | pass (17 / 0; 128 / 0 / 4) |

The vm crate's `ses_*` tests are self-contained probes; the real SES bundle boot
(`ironhorse-262/tests/stage4_ses_boot.rs`) needs the oracle crate and was not run.

Not run, and open verification before merge:

- test262 (committed expectation slices and the full lane), the XS-oracle differential lanes and
  everything else that needs the `c/moddable` submodule (workspace clippy and build of
  `xs-oracle`, `ironhorse-262`, `ironhorse-fuzz`; the `parity` tests; the SES bundle boot; the
  `endo` crate's ironhorse tests).
- Gate D over the `ironhorse-262` corpus programs, and a fuzz variant of `differential_source`
  (both need the oracle crate).
- Fuzz lanes, sanitizer lanes, the wasm32 builds and the cross-target stack lanes, the macOS and
  release matrix legs, the cross-platform Math vector comparison, the yarn-driven thixotrope bundle
  tests, and `benches/run.py --check-baseline`.

## Round-3 candidates, in priority order

1. **A meter-version proposal from the calibration table** (`ironhorse-meter-N`, owner approval):
   charge `length` shrinks by the named properties scanned (or index the decimal names so the scan
   disappears), a footprint charge for retained `eval` bytecode and its dispatch buffer, a
   length-proportional charge for concatenation, and the holey push/pop slow path.
   The first is also a plain host-work fix that needs no meter change if the scan goes.
2. **Global binding cache (plan item 6).**
   The largest remaining cost on the hole and global-loop workloads: `exec_get_variable` is 25.7%
   of `array_hole_fn` at the round-2 tip, and global access dominated `int_loop` in round 1.
   The exotic bits already make "the global object is ordinary" one word test.
3. **Split `SlotArena::get_mut` into value writes and structural writes**, then the monomorphic
   inline cache (plan item 7) with a structure epoch bumped only by structural writes, allocation,
   free, sweep and restore.
   The same split unblocks round 1's T10 bitset.
4. **T19, full.**
   Design: a derived per-array "ever held an item" bit set inside the item store's insert (the
   `ExoticTable::insert` pattern, so it is structural), and a hole read whose chain is the
   receiver array plus levels that are either clear-word ordinary objects or never-filled arrays,
   and whose index has no bound decimal id (`may_bind_index_name`), answers `undefined` without the
   walk.
   Bounded by the walk's 7.1% of `array_hole_fn`; worth doing after item 2 removes the global read
   that dominates it.
5. **Call path (plan item 8)**: pooled argument and local vectors and a lazy `id_map`.
6. **Stack headroom on the JSON parse path**, now at exactly the gate's slack.
7. **The `json` codegen blip** in `ChunkArena::free_chunk_for` (1.4%): restructure the free-list
   search so it does not depend on an inlined B-tree range iterator.
