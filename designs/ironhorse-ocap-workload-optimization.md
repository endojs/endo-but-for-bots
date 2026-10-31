# Ironhorse Optimization for Object-Capability Workloads

| | |
|---|---|
| **Created** | 2026-09-17 |
| **Author** | kriscendobot (prompted) |
| **Status** | Proposed |
| **Implementation base** | Frozen `llm-<sha>` (the engine is `llm`-only), one milestone PR per optimization |

This campaign optimizes Ironhorse for the allocation pattern produced by
object-capability programs: factories repeatedly create cohorts of method
closures, publish narrow facets, and transitively harden the resulting object
graphs. It is a **performance campaign**, not a conformance campaign. The test
corpus and its expectations are held fixed; elapsed time and allocation counts
are the quantities allowed to improve.

This distinction changes the definition of done. A correctness milestone earns
credit by covering more tests. An optimization milestone earns credit only when
the same tests produce the same classifications and a posted, reproducible
benchmark shows a material improvement. A change that is correct but not faster
is reverted or closed with an explicit “not pursuing” report.

## Current grounding

The original request was recorded on 2026-08-17. Two facts have changed since
then:

- Ironhorse is now the Rust engine under `rust/engine/`. Moddable XS, reached
  through `rust/endo/xsnap/` and `c/moddable`, is the result oracle and
  performance control; it is no longer the implementation surface to optimize.
- `rust/engine/benches/` now has a same-host baseline runner, growth tests, and
  XS microbenchmarks. It still has no object-capability workload corpus.

