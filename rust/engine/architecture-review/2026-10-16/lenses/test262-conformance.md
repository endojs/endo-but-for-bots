# Lens: test262 conformance

Reviewed commit `61cd656cb`.
Corpus `tc39/test262@be13516fb6441b950ba8a3df97eb34062c186972` (2026-08-07), the pin in
`rust/engine/ironhorse-262/TEST262_REVISION`.
Oracle: Moddable XS at the `c/moddable` gitlink `23b4d6b0a65f`.

This lens asks two questions and keeps them apart.
How much of test262 does IronHorse pass, judged by test262's own assertions?
And how much of it does IronHorse's harness report as passing, and is that report honest?
The harness answers a third question: does IronHorse agree with XS?
That is a useful regression gate.
It is not a conformance measure, and the published categories blur the two.

## Method

Two complete whole-tree sweeps were run with the repository's own orchestrator,
`rust/engine/ironhorse-262/scripts/full-run.sh`, on a 4-vCPU host with `--jobs 3`
and the default 60-second per-mode case bound.

| Sweep | Command | Started | Finished | Completion |
|---|---|---|---|---|
| Differential | `full-run.sh --jobs 3 --expectations-dir rust/engine/ironhorse-262/expectations/whole-tree` | 2026-10-16T14:10:44Z | 15:02:55Z | complete, no quarantines |
| Oracle gate off | `full-run.sh --jobs 3 --oracle off --test262-dir <vendored corpus> --no-fetch` | 2026-10-16T22:08:15Z | 22:31:04Z | complete, no quarantines |

Both sweeps report `corpus_verified: true` and the run identity
`test262=be13516f…;endo=61cd656cb8d9…;moddable=23b4d6b0a65f…;ses=none;cap=100;case-timeout=60;scope=<all>`.
`ses_mode` is `none` in both: no `lockdown()` or `Compartment` case ran, so the
Hardened JavaScript axis is not measured here.

**The expectation gate passed.**
The differential sweep compared every batch against the committed shards in
`expectations/whole-tree/` and wrote no ratchet file, so the engine at this commit
reproduces the committed baseline exactly, including its 1,064 accepted failures.
That baseline is current; it is not evidence of conformance (below).

**IronHorse's own verdict.**
`endot-ih` always runs both engines, and with the oracle gate off it still files
cases by the agreement shape.
Its reason strings nevertheless record what IronHorse did, so each case's
IronHorse-only verdict is recoverable from the oracle-off report:

| IronHorse verdict | Reasons in the oracle-off report |
|---|---|
| pass | category `covered`; any reason containing `ironhorse-only-complete`; `oracle-nontermination` (IronHorse terminated alone; 3 cases) |
| not run | `pre-skip` outcomes; `structural:*`; `feature:*` |
| unsupported | `unsupported-opcode:*`, `compiler-unimplemented:*`, `ironhorse-aborted-limit`, `refused:*`, `module:resolution-linking`, `module:compiler-rejected` |
| fail | everything else: IronHorse threw, mis-signalled an async test, over-accepted a negative test, or failed alongside XS |

The mapping was validated against an independent plain-host run.
A reviewer ran every `built-ins/Temporal` file through
`rust/engine/target/release/ironhorse-xst` with the standard harness includes and
no oracle.
All 2,023 files the mapping calls `pass` passed there, and all 2,378
`oracle-host-missing-global:Temporal` files it calls `fail` failed there
(201 further oracle-gate-off shapes also failed there, as mapped).
The case-level record merges a case's sloppy and strict modes; a case counts as
passing only if its record does.

