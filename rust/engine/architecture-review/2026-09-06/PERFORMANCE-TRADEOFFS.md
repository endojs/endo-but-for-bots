# Performance fixes: gains against complexity added

A reviewer-side assessment of the performance branch, complementing
[PERFORMANCE-FIXES.md](PERFORMANCE-FIXES.md), which is the implementers' own record.
Three independent subagent reviews of the branch produced the judgements below; the
line counts and the structural observations in
[What the engine now carries](#what-the-engine-now-carries) were re-measured against
`1b130df7` while applying the fourth revision of
[the architecture review](ARCHITECTURE-REVIEW.md).

**Headline: the asymptotic fixes generally justify their complexity, and further
optimization should stop here.**
F119's classification index and the late compiler tuning have the weakest measured
returns.

## Size of the change

The performance branch (`51b99651..1b130df7`) is 270 files and **+18,201/-1,709
lines, a net +16,492**.
Most of that is not engine code:

| Where | Net lines | What it is |
| --- | ---: | --- |
| `rust/engine/benches/` | +9,062 | Runner, checker, checked-in baseline, 20 measurement artifacts |
| `*/src/**` | +4,363 | Production source, including Rust inline `#[cfg(test)]` blocks |
| `*/tests/**` | +2,068 | Integration and semantic tests |
| `architecture-review/` | +211 | The implementers' record |

Line count alone overstates the runtime complexity added: roughly **55% of the branch
is measurement apparatus**, and the production-source growth is about 4,400 lines with
its inline tests still counted in.

## Change by change

Representative gains are the recorded same-host integration measurements in
[PERFORMANCE-FIXES.md § Final integrated measurements](PERFORMANCE-FIXES.md).

| Change | Added complexity | Efficiency gained | Assessment |
| --- | --- | --- | --- |
| **F044** indexed strings | Bounded UTF-16 access helpers; coercion and lazy-read checks. No cache invalidation. | Character-read fixture 189.79 → 63.85 ms; eliminates repeated whole-string decoding. | **Excellent tradeoff.** |
| **F045** collection indexes and shared iterators | Canonical keys, index maintenance, tombstones, reference-counted buffers. | Map insertion 22.45 → 2.916 ms; iterator steps stop copying entire buffers. | **Strongly justified.** Replaces growing repeated work with appropriate structures. |
| **F045** property indexes | Reverse dependencies, mutation interception, invalidation, GC and restore interactions. | Construction/iteration 11.196 → 1.772 s; warmed updates 3.252 s → 7.324 ms. | Large benefit, **substantial maintenance burden**. |
| **F043** sectioned checkpoints | Dirty tracking, section inventories, acknowledgement ordering, schema migration, backend transactions. | Large unchanged checkpoint 10.40 → 0.494 ms. Small checkpoint 0.318 → 0.867 ms. | Justified for persistent workloads, **with a real small-input cost**. |
| **F065** compiler algorithms | Stable target/declaration indexes and ordered compaction. | ~1 MB compilation 3.185 s → 129.59 ms. | **Excellent tradeoff.** Directly removes quadratic algorithms. |
| **F065** compilation metering | Shared meter ownership, callbacks, sticky refusal, unwind accounting, rollback integration. | Bounds compilation work and preserves charges across failures. | **Necessary safety complexity**, not a speed optimization. |
| **F176** shared bytecode and boot reuse | Shared-buffer ownership; more demanding pristine-template copying and isolation invariants. | Fresh realms 228.67 → 11.52 ms/1,000; daemon scalar evaluations 250.26 → 31.05 ms/1,000. | Shared buffers are straightforward; **boot reuse earns its greater complexity**. |
| **F119** classification | A second derived semantic index, overlap precedence, mutation/refinement guards, GC maintenance. | Integrated cases range from 3% faster to 7% slower. | **Weakest major tradeoff.** The architectural benefit is clearer than the elapsed-time benefit. |

## Qualifications

Several qualifications matter, and each narrows a claim that the headline numbers
would otherwise carry too far.

- **Property lookup gains depend on cache state.**
  Cold or restored chains can still scan repeatedly for existing deep properties, so
  the warmed-update result is not a universal constant-time guarantee.
  `PropertyIndex::find` (`rust/engine/ironhorse-vm/src/property_index.rs:85`) walks an
  unindexed owner's chain directly, and only a scan that reaches 32 nodes builds the
  index, so an object below that threshold is re-scanned on every lookup.
- **Derived indexes consume additional memory.**
  Collection keys can duplicate string and BigInt contents; property metadata can
  retain high-water allocations.
  Lookup also remains proportional to key length wherever hashing must read the key.
- **Checkpoint gains are per section, not per element.**
  Changing one element can still require processing its entire section.
  `FileStore` still rewrites its backing file, and the measurements do not establish
  equivalent SQLite latency gains.
- **The late compiler tweaks are marginal.**
  Lazy declaration indexes and omitted diagnostics yielded roughly 1-3% local gains,
  with some slower controls.
  Reverting the larger AST representation experiment was the right call.
- **Verification machinery is becoming fragmented.**
  The semantic tests and the retained failures are valuable.
  Multiple measurement formats, multiple runners, and a textual profiling patch create
  avoidable maintenance work.
  The new full-range compiler check establishes a measured growth envelope, not a
  proof of asymptotic linearity.

## What the engine now carries

Three structural costs are worth naming because they are the ones a later reader will
have to maintain, and they are visible in the tree rather than in a measurement.

**A second section inventory.**
`SnapshotSection` in
[`ironhorse-vm/src/snapshot_dirty.rs`](../../ironhorse-vm/src/snapshot_dirty.rs)
and `SmallSection` in
[`ironhorse-snapshot/src/store_sections.rs`](../../ironhorse-snapshot/src/store_sections.rs)
each enumerate the same 32 sections.
The `vm_section()` mapping between them is an exhaustive `match`, so the compiler
does force a store-side update when the VM gains a section.
What the compiler does not check is `SmallSection::ALL`'s **order**, and that order
is the persisted section id that `from_id` reads back out of a schema-28 store.
The test at `store_sections.rs:449` checks `ALL` against itself
(`section.id() == id`), not against fixed values, so a reordering would pass CI and
silently remap every persisted section.

**Retained per-slot memory.**
The owner prefilter added during the GC review costs one byte per slot up to its
high-water owner index, as retained host memory rather than a bit-packed vector
(PERFORMANCE-FIXES.md § Integration audit).
The arena ceilings W2 introduced bound the arenas, not this side-table memory.

**A GC cost signal that lives only in a CI log.**
The Linux GC-free control regressed from **4.266 to 5.348 ms at 80,000 slots**
(1.254x, just over the 1.25x floor) with growth still approximately linear.
It cannot be attributed to F119 alone from the aggregate measurements.
That measurement is **not** in `benches/results/`: the retained artifacts record the
same-host macOS pairs and the three-trial control audit, in which every median-of-trial
comparison came in below 1.25x.
This is the fragmentation qualification above, made concrete — the strongest remaining
cost signal is the one the checked-in evidence does not hold.

## Recommendation

**Retain the main fixes and defer further tuning.**

Later simplification should prioritize, in this order:

1. F119's classification machinery, which has the weakest measured return of the
   major changes.
2. The duplicated snapshot-section inventories, and the unpinned `ALL` ordering above.
3. The benchmark and provenance tooling, which is where the fragmentation cost is
   concentrated.

Property-cache simplification should **accompany a narrower mutation interface**, not
precede one: its invalidation complexity is what protects correctness today, so
removing the complexity without first narrowing what can mutate a chain would trade a
maintenance cost for a correctness risk.