The earlier entry conditions are satisfied. The below-baseline branch repair
landed, and hardened262 became available when
[PR 1040](https://github.com/endojs/endo-but-for-bots/pull/1040) merged on
2026-08-20. The campaign must nevertheless capture a fresh baseline at its own
first commit; historical counts are evidence, not a substitute for measuring
the implementation base.

Related designs are [Ironhorse Engine](ironhorse-engine.md),
[test262 Fixture Consolidation](test262-fixture-consolidation.md), and the
benchmark discipline demonstrated by
[Purely Indexed TypedArray Fast Path for `harden`](hardener-indexed-cardinality.md).

## The workload

The benchmark corpus is checked-in, self-contained JavaScript executed by
Ironhorse and XS. It is reduced from patterns that already occur in Endo rather
than copied from one application. The first milestone inventories representative
uses of `defineExoClassKit`, `makeExo`, promise kits, revocable forwarders, and
SES `harden`, and records the observed distributions of facet count, method
count, capture count, and hardened graph size. Those observations determine the
fixture parameters.

The stable workload roster is:

| Fixture | Shape measured | Required observable result |
|---|---|---|
| `closure-site` | Repeated evaluation of one function-creating site with 0, 1, 4, and 8 captured cells | checksum from invoking every closure |
| `facet-cohort` | Factories returning 2, 4, and 8 facets, each with 2 or 4 methods over shared state | checksum after round-robin method calls |
| `harden-tree` | Wide, deep, and shared-DAG ordinary object graphs hardened once | frozen-state census plus leaf checksum |
| `harden-repeat` | Repeated harden and integrity queries on an already-hardened graph | identical booleans and identity checks |
| `ocap-mixed` | Allocate a cohort, harden it, retain it, invoke it, and release it in batches | checksum and retained-live-object census |
| `mutable-control` | Same object/closure sizes without harden, plus ordinary mutation | checksum proving mutable paths did not regress |

Each fixture has small, representative, and stress sizes. Source generation is
deterministic and its digest is part of every report. Setup, compile/link, guest
execution, collection, and checkpoint are reported separately; the primary
score is steady-state guest execution including allocation and hardening but
excluding source generation and machine creation. Supporting counters include
slot allocations, peak live slots, collected slots, chunk bytes, and deterministic
computrons. Counters diagnose the win; wall-clock time decides it.

The corpus lives beside the current performance instruments under
`rust/engine/benches/ocap/`. It uses the existing release-mode, serial,
same-host comparison machinery. XS is a comparison arm, not the acceptance
baseline: an Ironhorse change is compared to its immediate pre-change revision
using identical fixtures and toolchain.

## Measurement and acceptance

Each milestone measures the parent and candidate in alternating order on the
same otherwise-idle host, with one warm-up and at least seven samples. The report
records both commits, CPU, OS, Rust compiler, build environment, fixture digest,
sample order, medians, and raw samples. Ordinary PR CI checks fixture results and
report schema; timing decisions run in the nightly benchmark lane and are posted
as JSON under `rust/engine/benches/results/` and summarized on the milestone PR.

An optimization is accepted only when all of these hold:

1. The representative target improves by at least 10%, its 95% bootstrap
   confidence interval excludes no change, and the object-capability composite
   geometric mean improves by at least 5%.
2. No individual object-capability or mutable-control fixture regresses by more
   than 5%. The existing general benchmark corpus stays within its 1.25x
   regression floor.
3. Observable results, deterministic computrons, and the fixture roster are
   identical between parent and candidate. Optimization fast paths charge the
   existing cost model even when host work becomes cheaper; recalibrating the
   release-versioned meter is separate work.
4. The conformance gate below is exact. Aggregate counts are not sufficient.

If noise prevents a decision, increase samples and post the inconclusive result.
Do not tune the threshold or discard an inconvenient fixture after seeing the
candidate. If a representation idea misses the bar, preserve the report and
state why it is not being pursued.

## Conformance gate: “tests unmoved”

Every milestone pins the same test262 revision, hardened262 revision, feature
selection, and committed expectation files on both revisions. It emits a sorted
manifest keyed by test path and mode. The candidate manifest must be byte-for-byte
equal to the parent manifest: pass, expected fail, skip reason, negative phase,
and completion classification all remain unchanged. This prevents one new pass
and one new failure from cancelling in an aggregate count.

The gate also runs the Ironhorse workspace tests, snapshot/restore compatibility
tests, the differential XS result oracle, and hardened262 in every supported
mode. Test files and expectation lists do not change in an optimization PR.
There is no functional regression allowance. An infrastructure failure may be
classified as a flake only after it reproduces on both parent and candidate in
three interleaved attempts; the report names it and the milestone remains
undecided until the compared manifests are complete.

## Closure-site templates

Today a function-creation sequence executes `new_function`, `code`,
`function_environment`, and one `store` per capture. It allocates the function
instance and metadata, a default prototype, an environment head and behavior
slot, then one arena slot per captured cell. `store_closure` also walks to the
tail of the environment chain for every appended capture. The layout is largely
constant for every execution of the same bytecode site, but Ironhorse rebuilds
it one record at a time.

The linker derives a `ClosureSiteTemplate` from each immutable code segment. It
contains the fixed slot records, function kind, body range, arity, name metadata,
capture count, and patch positions. It never contains dynamic references. At
execution, a safe-Rust arena primitive reserves the fragment, copies the fixed
records as a batch, and patches only the function identity links, current global
and dynamic environment, default prototype back-reference, and captured cell
indices. The template path accrues the same computrons as the scalar path.

The key is `(code-segment identity, definition pc, linked symbol-table variant)`.
Templates are derived caches: they are not snapshot payloads, GC roots, or part
of the bytecode format. Restore and code-segment replacement rebuild them. The
scalar path remains for malformed/unrecognized sequences and as a test oracle.
Differential tests execute both allocators from identical pre-states and compare
the guest result, allocation order and count, function descriptors, GC edge set,
snapshot round-trip, and meter trace.

The first implementation stays representation-compatible with the existing
slot arena and snapshot schema. If free-list reuse makes a faithful batch
allocation more expensive than the scalar path, the template may batch only
fresh-tail allocation and fall back when reusable slots are present. A new heap
format or bytecode opcode is not justified until the benchmark proves this
narrow version insufficient.

## What immutability buys

Freezing is monotonic for ordinary ECMAScript properties: after an ordinary
object is non-extensible and every own property is non-configurable (and every
data property non-writable), its prototype, key set, descriptors, and outgoing
property references cannot change. Transitive hardening extends that fact over
the reached graph. Ironhorse can exploit this proof, but only within the exact
boundary established by the object kind.

| Opportunity | Decision |
|---|---|
| Fuse freeze and referent discovery for ordinary, non-proxy objects | Pursue. Walk the authoritative slot chain once; retain the full MOP path for proxies and exotics. |
| Cache sealed/frozen/hardened state | Pursue. A derived per-slot bitset makes repeated integrity queries and rejected writes constant-time. The persisted property flags remain authoritative and restore rebuilds the cache. |
| Keep the derived property index permanently valid for frozen ordinary objects | Measure. Frozen slots cannot invalidate it; eagerly building it is worthwhile only above a measured property-count threshold. |
| Cache the outgoing GC edge roster of hardened ordinary objects | Measure after the first two wins. The roster excludes mutable internal side tables and is discarded/rebuilt on restore. |
| Fast-reject writes to frozen ordinary objects | Pursue through the cached state, while preserving strict throws, sloppy no-ops, receiver semantics, and Proxy traps. |
| Skip dirty tracking or checkpoint pages wholesale | Do not pursue initially. Integrity marking itself writes flags, mutable objects can share a page, and page dirtiness is coarser than object immutability. |
| Treat frozen `Map`, `Set`, `Date`, RegExp, buffers, TypedArrays, or accessors as deeply immutable | Do not do this. `Object.freeze` does not generally freeze internal slots, TypedArray rules are special, and accessors execute code. Only the engine's separately proven `petrify`/read-only marker may justify an exotic-specific fast path. |
| Merge or hash-cons equal frozen objects, or share one object identity across realms | Reject. `===`, WeakMap keys, prototypes, and capability identity remain observable even when state is immutable. |
| Remove all write checks | Reject. Failed writes and reflective operations have specified observable behavior; immutability permits a cheaper decision, not omission of the decision. |

The immutable fast path therefore begins with ordinary records, arrays only
where their exotic indexed rules are explicitly handled, and function objects
whose mutable internal state has been excluded. Each additional object kind is
an independently benchmarked extension, not an inference from “frozen.”

## Ownership map

| Boundary | Mechanism | Policy | Durable state | Lifecycle / commit authority | Value crossing |
|---|---|---|---|---|---|
| compiler/linker → VM | Derive immutable closure-site descriptions from bytecode | VM validates a template and chooses template or scalar allocation | Bytecode remains authoritative; templates are derived only | VM drops/rebuilds templates with code segments and restore | `ClosureSiteTemplate`, named in VM allocation vocabulary |
| VM → snapshot/store | Expose canonical slots, side tables, and flags | Snapshot layer decides admission, encoding, commit, and restore | Snapshot/store owns persisted heap bytes; VM caches are omitted | Snapshot layer owns commit/discard and replay; VM reconstructs caches | Existing heap image, unchanged by the first milestones |
| benchmark harness → milestone | Run pinned workloads and emit manifests/reports | Milestone gate accepts, rejects, or declares inconclusive from fixed thresholds | Checked-in fixtures and result JSON | Milestone PR owns the optimization decision | Result manifest, timing samples, allocation counters |

Persistent state belongs to the snapshot/store layer; closure templates and
immutability indexes are disposable VM derivations. The snapshot layer alone
commits or discards heap state and owns restore/replay. The VM classifies an
execution result and maintains optimization caches; the campaign gate decides
whether the implementation is kept. Inner mechanisms use allocation, execution,
and cache vocabulary, never outer terms such as commit, crank, or replay.

## Milestones and PR shape

1. **Benchmark corpus and baseline.** Land the fixed workload roster, provenance
   schema, parent/candidate runner, allocation counters, and an initial report.
   No engine optimization is included.
2. **Closure-site templates.** Land one milestone PR with scalar/template twins,
   the exact conformance manifest, and the before/after benchmark report. Close
   as not pursuing if it misses the acceptance bar.
3. **Frozen-object exploitation.** Land the ordinary-object fused harden pass,
   integrity cache, and fast rejection in one milestone PR. Property-index and
   GC-roster extensions land only if their isolated measurements clear the same
   bar; otherwise the report records their rejection.
4. **Campaign audit.** Re-run both accepted optimizations together from the
   benchmark baseline, the full exact conformance manifest, hardened262, snapshot
   compatibility, general performance corpus, and XS comparison. Publish the
   combined report and record every declined candidate.

Each milestone is its own implementation PR against a frozen `llm-<sha>` base,
because `rust/engine/` is absent from `master`. It is not a handler-per-cluster
branch and is not part of this design PR. The work runs serially: the benchmark
contract must exist before either optimization, and the campaign audit observes
only changes that independently earned their place.

## Exit criteria

The campaign is complete when the fixed object-capability corpus and baseline are
landed, each proposed optimization has either an accepted benchmark-backed PR or
a posted not-pursuing result, every accepted PR has an identical parent/candidate
conformance manifest, and the combined report satisfies the performance and
regression thresholds. A faster engine with moved tests fails; an unchanged
engine with only a plausible optimization story also fails.
