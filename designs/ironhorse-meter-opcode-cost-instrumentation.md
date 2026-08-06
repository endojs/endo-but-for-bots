# Ironhorse Meter: Opcode Cost-Calibration Instrumentation

| | |
|---|---|
| **Created** | 2026-07-05 |
| **Author** | endolinbot (prompted) |
| **Status** | Not Started (designer-first; sibling plan of `ironhorse-engine`) |
| **Program** | `port-xs-to-rust-memory-safe-engine`, on PR #600's `xs2rust-endor` branch |
| **Parent** | [ironhorse-engine](ironhorse-engine.md) § Metering (requirement 1a); this is the "cost-calibration instrumentation (sibling plan)" that design names as the source of the release-versioned cost table's weights |

## Summary

The engine design (§ Metering, revised 2026-07-04) sets the meter's
doctrine: **accuracy over parity**. The meter is Ironhorse's own
release-versioned deterministic cost model — the best available
deterministic proxy for real (wall-clock) execution cost — **not** a
reproduction of XS's computron counts. Two properties are separated:
*determinism per release* (a frozen increment-point set with a frozen
integer cost table, unconditional, the property Agoric consensus needs)
and *accuracy across releases* (the cost table is recalibrated between
releases and every recalibration is an `ironhorse-meter-N` version bump).

That doctrine leaves a hole: **where do the frozen weights come from?**
The engine design's answer is "calibration constants derived from the
cost-calibration instrumentation (sibling plan
`xs2rust-endor-meter-opcode-cost-instrumentation`), which measures
per-opcode and per-builtin-step real cost on a named reference
platform." This document is that plan. It specifies:

1. **A complexity model** — per opcode and per builtin-step family, the
   expected computational complexity as a polynomial in the *size*
   (lengths, byte counts) or *magnitude* (numeric values, iteration and
   allocation counts) of the operation's operands.
2. **Optional instrumentation** on the `ironhorse-vm` metering path that,
   when enabled, records (a) an **opcode histogram** — execution counts
   per `XS_CODE_*` opcode and per builtin step — and (b) **normalized
   mean wall-clock time per opcode**, real time divided by the modeled
   work, whose outliers are the mis-priced opcodes worth recalibrating.
3. **A determinism firewall** — the instrumentation is behind a
   compile-time Cargo feature, off by default, provably absent from any
   metered, snapshotted, or reproducible path, so nondeterministic
   timing can never leak into a metered result or a snapshot.
4. **Measurement robustness** — no per-dispatch clock reads; batched
   aggregate timing against a monotonic clock, with streaming
   distributional statistics (count, mean, variance, percentiles) so a
   few scheduler stalls do not dominate a per-opcode mean.
5. **A report format and the recalibration loop** — a consumable JSON
   report the press/benchmark harness aggregates across the corpus,
   feeding a periodic re-derivation of the frozen integer cost table
   that ships as the next `ironhorse-meter-N`.

**Non-goals.** This instrumentation does not change the meter, the cost
table, or any observed computron count; it only *measures*. It is not a
profiler for end users, not shipped in a release build, and never
consulted by the interpreter at run time. Producing the recalibrated
table from the measurements — the reduction of timing distributions to
frozen integers — is described here as the loop's consumer but is a
downstream, human-supervised release act (a meter-version bump), not
something this instrumentation performs autonomously.

## Motivation

The deterministic meter assigns *fixed* costs at a fixed set of
increment points (today, inherited from XS: `1<<16` per dispatch in
`meter.rs::CODE_METERING`, `1<<14` per builtin step in `BUILTIN_METERING`,
`1<<8` per slot alloc, one per chunk byte; checks only at loop-closing
points). Under the accuracy-over-parity doctrine those weights *should*
be chosen to make the meter the best possible deterministic proxy for
wall-clock time. They are currently XS's constants, carried because the
landed stages predate the doctrine flip and a fortiori satisfy the
weaker result-agreement bar; they were never calibrated against real
Ironhorse execution cost.

