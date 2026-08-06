# test262 Fixture Consolidation: One Annotation-Driven Corpus, Parameterized Expectation Lists

| | |
|---|---|
| **Created** | 2026-08-06 |
| **Author** | endolinbot (prompted) |
| **Status** | Proposed (follow-up refactor of [ironhorse-test262-convergence](ironhorse-test262-convergence.md); one open decision for the maintainer, see § Open Decision) |

The maintainer directive (@kriskowal, liaison relay 2026-07-26) asks the
test262 fixtures to converge on "one source of truth ... consumed by
both the ironhorse dual-run harness and the CI `test262-harness` hosts,
keyed off the harness annotations already in each case, with explicit
lists of tests expected to pass and fail parameterized by
(host/engine, strict-mode, feature-set / roadmap stage)." This document
specs that consolidation. It is the concrete, code-grounded refinement
the parked plan flagged as "to be refined at promotion", and it is the
prerequisite groundwork for the end-state
[decommission-cxs-rust-default-xst-ci-parity] (Rust VM default, parity
proved through the downloaded `xst` binary under `test262-harness`).

The directive supersedes one decision in the parent convergence design.
That design (2026-07-05) chose two corpora with different jobs
(decision 2). This refactor collapses the *expectation model* onto one
mechanism; whether it also collapses the two *case trees* is the one
question this document leaves to the maintainer, because the premise the
directive rests on (that the ironhorse cases "duplicate upstream") is not
what the tree actually holds. See § Open Decision.

## Ground Truth: what exists today