The scripts that produced every table below are in the
[probes](#probes) section.

## Results

### Headline

| Measure | Cases | Pass | Pass % |
|---|---:|---:|---:|
| Whole corpus, IronHorse's own verdict | 51,976 | 42,714 | **82.2** |
| Whole corpus, IronHorse's own verdict, counting one-Script passes | 51,976 | 43,090 | 82.9 |
| Standard features only (no stage-3 proposal flag) | 49,418 | 42,299 | 85.6 |
| Core ECMA-262: standard features, excluding `intl402/`, `annexB/` and Temporal | 42,115 | 39,386 | **93.5** |
| Stage-3 proposal features (17 flags from `features.txt`) | 2,558 | 415 | 16.2 |
| Whole corpus, agreement with XS (the harness's "covered") | 51,976 | 39,860 | 76.7 |

Proposal flags, read from the "Proposed language features" section of the
corpus's `features.txt`: `Intl.Era-monthcode`, `Intl.Locale-info`,
`Intl.NumberFormat-v3`, `Iterator.prototype.join`, `ShadowRealm`,
`await-dictionary`, `decorators`, `error-stack-accessor`, `export-defer`,
`immutable-arraybuffer`, `import-bytes`, `import-defer`, `import-text`,
`legacy-regexp`, `nonextensible-applies-to-private`, `source-phase-imports`,
`source-phase-imports-module-source`.
Temporal is not among them at this corpus pin.

The second row counts 376 cases that the verdict scores as failures but that pass on the plain
host when the harness and the body run as one Script
([`one-script-passes.txt`](../probes/coverage-review/writer/one-script-passes.txt), recomputed by
[`headline.py`](../probes/coverage-review/writer/headline.py)).
362 are the T262-2 split-Script artifact, 11 are completion-value coercion artefacts, and 3 are
the async cases of COV-9 (below).
All 376 are core ECMA-262, so counting them also moves the standard-features figure to 42,675
(86.4%) and the core ECMA-262 figure to 39,762 (94.4%).
The other rows of this lens keep the uncorrected verdict.
Full entry: [`../COVERAGE.md`](../COVERAGE.md) § "Unexplained test262 failures".

### IronHorse's own verdict by tree

| Tree | Cases | Pass | Fail | Unsupported | Not run | Pass % |
|---|---:|---:|---:|---:|---:|---:|
| `built-ins` | 23,809 | 19,306 | 3,749 | 459 | 295 | 81.1 |
| `language` | 23,724 | 22,375 | 374 | 941 | 34 | 94.3 |
| `intl402` | 3,357 | 785 | 2,538 | 34 | 0 | 23.4 |
| `annexB` | 1,086 | 248 | 803 | 0 | 35 | 22.8 |
| **total** | **51,976** | **42,714** | **7,464** | **1,434** | **364** | **82.2** |

### IronHorse's own verdict by area (areas with 50 or more cases)

| Area | Cases | Pass | Fail | Unsupported | Not run | Pass % |
|---|---:|---:|---:|---:|---:|---:|
| `language/expressions` | 11,102 | 10,403 | 246 | 437 | 16 | 93.7 |
| `language/statements` | 9,347 | 9,236 | 81 | 12 | 18 | 98.8 |
| `built-ins/Temporal` | 4,603 | 2,023 | 2,579 | 1 | 0 | 43.9 |
| `built-ins/Object` | 3,411 | 3,386 | 25 | 0 | 0 | 99.3 |
| `built-ins/Array` | 3,082 | 2,995 | 87 | 0 | 0 | 97.2 |
| `intl402/Temporal` | 2,029 | 112 | 1,907 | 10 | 0 | 5.5 |
| `built-ins/RegExp` | 1,879 | 1,227 | 200 | 452 | 0 | 65.3 |
| `built-ins/TypedArray` | 1,446 | 1,300 | 146 | 0 | 0 | 89.9 |
| `built-ins/String` | 1,223 | 1,218 | 5 | 0 | 0 | 99.6 |
| `annexB/language` | 845 | 157 | 662 | 0 | 26 | 18.6 |
| `built-ins/TypedArrayConstructors` | 738 | 710 | 28 | 0 | 0 | 96.2 |
| `built-ins/Promise` | 729 | 630 | 99 | 0 | 0 | 86.4 |
| `built-ins/Iterator` | 654 | 438 | 216 | 0 | 0 | 67.0 |
| `language/module-code` | 599 | 202 | 24 | 373 | 0 | 33.7 |
| `built-ins/Date` | 594 | 582 | 12 | 0 | 0 | 98.0 |
| `built-ins/DataView` | 561 | 548 | 13 | 0 | 0 | 97.7 |
| `language/literals` | 534 | 534 | 0 | 0 | 0 | 100.0 |
| `built-ins/Function` | 509 | 424 | 85 | 0 | 0 | 83.3 |
| `built-ins/Atomics` | 389 | 146 | 13 | 0 | 230 | 37.5 |
| `built-ins/Set` | 383 | 378 | 5 | 0 | 0 | 98.7 |
| `language/eval-code` | 347 | 340 | 7 | 0 | 0 | 98.0 |
| `built-ins/Number` | 340 | 339 | 1 | 0 | 0 | 99.7 |
| `built-ins/Math` | 327 | 322 | 5 | 0 | 0 | 98.5 |
| `built-ins/Proxy` | 311 | 269 | 40 | 1 | 1 | 86.5 |
| `language/identifiers` | 268 | 268 | 0 | 0 | 0 | 100.0 |
| `language/arguments-object` | 263 | 263 | 0 | 0 | 0 | 100.0 |
| `intl402/NumberFormat` | 249 | 166 | 63 | 20 | 0 | 66.7 |
| `intl402/DateTimeFormat` | 244 | 122 | 118 | 4 | 0 | 50.0 |
| `annexB/built-ins` | 241 | 91 | 141 | 0 | 9 | 37.8 |
| `built-ins/ArrayBuffer` | 221 | 193 | 28 | 0 | 0 | 87.3 |
| `language/function-code` | 217 | 217 | 0 | 0 | 0 | 100.0 |
| `built-ins/Map` | 204 | 203 | 1 | 0 | 0 | 99.5 |
| `intl402/Locale` | 168 | 65 | 103 | 0 | 0 | 38.7 |
| `built-ins/JSON` | 165 | 163 | 2 | 0 | 0 | 98.8 |
| `built-ins/Reflect` | 153 | 153 | 0 | 0 | 0 | 100.0 |
| `language/block-scope` | 145 | 145 | 0 | 0 | 0 | 100.0 |
| `built-ins/WeakMap` | 141 | 123 | 14 | 4 | 0 | 87.2 |
| `language/import` | 129 | 10 | 0 | 119 | 0 | 7.8 |
| `language/types` | 113 | 111 | 2 | 0 | 0 | 98.2 |
| `intl402/DurationFormat` | 110 | 0 | 110 | 0 | 0 | 0.0 |
| `built-ins/AsyncDisposableStack` | 104 | 94 | 10 | 0 | 0 | 90.4 |
| `built-ins/SharedArrayBuffer` | 104 | 103 | 1 | 0 | 0 | 99.0 |
| `language/asi` | 102 | 102 | 0 | 0 | 0 | 100.0 |
| `built-ins/Symbol` | 98 | 81 | 17 | 0 | 0 | 82.7 |
| `built-ins/NativeErrors` | 94 | 88 | 6 | 0 | 0 | 93.6 |
| `built-ins/DisposableStack` | 93 | 86 | 7 | 0 | 0 | 92.5 |
| `built-ins/Error` | 93 | 78 | 15 | 0 | 0 | 83.9 |
| `built-ins/WeakSet` | 85 | 77 | 7 | 1 | 0 | 90.6 |
| `intl402/ListFormat` | 81 | 72 | 9 | 0 | 0 | 88.9 |
| `intl402/RelativeTimeFormat` | 80 | 0 | 80 | 0 | 0 | 0.0 |
| `language/statementList` | 80 | 80 | 0 | 0 | 0 | 100.0 |
| `intl402/Segmenter` | 79 | 68 | 11 | 0 | 0 | 86.1 |
| `built-ins/BigInt` | 77 | 76 | 1 | 0 | 0 | 98.7 |
| `built-ins/Uint8Array` | 70 | 68 | 2 | 0 | 0 | 97.1 |
| `language/white-space` | 67 | 67 | 0 | 0 | 0 | 100.0 |
| `intl402/Intl` | 66 | 28 | 38 | 0 | 0 | 42.4 |
| `intl402/Collator` | 65 | 44 | 21 | 0 | 0 | 67.7 |
| `built-ins/ShadowRealm` | 64 | 0 | 0 | 0 | 64 | 0.0 |
| `language/directive-prologue` | 62 | 62 | 0 | 0 | 0 | 100.0 |
| `built-ins/GeneratorPrototype` | 61 | 61 | 0 | 0 | 0 | 100.0 |
| `intl402/DisplayNames` | 57 | 4 | 53 | 0 | 0 | 7.0 |
| `built-ins/decodeURIComponent` | 56 | 55 | 1 | 0 | 0 | 98.2 |
| `built-ins/decodeURI` | 55 | 54 | 1 | 0 | 0 | 98.2 |
| `built-ins/parseInt` | 55 | 54 | 1 | 0 | 0 | 98.2 |
| `language/future-reserved-words` | 55 | 55 | 0 | 0 | 0 | 100.0 |
| `built-ins/parseFloat` | 54 | 53 | 1 | 0 | 0 | 98.1 |
| `intl402/PluralRules` | 53 | 48 | 5 | 0 | 0 | 90.6 |
| `language/comments` | 52 | 52 | 0 | 0 | 0 | 100.0 |
| `built-ins/Boolean` | 51 | 50 | 1 | 0 | 0 | 98.0 |

### Where IronHorse does not pass

**Unsupported (1,434 cases): the engine declines.**

| Cases | Reason | Meaning |
|---:|---|---|
| 452 | `ironhorse-aborted-limit` | IronHorse halted on a resource limit; all 452 are in `built-ins/RegExp`: 444 in `property-escapes/generated`, 4 in `unicodeSets/generated`, 3 `CharacterClassEscapes` positive-case files and `quantifier-integer-limit.js`, whose greedy match over a large generated subject halts `HeapExhausted` (see the RegExp findings) |
| 436 | `unsupported-opcode:module:dynamic-import` | `import()` is not supported |
| 211 | `unsupported-opcode:module:top-level-await` | top-level `await` is not supported |
| 134 | `unsupported-opcode:module:static-linking` | modules that import other modules are not supported |
| 98 | `module:compiler-rejected` | module sources the compiler rejects |
| 34 | `module:resolution-linking` | multi-file module fixtures |
| 21 | `compiler-unimplemented:module` | module syntax not ported |
| 15 | `unsupported-opcode:Temporal.ZonedDateTime.toLocaleString:needs-intl` | |
| 11 | `unsupported-opcode:Intl.NumberFormat:formatRange` | |
| 9 | `unsupported-opcode:Intl.NumberFormat:compact-locale` | |
| 5 | `refused:collection-constructor:weak-symbol-oracle-version` | Symbols as WeakMap keys refused |
| 5 | `unsupported-opcode:module:import-meta` | |
| 3 | `compiler-unimplemented:parse` | |

**Not run (364 cases): the harness never executes them.**

| Cases | Reason |
|---:|---|
| 228 | `structural:multi-agent` (`$262.agent` is not provided) |
| 64 | `feature:ShadowRealm` |
| 35 | `feature:IsHTMLDDA` |
| 35 | `feature:tail-call-optimization` |
| 2 | `structural:can-block` |

**Fail (7,464 cases).**

| Cases | Reason in the oracle-off report | What happened |
|---:|---|---|
| 4,238 | `oracle-host-missing-global:Temporal` | both engines threw; XS lacks Temporal, IronHorse threw for its own reasons |
| 1,618 | `shared-positive-test-failure` | both engines failed a positive test: `annexB/language` eval-code, function-code and global-code (563: CMP-12's Annex B function-declaration forms 546, T262-9 17); `language/expressions/dynamic-import` (148, all `import defer` and `import.source` syntax rejections, stage-3 proposals); `built-ins/RegExp/unicodeSets` (108, all the T262-2 split-Script artifact); and `TypedArray`, `Iterator`, `Array` and `Function` prototype methods (344: 235 are the T262-2 artifact, `TypedArray` 94, `Array` 71 and `Function` 70; the 90 `Iterator` rows are absent proposals, `iterator-chunking` 55, `iterator-includes` 25 and `Iterator.prototype.join` 10) |
| 539 | `oracle-host-missing-global:Intl` | both engines threw; XS has no Intl |
| 327 | `oracle-gate-off:abort-value-differs` | both threw, with different values |
| 278 | `shared-test262-failure` | both failed a harness assertion |
| 130 | `oracle-gate-off:oracle-only-complete` | IronHorse threw, XS completed |
| 349 | `async: …` (several reasons) | async test signalled failure; 53 + 48 are `TypeError: call: not a function` from the missing `%AsyncFromSyncIteratorPrototype%` |
| 24 | `engine-invariant:await:no-async-instance` | an engine invariant failure, filed as a test failure: COV-10 (low), a parser flag restore drops the `await` in a module-level class heritage, so the module compiles as sync and the AWAIT opcode halts `EngineInvariant`; fixed, these get the `module:top-level-await` refusal (`rust/engine/ironhorse-compile/src/parser/stmt.rs:1846`, `:2019`; full entry: [`../COVERAGE.md`](../COVERAGE.md)) |
| remainder | assertion failures and over-acceptances | |

**Features with the most non-passing cases.**

| Feature | Not passing | Cases | Pass % |
|---|---:|---:|---:|
| `Temporal` | 4,576 | 6,711 | 31.8 |
| `Intl.Era-monthcode` (proposal) | 1,484 | 1,566 | 5.2 |
| `dynamic-import` | 581 | 1,011 | 42.5 |
| `regexp-unicode-property-escapes` | 508 | 681 | 25.4 |
| `Symbol` | 420 | 1,469 | 71.4 |
| `TypedArray` | 285 | 2,519 | 88.7 |
| `top-level-await` | 267 | 276 | 3.3 |
| `Atomics` | 238 | 384 | 38.0 |
| `BigInt` | 225 | 1,499 | 85.0 |
| `arrow-function` | 206 | 949 | 78.3 |
| `cross-realm` | 200 | 202 | 1.0 |
| `resizable-arraybuffer` | 196 | 462 | 57.6 |
| `async-iteration` | 193 | 4,971 | 96.1 |
| `SharedArrayBuffer` | 183 | 463 | 60.5 |
| `import-defer` (proposal) | 160 | 252 | 36.5 |
| `regexp-v-flag` | 122 | 187 | 34.8 |
| `Reflect` | 120 | 478 | 74.9 |
| `Intl.DurationFormat` | 111 | 111 | 0.0 |
| `Atomics.waitAsync` | 101 | 101 | 0.0 |
| `Intl.RelativeTimeFormat` | 79 | 79 | 0.0 |
| `import-attributes` | 78 | 101 | 22.8 |
| `joint-iteration` | 77 | 82 | 6.1 |
| `Proxy` | 73 | 479 | 84.8 |
| `iterator-chunking` | 69 | 78 | 11.5 |
| `immutable-arraybuffer` (proposal) | 64 | 66 | 3.0 |

`cross-realm` fails because `$262.createRealm` is not provided; those 200 cases
measure the host, not the engine.

## How the harness's categories relate to the verdict

The published report sorts every case into six categories by agreement with XS.
Cross-tabulated against IronHorse's own verdict:

| Differential category | IronHorse pass | IronHorse fail | IronHorse unsupported | IronHorse not run | Total |
|---|---:|---:|---:|---:|---:|
| covered | 39,860 | 0 | 0 | 0 | 39,860 |
| ironhorse-failure | **371** | 693 | 0 | 0 | 1,064 |
| unsupported | 0 | **1,964** | 1,292 | 0 | 3,256 |
| refused | 0 | 0 | 5 | 0 | 5 |
| skipped | **2,473** | **4,777** | 0 | 364 | 7,614 |
| infrastructure | 10 | 30 | 137 | 0 | 177 |
| **total** | **42,714** | **7,464** | **1,434** | **364** | **51,976** |

Read the bold cells against the category names:

- 371 "IronHorse failures" are cases IronHorse passes; XS rejects them.
  They are XS gaps (Temporal and Intl surfaces, newer built-ins) filed as
  IronHorse defects.
- 1,964 "unsupported" cases are plain failures that XS shares.
  "Unsupported" suggests a declined feature; these are wrong answers.
- 7,250 "skipped" cases ran to completion on IronHorse: 2,473 passed and 4,777
  failed.
  Neither number reaches the report or the CI gate.
  This is where most of Temporal lives (6,104 of the 6,632 cases under
  `built-ins/Temporal` and `intl402/Temporal`), and 3,093 of the 3,357
  `intl402` cases.
- 30 "infrastructure" cases ("not an IronHorse gap") are IronHorse failures.

The harness's internal consistency is good: discovery, resume identity and the
expectation gate behave as documented, and the gate passed.
The problem is the ontology of the report, which answers "does IronHorse agree
with XS?" under labels that read as "does IronHorse pass test262?".
The region map's findings T262-1 and T262-5 analyze the classifier sites; this
lens supplies the whole-tree measurement.

## Findings

The harness findings below were found by the test262-harness region reviewer
([`../maps/test262-harness.md`](../maps/test262-harness.md)) and survived two-pass
verification.
The COV entries come from the coverage review ([`../COVERAGE.md`](../COVERAGE.md)), which
re-clustered every non-passing case and re-ran the clusters on the plain host; they passed its own
verification.
Severities are the verified final severities.
Counts quoted as "rows" are case/mode rows from the committed shards; counts quoted as
"cases" or "files" are per file, as in `report.json`.

### Engine defects that test262 exposes and the report hides

#### RGX-1 (same defect: T262-7) — a greedy regexp over more than 65,536 iterations halts the machine (high)

The backtracking matcher retains one state per greedy iteration and stops at
`MAX_MATCH_STATES = 65_536` (`rust/engine/ironhorse-regexp/src/matcher.rs:127`); the VM turns
that into an uncatchable `Halt::HeapExhausted`
(`rust/engine/ironhorse-vm/src/interp/natives/regexp.rs:556-558`).
`/^a+$/.test('a'.repeat(66000))` halts; node and XS return `true`.
All 452 `ironhorse-aborted-limit` cases in the sweep are this defect
(444 `built-ins/RegExp/property-escapes/generated`, 4 `unicodeSets/generated`, 4 others).
The report files them as "unsupported", which reads as a declined feature.
See [`correctness.md`](correctness.md) for the full entry.

#### COV-2 — strict computed-key writes drop a rejected `[[Set]]` silently (high)

For a named key (a non-index string or a symbol) on an ordinary object, and a non-numeric key on a
TypedArray, `property_at_set` discards the boolean result of `[[Set]]`
(`rust/engine/ironhorse-vm/src/interp/property.rs:801`, `:632`), so strict `o[k] = v`, `o[k] += 1`,
`o[k]++` and `[o[k]] = [v]` complete silently on a frozen, non-writable, getter-only or
non-extensible target; the static `o.k = v` and index paths throw.
The 5 test262 cases are strict, XS passes all of them, and the shards accept them as "ironhorse
failed a harness assertion the oracle passed".
This entry and COV-4, COV-12 and COV-13 below are the 45 accepted IronHorse-only failures that XS
passes and that had no finding (5 + 19 + 6 + 15).
Full entry: [`../COVERAGE.md`](../COVERAGE.md).

#### T262-2 — top-level `let`/`const`/`class` are not shared across Scripts (medium)

ECMA-262 GlobalDeclarationInstantiation puts a Script's top-level lexical declarations in
the realm's global declarative Environment Record, visible to later Scripts.
IronHorse keeps them per Script: `environment.global_lexicals` is filled only by the
`Compartment` constructor's `globalLexicals` option
(`rust/engine/ironhorse-vm/src/interp/environment.rs:39-52`), never by Script evaluation.
The harness runs harness includes as a separate setup Script
(`rust/engine/ironhorse-262/src/xst.rs:453-500`), and the XS oracle shim's eval framing hides
the bindings too, so 724 rows fail identically on both engines and are filed as
`shared-positive-test-failure` ("unsupported").
They pass when setup and body are one Script.
For an embedder this is a real engine defect: a top-level `const` in one Script is
invisible to the next, and redeclaring it is not an error.
Fix: implement the global declarative record and its cross-Script early errors; until then,
concatenate setup and body as `test262-harness` hosts do.
The engine defect's full entry, with its probe, is in [`correctness.md`](correctness.md); this
entry records what it does to the measurement.

#### T262-4 (same defect: NOBJ-14) — Atomics refused before validation; pre-skips over-capture (medium)

`Atomics.wait`, `notify` and `waitAsync` halt with `Refused("atomics:wait-notify")` before any
argument validation (`rust/engine/ironhorse-vm/src/interp/natives/buffer.rs:2231-2233`),
although single-agent behavior is fully specified
(`Atomics.notify(new Int32Array(4), 0)` returns 0 in node; IronHorse halts).
The harness pre-skips any case whose source contains `$262.agent`, `Atomics.wait` or
`Atomics.notify` as `structural:multi-agent` (`rust/engine/ironhorse-262/src/xst.rs:1541-1561`):
228 files, of which only 112 use `$262.agent`.
IronHorse cannot block, so its faithful host value is `[[CanBlock]] = false`: the two
`CanBlockIsFalse` files should run and the seven `CanBlockIsTrue` files should be skipped.

#### T262-8 (same defect: FN-18) — the skip list hides missing proper tail calls (medium)

`DEFAULT_ENDOR_SKIP_FEATURES` (`rust/engine/ironhorse-262/src/xst.rs:33-55`) claims to mirror
XS's `gxFeatures`, but adds `tail-call-optimization`, which XS implements.
Strict-mode tail recursion in IronHorse halts with `StackOverflow(4058)` where XS runs in
constant stack; the 35 cases are pre-skipped.

#### COV-4 — object environments skip the HasProperty re-check; globals resolve late (medium)

`dispatch_set_variable` ignores the result of its HasProperty call for a `with` or eval object
environment (`let (_still_exists, frames) = ...`), so SetMutableBinding's strict `ReferenceError`
never fires and the store recreates a deleted property; the comment justifying it cites an
`oracle_loses_with_reference` exclusion that does not exist anywhere in the repository's history.
The read path has no HasProperty step either, and an unresolvable strict global is decided after
the right-hand side has run.
23 cases fail; XS passes 19 of them, which the shards accept (one of the 45).
Where: `rust/engine/ironhorse-vm/src/interp/dispatch/environment.rs:251-264`, `:86`, `:278`,
`:352-353`.
Full entry: [`../COVERAGE.md`](../COVERAGE.md).

#### COV-12 — `%StringIteratorPrototype%` does not exist (low)

`make_string_iterator` allocates its iterator with `%ArrayIteratorPrototype%`, whose one `next`
accepts both brands, so the two iterators share a prototype, each `next` accepts the other kind
without a brand-check `TypeError`, and neither has `@@toStringTag`
(`rust/engine/ironhorse-vm/src/interp/natives/collection.rs:626`;
`rust/engine/ironhorse-vm/src/interp/link.rs:935-937`).
6 cases fail and XS passes all of them (one of the 45).
Full entry: [`../COVERAGE.md`](../COVERAGE.md).

#### COV-13 — the iterator prototypes lack `@@dispose` and `@@asyncDispose` (low)

`explicit-resource-management` is standard at this corpus pin and the stacks and `using` are
implemented, but `%IteratorPrototype%[@@dispose]` and `%AsyncIteratorPrototype%[@@asyncDispose]`
are never installed, so `using it = arr.values()` throws `TypeError`
(`rust/engine/ironhorse-vm/src/interp/boot.rs:1463-1485`;
`rust/engine/ironhorse-vm/src/interp/intrinsic_order.rs:790`, `:912-913`).
15 cases fail and XS passes all of them (one of the 45).
Full entry: [`../COVERAGE.md`](../COVERAGE.md).

#### COV-7 — BigInt literals are rejected as property names (low)

`property_name` and `object_binding` have no `Token::Bigint` arm, so `{1n: 5}`,
`class C { 2n() {} }` and `({1n: x} = ...)` are `SyntaxError`s although LiteralPropertyName admits
BigInt literals; the computed form `[1n]` works
(`rust/engine/ironhorse-compile/src/parser.rs:1728`, `:1773-1803`, `:1828-1845`;
`rust/engine/ironhorse-compile/src/parser/stmt.rs:1108`).
XS has the same gap, so `language/expressions/object/literal-property-name-bigint.js` is a
`shared-positive-test-failure` run-skip that the differential gate cannot see.
Full entry: [`../COVERAGE.md`](../COVERAGE.md).

### Classification defects (the report's ontology)

#### T262-1 — the score conflates the XS differential with test262's verdict (medium)

`endot-ih` decides every positive-case verdict by agreement with XS.
Three shapes are misfiled: both engines threw but XS lacked the global (Temporal, Intl) →
"skipped" although IronHorse failed; IronHorse completed but XS lacked the global →
"skipped" although IronHorse passed; IronHorse completed and XS threw → "IronHorse failure"
(`rust/engine/ironhorse-262/src/xst.rs:716-718`, `:779-790`, `:813-816`;
`rust/engine/ironhorse-262/src/report.rs:182-187`).
The reviewer counted 15,205 misattributed rows in the committed shards.
This lens's whole-tree cross-tabulation measures the same thing per file: 371 "failures"
pass, 1,964 "unsupported" fail, and 7,250 "skipped" ran (2,473 pass, 4,777 fail).
Fix: record two orthogonal fields per case and mode — test262 verdict and differential
status — and never let oracle unavailability decide the verdict column.

#### T262-5 — "infrastructure, not an IronHorse gap" holds IronHorse gaps (medium)

`report.rs:189-229` routes `module:resolution-linking` (no module linker),
`module:compiler-rejected` (IronHorse's compiler rejects the source; 6 of them are ES2022
string export names), `module:compiler-byte-divergence` and `negative-oracle-unexpected`
(IronHorse over-accepts a negative test) into Infrastructure, and the classifier's default
arm sends every unknown reason there too.
The cross-tabulation above finds 30 IronHorse failures and 137 IronHorse refusals among
the 177 infrastructure cases.
Fix: classify by who failed, and replace the prefix cascade with an exhaustive reason enum.

#### T262-10 — the expectation list's mode column is wrong for 1,189 files (low)

Cases with no per-mode outcomes (pre-skips, timeouts, all 830 module cases) get a single
"sloppy" row (`rust/engine/ironhorse-262/src/xst.rs:2382-2399`), so case/mode totals weight
run cases twice and skipped cases once, and module code is recorded as sloppy.

#### T262-6 — a compiler panic on a positive case is a skip (low)

Positive cases turn a coder panic into empty bytecode and then `parse-or-decode`
("unsupported"), while negative cases turn it into a Fail (`rust/engine/ironhorse-262/src/lib.rs:412-421`,
`xst.rs:678`, `xst.rs:1376`).
Downgraded because the `corpus_compiler_totality` gate catches compiler panics on test262
sources before a sweep.
The live leg: three `class/static-init-scope-*` files are `parse-or-decode` because the
compiler refuses lexical declarations in class static blocks (CMP-3).

#### T262-14 — two compile-error classifiers disagree (low)

`compile_failure_name` (`rust/engine/ironhorse-262/src/lib.rs:118-156`) classifies meter and
overflow stops as `InternalError`; `compile_for` (`lib.rs:395-410`) classifies them as
grammar rejections, which would pass parse-negative cases if a bounded meter were ever used.
`compile_diff.rs:143` decides "oracle rejected" from error text while `xst.rs` uses emitted
bytecode.

#### T262-3 — an IronHorse hang in a module case is attributed to the oracle (low)

`ironhorse_terminates_alone` (`rust/engine/ironhorse-262/src/xst.rs:2651-2706`) re-runs module
cases with the Script goal, so module syntax fails to compile "promptly" and a module hang
becomes `oracle-nontermination`.
No current case is affected.

#### COV-9 — the async unhandled-rejection latch turns passes into skips, then failures (low)

`refine_async` returns the `async:unhandled-rejection` run-skip whenever IronHorse's
unhandled-rejection latch is set, before it looks at the `$DONE` signal, and a unit test pins that
order (`rust/engine/ironhorse-262/src/xst.rs:2243-2245`, `:2257-2258`, `:5099-5102`).
test262 does not treat an unhandled rejection as a failure, so a passing case can never be
reported covered; this lens's own `ih_alone.py` `verdict()` then scores the skip as a failure.
10 cases carry the reason, and 3 of them pass on the plain host; they are counted in the
headline's one-Script row.
Fix: take the `$DONE` signal first and record the latch as an advisory field.
Full entry: [`../COVERAGE.md`](../COVERAGE.md).

#### Recommendation — the accepted baseline should be a triage queue

The committed shards accept every "ironhorse failed a harness assertion the oracle passed" row as
baseline, so the expectation gate cannot tell a known gap from an untriaged engine defect.
Of 345 IronHorse-alone failures that XS passes, 45 had no finding until the coverage review
(COV-2, COV-4, COV-12 and COV-13 above).
That class should be a triage queue, not an accepted baseline.
Source: COV-4's fix in [`../COVERAGE.md`](../COVERAGE.md).

#### Latent: two negative-test checks are looser than test262's model (no finding)

The harness map records two gaps that change no verdict at this corpus pin
([`../maps/test262-harness.md`](../maps/test262-harness.md), lines 473 and 481):

- `negative.phase` is a free string: anything other than `parse` or `resolution` is judged as a
  runtime negative (`rust/engine/ironhorse-262/src/xst.rs:1262`), so a legacy `early` phase would
  silently be scored as runtime.
- Early negatives accept any compile rejection regardless of `negative.type`; this is benign while
  every parse negative at the pin expects `SyntaxError`.

### Host fidelity and maintenance

#### T262-9 — `$262` exposes only `detachArrayBuffer` (low)

`install_test262_host` (`rust/engine/ironhorse-vm/src/interp/boot.rs:2518-2541`) provides one
hook; `createRealm`, `evalScript`, `global`, `gc`, `agent`, `IsHTMLDDA` and
`AbstractModuleSource` are absent, and the module oracle installs no `$262`.
This alone accounts for the 1% pass rate of the `cross-realm` feature (200 of 202 cases fail).

#### T262-11 — `ironhorse-xst` is not a faithful eshost "xs" host (low)

It has no `print`, so every async case fails under `test262-harness`; it renders a thrown
`Test262Error` as `Object: boom`, which mis-scores the 14 negatives that expect
`Test262Error` (`rust/engine/ironhorse-262/src/bin/ironhorse_xst.rs:82-104`).
This lens did not use `ironhorse-xst` for async cases for that reason.

#### T262-12 — dead and legacy code, a second classifier, and 4.4 MB of unreferenced data (low)

`test262.rs`'s legacy runner survives only through its tests and carries a classifier with
different semantics from `xst.rs`; `compartment_dual_run` has no caller; `ironhorse-262/baseline/`
(4.4 MB) is read by no code, script or workflow.
The harness map's resource table adds smaller housekeeping costs
([`../maps/test262-harness.md`](../maps/test262-harness.md)): each case's frontmatter is parsed
three or four times (`rust/engine/ironhorse-262/src/xst.rs:1525`, `:2528`, `:2658`, `:2733`), the
committed `expectations/whole-tree/` is 14 MB (about 135 B per row, with full diagnostics), and
each oracle machine allocates an 8 MiB parser buffer
(`rust/engine/xs-oracle/csrc/xs_shim.c:275-289`).

#### T262-13 — resume identity is coarse; quarantine is permanent (low)

The run identity uses the whole-repository HEAD and a digest of every shard, so any commit or
any one-line shard edit reruns all 1,930 batches; a quarantined batch is never retried for
its identity, and the batch timeout that decides quarantines is not part of the identity
(`rust/engine/ironhorse-262/scripts/full-run.sh:230-258`, `:328-350`, `:413-425`).

#### Timed-out case threads leak and keep spinning (no finding)

`rust/engine/ironhorse-262/src/xst.rs:2577-2589` acknowledges in a comment that a timed-out case's
worker thread is leaked and keeps spinning (in XS or the VM) until the batch process exits.
Each hung case costs one core for up to the 900-second batch bound; with `--jobs 4` on a 4-vCPU
runner that is a quarter of capacity, and it cascades into further timeouts in the same batch.
Fix: run oracle cases in a subprocess, or arm the XS meter so the worker can be stopped.
Source: the resource table of [`../maps/test262-harness.md`](../maps/test262-harness.md), restored
by [`../COVERAGE.md`](../COVERAGE.md) § "Lost content and consistency".

#### T262-15 — documentation and code disagree on the sweep's shape (low)

The scripts README says workers have a 180-second bound (the script uses 900 s) and that the
workflow is dispatch-only (it also runs nightly over the full tree); discovery drops the 116
real cases under `test/harness/`; `endot_ih.rs` still says there is no guest `Compartment`.

## Probes

All four scripts read the two `report.json` files that `full-run.sh` writes under
`rust/engine/target/`.

| Script | Input | Output |
|---|---|---|
| [`analyze.py`](../probes/test262-sweep/analyze.py) | a `report.json` | category tables by tree, area, reason and feature |
| [`crosstab.py`](../probes/test262-sweep/crosstab.py) | both reports | oracle-on vs oracle-off category cross-tab and oracle-off reasons |
| [`ih_alone.py`](../probes/test262-sweep/ih_alone.py) | oracle-off report | IronHorse's own verdict tables (below) |
| [`standard_only.py`](../probes/test262-sweep/standard_only.py) | oracle-off report, corpus `features.txt`, `ih_alone.py` | standard vs proposal split and the core ECMA-262 figure |
| [`category_vs_verdict.py`](../probes/test262-sweep/category_vs_verdict.py) | both reports, `ih_alone.py` | the differential-category vs verdict cross-tab (below) |

The saved outputs are alongside them: `analysis.md` and `analysis-oracle-off.md`,
`crosstab.md`, `ih-alone.md`, `standard-only.md` and `category-vs-verdict.md`.

`ih_alone.py`, which defines the verdict mapping:

```python
"""IronHorse's own test262 verdict, derived from the oracle-off endot-ih sweep.

Mapping (validated against a plain-host ironhorse-xst run of built-ins/Temporal:
2,023/2,023 ironhorse-only-complete cases pass there and 2,378/2,378
oracle-host-missing-global cases fail there):
  pass         covered; any reason containing 'ironhorse-only-complete';
               'oracle-nontermination' (ironhorse terminated alone; 3 cases)
  not-run      pre-skip outcomes; structural:* skips; feature:* skips
  unsupported  the engine declined: unsupported-opcode:*, compiler-unimplemented:*,
               ironhorse-aborted-limit, refused:*, module:resolution-linking,
               module:compiler-rejected
  fail         everything else (ironhorse threw / mis-signalled / over-accepted a
               negative / both engines failed)
"""
import json, sys, collections
d = json.load(open(sys.argv[1]))
def verdict(c):
    r = c['reason'] or ''
    if c['category'] == 'covered': return 'pass'
    if 'ironhorse-only-complete' in r or r.startswith('oracle-nontermination'): return 'pass'
    if c['outcome'] == 'pre-skip' or r.startswith('structural:') or r.startswith('feature:'): return 'not-run'
    if (r.startswith('unsupported-opcode') or r.startswith('compiler-unimplemented') or r == 'ironhorse-aborted-limit'
            or r.startswith('refused') or r.startswith('module:resolution-linking') or r.startswith('module:compiler-rejected')):
        return 'unsupported'
    return 'fail'
V = ['pass','fail','unsupported','not-run']
def tab(keyfn, title, min_total=1, limit=None):
    g = collections.defaultdict(collections.Counter)
    for c in d['cases']: g[keyfn(c)][verdict(c)] += 1
    print(f'\n### {title}\n')
    print('| area | cases | pass | fail | unsupported | not run | pass % of all | pass % of run |')
    print('|---|---:|---:|---:|---:|---:|---:|---:|')
    rows = sorted(g.items(), key=lambda kv: -sum(kv[1].values()))
    for k, cnt in (rows[:limit] if limit else rows):
        t = sum(cnt.values())
        if t < min_total: continue
        run = t - cnt['not-run']
        print(f"| {k} | {t} | {cnt['pass']} | {cnt['fail']} | {cnt['unsupported']} | {cnt['not-run']} | {100*cnt['pass']/t:.1f} | {100*cnt['pass']/max(1,run):.1f} |")
tot = collections.Counter(verdict(c) for c in d['cases'])
print('## IronHorse-alone totals'); print(dict(tot), 'of', len(d['cases']))
tab(lambda c: 'all', 'Whole corpus')
tab(lambda c: c['path'].split('/')[0], 'By top-level tree')
tab(lambda c: '/'.join(c['path'].split('/')[:2]), 'By second-level area (25+ cases)', min_total=25)
print('\n### Fail reasons (IronHorse alone), top 30\n')
import re
cnt = collections.Counter(re.sub(r'"[^"]*"', '"…"', c['reason'] or '')[:120] for c in d['cases'] if verdict(c)=='fail')
for k,v in cnt.most_common(30): print(f'| {v} | {k} |')
print('\n### Unsupported reasons, all\n')
cnt = collections.Counter(c['reason'] for c in d['cases'] if verdict(c)=='unsupported')
for k,v in cnt.most_common(): print(f'| {v} | {k} |')
print('\n### Not-run reasons, all\n')
cnt = collections.Counter(c['reason'] for c in d['cases'] if verdict(c)=='not-run')
for k,v in cnt.most_common(): print(f'| {v} | {k} |')
print('\n### Features with the most non-passing cases (top 40)\n')
fc = collections.Counter(); ft = collections.Counter()
for c in d['cases']:
    for f in c['features']:
        ft[f] += 1
        if verdict(c) != 'pass': fc[f] += 1
print('| feature | not passing | cases | pass % |'); print('|---|---:|---:|---:|')
for k,v in fc.most_common(40): print(f'| {k} | {v} | {ft[k]} | {100*(ft[k]-v)/ft[k]:.1f} |')
```

`category_vs_verdict.py`:

```python
import json, sys, collections
ns = {}
exec(compile(open(sys.argv[3]).read().split("V = ['pass'")[0].replace("d = json.load(open(sys.argv[1]))", ""), 'ih', 'exec'), ns)
verdict = ns['verdict']
on = {c['path']: c for c in json.load(open(sys.argv[1]))['cases']}
off = {c['path']: c for c in json.load(open(sys.argv[2]))['cases']}
x = collections.Counter((on[p]['category'], verdict(off[p])) for p in on)
V = ['pass', 'fail', 'unsupported', 'not-run']
print('| differential category (oracle on) | ' + ' | '.join(f'IronHorse {v}' for v in V) + ' | total |')
print('|---|' + '---:|' * (len(V) + 1))
for cat in ['covered', 'ironhorse-failure', 'unsupported', 'refused', 'skipped', 'infrastructure']:
    row = [x[(cat, v)] for v in V]
    print(f'| {cat} | ' + ' | '.join(map(str, row)) + f' | {sum(row)} |')
row = [sum(x[(c, v)] for c in {k[0] for k in x}) for v in V]
print('| total | ' + ' | '.join(map(str, row)) + f' | {sum(row)} |')
```

To reproduce from scratch at the reviewed commit (about 52 minutes and 23 minutes on 4 vCPUs):

```sh
git submodule update --init c/moddable
bash rust/engine/ironhorse-262/scripts/full-run.sh --jobs 3 \
  --expectations-dir rust/engine/ironhorse-262/expectations/whole-tree
bash rust/engine/ironhorse-262/scripts/full-run.sh --jobs 3 --oracle off --no-fetch \
  --test262-dir rust/engine/target/test262-report/test262-src \
  --output rust/engine/target/test262-report-oracle-off
python3 ih_alone.py rust/engine/target/test262-report-oracle-off/report.json
```

### Beyond test262: the fuzz lane

test262 is not the only instrument; the fuzz lane carries three findings that bear on what the
engine's verification can see.
They come from the integration region
([`../maps/integration-fuzz-oracle.md`](../maps/integration-fuzz-oracle.md)).

#### INT-6 — no fuzz target compares the shipped compile-then-run pipeline with anything (medium)

What ships is `ironhorse-compile` feeding the VM, but every behavioural fuzz differential runs
the bytecode XS emitted (`rust/engine/ironhorse-fuzz/src/lib.rs:1898-2000`;
`rust/engine/ironhorse-262/src/lib.rs:524-575` for cranks).
`guest_no_abort` is the only target that runs IronHorse's own compiler output, and it asserts
only that nothing panics.
Where the compiler deliberately differs from XS, the shipped behaviour is fuzzed against
nothing: with a setter on `Array.prototype[0]`, `[...[7]]` gives `true 1 hits=0` on shipped
IronHorse and node but `false 0 hits=1` on XS and on the VM fed XS bytes, and the fuzz lane sees
only the second.
The test262 sweeps do run the shipped pipeline, so this gap is the fuzz lane's alone.
Fix: add a shipped-pipeline result differential for every surface, with an explicit allowlist of
intended divergences.

#### INT-7 — the compiler fuzz targets never see calls or exceptions (low)

`gen_compile_program` (`rust/engine/ironhorse-fuzz/src/lib.rs:2243-2251`) passes the original
slice rather than the advanced cursor to three sub-generators, which re-read the arm selector:
expression depth collapses to 1 or 5, the closure arm is always chosen in stage 2b, and
`differential_compile` never byte-compares `try`/`catch`/`finally`/`throw` or call shapes with XS.
The verifier found that the bug also limits arm 1: `gen_statement_program`'s `seed0` takes only 5
of its 20 values.
Fix: pass the advanced cursor and assert shape coverage.

#### INT-8 — the compile differential decides "XS rejected" from error text (low)

`compile_differential_check` (`rust/engine/ironhorse-fuzz/src/lib.rs:2302-2307`) treats any XS
run whose error mentions `SyntaxError` as a parse rejection, so `JSON.parse('{')` would be
misfiled, and the documented `IronhorseRejected` finding is ignored by the target.
This is the fuzz-lane twin of T262-14.
Fix: take XS's decision from a compile-only entry.

## Leads that did not survive

- T262-3 and T262-6 were downgraded from high and medium to low: no current case is
  misattributed by the module-hang path, and the compiler-totality CI gate catches compiler
  panics on test262 sources before a sweep could misfile them.
- The harness map's claim that `CanBlockIsFalse` is "read inverted" relative to XS did not
  survive: XS's own `xst262.c` skips it too.
  The defect is that IronHorse, which cannot block, inherited XS's choice (T262-4).
- No drift between the committed whole-tree shards and the engine at this commit: the
  expectation gate passed with no ratchet file and no quarantine.
- The `-Wclobbered` warnings the XS oracle build emits are false positives
  (INT-11 in [`../maps/integration-fuzz-oracle.md`](../maps/integration-fuzz-oracle.md)); they do
  not undermine the differential.

## What this lens did not cover

- The Hardened JavaScript axis: both sweeps ran with `ses_mode` `none`, so no `lockdown()`,
  `harden()` or `Compartment` case ran, and the README's Stage 4 bar is not measured here.
- Per-mode results: the report merges a case's sloppy and strict runs into one record.
  A case counts as passing only if its merged record does.
- An independent plain-host run of the whole corpus: the oracle-independent verdict is
  derived from `endot-ih`'s own runs of IronHorse, validated on `built-ins/Temporal` only.
  Async cases were not re-run through `ironhorse-xst`, which lacks `print` (T262-11).
- Multi-file module cases beyond what `endot-ih` runs, and anything under `staging/`, which
  discovery excludes by design.
- Computron agreement with XS: 38,612 cases carry `computron_gap`, which the harness treats
  as advisory telemetry and this review does too.