An opcode is **mis-priced** when its true per-unit-work cost diverges
from its fixed weight. If a dispatch of `XS_CODE_ADD` and a dispatch of
`XS_CODE_CALL` both cost `1<<16` computrons but `CALL` really takes 20×
the wall-clock time per invocation, the meter systematically
under-charges call-heavy code and over-charges arithmetic-heavy code —
so the meter is a poor time proxy even though it is perfectly
deterministic. The fix is not to make the meter track time at run time
(that would destroy determinism); it is to **measure** the real
per-opcode cost offline, **normalize** it by the work the opcode was
theoretically expected to do, and use the normalized per-unit constant
to re-derive the frozen weight for the next release. This instrumentation
produces exactly that measurement.

The normalization by expected complexity is the crux. Raw mean time per
opcode is uninterpretable: `XS_CODE_ADD` on two smis and `XS_CODE_ADD`
that concatenates two 10 KB strings are the same opcode with wildly
different real costs, because the string path is O(n) in the operand
length. A bare mean would blend them and make the opcode look
unpredictable. Dividing each sample's time by its modeled work units
(here, the total code-unit length of the two string operands) yields a
per-unit-work constant that *is* stable across operand sizes — and it is
the ratio of that constant across opcodes, not its absolute value, that
tells us which fixed weights are relatively wrong.

## The complexity model

For each opcode and builtin-step family we define an **expected work
function** `w(args)` — a polynomial in operand size or magnitude that
predicts how real cost scales with the inputs. Normalized time is
`t_measured / w(args)`; a family whose normalized time is flat across
inputs is well-modeled, and the flat value is its per-unit-work cost.
The model is a *hypothesis about scaling*, deliberately coarse: it does
not need to be exact, only to capture the dominant term so that
normalized time is roughly input-independent within a family. Where a
family's normalized time is *not* flat, that itself is a finding — the
complexity model for that family is wrong and needs a better term (a
second-order effect, a wrong size-vs-magnitude choice, or a hidden
allocation).

`w` returns work in abstract *work units*; the unit is per-family and
only its scaling with the argument matters, since calibration compares
*ratios* of normalized cost across families, and a constant per-family
unit factor cancels when the resulting weight is expressed relative to a
chosen reference opcode.

### Choosing size versus magnitude per family

Pick the driver that actually moves the cost:

- **Size** (lengths, byte counts, element counts) drives cost when the
  operation touches every element/byte: string concat/compare/index,
  array and collection iteration, chunk allocation, structured
  JSON walk, property enumeration.
- **Magnitude** (the numeric value, an iteration count, an allocation
  count) drives cost when the operation's work is proportional to a
  number rather than a container: loop trip counts (aggregated at the
  backward-branch opcode), BigInt digit counts (∝ log₂ of the value),
  a `repeat(n)` or `fill(n)`, the number of slots an allocation-faithful
  construction touches.

### Families and their expected work functions

The taxonomy is over the 245-opcode `Opcode` enum (`opcode.rs`,
generated from `xsCommon.h`) plus the ~209 `NativeMethod` builtin steps
(`interp.rs`). Opcodes are bucketed into families sharing a work model;
the histogram keys on the *individual* opcode/builtin so a family can be
split later without re-instrumenting.