All facts below were read and measured in the `llm` tree at
`18963b77a` (the ironhorse rename has landed; the crate is
`rust/engine/ironhorse-262`, PR #600 merged).

**Two fixture trees.**

1. `packages/test262-runner/test262/test/**`: the upstream test262
   subset (the design's prior head counted 38,181 `.js` files), the
   shared XS-Node parity corpus. Consumed by three hosts in
   `packages/test262-runner/package.json`:
   - `test262:xs` (`test262-harness --host-type xs --host-path xst
     --prelude prelude/xs.js --features-include ses-xs-parity`),
   - `test262:node` (same, `--host-type node`),
   - `test262:ironhorse` (`node scripts/run-ironhorse-host.js`, which
     builds and invokes the `ironhorse-xst` Rust binary over the same
     tree with `-l --feature-filter ses-xs-parity --features-include
     ses-xs-parity`).

2. `rust/engine/ironhorse-262/cases/**`: 1,712 test262-shaped case
   files, generated 1:1 from the retired bespoke bring-up corpora by
   `bin/corpus-to-262` (design § Part 1). These are **not** copies of
   upstream test262 cases. Each is a bespoke micro-case carrying the
   `ironhorse-dual-run`, `ironhorse-meter-exact`, and
   `ironhorse-meter-determinism` feature markers, and preserving its
   original one-line program verbatim in an `info: Source: <program>`
   line. `built-ins/` (18 stage buckets), `language/` (12 buckets),
   `regressions/` (1 fuzz trophy today). Consumed by:
   - `src/compile_diff.rs::corpora_programs()`, which reads the
     `info: Source:` line back out for the byte-identity compile-diff
     gate,
   - the in-crate `cargo test` suites,
   - `ironhorse-xst` when a positional path names the tree directly.

**One shared annotation parser.** `src/frontmatter.rs` is a full YAML
1.2 parse (`yaml-rust2`, pure Rust so `#![forbid(unsafe_code)]` holds)
of `description`, `flags`, `includes`, `negative` (`phase` + `type`),
`features`, `info`. Both the legacy dual-run path (`src/test262.rs`) and
the runner (`src/xst.rs`) parse through it. `run-ironhorse-host.js` does
**not** parse annotations itself: it delegates to the Rust binary. The
`xs`/`node` hosts use the npm `test262-harness` parser. So on the
ironhorse side there is already exactly one parser; the JS host is a
thin process wrapper.

**The expectation model today is the honest split, not a committed
list.** `src/xst.rs` classifies each case into one of four verdicts
(`Covered`, `PreSkip(reason)`, `RunSkip(reason)`, `Fail(detail)`) and
the run is green iff `total > 0 && failures.is_empty()`
(`XstReport::met_bar`). Skips are named at runtime (by the unsupported
opcode, the structural shape, the not-implemented feature) and reported
in the `skip:` / `skip-detail:` YAML sections, but they are **not**
committed anywhere. There is no per-case expected outcome checked in,
so:
- a case that flips from skip to covered (a newly-landed opcode) is
  silently absorbed into a higher covered count, never surfaced as a
  ratchet event;
- a case that flips from covered to skip (a regression that now stops
  ironhorse earlier) is likewise silently absorbed. Only a `Fail`
  (a real divergence or over-acceptance) reddens the build.

Measured on a bounded oracle-backed slice to confirm the model runs
here (`ironhorse-xst language/expressions/addition`, oracle on): 48
files, 15 covered, 0 failed, 33 skipped, of which 47 carried a
strict-mode run that was named-skipped (strict lands with the stage-5
compiler). The named skip breakdown was `unsupported-opcode:add` 23,
`ironhorse-aborted` 7, `unsupported-opcode:defineProperty:accessor-
descriptor` 2, `unsupported-opcode:native-call:Object` 1. This is the
exact per-case shape the committed lists must capture.

## The gap the directive names

| Directive ask | Today | This design |
|---|---|---|
| One corpus + shared annotation parser, no duplicated case trees (regressions excepted) | Two trees; one ironhorse-side parser already | § Open Decision (tree unification) + the parser is already single |
| Committed parameterized expected-pass/fail/skip lists; green iff observed == expected; ratchet both directions | Honest split, green iff zero `Fail`; no committed per-case expectation | § The expectation-list mechanism |
| Honest-skip ledger fully represented as list entries | Skips named at runtime, not committed | § Mapping the honest split to list entries |
| Differential oracle + CI hosts report against the same lists | Oracle wired into `ironhorse-xst`; `xs`/`node` report pass/fail via `test262-harness` independently | § Wiring the three hosts through one list set |
| No net change to what passes today, proven by before/after run at a pinned tip | n/a | § Equivalence proof |

The single-parser and oracle-wiring asks are already met. The real new
work is the committed, parameterized expectation lists with a
two-directional ratchet, and the decision about the two trees.

## Open Decision (maintainer): do the two case trees merge?

The directive's sketch says "the ironhorse dual-run harness reads cases
from `packages/test262-runner/test262/test/**` ... instead of
`ironhorse-262/cases`. Keep `ironhorse-262/cases/regressions` only ...
migrate `built-ins`/`language` cases that duplicate upstream to
references into the corpus." That phrasing assumes the 1,712 cases in
`ironhorse-262/cases` are duplicates of upstream test262 files. They are
not. They are bespoke bit-exact metering micro-cases (`assert`-free
one-liners such as `[]`, tagged `ironhorse-meter-exact`) generated from
the engine bring-up corpora. Upstream test262 has no analogue for them,
and by design (parent § Design decision 1) it never will: test262 has
no cost model, so the computron and byte-identity coverage those cases
carry cannot live in the upstream tree without either polluting the
XS-Node parity axis with `ironhorse-*`-tagged cases or losing the
metering regression coverage entirely.

Two coherent resolutions:

- **A. Keep two trees, unify only the expectation model (recommended).**
  Respect the parent design's decision 2 and the metering-is-proprietary
  doctrine. The consolidation the directive actually wants (one
  expectation mechanism, ratchet both directions, keyed off annotations)
  is delivered by § The expectation-list mechanism applied to both
  trees. `ironhorse-262/cases` stays the engine's proprietary
  meter/byte-identity corpus; the upstream tree stays the parity corpus;
  both are scored by one committed list format. "One source of truth"
  becomes true of the *expectation accounting*, which is where the
  drift the directive worries about actually lives.

- **B. Collapse to the upstream tree.** Drop `ironhorse-262/cases`
  except `regressions/`, and rely on the upstream tree for coverage.
  This satisfies the sketch literally but deletes the 1,712 metering
  micro-cases and the byte-identity compile-diff gate they feed
  (`corpora_programs()`), unless those are first re-homed. Choosing B
  means explicitly accepting the loss of, or a migration plan for, the
  `ironhorse-meter-exact` / `ironhorse-meter-determinism` /
  compile-diff coverage.

Recommendation: **A**. It delivers the directive's goal (parameterized
expectation lists, both-direction ratchet, one annotation-keyed model)
without discarding the metering coverage the parent design called
proprietary-forever. B should be taken only on an explicit maintainer
call that the metering micro-corpus is no longer wanted, or with a
companion plan to re-home its coverage.

The rest of this document specs the expectation mechanism so that it is
correct under **either** resolution: the list format is keyed by tree
root, so it scores one tree or two without change.

## The expectation-list mechanism

### Parameterization axes

A committed expectation is keyed by the tuple the directive names:

- **engine** in {`xst`, `node`, `ironhorse`}. `xst` and `node` are the
  npm `test262-harness` hosts; `ironhorse` is the Rust runner.
- **mode** in {`sloppy`, `strict`}. Mirrors `xst262.c`'s default
  two-run. `raw`/`noStrict`/`onlyStrict` collapse the pair per
  `strict_mode_status()` (already implemented).
- **feature-set / stage**: the opt-in axis (`ses-xs-parity`, and the
  ironhorse stage ladder). Selected exactly as
  `test262-harness --features-include` and `ironhorse-xst
  --features-include` already select, so no new selection concept is
  introduced.

The per-case expected outcome is one of `pass` / `fail` / `skip:<reason>`,
where `skip:<reason>` carries the honest named reason (§ Mapping).

### File format and location

One committed file per (engine, feature-set) under a new
`rust/engine/ironhorse-262/expectations/` directory (and, if resolution
B, the same format under `packages/test262-runner/`). Format is line
oriented and diff-friendly so the ratchet shows up as a reviewable
patch:

```
# engine=ironhorse features=default corpus=upstream tip=<sha>
# <case-relative-path> <mode> <outcome>
language/expressions/addition/S11.6.1_A1.js sloppy skip:unsupported-opcode:add
language/expressions/addition/S11.6.1_A1.js strict skip:strict-unimplemented
language/expressions/addition/11.6.1-1.js  sloppy pass
...
```

Rationale for a flat text list over an embedded per-case annotation:
the parent design decision 1 is explicit that ironhorse expectations
never enter a case body (a hardcoded expectation rots at recalibration,
means nothing to another consumer, and re-imports the parity framing the
doctrine retired). A committed sidecar list keeps the case files pure
and portable while making the expectation reviewable and machine
checked. The list is generated, not hand-written (§ Equivalence proof).

### The gate and the two-directional ratchet

A run loads the list for its (engine, feature-set), runs the corpus,
and compares observed to expected per (case, mode):

- **observed == expected**: green.
- **observed `fail` where expected `pass`**: red (regression). This is
  the current `Fail` behavior, preserved.
- **observed `pass` where expected `skip`** or **observed `skip` where
  expected `pass`**: a **ratchet event**. By default this reddens the
  build with a message naming the drift and the one-line command to
  re-baseline (`--update-expectations`), so neither direction is
  silently absorbed. Progress (skip becomes pass) and regression (pass
  becomes skip) are both surfaced; the maintainer accepts progress by
  committing the regenerated list, exactly as a snapshot test is
  updated.
- **observed `skip:<reason-a>` where expected `skip:<reason-b>`**: a
  soft ratchet (the case still does not run, but the reason moved).
  Reported, gated behind a `--strict-skip-reasons` flag so day-to-day
  churn in skip reasons does not redden the build while the surface is
  still growing.

`met_bar()` becomes "observed matches the committed expectation for
every (case, mode)" instead of "zero `Fail`". The honest split is not
lost; it becomes the *content* of the committed list.

### Mapping the honest split to list entries

The current `Verdict` maps onto list outcomes with no loss:

| `xst.rs` verdict | list outcome |
|---|---|
| `Covered` | `pass` |
| `Fail(detail)` | `fail` (must not appear in a green list; a committed `fail` is an accepted-divergence quarantine entry, used sparingly and reviewed) |
| `PreSkip(reason)` | `skip:<reason>` (feature/flag/structural) |
| `RunSkip(reason)` | `skip:<reason>` (opcode/value/honest) |

The existing honest-skip ledger (`unsupported-opcode:*`,
`non-primitive-completion`, `builtin-coercion-computron-gap`,
`negative-parse:pending-compiler`, `oracle-shim-unsafe:lockdown`, ...)
becomes the committed `skip:<reason>` right-hand sides. The directive's
"the existing honest-skip ledger is fully represented as list entries"
is satisfied by construction: the list is the serialized ledger.

### Wiring the three hosts through one list set

- **ironhorse**: `run_files` in `src/xst.rs` gains an optional
  `Expectations` loaded from the committed file; `XstReport` compares
  and reports ratchet events; `ironhorse-xst` grows
  `--expectations <file>` / `--update-expectations`.
- **xst / node**: `test262-harness` already emits per-case pass/fail.
  A thin post-processor (extend `run-ironhorse-host.js` into a shared
  `scripts/run-host.js`, or a sibling) maps its output to the same list
  format and applies the same ratchet, so all three hosts are scored by
  the same mechanism. The npm hosts have no ironhorse skip taxonomy;
  their `skip` reasons are `test262-harness`'s own (feature filtered,
  unsupported), which the format already accommodates as opaque
  `skip:<reason>` strings.
