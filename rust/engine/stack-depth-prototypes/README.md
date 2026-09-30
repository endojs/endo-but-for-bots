# Stack-depth refactoring prototypes

These patches are the experiments behind
[STACK-DEPTH-REFACTOR.md](../STACK-DEPTH-REFACTOR.md).
They are evidence for its measurements, not changes proposed for merging as they stand.
Each was measured against the unpatched engine in a scratch copy.
The report records what was measured and which differential suites they passed.

All of them apply to the tree at the commit that added this directory.
Apply one from the repository root:

```sh
git apply --directory=rust/engine rust/engine/stack-depth-prototypes/<patch>
```

| Patch | Report option (STACK-DEPTH-REFACTOR §4) | What it changes |
|---|---|---|
| `a1-thin-native-dispatch.patch` | A1, one family | Puts a thin dispatcher in front of `call_native_method_inner` that sends `Array.prototype.forEach` on a dense array to one `#[inline(never)]` function (`experiment_array_foreach`) and every other method to the renamed monolith (`call_native_method_inner_all`). It measures one family of A1; `call_native_inner` is unchanged. |
| `a2-dispatch-split-table.patch` | A2a | Moves `dispatch_at_inner`'s opcode arms into eight `#[inline(never)]` opcode-group functions chosen by one `match` on the opcode, so a re-entry carries the small loop frame plus one group's frame. Per-opcode handlers (A2b) are not prototyped. |
| `b1-b2-proxy-cursor-loops.patch` | B1, B2 | Cursor loops for trap-absent Proxy forwarding (a layer with a trap hands off to a separate function), and `instanceof` over bound functions as a loop, charging `native_depth` exactly as the recursion did |
| `b3-b4-json-parse-and-flat.patch` | B3, B4 (fast path) | `JSON.parse` over an explicit container stack, and the compact `flat` path as a depth-first walk with one cursor per open array |
| `d1a-compiler-outline-only.patch` | D1a | `#[inline(never)]` on the scoper's and coder's recursive arms, to shrink their frames |
| `d1a-d1c-compiler-worklists.patch` | D1a–D1c | D1a, plus worklists for two tree walks, explicit stacks in the scoper's hoist and bind arms, a coder spine for binary operators, and an iterative `Drop` for AST nodes. It also adds a public `scope_forget` hook to `ironhorse-compile/src/lib.rs` for the measurements. |

Each patch was also built and tested on its own against the unpatched tree, with
`cargo test --release -p <crate> --no-fail-fast`:

| Patch | Crate | Tests |
|---|---|---|
| (none) | `ironhorse-vm` | 1,117 passed |
| (none) | `ironhorse-compile` | 221 passed |
| `a1-thin-native-dispatch.patch` | `ironhorse-vm` | 1,117 passed |
| `a2-dispatch-split-table.patch` | `ironhorse-vm` | 1,111 passed, **6 failed** |
| `b1-b2-proxy-cursor-loops.patch` | `ironhorse-vm` | 1,117 passed |
| `b3-b4-json-parse-and-flat.patch` | `ironhorse-vm` | 1,117 passed |
| `d1a-compiler-outline-only.patch` | `ironhorse-compile` | 221 passed |
| `d1a-d1c-compiler-worklists.patch` | `ironhorse-compile` | 221 passed |

A2's six failures are all in `ironhorse-vm/tests/dispatch_loop_control_transfer.rs`.
That file scans the source of `interp/dispatch.rs` to check that every exit from the dispatch
loop goes through the depth and meter guards.
Three fail on the prototype's own code: it copies `macro_rules! dispatch_halt` into its group
functions (two scans require one declaration), and it leaves one raw return the scan cannot
classify.
The other three fail because the scans look only inside `dispatch_at_inner`, and the split moved
the raise sites, a mutation anchor and the `dispatch_result!`-wrapped handler calls out of it.
A production version of A2 must satisfy those checks or deliberately update the scanner.