| Family | Representative opcodes / steps | Size vs magnitude | Expected `w(args)` |
|---|---|---|---|
| **O(1) arithmetic & logic** | `XS_CODE_ADD` (numeric path), `SUBTRACT`, `MULTIPLY`, `DIVIDE`, `MODULO`, `BIT_*`, `LEFT_SHIFT`, comparisons on primitives, `NOT`, `TYPEOF`, `INCREMENT`, `DECREMENT`, `NULL`/`TRUE`/`UNDEFINED`/`INTEGER_*`/`NUMBER` literals | — | `1` (constant) |
| **Stack & register moves** | `DUB`, `SWAP`, `POP`, `RESULT`, `GET_LOCAL_*`, `SET_LOCAL_*`, `PULL_LOCAL_*`, `CONST_LOCAL_*`, `RESERVE_*`, `RETRIEVE_*` | — | `1` |
| **Control transfer** | `BRANCH_*`, `BRANCH_IF_*`, `BRANCH_ELSE_*`, `BRANCH_COALESCE_*`, `CATCH_*`, `CODE_*` (jump targets) | magnitude (per *taken* branch) | `1` per dispatch; loop cost accrues by trip count at the backward branch |
| **String-content ops** | `XS_CODE_ADD` (string-concat path → `STRING_METERING`), string `<`/`===`, `AT`/index into a string, `template`, coercions producing strings | size (code-unit length) | `n` = total code-unit length of the operands touched |
| **Numeric wide path** | `XS_CODE_ADD`/`MULTIPLY`/etc. on BigInt (`BIGINT_METERING`), `BIGINT_1`/`BIGINT_2` literal decode, shifts on BigInt | magnitude (digit count) | `d` = operand digit count (≈ `1 + log₂(value)/32`) |
| **Property access** | `GET_PROPERTY`, `SET_PROPERTY`, `GET_PROPERTY_AT`, `SET_PROPERTY_AT`, `DELETE_PROPERTY*`, `IN`, `HAS`, `GET_SUPER*` | size (chain depth) per lookup model | `1 + p` where `p` = prototype-chain hops walked to resolve (XS has no shapes; lookup is a linked-list scan of property slots, so also `+ o` = own-property index of the hit) |
| **Object / array construction** | `XS_CODE_OBJECT`, `ARRAY`, `NEW_PROPERTY*`, `COPY_OBJECT`, `NEW`, class/instance setup | size (slots + chunk bytes) | `s` = slots allocated `+ b` = chunk bytes; the allocation-faithful metering already ties this to construction size |
| **Call & return** | `CALL`, `CALL_TAIL`, `RUN_*`, `BEGIN_*`, `END*`, `ARGUMENTS*`, `RETURN` | magnitude (argument count) | `1 + a` where `a` = argument count copied into the frame |
| **Iteration protocol** | `FOR_OF`, `FOR_IN`, `FOR_AWAIT_OF`, iterator `next` dispatch | magnitude (elements produced) | `k` = elements iterated (aggregate; per-element cost is the loop body's own opcodes) |
| **Builtin: linear collection** | `Array.prototype` `map`/`forEach`/`filter`/`reduce`/`join`/`indexOf`/`slice`/`concat`/`sort`, `String.prototype` `slice`/`split`/`indexOf`/`repeat`/`padStart`, `Map`/`Set` bulk ops, `TypedArray` fills | size (element or code-unit count) | `n` = element/code-unit count processed; `sort` is `n·log n`, an explicit non-linear term |
| **Builtin: O(1)** | `Math.*` (scalar), `Number.prototype.toString` (fixed radix on a bounded value), property getters, `Symbol` ops | — | `1` |
| **Builtin: structured walk** | `JSON.parse`, `JSON.stringify`, structured clone | size (input bytes / output nodes) | `n` = input byte length or emitted node count |
| **Allocation (metered directly)** | `fxNewSlot` seam (`tick_slot_alloc`), `fxNewChunk` seam (`tick_chunk_new`) | size (bytes) | `b` = adjusted chunk bytes / `1` per slot |

The table is the *initial* hypothesis. Its accuracy is itself an output:
each family reports how flat its normalized time is (a coefficient of
variation), and a non-flat family is a modeling finding, not a
calibration constant. The build stage that lands the model keeps it in
one reviewable table (a `CostModel` mapping opcode/builtin → a work
closure) so the hypothesis is data, editable without touching the hot
loop.

### Where the operand sizes/magnitudes come from

The interpreter already has every quantity `w` needs at the dispatch
site, because the meter's allocation-faithful accounting already reads
them:

- **String code-unit length** — from the operand slots' chunk length
  (the same length `STRING_METERING`/`tick_chunk_alloc` already uses).
- **Argument count** — `frame->ID` / the resolved arg count at `CALL`.
- **Prototype-chain hops / own-property index** — the property-lookup
  loop already walks these; the instrumentation reads the hop count it
  computes.
- **Slots and chunk bytes allocated** — the `tick_slot_alloc` /
  `tick_chunk_new` calls already carry the counts.
- **BigInt digit count** — the operand's digit array length.
- **Elements iterated / processed** — the builtin's own loop bound.

So the work function evaluates from data already in hand at the seam; the
instrumentation adds a read, not a re-derivation.

## Instrumentation architecture

### The determinism firewall (resolve-before-build crux)

Wall-clock time is nondeterministic; the deterministic meter, snapshots,
and reproducible runs **must be entirely unaffected**. The firewall is
**compile-time**, the strongest available guarantee in Rust:

- A Cargo feature `cost-calibration` on the `ironhorse-vm` crate, **off by
  default** and never enabled by any dependency in the default,
  release, snapshot, or consensus build graph. Only the calibration
  binary (a dev-only `ironhorse-calibrate` crate/bin) and the calibration
  CI job turn it on.
- Under `#[cfg(not(feature = "cost-calibration"))]` the instrumentation
  types compile to zero-sized no-ops: the `Recorder` is a unit struct,
  its `record`/`enter`/`exit` methods are `#[inline(always)]` empty
  bodies, and the interpreter holds it behind a field whose type is
  `()` in the off configuration. LLVM deletes the calls entirely — the
  hot loop is byte-identical to today's, verified by an object-code /
  disassembly diff of `dispatch_at` between a default build and today's
  (acceptance bar: no added instructions on the metered path when the
  feature is off).
- **The meter never reads the recorder, and the recorder never writes
  the meter.** The data flow is strictly one-directional (interpreter
  state → recorder), enforced by the recorder holding no `&mut Meter`
  and exposing no method the meter or `RunOutcome` calls. A grep-level
  invariant test asserts `meter.rs` and the snapshot module contain no
  reference to the recorder or any timing type.
- **No timing type appears in `RunOutcome`, the snapshot atom grammar,
  or the oracle's `OracleOutcome`.** The calibration report is a
  separate side-channel struct returned only by the calibration entry
  point, never by `run()`. This is a structural, compile-checked
  guarantee: the reproducible surfaces cannot even name a timing value.
- Even with the feature *on*, a metered or snapshotted run must produce
  identical computrons and identical snapshots to a feature-off run —
  because the recorder only observes. A CI cross-check runs the oracle
  corpus in both configurations and asserts computron and snapshot
  equality, so "on" is provably observation-only.

The recalibrated cost table this instrumentation informs **is** baked
into a release deterministically (as `ironhorse-meter-N`); the *timing
measurement* never is. That asymmetry is the whole point: measurement is
nondeterministic and quarantined; the frozen integer weights it yields
are deterministic and shipped.

### The recorder

A `CostRecorder` (present only under the feature) accumulates, keyed by a
`u16` that is the opcode discriminant for opcodes and a disjoint id range
for builtin steps (so the histogram is one dense array indexed by key,
`XS_CODE_COUNT + NATIVE_STEP_COUNT` wide):

- **Histogram** — a `u64` execution count per key. This is the cheap
  half and can run alone (histogram-only mode) with negligible overhead:
  it is one increment on an array the interpreter already touches
  (`n_dispatched` proves the pattern; the histogram generalizes that
  scalar to a per-opcode array).
- **Timing accumulator** — per key, a streaming distribution over
  *normalized* samples (time ÷ work units): count, sum, sum-of-squares
  (for mean and variance), and a bounded reservoir or a t-digest sketch
  for percentiles (p50/p90/p99) so a handful of scheduler stalls do not
  drag the mean. Storing normalized samples means the per-key
  distribution is directly the per-unit-work cost distribution.

### Measurement robustness — batched, not per-dispatch

**Per-dispatch clock reads are fatal**: a `clock_gettime`/`rdtsc` around
every opcode adds tens of nanoseconds to a dispatch that costs
single-digit nanoseconds, so the measurement would be dominated by its
own probe and the ratios (the thing we care about) would be crushed
toward 1. The design therefore never times a single dispatch. Two robust
strategies, used together:

1. **Batched homogeneous timing (primary).** For each opcode/builtin
   family, the calibration *driver* synthesizes microbenchmarks that
   execute the same opcode N times (N large, e.g. 10⁴–10⁶) over swept
   operand sizes, times the whole batch with one monotonic-clock read
   pair (`std::time::Instant`, backed by `CLOCK_MONOTONIC`), subtracts a
   measured empty-dispatch baseline, and divides by N and by `w(size)`
   to get the per-unit-work cost. Sweeping the size exposes the scaling
   and validates (or refutes) the family's `w`. This is the classic
   microbenchmark shape (à la Criterion, which the repo already uses in
   `rust/endo/xsnap/benches`), specialized to isolate one opcode. It has
   the best signal because the operand is controlled and the batch
   amortizes the clock.
2. **In-run sampled aggregate timing (secondary, corpus-driven).** For
   realistic corpus runs (where operands are whatever the program
   produces), the recorder times *runs of consecutive same-key
   dispatches* rather than single ones, or uses **sampling** — time only
   1-in-K dispatches of a key, chosen by a counter (deterministic
   stride, never a clock or RNG, so even the *sampling decision* is
   reproducible and cannot perturb a metered path). Each timed sample
   still divides by its own `w(args)`. This half is noisier but reflects
   real operand distributions; it feeds the histogram-weighted
   aggregation, not the per-unit constant.

Statistics kept per key are **distributional, not a bare mean**:
report mean, variance/CV, and p50/p90/p99. The recalibration reads the
robust central estimate (trimmed mean or p50) so a stall tail does not
inflate a weight. High CV within a family after normalization is
surfaced as a *model* finding (the `w` is wrong for that family), the
second, equally valuable output of the run.

The **named reference platform** is part of the report (CPU model, clock
source, core pinning, governor/turbo state, `Ironhorse` build hash, feature
flags). Absolute nanoseconds are platform-specific; the calibration only
uses *ratios* across opcodes measured on the *same* platform in the same
run, which are far more portable than absolute times. The report records
the platform so a later run on a different machine is never blended with
an earlier one.

### Hook sites (the touch points)

- **Dispatch histogram + optional sample timing** at `interp.rs`
  `dispatch_at`, immediately alongside the existing
  `self.meter.tick_code(); self.n_dispatched += 1;` (the seam that
  already exists for exactly this shape of per-dispatch bookkeeping).
  Under the feature, add `self.cost.on_dispatch(op, /* work inputs */)`;
  off, it compiles away.
- **Builtin-step histogram** at each `self.meter.tick_builtin()` /
  `tick_builtin_some(k)` site, keyed by the active `NativeMethod`, with
  `k` folding into the count.
- **Allocation size capture** at the `tick_slot_alloc` / `tick_chunk_new`
  seams, so the object-construction and allocation families get their
  `b`/`s` work inputs.
- **Batched driver** in the dev-only `ironhorse-calibrate` binary, which
  builds the synthetic per-opcode microbenchmarks and drives the
  primary measurement without touching the interpreter hot loop at all
  (it calls `run` with feature-on and reads the side-channel report).

Reuse the meter's opcode enum + `CODE_NAMES`/`CODE_SIZES` name/size
tables (`opcode.rs`) and `NativeMethod::display_name` for human-readable
report keys, so the report is self-describing and re-generated from the
same generated tables the meter uses — no second name list to drift.

## Output & the recalibration loop

### Report format

The calibration entry point returns (and the driver serializes to JSON) a
report:

```json
{
  "ironhorse_build": "<git sha>",
  "meter_version_measured_against": "ironhorse-meter-3",
  "reference_platform": { "cpu": "...", "clock": "CLOCK_MONOTONIC",
                          "pinned_core": 2, "turbo": false },
  "corpus": "stage3 + agoric-contract-replay",
  "opcodes": [
    { "key": "XS_CODE_ADD", "count": 148203391,
      "work_model": "string:n | numeric:1",
      "normalized_ns_per_unit": { "mean": 2.9, "cv": 0.11,
                                  "p50": 2.7, "p90": 3.4, "p99": 6.1 },
      "current_weight": 65536, "suggested_relative": 1.00 },
    { "key": "XS_CODE_CALL", "count": 9120044,
      "work_model": "1 + argc",
      "normalized_ns_per_unit": { "mean": 41.0, "cv": 0.22,
                                  "p50": 39.5, "p90": 55.0, "p99": 120.0 },
      "current_weight": 65536, "suggested_relative": 14.0 },
    ...
  ],
  "builtins": [ ... same shape, keyed by NativeMethod ... ],
  "model_findings": [
    { "key": "XS_CODE_GET_PROPERTY", "issue": "cv=0.9 after 1+p model",
      "hint": "own-property index term missing; add +o" }
  ]
}
```

`suggested_relative` is each opcode's normalized cost as a multiple of a
chosen reference opcode (e.g. a stack move = 1.0). The recalibration
turns these relatives into the next frozen integer weight table by
scaling to the meter's fixed-point range and rounding to integers —
producing `ironhorse-meter-(N+1)`. That reduction is a **human-supervised
release act**, not automated here: the instrumentation surfaces the
evidence; a maintainer (or the program supervisor) approves the version
bump, since it changes gas costs and is a coordinated-upgrade event
(engine design § Agoric consensus compatibility).

### The loop

1. The **press / benchmark driver** (the hourly garden harness that runs
   the corpus) runs `ironhorse-calibrate` over the corpus + synthetic
   sweeps on the reference platform, in a feature-on build, on a cadence.
2. It **aggregates** reports across the corpus (histogram-weighted, so
   hot opcodes dominate the fit) and across runs (to shrink variance),
   emitting a rolling calibration report.
3. A periodic **recalibration review** reads the aggregate, and when the
   evidence justifies it, re-derives the frozen integer cost table and
   ships it as `ironhorse-meter-(N+1)` — a versioned, coordinated bump; the
   previous table stays addressable by version so old metered outcomes
   remain reproducible.
4. **Model findings** (non-flat families) feed back into the complexity
   model itself, improving future normalization.

This closes the loop: measurement → mis-pricing evidence →
more-accurate deterministic meter, without ever letting timing touch a
metered result.

## Staged roadmap

Each stage lands as commits on PR #600's `xs2rust-endor` branch, is
independently green, and names its acceptance bar. **Ordered**; the
model + firewall land before any timing, and the histogram (cheap,
deterministic-safe) lands before wall-clock measurement.

| Stage | Deliverable | Acceptance bar |
|---|---|---|
| **C1. Feature scaffold + firewall + histogram** | `cost-calibration` Cargo feature (off by default); zero-sized-when-off `CostRecorder`; the per-opcode + per-builtin **histogram** wired at the existing `tick_code`/`tick_builtin` seams; the `CostModel` work-function table (data only). | Disassembly of `dispatch_at` in a default build is instruction-identical to pre-change (firewall proof); oracle corpus produces identical computrons and snapshots feature-on vs feature-off; histogram counts match `n_dispatched` in aggregate; `forbid(unsafe_code)` holds. |
| **C2. Batched timing driver + normalization** | dev-only `ironhorse-calibrate` binary; synthetic per-opcode microbenchmarks over swept operand sizes; monotonic-clock batched timing with empty-dispatch baseline subtraction; normalization by `w`; distributional stats (mean/CV/percentiles); JSON report with `reference_platform`. | Report emits per-opcode normalized cost with CV; a known-linear family (string concat) shows flat normalized cost across swept sizes (model validated); a deliberately O(1)-mismodeled family shows high CV (finding surfaced); timing types appear in no reproducible surface (compile-checked). |
| **C3. In-run sampled timing + corpus mode** | deterministic-stride sampled aggregate timing on corpus runs; histogram-weighted aggregation across the corpus; `model_findings` output. | Corpus run produces an aggregate report; sampling stride is reproducible and provably absent from metered paths; feature-on corpus run still bit-identical in computrons/snapshots to feature-off. |
| **C4. Press/benchmark harness integration + loop** | wire `ironhorse-calibrate` into the press/benchmark driver on a cadence; rolling cross-run aggregation; the recalibration-review artifact (`suggested_relative` → candidate `ironhorse-meter-N+1` table, for human approval). | The harness produces a rolling calibration report over the corpus on the reference platform; the candidate-table artifact is generated but **not** auto-applied; a documented review step gates the meter-version bump. |

Stages C1 and C2 are the thin slice that proves the two cruxes (firewall
and normalization). C3/C4 scale it to the corpus and close the loop. If
C1 cannot show an instruction-identical hot loop when the feature is off,
or C2's normalization cannot flatten a known-linear family, the plan
stops cheaply with an informative failure rather than shipping a probe
that either perturbs determinism or produces uninterpretable numbers.

**Orchestration.** This decomposes into four ordered build stages;
promoted for build, it should run as a serial orchestration
(`post-orchestration.sh --serial`) over four parked children
(`xs2rust-endor-meter-calibration-stage-c1` … `-c4`), each gated on the
prior reaching `tada/`, so a stalled stage halts and surfaces rather
than a later stage building on an unlanded seam.

## Design decisions

- **Compile-time feature, not a runtime toggle.** The engine design
  offered "compile-time feature flag (preferably) or an explicit runtime
  toggle." We take the preferred branch unconditionally: a runtime toggle
  leaves a live branch (and a live timing field) on the metered path, a
  standing risk that a future edit reads it into a metered result. A
  compile-time feature makes the instrumentation *absent* from the
  release binary — the firewall is enforced by the linker, not by
  discipline.
- **Store normalized samples, not raw times.** Normalizing at record
  time (dividing by `w` at the seam, where the work inputs are in hand)
  keeps the per-key distribution directly interpretable as per-unit-work
  cost and avoids retaining per-sample operand sizes. The cost is that a
  wrong `w` is baked into the stored sample; we mitigate by also keeping
  the histogram (which is `w`-independent) and by the CV finding, which
  reveals a wrong `w`.
- **Ratios, not absolute times, are the calibration signal.** Absolute
  nanoseconds are platform- and thermal-state-specific. The weight table
  is a set of *relative* costs; measuring relatives on one pinned
  platform per run is robust where measuring portable absolutes is not.
- **The histogram is useful on its own** and is deterministic-safe (no
  clock), so it can run in more contexts than the timing half and is the
  cheaper acceptance gate in C1.
- **The recalibration is human-gated.** Turning measurements into a
  frozen table changes gas costs (a consensus/governance event). The
  instrumentation stops at *evidence + a candidate table*; the version
  bump is approved out-of-band, matching how every XS meter change has
  shipped (§ Agoric consensus compatibility in the parent design).

## Open questions

1. **Reference-platform selection.** Which machine is the canonical
   calibration platform, and how is its thermal/turbo state pinned for
   run-to-run comparability? (Proposal: a dedicated pinned core, turbo
   off, governor `performance`, recorded in every report; blend across
   reports only within one platform id.)
2. **Timing source.** `std::time::Instant` (portable, `CLOCK_MONOTONIC`)
   for the primary batched driver; is a TSC-based path (`rdtsc` with
   invariant-TSC check) worth it for the sampled in-run half, or does
   batching already amortize the clock enough? (Lean: `Instant` only —
   simpler, and batching makes the clock cost negligible.)
3. **Builtin-step granularity.** Some builtins meter with
   `mxMeterSome(k)` in one call; do we attribute the whole `k` to one
   sample, or model the builtin's own O(n) sweep as `w = k`? (Lean: the
   latter — treat `k` as the work units, consistent with the linear
   collection family.)
