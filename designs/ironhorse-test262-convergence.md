# Ironhorse test262 Convergence: the Corpus Becomes test262 Cases, the Harness Becomes `endot-ih`

| | |
|---|---|
| **Created** | 2026-07-05 |
| **Author** | endolinbot (prompted) |
| **Status** | In progress: the bounded, resumable whole-tree reporting instrument has landed; language-surface convergence remains a completion-phase milestone of [ironhorse-engine](ironhorse-engine.md) |

Toward the completion of the XS→Rust port (PR #600), the maintainer
directive is that "the corpus should eventually be converted into
test262 style cases and the harness into a proper analogue of `xst`"
(kriskowal, PR #600, 2026-07-02,
[comment 4872940142](https://github.com/endojs/endo-but-for-bots/pull/600#issuecomment-4872940142)).
This design specs that two-part convergence. It is deliberately a
**completion-phase** milestone: the bespoke per-stage corpus and the
dual-run harness are the right instruments *while the covered opcode
and built-in surface is still growing stage by stage*; a
test262-shaped corpus and an `xst`-analogue runner pay off once the
surface is broad enough that whole-tree runs, standard tooling, and a
durable regression suite matter more than per-stage bring-up speed.
Nothing here promotes ahead of the remaining build stages.

## Ground Truth: What Converges

All facts below are measured in this branch's tree and against the
engine design's pin (`Moddable-OpenSource/moddable` @ `48ee02d8cfe0`,
[ironhorse-engine § Ground Truth](ironhorse-engine.md)).

**The bespoke corpus.** `rust/engine/ironhorse-262/corpora/` holds 22
files totalling **1,374 one-line programs** (per-file: arithmetic 30,
logic 41, control-flow 15, stage2-behavioral 11, stage2-objects 12,
stage2b-functions 33, stage2b-closures 10, stage2b-exceptions 25,
stage3-language 55, stage3-fundamentals 152, stage3-arrays 287,
stage3-math 72, stage3-string 64, stage3-number 64, stage3-json 18,
stage3-collections 110, stage3-bigint 93, stage3b-json-metering 63,
stage3b-binary 70, stage3b-fundamentals-followup 64,
stage3b-object-statics 59, stage3b-promises 26). The format is one
program per non-empty non-`//` line (`ironhorse_262::parse_corpus`); the
completion value is the last expression; each stage's
`stage*_corpus()` accessor is asserted bit-exact — completion value
AND computron count — against the XS oracle by an in-crate test.

**The dual-run harness.** `ironhorse-262` (`src/lib.rs`) compiles each
program with the XS oracle (`xs-oracle`), runs the identical
bytecode on `ironhorse-vm`, and records four-valued completion agreement,
result/thrown-value agreement, and computron agreement (`DualRun`,
`is_bit_exact`). `src/test262.rs` already walks real test262: it
locates the monorepo's checked-in subset
(`packages/test262-runner/test262`, **38,181 `.js` files** under
`test/` at this branch head), parses a deliberately minimal
three-field frontmatter (`flags`, `includes`, presence of
`negative:`), assembles `sta.js` + `assert.js` + `includes:` + body,
dual-runs, and reports the **honest covered/skipped/divergent split**
— every skip named by the opcode or structural reason that stopped
Ironhorse, zero divergence required on whatever the covered grammar
reaches. Two binaries drive it: `harness` (stage-1 corpus CLI) and
`test262-language` (whole-subtree walker, one subtree per process to
bound oracle memory).

**The fuzz arms.** `ironhorse-fuzz` carries ~20 structure-aware grammar
generators (`gen_program` … `gen_stage3b_object_statics_program`) and
the differential comparators (`differential_check`,
`…_with_symbols`, `…_result_only`); divergence findings are
crash-equivalent.

**The upstream-shaped runner already in the repo.**
`packages/test262-runner` runs the checked-in subset through the npm
`test262-harness` runner on two hosts — `xst` (XS) and `node` —
with SES preludes, filtered to tests carrying the `ses-xs-parity`
feature marker (`package.json` § scripts). The engine design already
mandates that Ironhorse eventually joins as a **third host** on that same
tree ([ironhorse-engine § test262 conformance](ironhorse-engine.md)).

**`xst` itself, at the pin.** `xst` is XS's command-line and test262
runner, two files at `48ee02d8cfe0`:

- `xs/tools/xst.c` (1,291 lines): mode dispatch — `-b` script
  buffers, `-e` eval strings, `-f` a REPRL (Fuzzilli) fuzzing
  harness, `-j` JSON buffers, `-m` modules, `-p` profiling, `-s`
  scripts, `-v` version + slot geometry; **test262 mode is the
  default whenever `../harness` exists** relative to the given
  paths, so `xst` pointed into a test262 tree "just runs" it.
- `xs/tools/xst262.c` (1,489 lines, `main262`): a worker-thread pool
  over the given case files/directories; per case, full YAML
  frontmatter via libyaml (`includes`, `negative.type`, `flags`,
  `features`); a 13-entry `gxFeatures` skip list of
  not-implemented features (Temporal, ShadowRealm, decorators, …);
  flag semantics — `async` arms a `$DONE` host function with a
  did-not-complete latch, `onlyStrict`/`noStrict` select one mode
  where the **default is two runs, sloppy then strict**
  (`mxProgramFlag|mxDebugFlag`, then `|mxStrictFlag`), `module`
  routes through `fxRunModuleFile`, `raw` runs the body verbatim
  with no harness, `CanBlockIsFalse` is skipped; per case **per
  mode** a fresh machine is created, `$262` and the agent cluster
  built (`fxBuildAgent`), `sta.js` then `assert.js` then each
  include run, optional `lockdown()` called (`-l`, `-lc`, `-c`
  lockdown/compartment modes), the case run, then `fxRunLoop`
  drains the job queue and the unhandled-rejection latch
  (`the->rejection`) is checked; the **negative verdict** compares
  the thrown exception's `constructor.name` against
  `negative.type`, with memory/stack-overflow machine exits
  accepted for an expected `RangeError`; `-o` writes a YAML report
  (`mode:` / `skip:` / `fail:` sections) and `-t` traces per-case
  verdicts.

## Part 1: Corpus → test262-Style Cases

### Where the cases live and what shape they take

Ironhorse's cases live in the shared test262 tree at
`packages/test262-runner/test262/test/ironhorse/`, mirroring test262
directory idiom (`ironhorse/language/`, `ironhorse/built-ins/`, and
`ironhorse/regressions/`). Host-specific `features:` annotations keep
one corpus useful to several suites: XS and Node exclude the
`ironhorse-dual-run` and `ironhorse-meter-*` classifiers, while Ironhorse
selects them and applies its differential and metering checks. The cases
resolve `includes:` against the same
`packages/test262-runner/test262/harness/` directory (`sta.js`,
`assert.js`, `propertyHelper.js`, `compareArray.js`, …), so a case
that graduates upstream needs no rewriting.

Each case is a standard test262 file: a `/*---` YAML frontmatter
block (`description`, `flags`, `includes`, `negative`, `features`,
`info`), then a body whose expectations are **explicit
`assert.*` calls** rather than the corpus's implicit
"last-expression completion value" convention. This is a deliberate
strengthening: today a corpus line is *oracle-relative* (Ironhorse must
match whatever XS computes); an `assert.sameValue` body is
*spec-anchored AND oracle-relative* — a wrong value now throws in
whichever engine computes it, surfacing as a completion divergence
in the dual run, and additionally pins the expected value so a bug
shared by both engines against the spec is still caught.

### Frontmatter mapping

| Corpus reality today | test262 case expression |
|---|---|
| One-line program, completion value checked against the oracle | Body with `assert.sameValue(<expr>, <expected>)`; expected value taken from the recorded oracle result at conversion time and reviewed against the spec |
| Uncaught-throw programs (shared-abort arm, thrown-value string + computrons compared) | `negative: { phase: runtime, type: <ErrorConstructor> }` for real Error throws; primitive throws (`throw 7`) keep a `try`/`assert` body instead, since test262's `negative.type` is constructor-name-shaped (as in `xst262.c`'s verdict) and a bare `7` has none |
| Parse-negative programs | `negative: { phase: parse, type: SyntaxError }` cases, adjudicated from each engine's own compiler result; valid but unported syntax remains a named compiler gap |
| Strict-mode-sensitive programs | standard `onlyStrict` / `noStrict` / (default both-modes) flags; `raw` for harness-free bodies (the meter micro-cases below are `raw` so no harness cost precedes the measured region) |
| Stage attribution (`stage3b-promises.js`, …) | directory placement + `features:` markers; the stage name survives in `info:` prose, not in structure |

Ironhorse-specific gating rides the **`features:` mechanism**, exactly
the precedent the repo already set with `ses-xs-parity`: markers are
namespaced `Ironhorse-*` so any standard test262 consumer filters them
in or out with existing tooling (`--features-include`, as
`packages/test262-runner/package.json` already does):

- `ironhorse-dual-run` — the case participates in the differential gate
  (result agreement with the XS oracle is a red build on
  divergence).
- `ironhorse-meter-exact` — the case additionally carries the landed
  bit-exact computron evidence: on the pinned oracle it has
  historically metered identically, and the runner reports any drift
  prominently. Per the accuracy-over-parity doctrine
  ([ironhorse-engine § Metering](ironhorse-engine.md)) this
  marker is **advisory by default** — a computron delta against
  XS is telemetry, not a failure — with a runner flag
  (`--gate-meter-exact`) to gate it during stages that still hold
  the bit-exact bar, so the historical evidence keeps its regression
  value without re-imposing parity as doctrine.
- `ironhorse-meter-determinism` — the case is in the determinism set:
  the runner re-runs it (`--repeat N`) and identical computrons
  across runs of the same build are a **gating** assertion (this is
  the unconditional half of the doctrine).

### The meter assertion never enters the test body

The crucial portability decision: **computron expectations are never
written into case files.** A hardcoded count would (a) rot at every
`ironhorse-meter-N` recalibration, (b) mean nothing to any other test262
consumer, and (c) re-encode the XS-parity framing the doctrine
retired. The meter contract is a property of the *runner*, expressed
as the three assertions above (result gate, determinism gate,
oracle-computron advisory), computed per run against the live oracle
and the live cost table. A case file therefore remains a pure,
portable test262 test; strip the `Ironhorse-*` features and it runs
under `xst`, `test262-harness`, or any engine's runner unchanged.

### Conversion mechanics and corpus retirement

A converter binary (`ironhorse-262`, bin `corpus-to-262`) performs the
mechanical migration: for each corpus line, dual-run it once against
the oracle, emit a case file with the recorded completion value as
the `assert.sameValue` expectation, frontmatter derived from the
line's stage file (directory, `features`, `flags: [raw]` for
meter-sensitive micro-cases), and the source line preserved in
`info:`. Grouping is a curation pass after generation — several
related one-liners may merge into one richer case where that reads
better, but generation starts 1:1 so nothing is dropped silently
(1,374 lines in → 1,374 cases out, counted in the conversion
commit's report).

The `corpora/*.js` files and their `stage*_corpus()` accessors +
per-stage tests then retire **by name** in the same change that
proves the generated cases reproduce their coverage (same totals,
zero divergence, same bit-exact set under `--gate-meter-exact`) —
a named retirement, never a silent deletion. Until that proof, both
shapes run in CI.

### The fuzz-grammar arms

The differential fuzz generators are **generative instruments, not
corpus**, and stay as they are in `ironhorse-fuzz`. What migrates is
their *output*: a divergence trophy, once minimized and fixed,
is checked in as a test262-style case under `test/ironhorse/regressions/`
(features `ironhorse-dual-run` + the arm's name in `info:`), so every
fuzz finding becomes a durable, portable regression test rather
than a line in a stage corpus. The trophies ledger the engine
design's § Fuzzability names is the source of the initial
`regressions/` population.

### What stays ironhorse-proprietary vs. what can feed upstream

**Proprietary forever:** anything metering — the `ironhorse-meter-*`
feature markers, the dual-run oracle gate, the computron advisory
report. test262 has no cost model and should not learn Ironhorse's.
**Upstream-eligible:** pure semantic cases the differential campaign
surfaces that expose spec corners upstream test262 under-covers —
these follow the normal tc39/test262 contribution path once
generalized (expected values re-derived from the spec, Ironhorse
features stripped). Hardened JavaScript cases follow the existing
precedent: the checked-in subset already carries Moddable and
Hardened JavaScript additions beyond tc39, and ironhorse-discovered SES
cases join that set via `packages/test262-runner`, tagged
`ses-xs-parity` where they prove the XS↔Node↔Ironhorse surface.

## Part 2: Harness → `endot-ih`

### The shape of the analogue

One new binary, **`endot-ih`** (crate `ironhorse-262` — the runner is
an evolution of the existing harness, not a parallel tool), that
plays for the Rust engine exactly the role `xst` plays for XS,
plus the one thing `xst` never had: a differential oracle. The
corresponding XS test262 runner is named **`endot-xs`**; the unsuffixed
**`endot`** name remains reserved for a future runner that can select
either engine with a flag.

| `xst` behavior (at the pin) | `endot-ih` |
|---|---|
| Paths are test262 cases or directories; test262 mode auto-detected via `../harness` | Same: positional paths, harness dir located via the existing `locate_test262()` walk (defaulting to `packages/test262-runner/test262`), `--test262-dir` override |
| Full YAML frontmatter (libyaml): `includes`, `negative` (`phase` + `type`), `flags`, `features` | Full YAML frontmatter (a real YAML dependency replaces `test262.rs`'s three-field hand parser; `#![forbid(unsafe_code)]` constrains the choice to a pure-Rust parser) |
| `gxFeatures` 13-entry not-implemented skip list | An Ironhorse skip list with the same role (initially: everything the stage ladder has not landed — named per feature, reported per xst's `skip:` section) plus `--features-include` for opt-in sets like `ses-xs-parity`, matching the npm `test262-harness` idiom the repo already drives `xst` with |
| Default sloppy + strict double-run; `onlyStrict` / `noStrict` / `raw` / `module` / `async` / `CanBlockIsFalse` flag semantics | Identical sloppy/strict mode selection. The strict variant prepends its directive to the whole assembled Script. `module` routes through the module machinery when stage 4 lands |
| Fresh machine per case per mode; `sta.js`, `assert.js`, includes; `$DONE` host function + did-not-run latch for `async`; `fxRunLoop` job drain; unhandled-rejection latch | Fresh `ironhorse-vm` machine per case per mode; same assembly order (already implemented in `assemble()`); `$DONE` registered through the host-function seam once the async surface lands (the stage-3b promise pump is the job-drain substrate); the unhandled-rejection latch mirrors `the->rejection` |
| Negative verdict: thrown `constructor.name` vs `negative.type`; machine memory/stack-overflow exits accepted for expected `RangeError` | Same verdict, computed **per engine**; Ironhorse's stack-limit abort maps to the `RangeError` acceptance the same way (the stage-3 child-1 fixed stack limits make that abort deterministic) |
| `-l` / `-lc` / `-c` lockdown & compartment modes | The same modes once stage 4 (Hardened JavaScript) lands — this is precisely the "Ironhorse as a third `test262-runner` host alongside `xst` and `node`" the engine design promises, so `endot-ih` doubles as that host's engine-side entry point |
| `-o` YAML report: `mode:` / `skip:` / `fail:` | Same report grammar, extended with two Ironhorse sections (below), so tooling that reads an `xst` report reads an `endot-ih` report |
| Worker-thread pool | Per-subtree subprocess parallelism first (the memory-bounding pattern `test262-language` already documents); an in-process pool is an optimization, not a semantic |
| `-f` REPRL (Fuzzilli) harness | **Non-goal for now** — `ironhorse-fuzz`'s cargo-fuzz targets cover the differential-fuzz mandate; a REPRL mode is optional later work if a Fuzzilli campaign is ever wanted |
| `$262.agent.*` (multi-agent Atomics tests) | **Out of scope** until Ironhorse has a threading story; agent tests are named skips (`structural:agent`) |

### The dual-run oracle wiring

`endot-ih` subsumes the dual-run harness rather than sitting beside
it. `--oracle` (default **on** in CI for as long as the XS oracle
earns its keep, per engine-design decision 8) runs every assembled
source on both engines and layers three comparisons on top of the
per-engine `xst` verdicts:

1. **Verdict agreement (gating).** Ironhorse's pass/fail verdict for the
   case (including the negative-type match) must equal the
   oracle's. This is the four-valued `Agreement` generalized from
   raw completion to `xst` semantics; `IronhorseOnlyComplete`-shaped
   disagreements (Ironhorse accepting what XS rejects) stay red, exactly
   as `classify()` treats them today.
2. **Observable agreement (gating).** On shared completion, the
   completion value; on shared abort, the thrown-value string — the
   strong comparisons `DualRun` already makes, retained above the
   weaker constructor-name verdict.
3. **Computron comparison (advisory).** Recorded per case and
   aggregated per section into the report's `advisory:` section;
   never a failure by itself. `--gate-meter-exact` tightens
   `ironhorse-meter-exact`-tagged cases to the historical bit-exact bar
   where a stage still holds it; `--repeat N` drives the
   determinism gate (identical Ironhorse computrons across runs — a red
   build on drift, since determinism-per-release is unconditional).

`ironhorse-compile` now moves the differential to the source boundary:
each engine compiles its own source, parse-phase negative cases are active,
and bytecode byte-identity is separately enforced by the stage-5 bar.

The **honest-split discipline is retained as an Ironhorse extension**:
where `xst` reports a skip only by feature or flag, `endot-ih`
keeps naming skips by the exact unsupported opcode / built-in /
structural reason (`Report::skip_summary()` today), in a
`skip-detail:` report section. That reporting is the port's progress
instrument and survives the convergence.

### What retires

- `src/bin/harness.rs` (stage-1 corpus CLI) and
  `src/bin/test262_language.rs` fold into `endot-ih` (the latter's
  subtree-walk and per-subtree-process pattern become `endot-ih`
  defaults); both retire by name once `endot-ih` reproduces their
  output in CI.
- `test262.rs`'s three-field frontmatter parser is replaced by the
  full YAML parse; `assemble()` and the `Class`/`Report` core carry
  over and grow the verdict layer.
- The `stage*_corpus()` accessors retire with the corpus conversion
  (Part 1), closing the bespoke-corpus era.

## Staging and Rollout

Gated behind the port's remaining build stages (stage 3 in flight;
stages 4–5 are the enabling dependencies for lockdown modes, module
mode, strict mode, and parse negatives). Rollout order, each step
independently green on this PR (kept DRAFT):

1. **`endot-ih` core** — full frontmatter, feature skip list,
   both-modes run loop, negative verdicts, oracle wiring, xst-shaped
   report. Immediately useful: it runs today's checked-in subset with
   today's covered surface, replacing `test262-language`.
2. **Corpus conversion** — `corpus-to-262`, the `test/ironhorse/` tree
   (1,374 generated cases), coverage-equivalence proof, corpora
   retirement.
3. **Async/`$DONE` + job-drain wiring** — after the promise/async
   surface completes (stage 4 closes async/generators).
4. **Lockdown/compartment modes + third-host integration** — after
   stage 4; wires Ironhorse into `packages/test262-runner`'s
   `ses-xs-parity` axis alongside `xst` and `node`.
5. **Fuzz-trophies regression tree** — `test/ironhorse/regressions/`
   populated from the trophies ledger; thereafter part of the fix
   workflow.

Steps 1–2 need nothing beyond the landed surface and could in
principle land during late stage 3, but per the parking directive
they queue behind the build stages and are promoted by a future
build orchestration (children parked as `--orchestrated` under
`xs2rust-endor-test262-convergence`), not fanned out now.

## Design Decisions

1. **Cases are pure test262; all ironhorse-ness lives in `features:`
   markers and the runner.** Computron expectations never enter a
   case file — the meter contract is the runner's three-assertion
   stack (result gate, determinism gate, oracle advisory), so cases
   stay portable and recalibrations (`ironhorse-meter-N`) touch no test.
2. **All cases live in the shared `packages/test262-runner/test262/test/`
   tree.** The `ironhorse/` subtree retains engine bring-up and regression
   cases. `features:` classifiers select or exclude them for each host, so
   unsupported metering checks are skipped without maintaining another corpus.
3. **`endot-ih` is one runner that subsumes the dual-run harness**
   — `xst`'s CLI/verdict/report shape (grounded in `xs/tools/xst.c`
   + `xst262.c` at the pin) plus the differential oracle and the
   honest named-skip split as Ironhorse extensions. No parallel tool.
4. **Assertion bodies over completion-value convention.** The
   migration upgrades the corpus from oracle-relative to
   spec-anchored + oracle-relative; conversion is generated 1:1
   (nothing dropped silently), curation follows, retirement is by
   name against a coverage-equivalence proof.
5. **Agent tests and REPRL are out of scope**; async, strict,
   module, and lockdown modes land on the stage ladder that enables
   them, as named skips until then.

## Dependencies

| Design | Relationship |
|---|---|
| [ironhorse-engine](ironhorse-engine.md) | Parent: § test262 conformance (requirement 6), § Metering (the doctrine the meter assertions encode), § Fuzzability (the trophies ledger), the stage ladder this milestone queues behind |
| `packages/test262-runner` | The shared checked-in test262 subset, harness includes, `ses-xs-parity` convention, and the third-host integration target |
| `xs/tools/xst.c`, `xs/tools/xst262.c` @ `48ee02d8cfe0` | The behavioral reference `endot-ih` mirrors |