`d1a-d1c-compiler-worklists.patch` contains D1a, so apply one or the other, not both.
A2 was measured on top of A1; the other VM patches were measured one at a time.
The four VM patches and `d1a-d1c-compiler-worklists.patch` touch disjoint files and apply
together.
Built together, they pass 1,332 of the 1,338 `ironhorse-vm` and `ironhorse-compile` tests, and
the six failures are the same six as A2's alone.
Their stack savings were not measured together.

The measurement data these patches were compared with lived in session scratch and was not kept.
The report inlines its key per-case numbers in Appendix B.

## Stack savings per patch

What the report measured for each patch, one patch at a time against the unpatched tree.
N is native x86_64, WT is Wasmtime (Cranelift), LO and TF are V8's Liftoff and TurboFan tiers.
The section references are to `STACK-DEPTH-REFACTOR.md`.

| Patch | Measured on | Before → after | Section |
|---|---|---|---|
| `a1-thin-native-dispatch.patch` | forEach, per level | N 13,950 → 6,762 B (re-measured 14,027 → 6,608 B); gen-next unchanged at 13,666 B because it still crosses the monolith, so every family needs outlining | §4.3 A1 |
| `a2-dispatch-split-table.patch` (on top of A1) | per level | forEach N 13,950 → 2,454, WT 13,527 → 2,850, LO 3,149 → 1,314 B; async N 5,400 → 1,691, WT 11,200 → 910 B; getter N 7,054 → 3,858, WT 13,104 → 3,138, LO 3,351 → 1,976 B; Function-call N 9,583 → 1,391, WT 22,223 → 2,029 B; eval WT 24,651 → 4,594 B. Loop frame 208 B N / 304 B WT; group frames 512-1,232 B N / 256-624 B WT. At WT 512 KiB, eight family cases went from trap to native-identical; the worst remaining heavy case is getter-119 at 378,607 B | §4.3 A2 |
| `b1-b2-proxy-cursor-loops.patch`, B1 | trap-absent Proxy layer | N 242-991 B and WT 176-928 B → 0 B; the minimum stack stays flat from 500 to 1,500 layers (32 KiB N, 46 KiB Node, 33,008 B WT). Trap-present layers get costlier: WT 432 → 512 B, N 897 → 1,024 B; on Node the get-trapped 2,016-layer chain rises from 719 to 734 KiB (LO) and 779 to 889 KiB (TF); workerd not measured | §4.4 B1 |
| `b1-b2-proxy-cursor-loops.patch`, B2 | bound-function `instanceof`, per level | 209 / 384 B → 0 B; a 3,000-level chain completes at WT 512 KiB | §4.4 B2 |
| `b3-b4-json-parse-and-flat.patch`, B3 | `JSON.parse` at the ceiling | N 1,104 / 2,176 KiB → 36 KiB (the process floor); WT 855,159 → 17,836 B; LO 543 → 46 KiB (the floor) | §4.4 B3 |
| `b3-b4-json-parse-and-flat.patch`, B4 | fast `flat` at 1,022 levels | N 304 → 36 KiB; WT 244,479 → 16,868 B; LO 183 → 46 KiB; the generic path is not prototyped | §4.4 B4 |
| `d1a-compiler-outline-only.patch` | whole compile, WT, KiB | callchain-2044 1,952 → 866; elseif-2044 1,569 → 834; member-2045 1,441 → 707; function-512 1,060 → 667; cond-1011 779 → 413; block-512 675 → 347; binary-2045 1,218 → 515; tagged-2043 2,205 → 1,249; native binary chain 1,195 → 490 KiB | §4.6 D1 |
| `d1a-d1c-compiler-worklists.patch` | whole compile, WT, KiB | callchain-2044 962 (worse than D1a's 866); elseif 834; member 707; function-512 747 (worse than D1a's 667); cond 413; block 331; binary-2045 18 (constant in the chain length); tagged 1,249; Node TF callchain-2044 1,123 → 741 KiB. The two regressions against D1a alone are unexplained; the report asks for a fix before Phase 1 lands D1 | §4.6 D1 |