4. **Percentile sketch.** Reservoir sample vs t-digest for p99 under a
   bounded memory budget across 245+209 keys. (Lean: a small
   fixed-capacity reservoir per key; exactness of p99 is not needed, only
   robustness of the central estimate.)
5. **Corpus for C3/C4.** Which corpus best represents real Ironhorse load —
   the stage corpora, agoric-contract replay on the `kriscendobot`
   fork tooling (parent design stage 9, fork-scoped, no upstream), or a
   blend? (Defer to the press-driver's existing corpus plus synthetic
   sweeps.)

## Prompt

> Add optional instrumentation to the ironhorse-vm metering path that, when
> enabled, records (1) an opcode histogram — execution counts per
> XS_CODE_* opcode and per builtin step — and (2) normalized average
> wall-clock time per opcode, real time normalized by the operation's
> expected polynomial complexity in its arguments' sizes or magnitudes,
> so that opcodes whose normalized time is an outlier are surfaced as the
> mis-priced fixed costs most worth recalibrating. Off by default with
> zero overhead when disabled. Goal: increase meter accuracy as a proxy
> for wall-clock time while the meter stays deterministic per release;
> meter parity with XS is explicitly not a goal. Determinism firewall:
> gate behind a compile-time feature (preferred) provably off on any
> metered/reproducible/snapshot path so timing can never leak into a
> metered result or a snapshot. Define a per-opcode/builtin complexity
> model (size vs magnitude per op). Measurement must be robust: no
> per-dispatch clock reads — batched aggregate timing on a monotonic
> clock with distributional stats. Emit a consumable report the
> press/benchmark harness aggregates across the corpus, feeding periodic
> re-derivation of the per-release cost table. Designer specifies the
> model, the API, the off-by-default gating, and the recalibration loop;
> a staged build adds the hooks + report; a follow-on wires it into the
> harness.