- The **differential oracle** stays where it is (inside `ironhorse-xst`,
  gating verdict + observable agreement). Its output feeds the
  `ironhorse` list exactly as the honest split does today; the oracle is
  the source of the `pass`/`fail` truth for the `ironhorse` engine, not
  a fourth engine in the tuple.

## Equivalence proof (acceptance: no net change to what passes today)

The lists are generated by running the current harness at a pinned tip
and serializing its verdicts, so the "before" and the initial committed
list are the same artifact by construction. The proof that the refactor
changes nothing:

1. At the pinned tip, run every (engine, feature-set) over its corpus
   and record the verdict per (case, mode). This is the "before"
   snapshot and the initial committed list.
2. Apply the refactor (list loading + ratchet gate; and, under
   resolution B, the tree move).
3. Re-run. The gate must report zero ratchet events and zero new
   `fail`: observed == the committed list for every (case, mode). Any
   delta is a bug in the refactor, not an accepted change.

The ironhorse run is oracle-backed and memory-heavy: the XS oracle
accumulates process memory across machine create/destroy cycles, which
is why `ironhorse-xst` already walks one subtree per process, and why a
whole-tree oracle run is a multi-hour, memory-bounded batch (tracked
separately as the test262-oracle-OOM concern). The generation step
therefore runs as a batched, per-subtree sweep on a host with the Rust
toolchain and the `c/moddable` submodule initialized, not inline in a
single interactive session. The list format is designed for exactly
this: per-subtree files concatenate, so the sweep is resumable and the
OOM ceiling is per subtree.

