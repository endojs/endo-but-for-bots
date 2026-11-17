# Map: The test262 harness and the committed conformance baseline

Reviewed commit `61cd656cb`.

## Scope

| Path | Lines | Notes |
| --- | ---: | --- |
| `rust/engine/ironhorse-262/src/xst.rs` | 5,203 | runner core (`run_case`, verdicts, timeout, module path); production 1-2760, inline tests 2762-5203 |
| `rust/engine/ironhorse-262/src/lib.rs` | 1,882 | dual-run primitives (`dual_run*`, `compile_for`, `build_dual_run`), boot-bundle and compartment differentials; tests from 1166 |
| `rust/engine/ironhorse-262/src/report.rs` | 2,429 | `Category`/`classify`, batch JSON, aggregation, discovery, HTML; tests from 1368 |
| `rust/engine/ironhorse-262/src/expectations.rs` | 702 | committed-list format and two-directional ratchet; tests from 444 |
| `rust/engine/ironhorse-262/src/test262.rs` | 651 | legacy `language/` runner + file collection + `locate_test262` |
| `rust/engine/ironhorse-262/src/frontmatter.rs` | 179 | YAML frontmatter |
| `rust/engine/ironhorse-262/src/compile_diff.rs` | 914 | compiler byte-identity instrument |
| `rust/engine/ironhorse-262/src/bin/endot_ih.rs` | 603 | the runner CLI |
| `rust/engine/ironhorse-262/src/bin/ironhorse_262_report.rs` | 338 | discover / plan / validate / aggregate / quarantine CLI |
| `rust/engine/ironhorse-262/src/bin/ironhorse_xst.rs` | 104 | Ironhorse as a plain eshost "xs" host |
| `rust/engine/ironhorse-262/src/bin/corpus_to_262.rs` | 480 | corpus line -> test262 case converter |
| `rust/engine/ironhorse-262/src/bin/compile_diff.rs` | 102 | CLI over `compile_diff` |
| `rust/engine/ironhorse-262/scripts/full-run.sh` | 508 | whole-tree orchestrator |
| `rust/engine/ironhorse-262/scripts/expectation-shards.sh` | 59 | shard inventory and digest helpers |
| `rust/engine/ironhorse-262/scripts/README.md` | 162 | sweep design doc |
| `rust/engine/ironhorse-262/TEST262_REVISION` | 11 | pin `be13516fb6441b950ba8a3df97eb34062c186972` (2026-08-07) |
| `rust/engine/ironhorse-262/expectations/whole-tree/` | 1,931 files, 103,429 lines, 14 MB | 1,930 shards + `manifest.txt` |
| `rust/engine/ironhorse-262/expectations/{ironhorse,try}.txt`, `README.md` | 1,713 / 191 / 65 | PR-CI gates |
| `rust/engine/ironhorse-262/baseline/` | 4.4 MB (`baseline.json` 4,856 lines, two `refresh-*/covered.txt` of ~30k lines) | historical snapshots |
| `.github/workflows/ironhorse-full-test262.yml` | 428 | nightly sweep (+ unrelated bench/stack-lane jobs) |
| `.github/workflows/ci.yml` `test-ironhorse-oracle` | lines 1026-1199 | PR-CI harness job |
| `.github/workflows/ironhorse-{sanitizers,deep-fuzz}.yml` | 60 / 209 | skimmed only |
| `rust/engine/ironhorse-262/tests/` | 188 files, 27,287 lines, 1,262 `#[test]` | skimmed for what they gate |

## What was read