The savings were not measured with the patches combined.

## Runtime cost

The report measures stack bytes; its only throughput figure is §4.3's wall-clock table for A2.
This section is a second measurement, per patch group in isolation, made natively with
[`runtime-bench.rs`](runtime-bench.rs) (copy it into `ironhorse-vm/tests/` to run it; the
header says how).

Host: a shared 4-core x86_64 Linux VM, Rust 1.91.1, the workspace release profile
(`overflow-checks = true`), `RUST_MIN_STACK=33554432`, `CARGO_INCREMENTAL=0`.
Each tree was built from the same unpatched commit with one patch group applied: A1 alone;
A1 plus A2 (A2 was prototyped on top of A1); B1-B2 plus B3-B4; D1a-D1c.
Every cell is the median of up to three samples, each sample the median of 7 runs on a fresh
machine, with the samples of different trees interleaved.
The unpatched tree's three samples spread by ±5%, so cells inside that are noise; a patch
group's cells for paths it does not touch double as its noise check.

| Workload | Unpatched, ms | A1 + A2 | A1 alone | B1-B4 | D1a-D1c |
|---|---:|---:|---:|---:|---:|
| arithmetic dispatch loop, 2M iterations | 1,905 | 1.13× | 0.98× | 1.02× | 0.97× |
| ordinary property get/set, 1M iterations | 1,587 | 1.14× | 1.01× | 1.03× | 1.04× |
| getter re-entry, 1M reads | 1,547 | 1.10× | 1.01× | 1.05× | 1.00× |
| guest-to-guest recursion, 2,000 × depth 300 | 439 | 1.12× | 1.03× | 0.98× | 0.99× |
| `forEach` callbacks, 1M | 1,034 | 1.04× | 1.00× | 0.98× | 1.02× |
| `map` callbacks, 1M | 731 | 0.98× | 1.01× | 0.96× | 0.95× |
| `JSON.parse` + `stringify`, 39 KB × 10 | 447 | 1.03× | 0.97× | 1.02× | 1.00× |
| `flat(3)`, 30,000 leaves × 100 | 7,012 | 1.04× | 1.03× | 1.03× | 1.03× |
| 40 trap-absent Proxy layers, 200k gets | 2,308 | 1.02× | 1.03× | 1.03× | 1.09× |
| 40 trap-absent layers over one `get` trap, 200k | 4,460 | 1.00× | 0.96× | 1.01× | 1.00× |
| one trapped Proxy, 200k get/set | 6,828 | 1.01× | 1.00× | 1.02× | 1.01× |
| bound-function `instanceof`, 20 deep, 400k | 3,484 | 1.06× | 1.01× | 1.08× | 1.01× |
| compile 16,000 `if/else` statements | 214 | 1.00× | 0.95× | 0.96× | 1.06× |
| compile 3,000 small functions | 252 | 1.10× | 1.05× | 0.98× | 0.98× |

What it shows:

- A2's group split costs 10-14% on dispatch-bound and property-bound code and 4% on
  callback re-entry, in line with §4.3's 1.04-1.17× table-routing figures.
  A1 alone is within noise, so the cost is the split itself: a second `match` on the opcode per
  instruction, a non-inlined call, and a `Flow` value re-matched in the loop.
  `benches/run.py`'s gate is a 1.25× floor with no re-entry workload, so A2a as prototyped
  would pass the gate while regressing every workload above.
- B1-B4 are within noise.
  The `proxies` lookup B1 adds to every ordinary MOP call costs at most 3%.
  B2's loop reads 1.08× on bound `instanceof` across three samples, probably real and small.
- D1a-D1c is within noise on the two substantial compiles.
  The coder's binary spine allocates a `Vec` per binary node, even for `a + b`, which does not
  show at these sizes.
  The sub-millisecond chain and nesting workloads in `runtime-bench.rs` are too short to
  resolve on this host and are not tabulated.