## Rollout

Each step independently green, PR kept DRAFT until the maintainer
resolves § Open Decision (the tree question changes step 2 only):

1. **List format + loader + gate + ratchet, engine=ironhorse.** Add
   `expectations/` loading to `src/xst.rs`, the `Expectations` type, the
   two-directional ratchet, and the `ironhorse-xst
   --expectations/--update-expectations` flags. Unit-testable without
   the full oracle: synthetic observed maps against synthetic
   expectation files exercise every gate branch. Generate the initial
   `ironhorse` lists by the batched sweep; commit them.
2. **Tree resolution.** Under A: nothing moves; the same list format
   also scores `ironhorse-262/cases` (its own committed list). Under B:
   move `built-ins`/`language` bring-up cases out, re-home or retire the
   metering/compile-diff coverage, keep `regressions/`.
3. **xst / node host scoring.** The shared post-processor maps
   `test262-harness` output to the list format and applies the ratchet,
   so all three engines are gated by committed lists. Generate and
   commit the `xst` and `node` lists.
4. **CI.** The three `test262:*` scripts run against their committed
   lists; green iff observed == expected; a ratchet event is a
   reviewable list diff.

## Open Questions

1. § Open Decision (A vs B): the one maintainer call this document
   needs.
2. Committed `fail` entries: are accepted-divergence quarantine entries
   wanted at all, or is `fail` always a red build (no quarantine)? The
   parent design's honest-split discipline suggests never committing a
   `fail`; a quarantine lane is only for a known oracle-shim defect that
   cannot be fixed immediately.
3. Skip-reason churn: default `--strict-skip-reasons` off (soft ratchet)
   while the opcode surface still grows, or on from the start?

## Dependencies

| Design | Relationship |
|---|---|
| [ironhorse-test262-convergence](ironhorse-test262-convergence.md) | Parent. This refactor supersedes its decision 2 (two corpora) only to the extent § Open Decision resolves; it keeps decision 1 (expectations never in a case body) intact. |
| [ironhorse-engine](ironhorse-engine.md) | The stage ladder that lands the opcodes/features whose skip-to-pass flips the ratchet surfaces. |
| `decommission-cxs-rust-default-xst-ci-parity` (parked plan) | The end-state this consolidation is groundwork for: one annotation-driven corpus with parameterized expectations is the precondition for proving parity through the downloaded `xst` binary under `test262-harness` once the C engine is removed. |
</content>
</invoke>