- Full read: `xst.rs` 1-2760 (all production code) and the first ~550 lines of its tests; `lib.rs` 1-1195; `report.rs` 1-1060; `expectations.rs` (all); `frontmatter.rs` (all); `test262.rs` 1-410; `bin/endot_ih.rs` (all); `bin/ironhorse_xst.rs` (all); `scripts/full-run.sh` (all); `scripts/expectation-shards.sh` (all); `scripts/README.md`, `expectations/README.md`, `baseline/README.md`, `baseline/provenance.json`, the head of `baseline/refresh-20260904/{README.md,baseline.json}`; `ironhorse-full-test262.yml` (all); `ci.yml` 1026-1199.
- Targeted: `report.rs` 1062-1290 (HTML lede and section labels); `bin/ironhorse_262_report.rs` `command_validate`; `compile_diff.rs` 130-200; `corpus_to_262.rs` header; `examples/*.rs`; `ironhorse-vm/src/interp/boot.rs:2518-2541` (`install_test262_host`); `ironhorse-vm/src/interp/natives/buffer.rs:2200-2235` (Atomics refusal); `ironhorse-vm/src/interp/natives/collection.rs:300-330`; `ironhorse-vm/src/interp/environment.rs:33-52` (`define_global_lexical`); `ironhorse-regexp/src/matcher.rs:127-240`; `ironhorse-compile/src/{parser.rs:54-67,error.rs,meter.rs,coder.rs:1165-1220}`; `xs-oracle/csrc/xs_shim.c:60-130,275-430`; `c/moddable/xs/tools/xst262.c:150-164` (XS's own feature skip list).
- Data, script-driven: every line of the 1,930 committed shards (parsed with the `expectations.rs` grammar), joined with the frontmatter of all 51,976 cases of the pinned corpus at `rust/engine/target/test262-report/test262-src` (read only).
- Grep-driven: users of legacy APIs; `CaseResult {`/`RunOutcome {` literal counts; halt-classification copies; tests directory names and `locate_test262` users.

## What was not read

- `xst.rs` tests 3300-5203 (only grepped), `lib.rs` 1196-1882 (tests; outline only), `report.rs` tests 1368-2429, `compile_diff.rs` beyond 130-250, `corpus_to_262.rs` body, `test262.rs` tests.
- The 188 files under `ironhorse-262/tests/` were not read beyond names, `xs_departures.rs` 1-60 and the `locate_test262` guard pattern; they are engine-behavior differential suites, not harness tests (except `expectation_cli.rs`, `expectation_shards.rs`, `lockdown_setup.rs`, `module_*`, which I did not open).
- `ironhorse-deep-fuzz.yml` and `ironhorse-sanitizers.yml` were only skimmed for steps; the rest of `ci.yml` was not read.
- The live sweep under `rust/engine/target/test262-report/` was not read except its vendored `test262-src/` checkout (read only, to join frontmatter and assemble probes). All statistics below are from the COMMITTED shards (last touched in `db164064`, four engine commits before HEAD), not from the live sweep.
- `xs-oracle/src/lib.rs` (oracle memory behavior beyond the shim's create/delete) was not read.

## Architecture as built

**Two runners, one corpus.** `endot-ih` (`bin/endot_ih.rs` -> `xst::run_files`, `xst.rs:2714`) is a *differential* runner: every verdict is a function of agreement with the pinned XS oracle (`c/moddable` @ `23b4d6b`, XS 8.3.1, no Intl, no Temporal). `ironhorse-xst` (`bin/ironhorse_xst.rs`) is a plain eshost-"xs" host that runs one concatenated file through `lib.rs::run_script_source` and is not used by the sweep. The legacy `test262.rs` runner (`Class`, `classify`, `run_files`, concatenating `assemble`) survives only through one test call (`xst.rs:4463`).

**Per-case flow** (`xst::run_case`, `xst.rs:1524`): parse frontmatter (`frontmatter.rs:50`, yaml-rust2) -> feature pre-skip against `DEFAULT_ENDOR_SKIP_FEATURES` (`xst.rs:47`: `ShadowRealm`, `tail-call-optimization`, `IsHTMLDDA`, `ses-xs-parity`) -> `module` flag goes to `run_module_case` (`xst.rs:1672`) -> `CanBlockIsFalse` pre-skip (`xst.rs:1544`) -> substring pre-skip on `$262.agent`/`Atomics.wait`/`Atomics.notify` (`xst.rs:1558`) -> mode selection `strict_mode_status` (`xst.rs:380`) with an exact-meter override (`xst.rs:1569`) -> `async` flag goes to `run_async_case` (`xst.rs:2119`) -> otherwise `assemble`/`assemble_strict` (`xst.rs:464,502`) build a *setup Script* (sta.js, assert.js, includes, optional prelude, optional `lockdown();`, `void 0;`) and a separate *body Script* -> `lib.rs::dual_run_scripts` (`lib.rs:602`) runs both Scripts on one XS machine (eval-framed: `xs_shim.c` parses with `mxProgramFlag | mxEvalFlag`) and on one Ironhorse `Interp` (each Script compiled by `ironhorse-compile` Script goal, relinked with `relink_crank`) -> `verdict_for` (`xst.rs:602`) -> `evaluate_positive` (`xst.rs:667`) / `evaluate_negative` (`xst.rs:1243`) / `evaluate_negative_early` (`xst.rs:1335`) -> per-mode `Verdict` (Covered | PreSkip | RunSkip | Fail) folded into one file verdict (`xst.rs:1632-1650`).

**The `DualRun` record** (`lib.rs:242`, built by `build_dual_run`, `lib.rs:739`) carries a four-valued `Agreement` (both complete / both abort / Ironhorse-only complete / oracle-only complete), `result_agrees`, `error_agrees` (rendered thrown strings equal), the Ironhorse `Halt`, `IronhorseCompile` (Accepted/Rejected/Unsupported/Panicked/NotAttempted, set by `compile_for`, `lib.rs:366`), `oracle_parsed` (oracle emitted bytecode) and `oracle_exit_status`. A clean compiler rejection is presented as a synthetic `SyntaxError` throw (`lib.rs:480-496`); Unsupported and Panicked compiles return empty bytecode and surface as `Halt::Decode`.

**Positive verdict table** (`evaluate_positive`): BothComplete+agree -> Covered; BothAbort+same error -> `shared-test262-failure` (Test262Error) or `shared-positive-test-failure` (anything else), both RunSkip; BothAbort+different error -> `oracle-host-missing-global:<name>` when the oracle's error is an unresolved global Ironhorse binds (probe `probe_global`, `xst.rs:969`, cached process-wide), else Fail (`abort-type`/`error-message-differs`/`abort-value-differs`); IronhorseOnlyComplete -> skips `oracle-host-missing-{temporal,intl}`, eval-framing, unresolved-name, host-stack-limit, else Fail `over-acceptance`; OracleOnlyComplete -> Fail (Test262Error, spurious throw) or `ironhorse-missing-global:` / `ironhorse-aborted-limit` skips.

**Timeout** (`run_case_bounded_with`, `xst.rs:2541`): the case runs on a fresh 32 MiB thread, `recv_timeout(per_mode_bound * mode_count)`; on timeout the thread is leaked and `ironhorse_terminates_alone` (`xst.rs:2651`) re-runs the Script assemblies without the oracle to choose `ironhorse-hang` (Fail) vs `oracle-nontermination` (skip).

**Reporting.** `CaseRecord` (`report.rs:238`) is per file; `classify(outcome, reason)` (`report.rs:143`) maps reason-string prefixes to six `Category` values; unknown reasons default to `Infrastructure`. `XstReport::record_case` (`xst.rs:2346`) also writes per-mode `expectations::Outcome` rows (Pass/Fail(reason)/Skip(reason)) keyed `(path, Mode::{Sloppy,Strict})`; `expectations::compare` (`expectations.rs:361`) produces ratchet events, all gating except `SkipReasonChanged` (gates only with `--strict-skip-reasons`, which the sweep always passes).

**Sweep orchestration** (`full-run.sh`): vendors test262 at the pin, verifies a clean git top-level, requires clean `rust/engine` and `c/moddable`, computes `run_id = test262 sha; endo HEAD sha; oracle on/off; moddable sha; ses; cap; case-timeout; scope[; expectations digest]` (`full-run.sh:252-258`), discovers 100-case batches per directory (`report.rs:938`, `BATCH_CASE_LIMIT` `report.rs:807`), runs each batch as its own `endot-ih` process under a 900 s watchdog (`full-run.sh:372`), retries up to 3 times then writes a `quarantine:` batch, validates count and `run_id`, aggregates exactly the plan. Per-batch processes bound the oracle's retained RSS (fresh XS machine per Script run, `xs_shim.c:295-311`, 8 MiB parser buffer each).

**CI.** PR CI (`ci.yml:1026`) gates `cargo test -p ironhorse-262` (1,262 tests, mostly engine differential suites), `corpus_compiler_totality` over the vendored corpus, `try.txt` (102 upstream files from the checked-in subset) and `ironhorse.txt` (1,712 oracle-generated corpus rows, `--repeat 3`). The whole tree (51,976 files) is gated only nightly (`ironhorse-full-test262.yml:7-8,163`), against the committed shards.

**`$262` host surface.** Both engines install exactly one hook, `detachArrayBuffer` (`ironhorse-vm/src/interp/boot.rs:2534-2540`, `xs_shim.c:399-416`). The module oracle path installs none.

### Conformance statistics from the committed shards

Script: `../probes/test262-harness/stats.py` (source below), run as `python3 -I stats.py rust/engine/ironhorse-262/expectations/whole-tree rust/engine/target/test262-report/test262-src/test`.

Headline (per case/mode, 99,569 rows over 51,976 files; 51,342 sloppy + 48,227 strict rows):

| View | Pass / covered | Fail | Skip / other |
| --- | ---: | ---: | ---: |
| Recorded outcome | 77,067 (77.4%) | 2,056 (2.1%) | 20,446 (20.5%) |
| `report.rs::classify` per row | covered 77,067 (77.4%) | ironhorse-failure 2,056 (2.1%) | skipped 14,864 (14.9%), unsupported 5,391 (5.4%), infrastructure 181 (0.2%), refused 10 |
| `classify` per file (report.json shape; `filecat.py`) | covered 39,860 (76.7%) | 1,064 (2.0%) | skipped 7,614 (14.6%), unsupported 3,256 (6.3%), infrastructure 177, refused 5 |
| test262's own verdict for Ironhorse, probe-calibrated (`t262verdict.py`) per row | 82,748 (83.1%) | 16,272 (16.3%) | not run 549 (0.6%) |
| same, per file (every mode passes) | 42,723 (82.2%) | 8,704 (16.7%) | not run 549 (1.1%) |

By tree (per row): `language` 95.3% covered (test262 verdict 95.5%); `built-ins` 72.9% (81.5%); `annexB` 25.0% (26.1%); `intl402` 0.7% (23.4%).

Skip families (20,446 rows): oracle lacks a global Ironhorse has 9,554 (46.7%; `Temporal` 8,476, `Intl` 1,078); oracle lacks Temporal 3,770 (18.4%); both threw same non-Test262Error 2,641 (12.9%); engine NotImplemented label 1,213 (5.9%: `module:dynamic-import` 798, `module:top-level-await` 207, `module:static-linking` 133, Temporal-toLocaleString-needs-intl 30, `Intl.NumberFormat:formatRange` 22, `Intl.NumberFormat:compact-locale` 18, `module:import-meta` 5); oracle lacks Intl 1,176 (5.8%); Ironhorse limit 904 (4.4%; 896 are `RegExp/property-escapes/generated` + `unicodeSets/generated`); both failed the same assertion 460; multi-agent substring pre-skip 228; module loader/linker shapes 185; async 112; feature list 134 (ShadowRealm 64, IsHTMLDDA 35, tail-call-optimization 35); completion rendering 18; negative-type-unmatched 13 (Annex B HTML comments); refused 10 (symbol WeakMap keys); negative-oracle-unexpected 9; parse-or-decode 6 (class static blocks); eval framing 5; oracle non-termination 3; CanBlockIsFalse 2.

Fail families (2,056 rows): positive over-acceptance (Ironhorse completed, XS threw) 705; `abort-value-differs` 655 (630 are Test262Error vs Test262Error; 542 in Temporal); async 268; Ironhorse threw where XS completed 258; Ironhorse failed an assertion XS passed 136; `error-message-differs` 20; `abort-type divergence` 10; completion-value divergence 4.

`$262` hooks (case or its includes): `detachArrayBuffer` 595 rows (552 pass); `createRealm` 396 (0 pass; 372 shared-positive-test-failure, 18 error-message-differs); `agent` 112 (all multi-agent pre-skip); `evalScript` 44 (6 pass, 38 shared failures); `IsHTMLDDA` 35 (feature pre-skip); `AbstractModuleSource` 11 (0 pass; 8 Fail because the module oracle has no `$262` at all); `gc` 0 at this pin (only staging uses it).

Full outputs: `stats-output.txt`, `features-output.txt`, `t262verdict-output.txt`, `filecat-output.txt`, `modes-output.txt`, `shared-by-include-output.txt`, all in `../probes/test262-harness/`. The stats output is reproduced in the appendix at the end of this map.

## Candidate findings

### T262-1 — The score conflates the XS differential with test262's verdict: 15,205 case/modes are attributed to the wrong column

- **Lens(es):** 5, 6 (also 1 for the instrument's own correctness).
- **Proposed severity:** high.
- **Location:** `rust/engine/ironhorse-262/src/xst.rs:717-718`, `xst.rs:777-817`, `xst.rs:1054-1062`; `rust/engine/ironhorse-262/src/report.rs:182-187` and `report.rs:102-106` (category definition); HTML text `report.rs:1176`, `report.rs:1250`.
- **Excerpt:**
  ```rust
  // xst.rs:1043-1061
  /// ... the oracle certified nothing on such a program,
  /// so ironhorse's own throw goes unjudged.
  fn oracle_unresolved_name_skip(run: &DualRun) -> Option<Verdict> {
      ...
          Ok(binding) if !binding.oracle && binding.ironhorse => Some(Verdict::RunSkip(format!(
              "oracle-host-missing-global:{name}"
  // report.rs:182-186
  } else if reason == "oracle-host-missing-intl"
      || reason == "oracle-host-missing-temporal"
      || reason.starts_with("oracle-host-missing-global:")
  {
      return Category::Skipped;
  // report.rs:102-103
  /// Declared or structural skip the run never attempted ...
  ```
- **Mechanism:** a positive test262 case reports failure by throwing; its own assertions are the verdict. The harness instead files every case where XS cannot run the program (no Temporal, no Intl) under "skipped", whatever Ironhorse did, and files every case where Ironhorse completes but XS throws a `Test262Error` as an Ironhorse "over-acceptance" failure. `oracle-host-missing-global:{Temporal,Intl}` is reached only from the BothAbort arm (`xst.rs:717`; the IronhorseOnlyComplete arm takes the `oracle-host-missing-{temporal,intl}` names first, `xst.rs:779-789`), so every one of those rows is a case where Ironhorse itself threw. The `over-acceptance` arm (`xst.rs:813`) is a positive case Ironhorse completed. The code already makes the right call in the mirror case: an Ironhorse `Test262Error` on a case XS passes "gates even without `--oracle`" because "the assertion is the report" (`xst.rs:832-838`).
- **Scenario:** the published report says built-ins/Temporal has 0 covered and 890 Ironhorse failures; test262 itself says Ironhorse passes 4,046 of 9,206 Temporal rows (3,558 `oracle-host-missing-temporal` + 488 over-acceptance) and fails 5,160. Across the tree, the "ironhorse-failure" column (2,056 rows; 1,064 files) is about one eighth of the real test262 failure count (about 16,272 rows; 8,704 files), and 709 of its rows are Ironhorse passes. A side effect on the ratchet: fixing a bug that XS shares turns `skip:shared-test262-failure` into `fail:"over-acceptance..."`, which `classify_change` reports as `NEW-FAIL` (`expectations.rs:401-404`), so engine progress raises the published failure count.
- **Evidence:** `probe-missing-global.txt`: 33 `oracle-host-missing-global:*` rows sampled at a fixed stride (22 Temporal, 11 Intl) run on Ironhorse alone through `ironhorse-xst` with test262-harness assembly (`t262host.py`): 33/33 FAIL (for example `built-ins/Temporal/Instant/prototype/until/roundingincrement-nan.js`: `Expected a RangeError to be thrown but no exception was thrown at all`). `probe-ironhorse-only-complete.txt`: 8 `oracle-host-missing-temporal`, 4 `oracle-host-missing-intl` and 8 `fail:"over-acceptance` rows: 20/20 PASS. `t262verdict.py` rescoring: see the headline table.
- **Recommendation:** record two orthogonal axes per case/mode: test262 verdict (pass/fail/not-run, from Ironhorse's own run against the case's assertions/negative block) and differential status (agree / disagree / oracle-unavailable:<why>). Keep the oracle gate for "disagree" but never let oracle unavailability decide the pass/fail column. Rename the `Skipped` category or split it ("not attempted" vs "oracle unavailable"). Make an XS-only failure on a positive case (`over-acceptance` with a Test262Error oracle throw) an advisory oracle defect, not `IronhorseFailure`. Publish the test262-verdict numbers as the headline.
- **Confidence:** confirmed by probe (sampled; the BothAbort derivation is static and exact).

### T262-2 — Setup and body are separate Scripts, and neither engine shares top-level `let`/`const`/`class` across Scripts: 724 case/modes fail as a harness artifact

- **Lens(es):** 1, 5, 6.
- **Proposed severity:** high (the engine-side divergence; the harness side alone would be medium).
- **Location:** `rust/engine/ironhorse-262/src/xst.rs:453-500` (split assembly), `lib.rs:602-639` (one Interp, Scripts relinked in turn); engine side: `ironhorse-vm/src/interp/environment.rs:39-52` (`define_global_lexical` is called only from `natives/compartment.rs:158`), so Script-goal top-level lexical declarations never reach `global_lexicals`.
- **Excerpt:**
  ```rust
  // xst.rs:453-456
  /// Test setup and subject are different scripts, as in xst262.c. Concatenating
  /// them lets case declarations hijack lockdown and destroys raw directive
  /// prologues/hashbangs.
  ```
- **Mechanism:** ECMA-262 GlobalDeclarationInstantiation puts a Script's top-level lexical declarations in the global Environment Record's declarative part, shared by every later Script, and makes a later redeclaration a SyntaxError. Ironhorse keeps them per Script; the XS oracle shim evaluates each Script with eval framing, which does the same. Six harness includes declare top-level lexical names (`deepEqual.js`, `nativeFunctionMatcher.js`, `regExpUtils.js`, `resizableArrayBufferUtils.js`, `temporalHelpers.js`, `wellKnownIntrinsicObjects.js`). Every case whose body uses one fails identically on both engines and lands in `skip:shared-positive-test-failure` (classified "unsupported", an Ironhorse gap).
- **Scenario:** `built-ins/Array/prototype/at/coerced-index-resize.js` uses `ctors` from `resizableArrayBufferUtils.js`. `endot-ih` reports `shared-positive-test-failure`; the same case through `ironhorse-xst` (one concatenated Script, the way test262-harness runs it) passes. For an embedder that loads two Scripts on one machine, `const X` from the first is invisible to the second, and `let R` can be redeclared.
- **Evidence:**
  - `shared_by_include.py`: all 724 rows whose body references such a name are `skip:shared-positive-test-failure`; 0 pass.
  - `probe-shared.txt`: 8 of those rows sampled at a stride (resizable-arraybuffer and regexp-v-flag) PASS on `ironhorse-xst`.
  - The mini corpus `../probes/test262-harness/mini262/` has include `lexinc.js` = `const SHARED_CONST = 42; let SHARED_LET = 43; class SharedClass {} var SHARED_VAR = 44;` and four cases `if (typeof X === "undefined") throw new Error("not visible");`. `endot-ih --test262-dir mini262 --case-timeout 20 <4 files>` printed `total=4 covered=1 ... 3 shared-positive-test-failure`. Only the `var` case is covered.
  - Rust probe `ironhorse-vm/tests/zz_audit_test262_harness_1.rs` (source in the appendix; deleted after the run) runs two Scripts on one `Interp` through `run` then `relink_crank`+`run`. Output:
    ```
    PROBE "var V = 44;" then "typeof V" => number
    PROBE "const C = 42;" then "typeof C" => undefined
    PROBE "let L = 43;" then "typeof L" => undefined
    PROBE "class K {}" then "typeof K" => undefined
    PROBE "function F() {}" then "typeof F" => function
    PROBE "let R = 1;" then "let R = 2; 'redeclared'" => redeclared
    ```
  - Node 22 (`vm.runInContext` twice in one context) gives `number,number,function` and `SyntaxError: Identifier 'L' has already been declared`.
- **Recommendation:** engine: implement the global declarative record for Script-goal lexical declarations, including the cross-Script redeclaration early error (owner: VM environment/realm region). Harness: until then, either concatenate setup and body for non-`raw` cases (test262 INTERPRETING.md permits it, and that is what the other hosts do) or classify `shared-*` rows whose body uses an include's lexical name as a harness artifact. Add `test/harness/` (excluded today, see T262-15) to the sweep, because `test/harness/deepEqual*.js` would have caught this.
- **Confidence:** confirmed by probe.

### T262-3 — An Ironhorse hang in a module-goal case is attributed to the oracle

- **Lens(es):** 1, 6.
- **Proposed severity:** medium.
- **Location:** `rust/engine/ironhorse-262/src/xst.rs:2651-2706` (`ironhorse_terminates_alone`), with `run_accepted_module` running Ironhorse first (`xst.rs:2055`).
- **Excerpt:**
  ```rust
  // xst.rs:2658-2692
  let fm = frontmatter::parse(src);
  let (mut run_sloppy, mut run_strict, only_strict) = strict_mode_status(&fm.flags);
  ...
  let _ = tx.send(crate::ironhorse_only_scripts(&source.setup, &source.body));
  ```
- **Mechanism:** the attribution re-run ignores the `module` flag and compiles the body with the Script goal (`lib.rs:717-719`). Module syntax (`export`, `import`) fails to compile, which reads as "terminated promptly", so the verdict is `oracle-nontermination: ... (ironhorse terminates alone)` (category infrastructure). For a module case, the oracle never ran: Ironhorse runs first, and that is what hung.
- **Scenario:** any Ironhorse non-terminating dispatch in a module case (`language/module-code/**`, 830 files) passes the gate as an oracle problem.
- **Evidence:** the mini corpus has `test/probe/hang-module.js` (`flags: [module]`, body `export {};\nfor (;;) {}`) and the control `hang-script.js` (`flags: [noStrict]`, body `for (;;) {}`). `endot-ih --test262-dir mini262 --case-timeout 2 <file>` printed:
  ```
  == hang-module.js
  1  oracle-nontermination: oracle failed to terminate within 2s (ironhorse terminates alone)
  BAR MET: 0 covered, 0 failed (of 1 total; 1 skipped by named reason)
  == hang-script.js
  fail: (1):  ironhorse-hang: no verdict within 2s (non-terminating dispatch)
  ```
  Ironhorse alone loops on `for (;;) {}`: `ironhorse-xst loop.js` was killed by `timeout 8` (exit 124).
- **Recommendation:** route module cases through a module-goal Ironhorse-only runner in `ironhorse_terminates_alone`. Because `run_accepted_module` runs Ironhorse before the oracle, a module timeout with no oracle start can be attributed directly. Share one mode/goal-selection function with `run_case` (see duplication D8).
- **Confidence:** confirmed by probe.

### T262-4 — Atomics pre-skips: the `CanBlockIsFalse` flag is read inverted, a substring match over-captures single-agent cases, and both hide that the engine refuses `wait`/`notify`/`waitAsync` outright

- **Lens(es):** 3, 5, 6.
- **Proposed severity:** medium.
- **Location:** `rust/engine/ironhorse-262/src/xst.rs:1541-1561`; engine refusal `ironhorse-vm/src/interp/natives/buffer.rs:2230-2233`.
- **Excerpt:**
  ```rust
  // `CanBlockIsFalse` marks the `$262.agent`/Atomics blocking-agent tests,
  // which need a threading story ironhorse does not have — a named structural skip.
  if fm.flags.iter().any(|f| f == "CanBlockIsFalse") { return preskip("structural:can-block"); }
  if src.contains("$262.agent") || src.contains("Atomics.wait") || src.contains("Atomics.notify")
  { return preskip("structural:multi-agent"); }
  ```
  ```rust
  // buffer.rs:2231-2233
  if op >= 10 { return Err(Step::Host(Halt::Refused("atomics:wait-notify"))); }
  ```
- **Mechanism:** INTERPRETING.md says a `CanBlockIsFalse` file "should only be run when [[CanBlock]] is false". A single non-blocking agent is exactly that host. Both such files assert `Atomics.wait(...)` throws `TypeError` (`built-ins/Atomics/wait/cannot-suspend-throws.js`, `.../bigint/cannot-suspend-throws.js`). The harness skips the files it should run and never checks `CanBlockIsTrue` (7 files), relying on the substring instead. The substring catches 228 files, of which only 112 rows use `$262.agent`. Roughly 118 are single-agent cases (notify on non-shared buffers returns 0, argument validation, waitAsync timeouts) that the spec defines without a second agent. The engine refuses all three operations before argument validation, as an uncatchable halt.
- **Scenario:** `Atomics.notify(new Int32Array(4), 0)` must return 0; `Atomics.wait` with [[CanBlock]] false must throw a catchable TypeError after validation. Ironhorse halts the program instead, and the sweep never shows it.
- **Evidence:** static; counts from `stats.py` and `grep` over the corpus (notify 52 files / 16 use `$262.agent`; wait 77 / 43; waitAsync 101 / 53).
- **Recommendation:** honor the flags as INTERPRETING.md defines them (run `CanBlockIsFalse`, skip `CanBlockIsTrue`), drop the substring test in favor of `$262.agent` only, and let the engine's refusal surface as `refused:atomics:wait-notify`. Engine: implement validation, `notify` returning 0 or the woken count, `wait` throwing TypeError when !CanBlock, and `waitAsync` without waiters.
- **Confidence:** high.

### T262-5 — The "infrastructure — not an Ironhorse gap" category holds Ironhorse gaps and failures (173 case/modes), and unknown reasons default into it

- **Lens(es):** 6, 5.
- **Proposed severity:** medium.
- **Location:** `rust/engine/ironhorse-262/src/report.rs:189-229`; emitters `xst.rs:1813-1819`, `xst.rs:1826`, `xst.rs:1852`, `xst.rs:1289/1296/1385/1404`; doc `baseline/README.md` re-audit section.
- **Excerpt:**
  ```rust
  // report.rs:226-228
  // Unknown run skips must not be charged to Ironhorse. New
  // reason families stay honest until explicitly classified.
  Category::Infrastructure
  ```
- **Mechanism:** the following land in infrastructure, which the HTML labels "oracle/harness non-results, **not** Ironhorse gaps":
  - `module:resolution-linking` (34): Ironhorse has no linker.
  - `module:compiler-rejected` (98): ironhorse-compile rejects the source, and the arm never looks at whether XS compiled it (`xst.rs:1852`). This includes the ES2022 arbitrary-module-namespace-names case `language/module-code/export-expname-import-string-binding.js`; the other 97 are Stage 3 `import defer`.
  - `module:compiler-byte-divergence` (32): Ironhorse's module bytes differ from XS, so the case is not executed at all. 24 of these are ES2022 `top-level-await/syntax`. Script cases have no such byte gate.
  - `negative-oracle-unexpected` (9): every one is an Ironhorse test262 failure. Ironhorse accepts `{...rest,} = {}` (the 6 `obj-rest-before-comma-invalid.js` rows), completes `let undefined;` at global scope (`decl-lex-restricted-global.js`, 2 rows), and does not throw for strict `undeclared = (this.undeclared = 5)` (`assign-to-global-undefined.js`). XS is wrong too, so the row is filed as an oracle surprise.

  The same "fail-safe" default would put any new Ironhorse-gap reason in the not-Ironhorse column.
- **Scenario:** `baseline/README.md` states that `decl-lex-restricted-global.js` is "an oracle/host exclusion, **not** an Ironhorse engine gap", but Ironhorse alone completes it, where the spec requires a SyntaxError.
- **Evidence:** `probe-misc.txt`: `obj-rest-before-comma-invalid.js` (sloppy and strict, 2 of the 3 files) reaches `$DONOTEVALUATE()` on Ironhorse (accepted); `decl-lex-restricted-global.js` exits 0 in both modes; `assign-to-global-undefined.js strict` exits 0. Node throws `ReferenceError: undeclared is not defined` for the latter and `SyntaxError: Rest element must be last element` for the former.
- **Recommendation:** classify by who failed, not by whether the oracle agreed:
  - `negative-oracle-unexpected` with Ironhorse accepting/completing should be a test262 failure (shared).
  - `module:resolution-linking` should be Unsupported.
  - `module:compiler-rejected` should be decided against `oracle.compiled` (Fail when XS compiled it, Unsupported/shared otherwise).
  - `module:compiler-byte-divergence` should run the case anyway (as Scripts do) and report divergence separately.
  - Make unknown reasons a hard error in `classify` (an exhaustive enum of reason families, see the ontology notes), not a default.

  Correct `baseline/README.md`.
- **Confidence:** confirmed by probe.

### T262-6 — A compiler panic on a positive case is a skip, not the Fail the harness's own doctrine prescribes

- **Lens(es):** 1, 6.
- **Proposed severity:** medium (mitigated by the separate `corpus_compiler_totality` gate in PR CI).
- **Location:** `rust/engine/ironhorse-262/src/lib.rs:412-421` (Panicked returns empty bytecode), `xst.rs:678` (`Halt::Decode(_) => RunSkip("parse-or-decode")`), `xst.rs:1783-1790` and `xst.rs:1853` (module panic -> `compiler-unimplemented:*`), versus `xst.rs:1361-1376` (negative parse panic -> `Fail("compiler-panicked:..")`).
- **Excerpt:**
  ```rust
  // xst.rs:1366-1375 (negative path only)
  // It shared `compiler-unimplemented:<phase>` with the coverage gap
  // above for five revisions ... an engine fault read as missing coverage
  IronhorseCompile::Panicked(_) => Verdict::Fail(format!("compiler-panicked:{}", neg.phase)),
  ```
- **Mechanism:** `evaluate_positive` never reads `run.ironhorse_compile`. A Panicked or Unsupported compile yields empty bytecode, the VM stops with `Halt::Decode`, and the case becomes `parse-or-decode` (category unsupported). The module path catches the panic (`Err(_)`) and names it `compiler-unimplemented:parse`/`:module`. One condition gets three names: Fail `compiler-panicked`, skip `parse-or-decode`, skip `compiler-unimplemented`. This depends only on whether the case is negative/positive and script/module.
- **Scenario:** a coder panic introduced on a construct used only in positive cases (about 85% of the corpus) shows up as unsupported rows, and the nightly gate reports it as a `SKIP-MOVED` or `REGRESSION` with a misleading reason.
- **Evidence:** static path, plus the shard rows `language/statements/class/static-init-scope-{lex-close,var-close,var-open}.js skip:parse-or-decode`. `ironhorse-xst` shows the cause is a compiler `Unsupported` ("`InternalError: line 233: static block with lexical declarations deferred`", `probe-misc.txt`), which flows through the same empty-bytecode path a panic takes.
- **Recommendation:** classify `IronhorseCompile` before the halt in `evaluate_positive`, `evaluate_negative` and the module path, with one shared function: Panicked -> `Fail("compiler-panicked:<goal>")`, Unsupported -> `compiler-unimplemented:<goal>`. Retire `parse-or-decode` for compile outcomes.
- **Confidence:** high (static; the Unsupported leg is shown by the shards and the probe).

### T262-7 — A greedy regexp over more than about 65k characters halts with `HeapExhausted`; 904 ES2018/ES2024 case/modes are filed as an Ironhorse "limit"

- **Lens(es):** 3, 5, 6 (label); owner: regexp region.
- **Proposed severity:** medium.
- **Location:** `ironhorse-regexp/src/matcher.rs:127` (`pub const MAX_MATCH_STATES: usize = 65_536;`), mapped to `Halt::HeapExhausted` at `ironhorse-vm/src/interp/natives/regexp.rs:556-558`; harness label `xst.rs:761`, `xst.rs:880`.
- **Excerpt:** `if outcome.resource_limit { return Err(Step::Host(Halt::HeapExhausted)); }`
- **Mechanism:** each greedy iteration pushes a backtrack state. Past 65,536 states the match stops with a resource limit that the VM reports as heap exhaustion, an uncatchable halt. test262's `buildString` subjects for `\P{...}` contain about 1.1M code points.
- **Scenario:** `/^a+$/.test('a'.repeat(70000))` halts the whole program. Node returns `true`.
- **Evidence:**
  - Probe files `rga_<n>.js`: `const s = 'a'.repeat(n); const ok = /^a+$/.test(s); throw new Error('n=' + s.length + ' ' + ok);`. Ironhorse: n = 1000, 5000, 10000, 20000 and 40000 print `true`; n = 70000, 100000 and higher print `InternalError: ironhorse halted: HeapExhausted`. Node at n=70000: `Error: n=70000 true`.
  - `probe-aborted-limit.txt`: 4/4 sampled `ironhorse-aborted-limit` rows halt with `HeapExhausted`.
  - Building the 2.16M-unit subject alone succeeds (`regex_build_only.js` prints `len=2162552`).
  - `regexp-unicode-property-escapes` is 25.4% pass, 896 of its rows are this skip.
- **Recommendation:** charge states to the meter or heap ceiling instead of a fixed count, or represent greedy single-character loops without per-iteration states (XS's limit is memory, not a count). Report a fixed match-state cap as `Refused("regexp:match-states")`, not `HeapExhausted`.
- **Confidence:** confirmed by probe.

### T262-8 — The feature skip list drops `tail-call-optimization`, which the oracle implements, while claiming to mirror XS's list

- **Lens(es):** 3, 5, 6.
- **Proposed severity:** medium.
- **Location:** `rust/engine/ironhorse-262/src/xst.rs:33-54`.
- **Excerpt:** `/// The ironhorse not-yet-implemented feature skip list — the analogue of /// xst262.c's 13-entry gxFeatures.` ... `"tail-call-optimization",`
- **Mechanism:** XS's `gxFeatures` (`c/moddable/xs/tools/xst262.c:150-164`) skips Temporal, decorators, import-defer, joint-iteration, source-phase-imports, ShadowRealm and others. It does not skip `tail-call-optimization`, and XS has `XS_CODE_RUN_TAIL*`. Ironhorse decodes the same opcodes (`ironhorse-vm/src/opcode.rs:182-185`) but grows the stack, so the 35 TCO files (ES2015 proper tail calls, strict mode) are pre-skipped rather than reported as failures.
- **Evidence:** `probe-tco.txt`: `language/expressions/logical-or/tco-right.js` and `language/expressions/comma/tco-final.js` in strict mode both stop with `InternalError: ironhorse halted: StackOverflow(4057)`.
- **Recommendation:** remove the entry so the gap is measured, then implement frame reuse for `RUN_TAIL` in strict code (moderate effort in the interpreter's frame model and stack accounting). Correct the doc comment; the list is not an analogue of `gxFeatures`. `IsHTMLDDA` (a browser host hook) and `ShadowRealm` (Stage 2.7) are reasonable entries.
- **Confidence:** confirmed by probe.

### T262-9 — `$262` exposes only `detachArrayBuffer`; the module oracle exposes nothing

- **Lens(es):** 3, 5.
- **Proposed severity:** low.
- **Location:** `ironhorse-vm/src/interp/boot.rs:2518-2541`; `xs-oracle/csrc/xs_shim.c:399-416` (script oracle only); `xst.rs:1934-1961` (module oracle path).
- **Mechanism:** missing hooks cost:
  - `createRealm`: 396 rows, 0 pass; `cross-realm` feature 1.0% pass.
  - `evalScript`: 44 rows, 38 not passing.
  - `agent`: 112 rows.
  - `IsHTMLDDA`: 35 rows.
  - `AbstractModuleSource`: 11 rows.
  - `gc`: 0 at this pin.

  Because the module oracle has no `$262`, 8 `AbstractModuleSource` rows are Fails reading `oracle threw "ReferenceError: get $262: undefined variable"`.
- **Recommendation:** add `evalScript` (compile as Script with GlobalDeclarationInstantiation on the current machine; it shares the fix in T262-2) and `global`; install `$262` in the module oracle; treat `createRealm` as the multi-realm milestone it is.
- **Confidence:** high (counts from shards and corpus).

### T262-10 — The expectation list's mode column is wrong for 1,186 files, so case/mode totals are not comparable

- **Lens(es):** 6.
- **Proposed severity:** low.
- **Location:** `rust/engine/ironhorse-262/src/xst.rs:2382-2399`, `xst.rs:2607-2611` (timeout result has no `mode_outcomes`), `xst.rs:1856-1861` (module result has none).
- **Mechanism:** the following get the wrong rows (`modes.py`):
  - All 830 module cases are recorded as `sloppy`, though module code is always strict.
  - 31 `onlyStrict` pre-skips (the TCO files) are recorded as `sloppy`; the `starts_with("onlyStrict")` test matches a reason no code emits any more.
  - 325 default cases (230 structural, 95 feature, 3 timeouts) keep only a `sloppy` row, so their strict variant is not in the list.

  Per-row rates therefore weight run cases double and pre-skipped cases once. When TCO lands the ratchet will report MISSING+UNEXPECTED rather than PROGRESS.
- **Recommendation:** derive rows from `strict_mode_status` for every outcome, including pre-skips and timeouts; add a `module` mode.
- **Confidence:** confirmed (shard data).

### T262-11 — `ironhorse-xst` is not a faithful eshost "xs" host

- **Lens(es):** 6, 5.
- **Proposed severity:** low.
- **Location:** `rust/engine/ironhorse-262/src/bin/ironhorse_xst.rs:82-104`.
- **Mechanism:** `ironhorse-xst` has three gaps as a host:
  - No `print`. `doneprintHandle.js` calls it, so every async case (5,584 files) fails under the documented `test262-harness --host-type xs` invocation.
  - A thrown `Test262Error` renders as `Object: <message>`, so eshost reads the error name `Object` and the 14 negative cases with `type: Test262Error` mis-score.
  - A thrown plain object renders as `[object Object]`, not via its `toString`.
- **Evidence:** probes `print.js` -> `ReferenceError: get print: undefined variable`; `t262err.js` -> `Object: boom`; `obj_throw.js` -> `[object Object]`; `custom_err.js` -> `MyErr: m`.
- **Recommendation:** install a `print` host function in this binary, and render the escaping value with the guest-rendering path the differential already uses (`run_rendering_throws_in_guest`, `lib.rs:662`).
- **Confidence:** confirmed by probe.

### T262-12 — Dead and legacy code, a second classifier with different semantics, and 4.4 MB of unreferenced baseline data

- **Lens(es):** 2, 6.
- **Proposed severity:** low.
- **Location:**
  - `test262.rs:36-277`: `Class`, `classify`, `classify_run`, concatenating `assemble`, `Report`, `run_files`. Only `classify_run` has a caller, a test at `xst.rs:4463`. Its BothAbort mismatch is a skip (`test262.rs:179`), where `xst.rs` makes it a Fail.
  - `lib.rs:1083-1163` `compartment_dual_run`: no callers.
  - `report.rs:837` `aggregate`, `:994` `pending_batches`, `:701` `read_batch`: legacy unbound variants.
  - `report.rs:157-161` classify arms for reasons nothing emits (`onlyStrict:strict-mode-unimplemented`, `feature:lockdown`, `feature:Compartment`).
  - `xst.rs:359` `FEATURES_SUPPLIED_BY_PRELUDE`: inert by its own comment.
  - `xst.rs:681` `let _ = meter_exact_gate;`.
  - `examples/zz_apply.rs`: counts computron drift as "divergent", contradicting `lib.rs:15-28`.
  - `baseline/` (4.4 MB; no code, script or workflow reads it).
- **Recommendation:** delete or move to history; keep one classifier.
- **Confidence:** high (grep).

### T262-13 — Resume identity is coarse, and a quarantine is permanent for a run identity

- **Lens(es):** 4.
- **Proposed severity:** low.
- **Location:** `scripts/full-run.sh:252-258`, `scripts/expectation-shards.sh:47-59`, `full-run.sh:413-425`.
- **Mechanism:** the identity is coarser than the work it guards, in three ways:
  - `endo=$endo_sha` is the repository HEAD commit, so any commit anywhere (docs included) invalidates all 1,930 batches.
  - The expectations digest hashes the whole shard directory, so a one-line edit to one shard re-runs every batch, though each batch compares only against its own shard.
  - A quarantine record is a valid result file stamped with the run identity, so `plan` never retries it. A transient OOM under parallel load poisons that output directory until someone deletes the file by hand. `IRONHORSE_262_BATCH_TIMEOUT`, which decides quarantines, is not in the identity.
- **Recommendation:** identity = `git rev-parse HEAD:rust/engine` tree + moddable gitlink + per-batch shard digest; make quarantined batches pending again on a new invocation (keep the attempt counter).
- **Confidence:** high (static).

### T262-14 — Two compile-error classifiers disagree about which failures are SyntaxErrors

- **Lens(es):** 2, 6.
- **Proposed severity:** low (latent: the harness compiles with an unbounded `ParseMeter` and `Overflow` is "not raised in practice").
- **Location:** `rust/engine/ironhorse-262/src/lib.rs:118-156` vs `lib.rs:395-410`; plus `compile_diff.rs:137-146`.
- **Excerpt:** `compile_failure_name`: `ParseErrorKind::Unsupported | ParseErrorKind::MeterLimit => "InternalError"` and `LexErrorKind::MeterLimit | ... | Overflow => "InternalError"`; `compile_for`: `_ => IronhorseCompile::Rejected(rendered)`, which includes `MeterLimit`, `Lex(MeterLimit)` and `Lex(Overflow)`.
- **Mechanism:** a `Rejected` counts as a correct early-error rejection in `evaluate_negative_early` (`xst.rs:1379-1381`). If the harness ever arms a compile budget, a resource stop would pass parse-negative cases, which is the exact failure `compile_failure_name`'s comment warns about. `compile_diff.rs` decides oracle parse rejection with `o.error.contains("SyntaxError")`, while `xst.rs` uses `oracle_parsed` (non-empty bytecode): two definitions of "oracle rejected".
- **Recommendation:** one exhaustive `fn classify_compile_error(&ParseError) -> {Syntax, Unsupported, Resource}`, used by every caller.
- **Confidence:** high (static).

### T262-15 — Documentation and code disagree on the sweep's shape and scope

- **Lens(es):** 6.
- **Proposed severity:** low.
- **Location and mechanism:**
  - `scripts/README.md` ("CI") says "Each worker has a 180-second wall-clock bound"; `full-run.sh:372` uses 900 s.
  - The same README calls the workflow "an explicitly invokable (workflow_dispatch) path — never on the PR/push matrix" that "defaults to a bounded subtree"; it also has a nightly `schedule` that runs the full tree (`ironhorse-full-test262.yml:7-8`).
  - The workflow also runs unrelated bench and stack-lane jobs (`ironhorse-full-test262.yml:47-428`), up to 180 min, on every manual subtree dispatch.
  - `bin/endot_ih.rs:27-32` and the refusal text at `:509-513` say there is no guest `Compartment`; `xst.rs:93-99` says it landed.
  - Discovery excludes every directory named `harness` (`report.rs:958`), which drops the 116 real test cases under `test/harness/`. The README describes these as "harness support files".
  - The header `tip=` is taken from `GARDEN_TEST262_TIP` (`bin/endot_ih.rs:379`, default `unknown`), so for the PR gates it certifies an env var, not the corpus (the `try.txt` slice runs against the checked-in subset).
  - `ironhorse.txt` keys are `../../packages/...` relative paths, because `strip_prefix(root)` fails for the CI's relative positional (`xst.rs:2718-2722`). The keys depend on how the CLI is invoked, even though the header was made root-relative.
- **Recommendation:** fix the text; include `test/harness/`; derive `tip` from the corpus checkout; canonicalize case paths before stripping.
- **Confidence:** high.

## Duplication inventory

| # | Family | Copies (path:line) | Size | Note |
| --- | --- | --- | --- | --- |
| D1 | sloppy/strict verdict fold | `xst.rs:1632-1650`, `xst.rs:2206-2232` | ~20 lines x2 | byte-identical match arms |
| D2 | halt pre-classification (NotImplemented/Refused/EngineInvariant/EngineFault/Decode) | `xst.rs:671-680`, `xst.rs:1246-1256`, `xst.rs:1269-1278`, `xst.rs:2078-2087`, `xst.rs:546-561`, `lib.rs:1013-1036`, `test262.rs:123-159` | 7 copies, ~10-35 lines each | subtly different (setup lockdown arm, boot `Divergent`, legacy skip) |
| D3 | `CaseResult { verdict, strict_skipped: false, computron_gap: false, mode_outcomes: Vec::new() }` | 28 literal constructions in `xst.rs` 1-2760 (17 with all-default telemetry) | ~6 lines each | only `preskip()` (`xst.rs:329`) is factored |
| D4 | synthetic "did not run" `RunOutcome` (12 fields) | `lib.rs:481-494`, `lib.rs:535-548`, `lib.rs:559-572`, `lib.rs:674-687` | 4 x 13 lines | a `RunOutcome::not_run(halt)` |
| D5 | Agreement / `error_agrees` / `ironhorse_error` derivation | `lib.rs:747-775` (`build_dual_run`), `xst.rs:1974-2008` (`module_dual_run`) | ~35 lines x2 | module path reimplements the record builder |
| D6 | panic payload -> string | `lib.rs:430-443`, `xst.rs:2617-2628`, `compile_diff.rs:184-192` | 3 copies | different fallbacks ("panic", "non-string panic payload", "coder panic (opaque payload)") |
| D7 | `catch_unwind(compile_atoms*)` | `lib.rs:384`, `lib.rs:693`, `lib.rs:717`, `lib.rs:868`, `lib.rs:908`, `xst.rs:1704`, `xst.rs:1712`, `compile_diff.rs:159`, `compile_diff.rs:174` (and an uncaught one at `xst.rs:2029`) | 10 sites | each maps the outcome differently (see T262-6, T262-14) |
| D8 | mode/goal selection + exact-meter override | `xst.rs:1563-1576`, `xst.rs:2527-2539`, `xst.rs:2659-2670` | 3 copies | the third forgot the module goal (T262-3) |
| D9 | compile-error classification | `lib.rs:118-156`, `lib.rs:395-410`, `xst.rs:1770-1774`, `xst.rs:1845-1848`, `xst.rs:2032-2035`, `compile_diff.rs:137-146` | 6 sites | disagree (T262-14) |
| D10 | case JSON row emission | `report.rs:562-581`, `report.rs:610-628` | ~20 lines x2 | aggregate vs batch shape |
| D11 | string quoting | `xst.rs:2474-2487` (`yaml_quote`: no `\r`, `\t` or control escapes), `report.rs:649-665` (`json_str`) | 2 | YAML report can be broken by a `\r` in a diagnostic |
| D12 | "oracle lacks global X" carve-out | `xst.rs:1164-1168` (Intl), `xst.rs:1170-1174` (Temporal), `xst.rs:1054-1062` (generalized) | 3 mechanisms, 3 reason names | same condition, different names (ontology) |
| D13 | reason vocabulary kept in sync by hand | emitters across `xst.rs`; classifier `report.rs:143-232`; HTML prose `report.rs:1176,1250`; `scripts/README.md`; committed shards | 5 places | no enum; prefix matching with order-dependent precedence (`negative-` vs `negative-oracle-unexpected`) |
| D14 | test assembly | `test262.rs:81-111` (concatenate), `xst.rs:464-523` (split) | 2 semantics | the split one causes T262-2 |

## Skipped features and refusals inventory

| Site | What is refused or skipped | Rows (files) | Spec status | Should support? | Effort |
| --- | --- | ---: | --- | --- | --- |
| `xst.rs:49` `feature:ShadowRealm` | whole feature | 64 | Stage 2.7 | not yet | n/a |
| `xst.rs:54` `feature:tail-call-optimization` | proper tail calls | 35 (35) | ES2015, strict | yes; XS runs them | moderate (frame reuse on `RUN_TAIL`) |
| `xst.rs:55` `feature:IsHTMLDDA` | `$262.IsHTMLDDA` | 35 | Annex B host hook (browsers) | no | n/a |
| `xst.rs:75` `ses-xs-parity` | opt-in corpus marker | 0 upstream | repo-local | n/a | n/a |
| `xst.rs:1544` `structural:can-block` | `CanBlockIsFalse` files | 2 | flag semantics inverted | yes, run them | trivial (harness) + engine TypeError |
| `xst.rs:1558` `structural:multi-agent` | substring `$262.agent`/`Atomics.wait`/`Atomics.notify` | 228 (~118 single-agent) | ES2017/ES2024 | single-agent part yes | small (harness) + engine validation/notify/waitAsync |
| `ironhorse-vm/.../buffer.rs:2231` `Refused("atomics:wait-notify")` | all of wait/notify/waitAsync | hidden by the row above | ES2017/ES2024 | yes (non-blocking agent semantics) | small to moderate |
| `$262.createRealm` absent | multi-realm | 396 | test262 host hook | yes, eventually | high (second realm in one agent) |
| `$262.evalScript` absent | global Script eval | 44 | test262 host hook | yes | small, once T262-2 is fixed |
| `$262.agent` absent | multi-agent | 112 | test262 host hook | no (single-agent by design) | n/a |
| `$262.AbstractModuleSource` absent; module oracle has no `$262` | source phase imports | 11 | Stage 3 | later | small (oracle) |
| `unsupported-opcode:module:dynamic-import` | `import()` | 798 | ES2020 | yes | moderate (host loader + async job) |
| `unsupported-opcode:module:top-level-await` | TLA | 207 (+ 24 byte-divergence + others) | ES2022 | yes | moderate |
| `unsupported-opcode:module:static-linking`, `module:resolution-linking`, `:import-meta` | module graphs | 133 + 34 + 5 | ES2015/ES2020 | yes | moderate (linker) |
| `module:compiler-rejected` | `import defer` (97), arbitrary module namespace names (1) | 98 | Stage 3 / ES2022 | ES2022 part yes | small (parser) |
| `compiler-unimplemented:module`/`:parse` | import attributes, JSON modules | 24 | ES2025 | yes | small to moderate |
| ironhorse-compile `Unsupported` "static block with lexical declarations deferred" (`parse-or-decode`) | `class { static { let x } }` | 6 (3) | ES2022 | yes | small (compiler region) |
| `ironhorse-regexp/src/matcher.rs:127` `MAX_MATCH_STATES` | greedy match over >65k chars | 904 | ES2018 property escapes / ES2024 v-flag | yes | moderate (regexp region) |
| `natives/collection.rs:318-320` `Refused("collection-constructor:weak-symbol-oracle-version")` + `set` TypeError | symbols as WeakMap/WeakSet keys | 10 refused + 38 shared failures (29 files) | ES2023 | yes | small (VM region) |
| `unsupported-opcode:Intl.NumberFormat:{formatRange,compact-locale}`, `Temporal...toLocaleString:needs-intl` | Intl gaps | 22 + 18 + 30 | ECMA-402 | yes | moderate |
| Annex B HTML-like comments (`negative-type-unmatched`, shared failures) | `<!--`, `-->` | 13+ | Annex B (normative optional) | optional | small (lexer) |
| `report.rs:958` discovery excludes `test/harness/` | 116 harness self-tests | 116 | test262 | yes | trivial |
| `xst.rs:179-180` `-c`/`-lc` SES modes | compartment wrap | n/a (CLI refuses) | SES | later | measure first |

## Memory and performance opportunities

| Site | Waste | Magnitude | Fix |
| --- | --- | --- | --- |
| `xst.rs:464-500` + `lib.rs:602` | harness setup (sta.js, assert.js, includes such as `propertyHelper.js`, `temporalHelpers.js`) is re-parsed and re-run on both engines for every case and every mode | about 2 x 99.5k setup compiles per engine per sweep; not measured | snapshot the post-setup realm per include set (Ironhorse has snapshots), or at least reuse parsed setup bytecode |
| `expectation-shards.sh:47-59` | whole-directory digest in `run_id` | any one-shard edit re-runs all 1,930 batches | per-batch shard digest |
| `full-run.sh:230,252` | `endo_sha` = repo HEAD | any commit re-runs everything | use the `rust/engine` tree hash |
| `xst.rs:2577-2589` | a timed-out case's thread is leaked and keeps spinning (XS or VM) until the batch process exits | one core per hung case for up to 900 s; with `--jobs 4` on a 4-vCPU runner, a quarter of capacity, cascading into further timeouts in that batch | run oracle cases in a subprocess or arm the XS meter so the worker can be stopped |
| `xst.rs:1525,2528,2658,2733` | frontmatter YAML parsed 3-4 times per case | small | pass the parsed `Frontmatter` |
| `expectations/whole-tree` | 14 MB committed, about 135 B per row: full path on both mode rows plus full JSON diagnostics (some over 400 B) | 103,429 lines; re-baselines produce huge diffs | store diagnostics as a stable hash or short class, keep full text in the report artifact |
| `baseline/` | unreferenced historical data | 4.4 MB | move to a release artifact |
| `xs_shim.c:275-289` | each oracle machine allocates an 8 MiB parser buffer and a 64Ki-slot stack; the harness relies on 100-case processes to shed retained RSS | not measured | reuse one machine per batch for Scripts, or `malloc_trim` after delete |

## Ontology notes

**Vocabulary layers.** There are seven outcome vocabularies, with no single source:

1. `xst::Verdict` {Covered, PreSkip, RunSkip, Fail}.
2. `expectations::Outcome` {Pass, Fail, Skip} x `Mode` {Sloppy, Strict}.
3. `report::Verdict` wire {covered, pre-skip, run-skip, fail}.
4. `report::Category` {covered, ironhorse-failure, unsupported, refused, skipped, infrastructure}.
5. `test262::Class` {Covered, Divergent, Skipped}.
6. `BootVerdict` {Agrees, NamedGap, Divergent}.
7. Ratchet events {NEW-FAIL, REGRESSION, PROGRESS, FAIL-SKIPPED, FAIL-MOVED, SKIP-MOVED, MISSING, UNEXPECTED}.

On top of these sit about 60 free-form reason strings, classified by prefix.

**(a) Synonyms and homonyms.**
- "skip" means three sets: `Outcome::Skip` (anything not pass or fail), `Category::Skipped` (feature/structural pre-skips plus 14,500 rows that ran), and the CLI's `skipped=` (`total - covered - failed`, `bin/endot_ih.rs:308`). The pre-skip/run-skip distinction is lost in the committed shards.
- "over-acceptance" names opposite test262 outcomes: on a positive case Ironhorse is right and XS wrong (705 rows); on a negative case Ironhorse is wrong. Both are `IronhorseFailure` (T262-1).
- "oracle-host-missing-temporal" and "oracle-host-missing-global:Temporal" (likewise Intl) are synonyms by name, but in fact separate Ironhorse-pass from Ironhorse-fail rows. The name hides the only distinction that matters (T262-1, D12).
- "covered" = differential agreement, "pass" = `Outcome::Pass` = covered; test262's pass is not represented anywhere.
- "unsupported-opcode:" labels module-loader shapes and Intl options, not opcodes.
- "ironhorse-aborted-limit" covers stack overflow, meter abort, `HeapExhausted` (actually a regexp state count, T262-7), `ReentryLimit` and anything else non-throw.
- "strict-unimplemented" is the reason recorded for the exact-meter policy's omission of strict mode (`xst.rs:2379,2396`), though strict mode is implemented.
- "harness" means both the top-level `harness/` support files and the `test/harness/` test cases; discovery excludes both (T262-15).

**(b) Exhaustiveness and disjointness.**
- `classify` is a prefix cascade whose order decides overlaps: `negative-oracle-unexpected` matches both the infrastructure list and the `negative-` unsupported prefix, and wins only because the infrastructure list is tested first.
- Unknown reasons fall into Infrastructure (`report.rs:226-229`), so the taxonomy is closed by a default that contradicts that category's definition.
- One condition gets several classes:
  - compiler panic: Fail / unsupported (`parse-or-decode`) / unsupported (`compiler-unimplemented`) (T262-6);
  - compiler `Unsupported`: `parse-or-decode` (positive Script) vs `compiler-unimplemented:<phase>` (negative or module);
  - Ironhorse rejecting a valid module: infrastructure (`module:compiler-rejected`), but rejecting a valid Script: Fail ("threw where the oracle completed");
  - bytecode divergence from XS: gates execution for modules only.

**(c) Missing distinctions.**
- No type separates "test262 verdict" from "oracle agreement" (T262-1).
- `Mode` has no Module value (T262-10).
- `Negative.phase` is a free string: anything other than `parse`/`resolution` is treated as runtime (`xst.rs:1262`), so a legacy `early` phase would silently be judged as a runtime negative.
- `IronhorseCompile::Rejected` does not record which kind of rejection it was (resource vs grammar, T262-14).
- Per-file `CaseRecord` keeps one reason for two modes; `strict:` prefixing is the only trace of which mode failed.

**(d) Divergence from the test262/ECMA-262 model that changes verdicts.**
- Split setup/body Scripts plus non-shared Script lexical scope make 724 rows fail (T262-2; INTERPRETING.md requires includes to be evaluated in the global scope).
- `CanBlockIsFalse` is read inverted (T262-4).
- Module cases are scored under "sloppy" (T262-10).
- Early negatives accept any `Rejected` regardless of `negative.type` (benign at this pin: all parse negatives are SyntaxError).
- `raw` correctly implies a single sloppy run.

**(e) Docs vs code.**
- `report.rs:102-106` defines Skipped as "the run never attempted", but most Skipped rows ran.
- HTML `report.rs:1250` heads the section "Skipped reasons (declared & structural)" over `oracle-host-missing-global:Temporal`.
- HTML `report.rs:1176` says infrastructure is "**not** Ironhorse gaps", contradicted by T262-5.
- `scripts/README.md` "Honest coverage ... An unsupported language feature surfaces as a named `unsupported` gap, never hidden" is contradicted by T262-1.
- `baseline/README.md` re-audit claim (T262-5).
- `xst.rs:33-36` calls the skip list a `gxFeatures` analogue (T262-8).
- `endot_ih.rs` Compartment text (T262-15).
- `expectations.rs:17-19` documents `strict-unimplemented` and `unsupported-opcode:add` as example reasons; neither means what it says today.

All Lens-6 items that change a reported number are promoted above: T262-1, T262-2, T262-4, T262-5, T262-6, T262-10.

## Leads that did not survive

- Resume can mix batches across corpora/engines: no; `plan` and `aggregate_plan` bind exact `run_id` strings and the plan, and the dirty checks cover `rust/engine` and `c/moddable` (`full-run.sh:223-236`).
- Negative early tests pass on any Ironhorse throw: no; `evaluate_negative_early` keys on `IronhorseCompile`, and `$DONOTEVALUATE()` runtime throws cannot satisfy it (`xst.rs:1347`).
- Expectations parser loses whitespace/newlines in failure reasons: no; JSON-quoted and round-trip tested (`expectations.rs:465-489`).
- `probe_global` caching a transient machine failure: no; `MachineError` is not cached (`xst.rs:995-997`).
- Determinism gate comparing NaN halts: handled by Debug-string fingerprint (`xst.rs:1441-1443`).
- Shards stale against HEAD: they were last regenerated in `db164064` (4 engine commits before HEAD); a fresh single-file `endot-ih` run at HEAD reproduced the shard row I checked (`coerced-index-resize.js`).
- Async refinement manufacturing passes: no; only `Test262:AsyncTestComplete` with no unhandled rejection is Covered (`xst.rs:2243-2267`).
- `MeterLimit` compile errors counted as early errors in practice: unreachable, because the harness uses `ParseMeter::new()` (unbounded); kept as latent T262-14.
- Oracle-only `oracle-nontermination` rows hiding Ironhorse hangs in Script cases: the control probe shows Script attribution works; only modules are affected (T262-3).

## Appendix: probe sources and outputs

All files are in `../probes/test262-harness/` (`$SCRATCH` = `$SCRATCH`).

### stats.py (conformance statistics)

```python
#!/usr/bin/env python3
"""Conformance statistics from the committed whole-tree expectation shards.

usage: python3 -I stats.py <expectations/whole-tree> <test262/test> [--json out.json]

Parses each shard with the grammar of ironhorse-262/src/expectations.rs:
  header  : '# engine=.. features=.. corpus=.. tip=..'
  entry   : '<path> <sloppy|strict> <pass | fail | fail:"json" | skip | skip:reason>'
(splitn(3, whitespace): the outcome token is the rest of the line.)

Joins every case with its test262 frontmatter (features/flags/negative/includes)
and with a text scan for `$262.<hook>` uses.
"""
import json, os, re, sys, collections

shard_dir, test_root = sys.argv[1], sys.argv[2]
out_json = sys.argv[sys.argv.index('--json') + 1] if '--json' in sys.argv else None

entries = []  # (path, mode, kind, reason)
headers = {}
manifest = []
for name in sorted(os.listdir(shard_dir)):
    p = os.path.join(shard_dir, name)
    if name == 'manifest.txt':
        manifest = [l.strip() for l in open(p) if l.strip()]
        continue
    for line in open(p, encoding='utf-8'):
        line = line.strip()
        if not line:
            continue
        if line.startswith('#'):
            if 'engine=' in line or 'corpus=' in line:
                headers[name] = dict(kv.split('=', 1) for kv in line[1:].split() if '=' in kv)
            continue
        parts = re.split(r'\s', line, maxsplit=2)
        path, mode, tok = parts[0], parts[1], parts[2]
        if tok == 'pass':
            entries.append((path, mode, 'pass', ''))
        elif tok == 'fail':
            entries.append((path, mode, 'fail', ''))
        elif tok.startswith('fail:'):
            entries.append((path, mode, 'fail', json.loads(tok[5:])))
        elif tok == 'skip':
            entries.append((path, mode, 'skip', ''))
        elif tok.startswith('skip:'):
            entries.append((path, mode, 'skip', tok[5:]))
        else:
            raise SystemExit(f'bad outcome {tok!r} in {name}')

# --- frontmatter join -------------------------------------------------------
FM_RE = re.compile(r'/\*---(.*?)---\*/', re.S)
fm_cache = {}
def frontmatter(path):
    if path in fm_cache:
        return fm_cache[path]
    try:
        src = open(os.path.join(test_root, path), encoding='utf-8').read()
    except OSError:
        fm_cache[path] = None
        return None
    m = FM_RE.search(src)
    text = m.group(1) if m else ''
    def listfield(key):
        mm = re.search(r'^' + key + r':\s*\[(.*?)\]', text, re.M | re.S)
        if mm:
            return [x.strip() for x in mm.group(1).split(',') if x.strip()]
        mm = re.search(r'^' + key + r':\s*\n((?:\s+-\s*.*\n?)+)', text, re.M)
        if mm:
            return [l.strip()[1:].strip() for l in mm.group(1).splitlines() if l.strip().startswith('-')]
        return []
    neg = re.search(r'^negative:\s*\n\s+phase:\s*(\S+)\s*\n\s+type:\s*(\S+)', text, re.M)
    if not neg:
        neg2 = re.search(r'^negative:\s*\n\s+type:\s*(\S+)\s*\n\s+phase:\s*(\S+)', text, re.M)
        negative = (neg2.group(2), neg2.group(1)) if neg2 else None
    else:
        negative = (neg.group(1), neg.group(2))
    hooks = sorted(set(re.findall(r'\$262\.(\w+)', src)))
    rec = dict(features=listfield('features'), flags=listfield('flags'),
               includes=listfield('includes'), negative=negative, hooks=hooks,
               src_len=len(src))
    fm_cache[path] = rec
    return rec

# --- categorization ---------------------------------------------------------
def skip_family(reason):
    r = reason
    if r.startswith('strict:'):
        r = r[7:]
    if r.startswith('oracle-host-missing-global:'):
        return 'oracle lacks a global Ironhorse has (oracle-host-missing-global:*)'
    if r == 'oracle-host-missing-temporal':
        return 'oracle lacks Temporal (oracle-host-missing-temporal)'
    if r == 'oracle-host-missing-intl':
        return 'oracle lacks Intl (oracle-host-missing-intl)'
    if r == 'shared-positive-test-failure':
        return 'both engines threw the same non-Test262Error (shared-positive-test-failure)'
    if r == 'shared-test262-failure':
        return 'both engines failed the same assertion (shared-test262-failure)'
    if r.startswith('unsupported-opcode:'):
        return 'engine NotImplemented label (unsupported-opcode:*)'
    if r == 'ironhorse-aborted-limit':
        return 'Ironhorse stack/meter/step limit (ironhorse-aborted-limit)'
    if r.startswith('structural:multi-agent'):
        return 'multi-agent / $262.agent / Atomics.wait (structural:multi-agent)'
    if r.startswith('structural:can-block'):
        return 'CanBlockIsFalse flag (structural:can-block)'
    if r.startswith('structural:'):
        return 'other structural (' + r + ')'
    if r.startswith('module:') or r.startswith('compiler-unimplemented:module'):
        return 'module loader / linker shape (module:*)'
    if r.startswith('feature:'):
        return 'feature skip list (' + r + ')'
    if r.startswith('async:'):
        return 'async completion not signalled by Ironhorse (async:*)'
    if r.startswith('compiler-unimplemented:'):
        return 'compiler Unsupported construct (compiler-unimplemented:*)'
    if r == 'non-primitive-completion':
        return 'completion-value rendering (non-primitive-completion)'
    if r.startswith('negative-type-unmatched'):
        return 'Ironhorse threw wrong error type on negative test (negative-type-unmatched:*)'
    if r.startswith('refused:'):
        return 'execution-profile refusal (refused:*)'
    if r == 'negative-oracle-unexpected':
        return 'oracle disagrees with test262 negative (negative-oracle-unexpected)'
    if r == 'parse-or-decode':
        return 'empty/undecodable bytecode (parse-or-decode)'
    if r.startswith('oracle-xs-script-decl-eval-framing'):
        return 'oracle eval framing (oracle-xs-script-decl-eval-framing)'
    if r.startswith('oracle-nontermination'):
        return 'timeout: oracle non-termination'
    if r.startswith('oracle-'):
        return 'other oracle failure (' + r + ')'
    if r == 'strict-unimplemented':
        return 'strict omitted by policy'
    return 'other (' + r + ')'

def fail_family(reason):
    r = reason[7:] if reason.startswith('strict:') else reason
    for prefix, fam in [
        ('error-message-differs:', 'same native error ctor, different message (error-message-differs)'),
        ('abort-type divergence', 'different error constructor (abort-type divergence)'),
        ('abort-value-differs', 'different thrown value (abort-value-differs)'),
        ('ironhorse failed a harness assertion', 'Ironhorse failed an assertion XS passed'),
        ('ironhorse threw where the oracle completed', 'Ironhorse threw where XS completed'),
        ('spurious ReferenceError', 'spurious ReferenceError'),
        ('result divergence', 'completion-value divergence (both completed)'),
        ('negative over-acceptance', 'negative over-acceptance'),
        ('over-acceptance', 'positive over-acceptance (Ironhorse completed, XS threw)'),
        ('module over-acceptance', 'module over-acceptance'),
        ('async:', 'async: Ironhorse did not complete where XS did'),
        ('engine-invariant', 'engine invariant'),
        ('engine-fault', 'engine fault'),
        ('compiler-panicked', 'compiler panic'),
        ('ironhorse-hang', 'timeout: Ironhorse hang'),
        ('ironhorse-worker-panic', 'worker panic'),
        ('setup failed', 'harness setup failed'),
        ('unregistered-halt-label', 'unregistered halt label'),
        ('nondeterministic', 'nondeterminism'),
    ]:
        if r.startswith(prefix):
            return fam
    return 'other fail (' + r[:60] + ')'

# report.rs::classify replica (per-mode)
def classify(kind, reason):
    r = reason[7:] if reason.startswith('strict:') else reason
    if kind == 'pass':
        return 'covered'
    if kind == 'fail':
        return 'ironhorse-failure'
    # NOTE: shards do not distinguish pre-skip from run-skip; feature:/structural:
    # are pre-skips, everything else is a run-skip.
    if r.startswith('feature:') or r.startswith('structural:') or r.startswith('ses-mode:'):
        if r.startswith('structural:missing-harness') or r == 'unreadable':
            return 'infrastructure'
        if r.startswith('ses-mode:') or r in ('feature:lockdown', 'feature:Compartment', 'feature:ses-xs-parity'):
            return 'unsupported'
        return 'skipped'
    if r.startswith('refused:'):
        return 'refused'
    if r in ('oracle-host-missing-intl', 'oracle-host-missing-temporal') or r.startswith('oracle-host-missing-global:'):
        return 'skipped'
    for p in ('oracle-machine-error', 'negative-oracle-unexpected', 'oracle-shim-unsafe', 'oracle-gate-off', 'quarantine:'):
        if r.startswith(p):
            return 'infrastructure'
    if (r.startswith('unsupported-opcode:') or r == 'parse-or-decode' or r.startswith('non-primitive-completion')
            or r.startswith('builtin-coercion-computron-gap') or r.startswith('abort-value-differs')
            or r.startswith('error-message-differs:') or r.startswith('ironhorse-aborted')
            or r.startswith('ironhorse-missing-global:') or r.startswith('negative-') or r.startswith('async:')
            or r in ('shared-test262-failure', 'shared-positive-test-failure') or r.startswith('compiler-unimplemented:')):
        return 'unsupported'
    return 'infrastructure'

# test262's own verdict for Ironhorse, inferred from the recorded outcome.
def t262(kind, reason):
    r = reason[7:] if reason.startswith('strict:') else reason
    if kind == 'pass':
        return 'pass'
    if kind == 'fail':
        if r.startswith('result divergence'):
            return 'pass'  # both completed; completion value is not a test262 observable
        if r.startswith('over-acceptance'):
            return 'pass'  # positive test, Ironhorse completed, XS threw
        return 'fail'
    if r in ('oracle-host-missing-temporal', 'oracle-host-missing-intl',
             'non-primitive-completion') or r.startswith('oracle-xs-script-decl-eval-framing'):
        return 'pass'  # Ironhorse completed the positive test
    if r.startswith('oracle-host-missing-global:') or r == 'negative-oracle-unexpected' \
            or r.startswith('oracle-nontermination'):
        return 'unknown'
    if r.startswith('feature:') or r.startswith('structural:') or r.startswith('module:') \
            or r.startswith('compiler-unimplemented:module'):
        return 'not-run'
    return 'fail'

def topdir(path, depth=2):
    parts = path.split('/')
    return '/'.join(parts[:depth]) if len(parts) > depth else '/'.join(parts[:-1])

# --- aggregate --------------------------------------------------------------
cases = collections.OrderedDict()
for path, mode, kind, reason in entries:
    cases.setdefault(path, []).append((mode, kind, reason))

C = collections.Counter
kind_count = C(k for _, _, k, _ in entries)
mode_count = C(m for _, m, _, _ in entries)
skip_fam = C(); skip_reason = C(); fail_fam = C(); fail_reason_head = C()
cat = C(); t262c = C()
by_dir = collections.defaultdict(C)
by_top = collections.defaultdict(C)
skip_examples = {}
for path, mode, kind, reason in entries:
    d = topdir(path)
    by_dir[d][kind] += 1
    by_dir[d]['total'] += 1
    t = path.split('/')[0]
    by_top[t][kind] += 1
    by_top[t]['total'] += 1
    cat[classify(kind, reason)] += 1
    t262c[t262(kind, reason)] += 1
    by_dir[d]['t262:' + t262(kind, reason)] += 1
    by_top[t]['t262:' + t262(kind, reason)] += 1
    if kind == 'skip':
        f = skip_fam_name = skip_family(reason)
        skip_fam[f] += 1
        skip_reason[reason] += 1
        skip_examples.setdefault(reason, path)
    elif kind == 'fail':
        fail_fam[fail_family(reason)] += 1
        fail_reason_head[(reason[7:] if reason.startswith('strict:') else reason).split(':')[0][:70]] += 1

# per-file view (a file passes iff every recorded mode passes)
file_view = C()
for path, modes in cases.items():
    kinds = {k for _, k, _ in modes}
    if kinds == {'pass'}:
        file_view['all modes pass'] += 1
    elif 'fail' in kinds:
        file_view['some mode fails'] += 1
    else:
        file_view['no fail, some skip'] += 1

# frontmatter join: features of skipped cases, $262 hooks
feat_skip = C(); feat_total = C(); feat_pass = C()
hook_count = collections.defaultdict(C)
neg_early_pass = C()
missing_fm = 0
for path, mode, kind, reason in entries:
    fm = frontmatter(path)
    if fm is None:
        missing_fm += 1
        continue
    for f in fm['features']:
        feat_total[f] += 1
        if kind == 'pass':
            feat_pass[f] += 1
        else:
            feat_skip[f] += 1
    for h in fm['hooks']:
        hook_count[h][kind] += 1
        hook_count[h]['total'] += 1
        if kind != 'pass':
            hook_count[h]['nonpass:' + (skip_family(reason) if kind == 'skip' else fail_family(reason))] += 1
    if fm['negative']:
        neg_early_pass[(fm['negative'][0], kind)] += 1

# missing-global names
mg = C()
for path, mode, kind, reason in entries:
    r = reason[7:] if reason.startswith('strict:') else reason
    if kind == 'skip' and r.startswith('oracle-host-missing-global:'):
        mg[r.split(':', 1)[1]] += 1
uo = C()
for path, mode, kind, reason in entries:
    r = reason[7:] if reason.startswith('strict:') else reason
    if kind == 'skip' and r.startswith('unsupported-opcode:'):
        uo[r.split(':', 1)[1]] += 1

def pct(a, b):
    return f'{100.0 * a / b:.1f}%' if b else '-'

N = len(entries)
print(f'shards (excluding manifest): {len(headers)}; manifest batches: {len(manifest)}')
print(f'tips: {sorted({h.get("tip") for h in headers.values()})}')
print(f'unique cases (files): {len(cases)}; case/modes: {N}; modes: {dict(mode_count)}')
print(f'missing frontmatter (file not in corpus): {missing_fm}')
print()
print('== per case/mode outcome ==')
for k in ('pass', 'fail', 'skip'):
    print(f'  {k:6} {kind_count[k]:7}  {pct(kind_count[k], N)}')
print()
print('== per file (all recorded modes) ==')
for k, v in file_view.most_common():
    print(f'  {k:22} {v:7}  {pct(v, len(cases))}')
print()
print('== report.rs::classify categories (per case/mode) ==')
for k, v in cat.most_common():
    print(f'  {k:18} {v:7}  {pct(v, N)}')
print()
print("== test262's own verdict for Ironhorse, inferred from recorded outcome (per case/mode) ==")
for k, v in t262c.most_common():
    print(f'  {k:8} {v:7}  {pct(v, N)}')
print()
print('== skip families ==')
for k, v in skip_fam.most_common():
    print(f'  {v:7}  {pct(v, kind_count["skip"]):>6} of skips  {k}')
print()
print('== fail families ==')
for k, v in fail_fam.most_common():
    print(f'  {v:7}  {pct(v, kind_count["fail"]):>6} of fails  {k}')
print()
print('== top 25 skip reasons (exact) ==')
for k, v in skip_reason.most_common(25):
    print(f'  {v:6}  {k}   e.g. {skip_examples[k]}')
print()
print('== oracle-host-missing-global names ==')
for k, v in mg.most_common(30):
    print(f'  {v:6}  {k}')
print()
print('== unsupported-opcode labels ==')
for k, v in uo.most_common(40):
    print(f'  {v:6}  {k}')
print()
print('== by top-level tree ==')
print(f'  {"tree":10} {"total":>7} {"pass":>7} {"fail":>6} {"skip":>6}  pass%  t262-pass%(min..max)')
for t, c in sorted(by_top.items()):
    lo = c['t262:pass']; hi = lo + c['t262:unknown']
    print(f'  {t:10} {c["total"]:7} {c["pass"]:7} {c["fail"]:6} {c["skip"]:6}  {pct(c["pass"], c["total"]):>6} {pct(lo, c["total"])}..{pct(hi, c["total"])}')
print()
print('== top 25 directories (depth 2) by non-pass count ==')
rows = sorted(by_dir.items(), key=lambda kv: -(kv[1]['fail'] + kv[1]['skip']))
print(f'  {"dir":42} {"total":>6} {"pass":>6} {"fail":>5} {"skip":>6} {"pass%":>6}')
for d, c in rows[:25]:
    print(f'  {d:42} {c["total"]:6} {c["pass"]:6} {c["fail"]:5} {c["skip"]:6} {pct(c["pass"], c["total"]):>6}')
print()
print('== top 25 directories (depth 2) by fail count ==')
rows = sorted(by_dir.items(), key=lambda kv: -kv[1]['fail'])
for d, c in rows[:25]:
    print(f'  {d:42} {c["total"]:6} fail {c["fail"]:5} ({pct(c["fail"], c["total"])})  skip {c["skip"]:6}')
print()
print('== features: most non-pass case/modes (top 30) ==')
for f, v in feat_skip.most_common(30):
    print(f'  {f:40} nonpass {v:6} / {feat_total[f]:6}  pass {pct(feat_pass[f], feat_total[f])}')
print()
print('== $262 hooks referenced in source (case/modes) ==')
for h, c in sorted(hook_count.items(), key=lambda kv: -kv[1]['total']):
    np = {k[8:]: v for k, v in c.items() if k.startswith('nonpass:')}
    print(f'  $262.{h:22} total {c["total"]:5} pass {c["pass"]:5} fail {c["fail"]:5} skip {c["skip"]:5}')
    for k, v in sorted(np.items(), key=lambda kv: -kv[1])[:4]:
        print(f'        {v:5}  {k}')
print()
print('== negative tests by phase x outcome (case/modes) ==')
for (ph, k), v in sorted(neg_early_pass.items()):
    print(f'  {ph:10} {k:5} {v:6}')

if out_json:
    json.dump({'skip_reason': skip_reason, 'by_dir': {k: dict(v) for k, v in by_dir.items()}}, open(out_json, 'w'), indent=1)
```

Output (`stats-output.txt`, verbatim except the two long feature/hook tables trimmed to their first rows):

```
shards (excluding manifest): 1930; manifest batches: 1930
tips: ['be13516fb6441b950ba8a3df97eb34062c186972']
unique cases (files): 51976; case/modes: 99569; modes: {'sloppy': 51342, 'strict': 48227}
missing frontmatter (file not in corpus): 0

== per case/mode outcome ==
  pass     77067  77.4%
  fail      2056  2.1%
  skip     20446  20.5%

== per file (all recorded modes) ==
  all modes pass           39860  76.7%
  no fail, some skip       11052  21.3%
  some mode fails           1064  2.0%

== report.rs::classify categories (per case/mode) ==
  covered              77067  77.4%
  skipped              14864  14.9%
  unsupported           5391  5.4%
  ironhorse-failure     2056  2.1%
  infrastructure         181  0.2%
  refused                 10  0.0%

== test262's own verdict for Ironhorse, inferred from recorded outcome (per case/mode) ==
  pass       82745  83.1%
  unknown     9566  9.6%
  fail        6709  6.7%
  not-run      549  0.6%

== skip families ==
     9554   46.7% of skips  oracle lacks a global Ironhorse has (oracle-host-missing-global:*)
     3770   18.4% of skips  oracle lacks Temporal (oracle-host-missing-temporal)
     2641   12.9% of skips  both engines threw the same non-Test262Error (shared-positive-test-failure)
     1213    5.9% of skips  engine NotImplemented label (unsupported-opcode:*)
     1176    5.8% of skips  oracle lacks Intl (oracle-host-missing-intl)
      904    4.4% of skips  Ironhorse stack/meter/step limit (ironhorse-aborted-limit)
      460    2.2% of skips  both engines failed the same assertion (shared-test262-failure)
      228    1.1% of skips  multi-agent / $262.agent / Atomics.wait (structural:multi-agent)
      185    0.9% of skips  module loader / linker shape (module:*)
      112    0.5% of skips  async completion not signalled by Ironhorse (async:*)
       64    0.3% of skips  feature skip list (feature:ShadowRealm)
       35    0.2% of skips  feature skip list (feature:IsHTMLDDA)
       35    0.2% of skips  feature skip list (feature:tail-call-optimization)
       18    0.1% of skips  completion-value rendering (non-primitive-completion)
       13    0.1% of skips  Ironhorse threw wrong error type on negative test (negative-type-unmatched:*)
       10    0.0% of skips  execution-profile refusal (refused:*)
        9    0.0% of skips  oracle disagrees with test262 negative (negative-oracle-unexpected)
        6    0.0% of skips  empty/undecodable bytecode (parse-or-decode)
        5    0.0% of skips  oracle eval framing (oracle-xs-script-decl-eval-framing)
        3    0.0% of skips  compiler Unsupported construct (compiler-unimplemented:*)
        3    0.0% of skips  timeout: oracle non-termination
        2    0.0% of skips  CanBlockIsFalse flag (structural:can-block)

== fail families ==
      705   34.3% of fails  positive over-acceptance (Ironhorse completed, XS threw)
      655   31.9% of fails  different thrown value (abort-value-differs)
      268   13.0% of fails  async: Ironhorse did not complete where XS did
      258   12.5% of fails  Ironhorse threw where XS completed
      136    6.6% of fails  Ironhorse failed an assertion XS passed
       20    1.0% of fails  same native error ctor, different message (error-message-differs)
       10    0.5% of fails  different error constructor (abort-type divergence)
        4    0.2% of fails  completion-value divergence (both completed)

== top 25 skip reasons (exact) ==
    8476  oracle-host-missing-global:Temporal   e.g. built-ins/Temporal/Duration/compare/argument-duration-precision-exact-numerical-values.js
    3770  oracle-host-missing-temporal   e.g. built-ins/Temporal/Duration/compare/argument-cast.js
    2641  shared-positive-test-failure   e.g. annexB/built-ins/Function/createdynfn-html-close-comment-body.js
    1176  oracle-host-missing-intl   e.g. intl402/BigInt/prototype/toLocaleString/taint-Intl-NumberFormat.js
    1078  oracle-host-missing-global:Intl   e.g. intl402/BigInt/prototype/toLocaleString/returns-same-results-as-NumberFormat.js
     904  ironhorse-aborted-limit   e.g. built-ins/RegExp/CharacterClassEscapes/character-class-non-digit-class-escape-positive-cases.js
     798  unsupported-opcode:module:dynamic-import   e.g. language/expressions/dynamic-import/assignment-expression/additive-expr.js
     460  shared-test262-failure   e.g. annexB/built-ins/RegExp/legacy-accessors/index/this-subclass-constructor.js
     228  structural:multi-agent   e.g. built-ins/Atomics/notify/bigint/bad-range.js
     207  unsupported-opcode:module:top-level-await   e.g. language/expressions/class/cpn-class-expr-accessors-computed-property-name-from-await-expression.js
     133  unsupported-opcode:module:static-linking   e.g. built-ins/Proxy/preventExtensions/trap-is-undefined-target-is-proxy.js
      98  module:compiler-rejected   e.g. language/expressions/dynamic-import/import-defer/import-defer-async-module/main.js
      92  async:reported-failure   e.g. built-ins/Promise/allKeyed/arg-is-function.js
      64  feature:ShadowRealm   e.g. built-ins/ShadowRealm/WrappedFunction/length-throws-typeerror.js
      35  feature:IsHTMLDDA   e.g. annexB/built-ins/Array/from/iterator-method-emulates-undefined.js
      35  feature:tail-call-optimization   e.g. built-ins/Proxy/revocable/tco-fn-realm.js
      34  module:resolution-linking   e.g. language/import/import-attributes/json-invalid.js
      32  module:compiler-byte-divergence   e.g. language/module-code/namespace/internals/define-own-property.js
      30  unsupported-opcode:Temporal.ZonedDateTime.toLocaleString:needs-intl   e.g. built-ins/Temporal/ZonedDateTime/prototype/toLocaleString/return-string.js
      22  unsupported-opcode:Intl.NumberFormat:formatRange   e.g. intl402/NumberFormat/prototype/formatRange/argument-to-Intlmathematicalvalue-throws.js
      21  compiler-unimplemented:module   e.g. language/import/import-attributes/json-extensibility-array.js
      20  async:unhandled-rejection   e.g. built-ins/AsyncDisposableStack/prototype/disposeAsync/rejects-with-error-as-is-if-only-one-error-during-disposal.js
      18  non-primitive-completion   e.g. built-ins/Date/is-a-constructor.js
      18  unsupported-opcode:Intl.NumberFormat:compact-locale   e.g. intl402/NumberFormat/prototype/format/notation-compact-de-DE.js
      10  negative-type-unmatched:Test262Error   e.g. annexB/language/comments/multi-line-html-close.js

== by top-level tree ==
  tree         total    pass   fail   skip  pass%  t262-pass%(min..max)
  annexB        1342     335     19    988   25.0% 26.1%..26.1%
  built-ins    47023   34261   1387  11375   72.9% 81.5%..91.7%
  intl402       6714      50    382   6282    0.7% 23.4%..94.8%
  language     44490   42421    268   1801   95.3% 95.5%..95.5%

== top 25 directories (depth 2) by non-pass count ==
  dir                                         total   pass  fail   skip  pass%
  built-ins/Temporal                           9206      0   890   8316   0.0%
  intl402/Temporal                             4058      0   144   3914   0.0%
  built-ins/RegExp                             3756   2450   176   1130  65.2%
  language/expressions                        21286  19999   135   1152  94.0%
  annexB/language                               869    157    11    701  18.1%
  intl402/NumberFormat                          498      0    24    474   0.0%
  intl402/DateTimeFormat                        488      0    32    456   0.0%
  built-ins/Iterator                           1308    876    12    420  67.0%
  language/module-code                          602    203     0    399  33.7%
  intl402/Locale                                336      0    32    304   0.0%
  annexB/built-ins                              473    178     8    287  37.6%
  built-ins/TypedArray                         2876   2584    80    212  89.8%
  built-ins/Atomics                             548    292     0    256  53.3%
  intl402/DurationFormat                        220      0    16    204   0.0%
  built-ins/Promise                            1452   1254    16    182  86.4%
  language/statements                         18012  17814   106     92  98.9%
  built-ins/Array                              6117   5939     4    174  97.1%
  built-ins/Function                            893    715    10    168  80.1%
  intl402/ListFormat                            162      0    12    150   0.0%
  intl402/RelativeTimeFormat                    160      0     6    154   0.0%
  intl402/Segmenter                             158      0    22    136   0.0%
  intl402/Intl                                  132      0    16    116   0.0%
  intl402/Collator                              130      0     4    126   0.0%
  language/import                               135     16     0    119  11.9%
  intl402/DisplayNames                          114      0    44     70   0.0%

== top 25 directories (depth 2) by fail count ==
  built-ins/Temporal                           9206 fail   890 (9.7%)  skip   8316
  built-ins/RegExp                             3756 fail   176 (4.7%)  skip   1130
  intl402/Temporal                             4058 fail   144 (3.5%)  skip   3914
  language/expressions                        21286 fail   135 (0.6%)  skip   1152
  language/statements                         18012 fail   106 (0.6%)  skip     92
  built-ins/TypedArray                         2876 fail    80 (2.8%)  skip    212
  built-ins/AsyncFromSyncIteratorPrototype       76 fail    58 (76.3%)  skip      2
  intl402/DisplayNames                          114 fail    44 (38.6%)  skip     70
  intl402/DateTimeFormat                        488 fail    32 (6.6%)  skip    456
  intl402/Locale                                336 fail    32 (9.5%)  skip    304
  built-ins/Object                             6802 fail    30 (0.4%)  skip     16
  intl402/NumberFormat                          498 fail    24 (4.8%)  skip    474
  intl402/Segmenter                             158 fail    22 (13.9%)  skip    136
  built-ins/AsyncIteratorPrototype               26 fail    18 (69.2%)  skip      0
  language/eval-code                            454 fail    18 (4.0%)  skip      8
  built-ins/Promise                            1452 fail    16 (1.1%)  skip    182
  intl402/DurationFormat                        220 fail    16 (7.3%)  skip    204
  intl402/Intl                                  132 fail    16 (12.1%)  skip    116
  built-ins/AsyncDisposableStack                208 fail    14 (6.7%)  skip      6
  built-ins/Iterator                           1308 fail    12 (0.9%)  skip    420
  intl402/ListFormat                            162 fail    12 (7.4%)  skip    150
  annexB/language                               869 fail    11 (1.3%)  skip    701
  built-ins/DisposableStack                     186 fail    10 (5.4%)  skip      4
  built-ins/Function                            893 fail    10 (1.1%)  skip    168
  built-ins/Math                                654 fail    10 (1.5%)  skip      0

== features: most non-pass case/modes (top 30; first rows) ==
  Temporal                                 nonpass  13422 /  13422  pass 0.0%
  Intl.Era-monthcode                       nonpass   3132 /   3132  pass 0.0%
  dynamic-import                           nonpass   1082 /   1907  pass 43.3%
  Symbol                                   nonpass   1044 /   2851  pass 63.4%
  regexp-unicode-property-escapes          nonpass   1016 /   1362  pass 25.4%
  BigInt                                   nonpass    512 /   2903  pass 82.4%
  arrow-function                           nonpass    442 /   1726  pass 74.4%
  cross-realm                              nonpass    389 /    393  pass 1.0%
  resizable-arraybuffer                    nonpass    387 /    919  pass 57.9%
  ...

== negative tests by phase x outcome (case/modes) ==
  parse      pass    8639
  parse      skip       9
  resolution skip      34
  runtime    pass      45
  runtime    skip      21
```

### t262verdict.py (probe-calibrated rescoring)

```python
#!/usr/bin/env python3
"""Re-score the committed shards under test262's own verdict (probe-calibrated):
oracle-host-missing-global:* -> fail (33/33 sampled fail on Ironhorse alone),
oracle-host-missing-{temporal,intl} -> pass (12/12), fail:"over-acceptance..." -> pass (8/8),
negative-oracle-unexpected -> fail (9/9 checked), oracle-nontermination -> pass (1/1)."""
import os, re, sys, json, collections
d = sys.argv[1]
def v(tok):
    if tok == 'pass': return 'pass'
    if tok.startswith('fail'):
        r = json.loads(tok[5:]) if tok.startswith('fail:') else ''
        r = r[7:] if r.startswith('strict:') else r
        return 'pass' if r.startswith(('over-acceptance', 'result divergence')) else 'fail'
    r = tok[5:]; r = r[7:] if r.startswith('strict:') else r
    if r in ('oracle-host-missing-temporal', 'oracle-host-missing-intl', 'non-primitive-completion') \
       or r.startswith(('oracle-xs-script-decl-eval-framing', 'oracle-nontermination')):
        return 'pass'
    if r.startswith(('feature:', 'structural:', 'module:', 'compiler-unimplemented:module')):
        return 'not-run'
    return 'fail'
# ... tallies per row, per file (all modes pass), per top-level tree
```

Output:

```
per case/mode: {'pass': '82748 (83.1%)', 'fail': '16272 (16.3%)', 'not-run': '549 (0.6%)'}
per file (all modes pass): {'pass': '42723 (82.2%)', 'fail': '8704 (16.7%)', 'not-run': '549 (1.1%)'}
  annexB     pass    350/  1342 = 26.1%   fail 957  not-run 35
  built-ins  pass  38347/ 47023 = 81.5%   fail 8381  not-run 295
  intl402    pass   1570/  6714 = 23.4%   fail 5144  not-run 0
  language   pass  42481/ 44490 = 95.5%   fail 1790  not-run 219
```

`filecat.py` (per-file fold the way `run_case` folds, then `classify`): `covered 39860 (76.7%), skipped 7614 (14.6%), unsupported 3256 (6.3%), ironhorse-failure 1064 (2.0%), infrastructure 177, refused 5`.

### t262host.py (test262's own verdict on Ironhorse alone)

```python
#!/usr/bin/env python3
"""Run sampled test262 cases through ironhorse-xst as a plain test262 host
(test262's own verdict, no oracle), the way test262-harness assembles them:
["use strict";] sta.js assert.js [doneprintHandle.js if async] includes body.

usage: python3 -I t262host.py <test262 root> <ironhorse-xst> <outdir> <path:mode>...
Prints one line per case: path mode exit verdict first-stderr-line.
"""
import os, re, subprocess, sys

root, host, outdir = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(outdir, exist_ok=True)
FM_RE = re.compile(r'/\*---(.*?)---\*/', re.S)

def listfield(text, key):
    mm = re.search(r'^' + key + r':\s*\[(.*?)\]', text, re.M | re.S)
    if mm:
        return [x.strip() for x in mm.group(1).split(',') if x.strip()]
    mm = re.search(r'^' + key + r':\s*\n((?:\s+-\s*.*\n?)+)', text, re.M)
    if mm:
        return [l.strip()[1:].strip() for l in mm.group(1).splitlines() if l.strip().startswith('-')]
    return []

for i, spec in enumerate(sys.argv[4:]):
    path, mode = spec.rsplit(':', 1)
    src = open(os.path.join(root, 'test', path), encoding='utf-8').read()
    fm = FM_RE.search(src).group(1)
    flags = listfield(fm, 'flags')
    includes = listfield(fm, 'includes')
    neg = re.search(r'^\s+type:\s*(\S+)', fm, re.M) if re.search(r'^negative:', fm, re.M) else None
    parts = []
    if mode == 'strict':
        parts.append('"use strict";\n')
    if 'raw' not in flags:
        names = ['assert.js', 'sta.js']
        if 'async' in flags:
            names.append('doneprintHandle.js')
        for n in names + includes:
            parts.append(open(os.path.join(root, 'harness', n), encoding='utf-8').read() + '\n')
    parts.append(src)
    f = os.path.join(outdir, f'case{i}.js')
    open(f, 'w', encoding='utf-8').write(''.join(parts))
    try:
        p = subprocess.run([host, f], capture_output=True, text=True, timeout=60)
        code, err = p.returncode, (p.stderr.strip().splitlines() or [''])[0][:160]
    except subprocess.TimeoutExpired:
        code, err = 'timeout', ''
    if neg:
        verdict = 'PASS' if code == 1 and err.startswith(neg.group(1)) else 'FAIL'
    elif 'async' in flags:
        verdict = 'ASYNC?'  # needs print(); ironhorse-xst has none
    else:
        verdict = 'PASS' if code == 0 else 'FAIL'
    print(f'{path} {mode} exit={code} {verdict} {err}')
```

Outputs:
- `probe-missing-global.txt`: 33 lines, all `FAIL`. Examples: `built-ins/Temporal/PlainDate/prototype/since/roundingmode-halfFloor.js sloppy exit=1 FAIL Object: rounds to years ... Expected SameValue(«0», «3»)`; `intl402/DurationFormat/prototype/format/negative-duration-style-short-en.js sloppy exit=1 FAIL TypeError: new: not a constructor`.
- `probe-ironhorse-only-complete.txt`: 20 lines, all `PASS`.
- `probe-shared.txt`: 8 lines, all `PASS`.
- `probe-aborted-limit.txt`: 4 lines, all `HeapExhausted`.
- `probe-tco.txt`: 2 lines, `StackOverflow(4057)`.
- `probe-misc.txt`: `static-init-scope-*` `InternalError: line 233: static block with lexical declarations deferred`; `obj-rest-before-comma-invalid.js` `Test262: This statement should not be evaluated.` (accepted); `assign-to-global-undefined.js strict exit=0`; `decl-lex-restricted-global.js` sloppy and strict `exit=0`; `const-invalid-assignment-next-expression-for.js PASS`; Annex B HTML comment files `SyntaxError: line N: missing expression`.

### JS probes

```js
// rga_<n>.js (n in 1000..1000000)
const s = 'a'.repeat(n);
const ok = /^a+$/.test(s);
throw new Error('n=' + s.length + ' ' + ok);
// Ironhorse: n<=40000 -> "Error: n=<n> true"; n>=70000 -> "InternalError: ironhorse halted: HeapExhausted"
// node: n=70000 -> "Error: n=70000 true"

// print.js:     print("hi");                       -> ReferenceError: get print: undefined variable
// t262err.js:   assert.js + sta.js + throw new Test262Error("boom");  -> Object: boom
// obj_throw.js: throw {toString(){return "Weird: x"}};               -> [object Object]
// loop.js:      for (;;) {}                        -> killed by timeout 8 (exit 124)
// weaksym.js:   var s = Symbol("x"); var w = new WeakMap(); w.set(s, 1); ...
//               Ironhorse: TypeError: key: not an object; node: Error: 1,2
```

Mini corpus `mini262/` (harness = pinned `sta.js`, `assert.js`, plus `lexinc.js`); outputs quoted in T262-2 and T262-3.

### Rust probe (deleted after the run)

`rust/engine/ironhorse-vm/tests/zz_audit_test262_harness_1.rs`, run with `CARGO_TARGET_DIR=$SCRATCH/audit-target RUST_MIN_STACK=33554432 cargo test -p ironhorse-vm --test zz_audit_test262_harness_1 -- --nocapture`:

```rust
use ironhorse_vm::Interp;

fn compile(src: &str) -> (Vec<u8>, Vec<ironhorse_vm::SymbolName>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (b, ironhorse_vm::parse_symbols(&s))
}

fn two_scripts(first: &str, second: &str) -> String {
    let (b1, n1) = compile(first);
    let (b2, n2) = compile(second);
    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    let o1 = m.run(&b1);
    assert!(o1.completed, "first script: {:?}", o1.halt);
    let b2r = m.relink_crank(&b2, &n2).expect("relink");
    let o2 = m.run(&b2r);
    if o2.completed { o2.result } else { format!("halt {:?}", o2.halt) }
}

#[test]
fn zz_audit_global_lexical_visibility_across_scripts() {
    for (first, second) in [
        ("var V = 44;", "typeof V"),
        ("const C = 42;", "typeof C"),
        ("let L = 43;", "typeof L"),
        ("class K {}", "typeof K"),
        ("function F() {}", "typeof F"),
        ("let R = 1;", "let R = 2; 'redeclared'"),
    ] {
        eprintln!("PROBE {first:?} then {second:?} => {}", two_scripts(first, second));
    }
}
```

Output quoted in T262-2 (`test result: ok. 1 passed`).
