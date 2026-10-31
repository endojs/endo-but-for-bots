# Lens: skipped features and aborted conditions

Reviewed commit `61cd656cb`.

The question: where does IronHorse refuse, stub, approximate or silently skip something that
ECMA-262, ECMA-402, Temporal or XS supports, and should it?
A second question follows from the first: when the engine stops at a limit, does the guest see a
catchable error, or does the whole crank end?

## Method

- **Inputs.** The "Skipped features and refusals" inventories of all 13 region maps
  (`../maps/<region>.md`), both verification passes for each map, the merged severity ledger,
  the orchestrator's cross-map merges, and the draft test262 lens (`test262-conformance.md`).
  Where a map and its verification disagree, the verification wins.
  Severities are the ledger's; a merged defect carries its primary ID and the merge table's
  severity.
- **test262 counts** are cases, not case/mode rows, taken from the oracle-off whole-tree sweep
  at this commit and judged by IronHorse's own verdict (pass, fail, unsupported, not run) as
  defined in the draft test262 lens.
  A count quoted from a verifier that tallied expectation-shard rows is labelled "rows".
  Plain-host counts (a standalone `ironhorse-xst` run with no oracle) are labelled "plain host".
- **Added for this lens:**
  - per-feature, per-path and per-`$262`-hook tallies over the oracle-off `report.json`
    (`../probes/skipped-features/feat.py`, `paths.py`, `hooks.py`, `freason.py`; outputs
    `feat.out`, `paths.out`, `hooks.out`, `compiler_rejected.out`);
  - a grep of `rust/engine/ironhorse-vm/src` and a read of
    `rust/engine/ironhorse-vm/src/interp/intrinsic_order.rs` to confirm which recent built-ins
    are absent;
  - a read of the halt-label registry `rust/engine/ironhorse-vm/src/halt_labels.rs` to count
    NotImplemented and Refused labels;
  - one re-run: every non-async `built-ins/Function/prototype/toString` test assembled as a
    single Script on `ironhorse-xst` (`../probes/skipped-features/tostring_single_script.sh`,
    output `tostring_single_script.out`).
- **Spec status.** "Standard" means listed under "Standard language features" in the pinned
  corpus's `features.txt`; at this pin that list includes recent stage 4 additions such as
  Temporal, `joint-iteration`, `iterator-chunking`, `iterator-includes`, `Atomics.pause` and
  `upsert`.
  "Stage 3 proposal" means listed under "Proposed language features".
- **How refused.** Halt::NotImplemented, Halt::Refused, StepLimit, ReentryLimit, StackOverflow
  and HeapExhausted are halts: the crank ends and no `try`/`catch` observes them.
  "Catchable error" is an ordinary exception.
  "Silent wrong answer" means the engine completes with a result the spec does not allow.
  "Absent" means the property does not exist, so calls throw `TypeError`.
  "Harness pre-skip" means the test262 harness never runs the case.
- **Effort.** S: a contained change in one region, roughly under 500 lines.
  M: a subsystem change or a new data table, roughly 500 to 2,000 lines.
  L: a new subsystem, a data import, or cross-crate work.

## Inventory

One row per feature or condition, deduplicated across the 13 maps and the verified findings.
Paths are repo-relative at `61cd656cb`.
"Support?" gives the recommendation and its one-line reason.

### Language and modules

| Feature or condition | How refused | Where | Spec status | test262 cases | Support? | Effort |
|---|---|---|---|---|---|---|
| Static `import` and `export … from` (BOOT-7) | Halt::NotImplemented `module:static-linking` | `rust/engine/ironhorse-vm/src/interp/dispatch.rs:4867` | ES2015 | 134 unsupported, plus 34 `module:resolution-linking` | yes, first: prerequisite for `importNow` | L |
| Dynamic `import()` (BOOT-7) | Halt::NotImplemented `module:dynamic-import` | `rust/engine/ironhorse-vm/src/interp/dispatch.rs:4846`, `:4938`; host side `rust/engine/ironhorse-vm/src/compartment.rs:579-581` | ES2020 | 436 unsupported; feature `dynamic-import` 581 of 1,011 not passing | yes | L |
| Top-level `await` (BOOT-7) | Halt::NotImplemented `module:top-level-await` | `rust/engine/ironhorse-vm/src/interp/dispatch.rs:4878` | ES2022 | 211 unsupported; feature 267 of 276 not passing | yes, with dynamic import | L |
| `import.meta` (BOOT-7) | Halt::NotImplemented `module:import-meta` | `rust/engine/ironhorse-vm/src/interp/dispatch.rs:4849`, `:4944` | ES2020 | 5 unsupported | yes | S once modules link |
| Module evaluation errors (BOOT-7) | silent wrong answer: no Errored status, re-evaluation reports success | `rust/engine/ironhorse-vm/src/module.rs:640-643` | ES2015 | none (the model is not wired in) | yes | S |
| `export * as ns from` | static-linking halt; not modelled in `ModuleGraph` | `rust/engine/ironhorse-vm/src/module.rs` (`Resolution`) | ES2020 | 15 of 19 unsupported | yes | S within the model |
| Import attributes and JSON modules | compiler `Unsupported`, filed `compiler-unimplemented:module` | `rust/engine/ironhorse-compile/src/parser/stmt.rs:2206`, `:2485` | ES2025 | 21 + 3 `compiler-unimplemented`; `import-attributes` 78 of 101 and `json-modules` 14 of 14 not passing | yes, later: no production path compiles the Module goal | S syntax, M host |
| String export names (arbitrary module namespace names) | compiler rejects the module fixture (cause not isolated) | module parser in `rust/engine/ironhorse-compile/src/parser/stmt.rs` | ES2022 | 6 `module:compiler-rejected` + 3 static-linking | yes | S |
| `import defer`, `import.source`, import text and bytes | compiler rejects | `rust/engine/ironhorse-compile/src/parser.rs:1457` (`import.source`); module parser | stage 3 proposals | 92 `module:compiler-rejected`; `import-defer` 160 of 252 and `source-phase-imports` 102 of 251 not passing; `import-text` 6, `import-bytes` 5 unsupported | yes, later | S syntax, L semantics |
| Guest `Compartment` `import`, `importNow`, `ModuleSource`; `modules` option (BOOT-8) | absent; option validated then discarded | `rust/engine/ironhorse-vm/src/interp/natives/compartment.rs:84-97` | XS Compartment; SES | none in test262; hardened262 phase 2 is 56 files plus 7 | yes, on top of BOOT-7 | M |
| Lockdown's compartment-global template (per-compartment `Date`, `Math`) (BOOT-8) | skipped step | `rust/engine/ironhorse-vm/src/interp/realm.rs:244-253` | XS `fx_lockdown` | none | yes, XS parity | S-M |
| Class static block with direct declarations (CMP-3) | compiler `Unsupported`; through `eval`, `Function` or `Compartment.evaluate` it becomes Halt::NotImplemented `eval:compiler-unimplemented`; spurious `SyntaxError` for one name in two blocks | `rust/engine/ironhorse-compile/src/coder.rs:3552-3568`; `rust/engine/ironhorse-compile/src/scoper.rs:803-833` | ES2022 | 4 (3 unsupported, 1 fail) | yes: modern libraries and ES2022 TypeScript output | M |
| Proper tail calls (FN-18) | not implemented: `RUN_TAIL` runs as `RUN`, so deep strict tail recursion halts StackOverflow; harness pre-skip | `rust/engine/ironhorse-vm/src/interp/dispatch.rs:2452`; `rust/engine/ironhorse-262/src/xst.rs:54` | ES2015 strict; XS implements it | 35 not run | yes, XS parity | M |
| `%AsyncFromSyncIteratorPrototype%` (CORE-2) | silent wrong answer: values not awaited, user sync iterables throw | `rust/engine/ironhorse-vm/src/interp/dispatch/iteration.rs:73-167` | ES2018 | about 115 fail | yes (correctness lens) | M |
| Global declarative record shared across Scripts (T262-2) | silent: each Script's top-level `let`, `const`, `class` stay private to it | `rust/engine/ironhorse-vm/src/interp/environment.rs:39-52` | ES2015 | 724 rows misfiled as shared failures | yes | M |
| Separate FormalParameters and FunctionBody parses in CreateDynamicFunction (CMP-1) | skipped step: parameters and body are parsed as one program | `rust/engine/ironhorse-vm/src/interp/eval.rs:323-380` | ES2015 | almost none | yes: security (critical; see the cross-references) | M |
| Global object `[[Prototype]]` (CORE-4) | silent wrong answer: null | `rust/engine/ironhorse-vm/src/interp/boot.rs:62-66`; `rust/engine/ironhorse-vm/src/interp/realm.rs:941-943` | host-defined; the spec default, XS and every host use `%Object.prototype%` | 10 fail | yes | S |
| Immutable prototype of `%Object.prototype%` (PROP-6) | skipped step | `rust/engine/ironhorse-vm/src/interp/property.rs:965-999` | ES2016 | 2 fail | yes | S |
| Annex B.3.3 block-function hoisting (CMP-12) | silent wrong answer: `typeof f` is `'undefined'` after the block | scoper in `rust/engine/ironhorse-compile/src/scoper.rs` (no B.3.3 pass) | Annex B (web browsers) | 563 + 76 fail in `annexB/language/{eval-code,function-code,global-code}` | later; decide the Annex B profile | M |
| Annex B.3.1 and B.3.4 labelled functions and `if (x) function f(){}` (CMP-12) | catchable `SyntaxError`, worded "(strict code)" in sloppy code | `rust/engine/ironhorse-compile/src/parser/stmt.rs:421`, `:483` | Annex B | inside the rows above | optional; fix the message now | S |
| Annex B.1.1 HTML-like comments (CMP-12) | catchable `SyntaxError` | `rust/engine/ironhorse-compile/src/lexer.rs:665-730` (no branch) | Annex B | 8 fail | optional | S |
| Annex B call-expression assignment targets: sloppy `f() = 1`, `f() += 1`, `f()++`, `for (f() in o)` (CMP-12) | catchable early `SyntaxError: no reference`, where Annex B's runtime errors for function call assignment targets throw `ReferenceError` only when the assignment is evaluated | `rust/engine/ironhorse-compile/src/parser.rs:774-816` (`check_reference` has no call-expression arm), called at `:932`, `:1125`, `:1143` and `rust/engine/ironhorse-compile/src/parser/stmt.rs:917` | Annex B (web browsers) | 7 fail in `annexB/language/expressions/assignmenttargettype/`, shared with XS | optional; decide with the Annex B profile | S |
| Annex B.1.2 regular-expression pattern grammar: legacy octal and decimal escapes, `\c` fallback, identity escapes, quantified lookaheads | catchable `SyntaxError`: the regexp crate deliberately keeps XS's stricter-than-Annex-B verdicts, locked by in-crate tests (`../maps/regexp.md:112-114`) | pattern parser in `rust/engine/ironhorse-regexp/src/compile.rs` | Annex B (web browsers) | 16 fail, shared with XS: 7 in `annexB/language/literals/regexp`, 9 in `annexB/built-ins/RegExp` | optional; decide with the Annex B profile | S-M |
| Sloppy `08.5` and `09e1` (CMP-7) | catchable `SyntaxError` | `rust/engine/ironhorse-compile/src/lexer.rs:827-850` | ES2015 sloppy | none recorded | yes | S |
| Decorators | catchable `SyntaxError`: `@` is `InvalidAtSign` outside host mode | `rust/engine/ironhorse-compile/src/lexer.rs:639-644` | stage 3 proposal | 22 of 24 fail | later | L |
| `Function.prototype.toString` source text | returns the NativeFunction form for user functions | `rust/engine/ironhorse-vm/src/interp/render.rs:201`, `:223` | permitted (HostHasSourceTextAvailable) | 68 of 80 fail in the sweep, but 79 of 80 pass as one Script: the failures are T262-2's harness artifact | no; document the choice | M to retain source |
| Flat chains over about 2,040 terms; nests over 89 levels (CMP-8) | catchable `SyntaxError: stack overflow` | `rust/engine/ironhorse-compile/src/ast.rs:186`; `rust/engine/ironhorse-compile/src/parser.rs:155-158` | implementation limit | none | raise it for flat chains | M |
| More than 65,534 distinct names per compile unit (CMP-11) | catchable `SyntaxError`, reported at line 0 | `rust/engine/ironhorse-compile/src/coder.rs:296-312`, `:365-371` | implementation limit (XS bytecode format) | none | document it; report the real line | L to lift |
| Lifetime property-key budget of about 64.4k names (PROP-2, BOOT-9) | catchable `RangeError` (soft ceiling); Halt::Refused `property-key:id-space-exhausted` (hard latch); HeapExhausted or Decode on host entry paths | `rust/engine/ironhorse-vm/src/interp/property/keys.rs:53-58`; `rust/engine/ironhorse-vm/src/interp/dispatch.rs:288-290`; `rust/engine/ironhorse-vm/src/interp/realm.rs:1027-1030`; `rust/engine/ironhorse-vm/src/compartment.rs:783-786` | implementation limit | none | reclaim ids (PROP-2); one classification (BOOT-9) | L |
| User-function call with more than about 2,025 arguments (FN-10) | StackOverflow halt | `rust/engine/ironhorse-vm/src/interp/frames.rs:347-350` | none (no spec limit) | none | yes: count arguments once, throw `RangeError` | S |
| Async nesting over 126 levels; `yield*` over 50 to 70 levels (FN-14) | ReentryLimit halt | `rust/engine/ironhorse-vm/src/interp/suspend.rs:901-1121`, `:224-411`; `rust/engine/ironhorse-vm/src/interp.rs:409` | none | none | yes (refactor C5) | M-L |
| Deep plain recursion | StackOverflow halt at about 4,060 frames | `rust/engine/ironhorse-vm/src/interp/frames.rs` (XS 4,096-slot geometry) | implementation limit | none | keep: xsnap-faithful policy | — |

### Built-ins

| Feature or condition | How refused | Where | Spec status | test262 cases | Support? | Effort |
|---|---|---|---|---|---|---|
| `%TypedArray%.prototype.toSorted`, `toReversed`, `with` (NOBJ-12) | absent | `rust/engine/ironhorse-vm/src/interp/boot.rs:742-768` | ES2023 | 38 of 43 fail | yes | S |
| Symbols as weak keys and targets (NOBJ-13) | catchable `TypeError` on methods; Halt::Refused `collection-constructor:weak-symbol-oracle-version` in the constructors | `rust/engine/ironhorse-vm/src/interp/natives/collection.rs:316-330`, `:92-94`, `:121-123`, `:2577-2579`; `rust/engine/ironhorse-vm/src/interp/natives/weak.rs:22-27` | ES2023 | 28 of 28 not passing (5 refused) | yes | M (collector) |
| `Atomics.wait`, `notify`, `waitAsync` (NOBJ-14) | Halt::Refused `atomics:wait-notify` before validation; harness pre-skip | `rust/engine/ironhorse-vm/src/interp/natives/buffer.rs:2231-2234`; `rust/engine/ironhorse-262/src/xst.rs:1541-1561` | ES2017, ES2024 | 230 not run (116 single-agent files caught by a substring, 2 CanBlockIsFalse) | yes, the non-blocking outcomes | S |
| `Atomics.pause` | absent (XS lacks it too) | no occurrence in `rust/engine/ironhorse-vm/src` | standard | 5 fail | yes | S |
| `Iterator.zip`, `Iterator.zipKeyed` | absent (XS lacks them too) | no occurrence in `rust/engine/ironhorse-vm/src` | standard (`joint-iteration`) | 77 of 82 fail | yes | M |
| `Iterator.prototype.chunks`, `windows` | absent (XS lacks them too) | `rust/engine/ironhorse-vm/src/interp/intrinsic_order.rs:775-792` lists neither | standard (`iterator-chunking`) | 69 of 78 fail | yes | S |
| `Iterator.prototype.includes` | absent (XS lacks it too) | same roster | standard (`iterator-includes`) | 40 of 44 fail | yes | S |
| `Iterator.prototype.join` | absent | same roster | stage 3 proposal | 16 of 18 fail | later | S |
| `Promise.allKeyed`, `Promise.allSettledKeyed` | absent (XS lacks them too) | `rust/engine/ironhorse-vm/src/interp/intrinsic_order.rs:522-533` lists neither | stage 3 proposal (`await-dictionary`) | 87 of 89 fail | later | S |
| Immutable `ArrayBuffer` | absent | — | stage 3 proposal | 58 fail, 5 unsupported, of 66 | later | M |
| ShadowRealm | absent; harness pre-skip | `rust/engine/ironhorse-262/src/xst.rs:49` | proposal (stage 2.7) | 64 not run | no, not yet | L |
| `Math.random` | absent, "omitted by design" | `rust/engine/ironhorse-vm/src/interp/intrinsic_order.rs:18-19` | required since ES1 | 5 fail | yes: a host-seeded deterministic generator, or a documented throwing stub | S |
| `Date.now()`, `new Date()`, `Temporal.Now` | silent: constant epoch 0, zone UTC | `rust/engine/ironhorse-vm/src/interp/natives/date.rs:50`; `rust/engine/ironhorse-vm/src/interp/natives/temporal.rs` (about 1880-1914) | host time value required | none recorded | keep for determinism; offer a host clock capability | S |
| Hard 1,000,000-step iterator caps (NOBJ-10) | StepLimit halt; silent truncation in `groupBy` | 12 loops, e.g. `rust/engine/ironhorse-vm/src/interp/natives/collection.rs:550`, `:2784`; `rust/engine/ironhorse-vm/src/interp/iterable.rs:179` | none | none | remove them | S |
| 2^24 "oversized-array-like" caps (NOBJ-11) | Halt::Refused (13 constants); HeapExhausted at exactly 2^24 in `sort` | `rust/engine/ironhorse-vm/src/interp/natives/array.rs:2397-4549` | none | none | iterate present keys; `RangeError` for exotic array-likes | S-M |
| `padStart`, `padEnd`, `String.raw` over 2^24 units (NVAL-9) | Halt::Refused | `rust/engine/ironhorse-vm/src/interp/natives/string.rs:741-746`, `:148-151` | none | none | admit through `reserve_units` | S |
| BigInt `asIntN`, `asUintN`, `**`, `<<` over 64 Ki bits (NVAL-9) | Halt::Refused; `*` has no cap (NVAL-2) | `rust/engine/ironhorse-vm/src/interp/natives/bigint.rs:264-265`, `:338-349`, `:638-640` | none | none | `RangeError`, applied to `*` too | S |
| `RegExp.prototype[@@replace]` result size | Halt::Refused `RegExp.replace:oversized-result`, uncatchable even inside `try`, where node completes (probed with a custom `exec` returning `length: 2^24 + 2`: `../probes/coverage-review/handed-off-leads/l9_replace_cap_catch.js`) | `rust/engine/ironhorse-vm/src/interp/natives/regexp.rs:1666` | none | none | `RangeError` | S |
| JSON nesting deeper than 2,048 (NVAL-13) | ReentryLimit halt | `rust/engine/ironhorse-vm/src/interp/natives/json.rs:1323-1331`, `:828-840` | none | none | no limit, or `RangeError` | S |
| JSON replacer or array-like length over u32 (NVAL-9) | Halt::Refused | `rust/engine/ironhorse-vm/src/interp/natives/json.rs:664-667`, `:1045-1046` | none | none | `RangeError` | S |
| One request larger than the heap ceiling: `'x'.repeat(2**28)`, a huge `ArrayBuffer` (NVAL-9) | HeapExhausted halt | `rust/engine/ironhorse-vm/src/interp/admission.rs:131-133`; `rust/engine/ironhorse-vm/src/interp/natives/buffer.rs:2502` | spec: `RangeError` when a data block cannot be created | none | `RangeError` when the request alone exceeds the ceiling | S |
| Iterator result objects (PROP-8) | silent wrong answer: one reused object with non-writable fields (XS parity) | `rust/engine/ironhorse-vm/src/interp/natives/array.rs:1369-1375`; `rust/engine/ironhorse-vm/src/interp/natives/collection.rs:625`, `:662`, `:2040-2041`, `:2968-2969` | ES2015 | none (XS shares it) | yes | S |
| The merged `%StringIteratorPrototype%` and the missing iterator `@@toStringTag` (COV-12, low) | silent wrong answer: String iterators are allocated with `%ArrayIteratorPrototype%`, whose one `next` accepts both brands, and the merged prototype has no `@@toStringTag`, so both kinds stringify as `[object Iterator]` | `rust/engine/ironhorse-vm/src/interp/natives/collection.rs:626`; `rust/engine/ironhorse-vm/src/interp/natives/dispatch.rs:5473`; `rust/engine/ironhorse-vm/src/interp/link.rs:935-937`; full entry: `../COVERAGE.md` | ES2015 | 6 fail; XS passes all 6 | yes: a separate prototype with a brand-checked `next`, and both tags; the key-order table already reserves the slots | S |
| Map and Set `clear()` during iteration (NOBJ-17) | silent wrong answer: XS purge model | `rust/engine/ironhorse-vm/src/bulk.rs:863-881` | ES2015 | none | yes | S |
| RegExp flag, `disposed`, Temporal and Intl accessors (CORE-3 and family) | silent: answered only on static `o.k` reads, absent from the prototypes | `rust/engine/ironhorse-vm/src/interp/dispatch/property_read.rs:44-299` | ES2015 and later | 86 RegExp + 8 `disposed` fail; Temporal and Intl on a plain host | yes (correctness lens) | M |
| Awaiting in `AsyncDisposableStack.prototype.disposeAsync` (NOBJ-8) | silent wrong answer: disposers not awaited | `rust/engine/ironhorse-vm/src/interp/natives/resource.rs:213-267` | ES2026 | 3 | yes (correctness lens) | M |
| `%IteratorPrototype%[@@dispose]` and `%AsyncIteratorPrototype%[@@asyncDispose]` (COV-13, low) | absent, although the key-order table lists both: `using it = arr.values()` throws `TypeError`, and an async generator object cannot be used with `await using` | `rust/engine/ironhorse-vm/src/interp/intrinsic_order.rs:790`, `:912-913`; `rust/engine/ironhorse-vm/src/interp/boot.rs:1463-1485`; full entry: `../COVERAGE.md` | ES2026 (`explicit-resource-management`) | 15 fail; XS passes all 15 | yes: GetMethod(this, `"return"`) and call it, about 20 lines each | S |
| `using`, `await using` and the stacks' `use` on a primitive; the async forms' fallback to `@@dispose` (COV-19, low) | silent wrong answer (XS parity, no recorded departure): ToObject lets a primitive through whenever its prototype carries a disposer, where the spec throws `TypeError` for any non-Object; the async forms fall back to `@@dispose` whenever `@@asyncDispose` is not callable, where GetMethod throws for a present non-callable value | `rust/engine/ironhorse-vm/src/interp/natives/resource.rs:85-113`; `rust/engine/ironhorse-vm/src/interp/dispatch.rs:4716-4775`; full entry: `../COVERAGE.md` | ES2026 | none: no case covers either shape | yes: `TypeError` for a non-Object, GetMethod semantics, and a record in `rust/engine/ironhorse-262/tests/xs_departures.rs` | S |
| Annex B `String.prototype` HTML methods | absent (XS omits them) | `rust/engine/ironhorse-vm/src/interp/natives/annex_b.rs` | Annex B | 82 of 82 fail | optional | S |
| Annex B legacy RegExp statics (`RegExp.$1`, ...) | absent | — | stage 3 proposal (`legacy-regexp`) | 26 fail | no: Hardened JavaScript removes them | M |
| `RegExp.prototype.compile` (COV-11, low) | silent wrong answer: a no-op stub copied from XS returns `this` unchanged, and accepts a non-RegExp `this`, an invalid pattern and a non-writable `lastIndex` without error | `rust/engine/ironhorse-vm/src/interp/natives/dispatch.rs:5985`; `rust/engine/ironhorse-vm/src/interp/boot.rs:1440`; full entry: `../COVERAGE.md` | Annex B (B.2.4, normative-optional) | 21 fail; XS shares the stub | yes: RegExpInitialize on the existing instance, or remove the method so its absence is honest | S |
| `Error.prototype.stack` setter (COV-14, low) | silent wrong answer against the proposal (XS parity): the setter checks only for an object receiver and an argument, then defines an own data property, so a non-string is accepted and `Error.prototype.stack = 's'` replaces the accessor for every Error in an unfrozen realm | `rust/engine/ironhorse-vm/src/interp/natives/dispatch.rs:7717-7741`; `rust/engine/ironhorse-vm/src/interp/boot.rs:1675-1676`; full entry: `../COVERAGE.md` | stage 3 proposal (`error-stack-accessor`) | 12 fail, shared with XS (2 also need `$262.createRealm`) | yes: the proposal's string and receiver checks with CreateDataProperty semantics, or record the XS-parity accessor as a deliberate divergence | S |
| `ArrayBuffer.prototype.concat` | present, not refused: an XS extension installed as an own property of the standard prototype; `../probes/coverage-review/lost-content/ab_concat.js` finds `concat` on IronHorse and not on node | `rust/engine/ironhorse-vm/src/interp/boot.rs:1124`; `../maps/vm-natives-objects.md:555` | not in ECMA-262 (XS extension) | none | not on a standard prototype: remove it, or document it as an XS extension | S |

### Intl and Temporal

| Feature or condition | How refused | Where | Spec status | test262 cases | Support? | Effort |
|---|---|---|---|---|---|---|
| Named time zones (NVAL-6) | silent wrong answer for 22 zones at fixed standard-time offsets (DST ignored); catchable `RangeError` worded "invalid" for every other zone | `rust/engine/ironhorse-vm/src/interp/temporal.rs:1409-1494`; `rust/engine/ironhorse-vm/src/interp/natives/intl.rs:450-459` | Temporal; ECMA-402 | plain host: `built-ins/Temporal/ZonedDateTime` 495 of 901, `intl402/DateTimeFormat` 122 of 244 pass; sweep: `canonical-tz` 0 of 19 | yes: a frozen tzdb snapshot | M |
| Temporal conformance (NVAL-7) | silent: an older proposal snapshot, lax validation, `until`/`since` ignore their options, unmetered | `rust/engine/ironhorse-vm/src/interp/temporal.rs:158-252`; `rust/engine/ironhorse-vm/src/interp/natives/temporal.rs:432-438` | standard at this corpus pin | `built-ins/Temporal` 2,023 of 4,603 and `intl402/Temporal` 112 of 2,029 pass | yes (`temporal_rs`), or gate Temporal off | L |
| Calendars other than `iso8601` | catchable `RangeError` worded as invalid input; `until`/`since` Halt::NotImplemented `Temporal.Plain:difference-calendar` | `rust/engine/ironhorse-vm/src/interp/natives/temporal.rs:120`, `:195`, `:1766`, `:435` | Temporal with ECMA-402 (`Intl.Era-monthcode` is stage 3) | `Intl.Era-monthcode` 1,484 of 1,566 not passing | later (ICU4X `icu_calendar`) | L |
| `Temporal.ZonedDateTime.prototype.toLocaleString` | Halt::NotImplemented `…toLocaleString:needs-intl` | `rust/engine/ironhorse-vm/src/interp/natives/temporal.rs:1780-1782` | Temporal | 15 unsupported | yes | S |
| `Date.prototype.toTemporalInstant` | absent | — | Temporal | 8 of 8 fail | yes | S |
| `Intl.NumberFormat` `formatRange`, `formatRangeToParts` | Halt::NotImplemented | `rust/engine/ironhorse-vm/src/interp/natives/dispatch.rs:3152-3154` | ECMA-402 | 11 unsupported | yes | M |
| `Intl.NumberFormat` compact notation outside `en` | Halt::NotImplemented | `rust/engine/ironhorse-vm/src/interp/natives/intl.rs:1316-1319` | ECMA-402 | 9 unsupported | yes, with CLDR data | M |
| `Intl.RelativeTimeFormat`, `Intl.DisplayNames`, `Intl.DurationFormat` | absent | boot roster | ECMA-402 | 80 of 80, 53 of 57, 110 of 110 fail | yes for the first two; `DurationFormat` later | M-L |
| Locale data (NVAL-8) | silent wrong answer: advertised locales formatted with English data; plural rules for `en` and `fr` only; `Intl.DateTimeFormat` accepts the `calendar` and `numberingSystem` options and ignores them (`../maps/vm-natives-values.md:729`) | `rust/engine/ironhorse-vm/src/interp/locale.rs:225-248`, `:272-298`, `:466-677`, `:816-901`; `rust/engine/ironhorse-vm/src/intl_number.rs:884-913` | ECMA-402 | plain host: non-Temporal `intl402` 673 of 1,328 pass | yes (ICU4X data), or shrink the advertised set to `en` | L |
| Collation (NVAL-5) | silent: lowercase code-point order, not UCA; `sensitivity: 'base'` keeps accents; `numeric` reads one digit run | `rust/engine/ironhorse-vm/src/interp/locale.rs:903-988` | ECMA-402 (order is implementation-defined; option semantics are not) | plain host: `intl402/Collator` 44 of 65 pass | yes (`icu_collator`) | M |
| `Date.prototype.toLocaleString`, `toLocaleDateString`, `toLocaleTimeString` | silent: the `toString` forms | `rust/engine/ironhorse-vm/src/interp/boot.rs:2766-2768` | ECMA-402 | — | yes: route through `DateTimeFormat` | S |
| Locale case mapping | silent: tailored for `tr` and `az` only, not `lt` | `rust/engine/ironhorse-vm/src/interp/text.rs:114-117` | ECMA-402 | — | yes (`icu_casemap`) | S |
| `Intl.Locale` info getters | absent | — | stage 3 proposal | 57 of 60 fail | later | S-M |
| Intl and Temporal against the XS oracle | not differenced: XS has neither | harness | — | 3,093 of 3,357 `intl402` cases skipped in the differential sweep | needs an oracle-independent gate | M |

### RegExp

| Feature or condition | How refused | Where | Spec status | test262 cases | Support? | Effort |
|---|---|---|---|---|---|---|
| Greedy match retaining more than 65,536 states (RGX-1) | HeapExhausted halt | `rust/engine/ironhorse-regexp/src/matcher.rs:127`; `rust/engine/ironhorse-vm/src/interp/natives/regexp.rs:556-558` | ES2015 and later (no limit) | 451 unsupported: 444 `property-escapes/generated`, 4 `unicodeSets/generated`, 3 `CharacterClassEscapes` | yes | M |
| Quantifier bound above 2^31-1 (RGX-1) | HeapExhausted halt at construction | `rust/engine/ironhorse-regexp/src/compile.rs:2221-2223`; `rust/engine/ironhorse-vm/src/interp/natives/regexp.rs:348-349` | any integer bound is valid | 1 unsupported (`quantifier-integer-limit.js`) | yes: clamp as XS does | S |
| Catastrophic backtracking with no meter armed (RGX-6) | unbounded; `run_bounded`'s step limit ignores matcher steps | `rust/engine/ironhorse-vm/src/interp/natives/regexp.rs:519-563` | inherent to backtracking matchers | none | count matcher steps against the step limit | S |
| Pattern nesting deeper than 512 | catchable `SyntaxError` | `rust/engine/ironhorse-regexp/src/compile.rs:284` | implementation limit | none | keep | — |
| `CompileError::Unsupported` | Halt::NotImplemented, but no live emit site | `rust/engine/ironhorse-vm/src/interp/natives/regexp.rs:364` | — | 0 | nothing to do | — |
| Fuzz differential coverage | no `u` or `v` flags, no named groups, ASCII subjects only | `rust/engine/ironhorse-fuzz/src/regexp.rs:7-9`, `:51` | — | — | yes | S-M |

The 108 `built-ins/RegExp/unicodeSets` shared failures are not an engine gap: they use
`testExtendedCharacterClass`, a top-level `const` in an include, and fail because of T262-2's
Script split.

### Host and harness

| Feature or condition | How refused | Where | Spec status | test262 cases | Support? | Effort |
|---|---|---|---|---|---|---|
| `$262.createRealm` (T262-9) | absent | `rust/engine/ironhorse-vm/src/interp/boot.rs:2518-2541` | test262 host hook | 204 (200 fail, 4 not run); `cross-realm` 2 of 202 pass | yes, as the multi-realm milestone | L |
| `$262.evalScript` (T262-9) | absent | `rust/engine/ironhorse-vm/src/interp/boot.rs:2518-2541` | test262 host hook | 31 (28 fail) | yes, after T262-2's global record | S |
| `$262.agent` | harness pre-skip `structural:multi-agent` | `rust/engine/ironhorse-262/src/xst.rs:1558` | test262 host hook | 112 not run | no: single agent by design | — |
| Single-agent Atomics cases caught by the same substring (T262-4) | harness pre-skip | `rust/engine/ironhorse-262/src/xst.rs:1541-1561` | ES2017, ES2024 | 116 files + 2 CanBlockIsFalse | yes: pre-skip only `$262.agent` users | S |
| `$262.IsHTMLDDA` | harness pre-skip `feature:IsHTMLDDA` | `rust/engine/ironhorse-262/src/xst.rs:55` | Annex B host hook (browsers) | 35 not run | no | — |
| `$262.AbstractModuleSource`; the module oracle has no `$262` (T262-9) | absent | `rust/engine/ironhorse-vm/src/interp/boot.rs:2518-2541`; `rust/engine/xs-oracle/csrc/xs_shim.c:898` | stage 3 (`source-phase-imports`) | 11 (8 fail, 3 unsupported) | later; skip the feature as XS does | S |
| `tail-call-optimization` (T262-8) | harness pre-skip | `rust/engine/ironhorse-262/src/xst.rs:54` | ES2015 | 35 not run | stop skipping it | S |
| Compiler panic or refusal on a positive case (T262-6) | filed as skip `parse-or-decode` | `rust/engine/ironhorse-262/src/lib.rs:412-421`; `rust/engine/ironhorse-262/src/xst.rs:678` | — | 3 cases today | one classifier | S |
| `test/harness/` self-tests | excluded from discovery | `rust/engine/ironhorse-262/src/report.rs:958` | test262 | 116 files | yes | S |
| `ironhorse-xst` as an eshost `xs` host (T262-11) | no `print`; errors rendered as `Object: …` | `rust/engine/ironhorse-262/src/bin/ironhorse_xst.rs:82-104` | — | only the test262-harness lane: about 5,600 async files and 14 negatives | yes | S |
| `ironhorse-xst -m` (module goal), `-c` and `-lc` (SES modes) | refused by the command line | `rust/engine/ironhorse-262/src/bin/ironhorse_xst.rs:39-41`; `rust/engine/ironhorse-262/src/xst.rs:179-180` | — | `ses_mode` is `none` in both sweeps | yes once modules run; SES modes later | S |
| Fuzz roster | no targets for Proxy, generators and async, classes, `eval`/`Function`, WeakRef, modules, Date, lockdown and Compartment, the host API, `PersistentMachine` | `rust/engine/ironhorse-fuzz/src/lib.rs` | — | — | yes, one generator per surface | S each |

### Persistence

| Feature or condition | How refused | Where | Spec status | test262 cases | Support? | Effort |
|---|---|---|---|---|---|---|
| Module graph that is Linking or Evaluating, or holds a non-primitive binding | persist gate refusal | `rust/engine/ironhorse-vm/src/interp/persist.rs:590`; `rust/engine/ironhorse-vm/src/module_snapshot.rs:23-34` | ES2015 modules | — | yes for cells (store `Ready(Value)` as stored slots); mid-crank states are correctly refused | M |
| Live guest `Compartment` | persist gate refusal by presence | `rust/engine/ironhorse-vm/src/interp/persist.rs:640` | XS and SES Compartment | — | yes: the two-column table of `designs/ironhorse-guest-compartment.md` §7 | M |
| Compartment `globalLexicals` | persist gate refusal | `rust/engine/ironhorse-vm/src/interp/persist.rs:669` | XS and SES Compartment | — | yes: add an `EnvironmentRow` column | S |
| Guest compartment on a machine with no shared-realm primordial profile | persist gate refusal | `rust/engine/ironhorse-vm/src/interp/persist.rs:674` | — | — | no: no restore could accept the image | — |
| test262 `$262` host | persist gate refusal by presence | `rust/engine/ironhorse-vm/src/interp/persist.rs:613` | harness only | — | no (policy) | — |
| Reaction that would resume a non-persisted async frame | persist gate refusal | `rust/engine/ironhorse-vm/src/interp/persist.rs:715` | — | — | keep as a guard (unreachable today) | — |
| Stored reference to a non-persisting native (`CopyObject`) | persist gate refusal | `rust/engine/ironhorse-vm/src/interp/persist.rs:759`, `:763` | — | — | no | — |
| Machine not quiescent | `NotQuiescent` | `rust/engine/ironhorse-snapshot/src/machine.rs:253` | — | — | by design | — |
| The error for every refusal above (SNI-10) | one `row` string: "that side table does not travel yet" | `rust/engine/ironhorse-snapshot/src/machine.rs:61-66`, `:77-82` | — | — | typed reasons | S |
| Generators, async functions, `Array.fromAsync`, WeakRef, FinalizationRegistry, Proxy, accessors | carried; `Coverage::Pending` has no member | `rust/engine/ironhorse-snapshot/src/sidetable.rs` | — | — | done | — |
| Page eviction (lazy residency) | implemented, never called: residency only grows | `rust/engine/ironhorse-vm/src/value.rs:1064`, `:2189` | design phase 8 | — | yes, for memory-bounded wakes | S |
| Partial and generational collectors | no production caller; `generational_collect` is not resume-invariant | `rust/engine/ironhorse-snapshot/src/machine.rs:1625-1809`, `:1719-1734` | design phases 6 to 10 | — | wire them or retire them | S to retire, M to wire |
| Migration across a different boot layout or cost table | refused | `rust/engine/ironhorse-snapshot/src/store.rs:1690-1731` | by design (fingerprint gate) | — | design question | L |
| Read-only SQLite open | refused | `rust/endo/ironhorse-store-sqlite/src/lib.rs:296-303` | by design | — | a read-only inspection open would help tooling | S |

### Embedding

| Feature or condition | How refused | Where | Spec status | test262 cases | Support? | Effort |
|---|---|---|---|---|---|---|
| `endor worker -e ironhorse` | `MachineError::Unavailable` | `rust/endo/src/ironhorse_engine.rs:1860-1879` | the XS worker exists | — | yes: the integration's goal | L |
| Host callables and powers | absent | `rust/endo/src/ironhorse_engine.rs:1307-1311`; `rust/endo/src/engine/js_machine.rs:51-53` | xsnap provides them | — | yes | M-L |
| `ExecutionOutcome` | not wired to any delivery path | `rust/endo/src/ironhorse_engine.rs:322-328` | — | — | wire it or delete it | S |
| Direct-eval context in the thixotrope worker (INT-3) | silent: a different program is compiled, so `SyntaxError` | `rust/thixotrope-ironhorse-worker/src/main.rs:17-116`; trait default `rust/engine/ironhorse-vm/src/interp.rs:300-312` | ES2015, ES2022 | none (`ironhorse-xst` uses the runtime compiler) | yes | S |
| Garbage collection in the thixotrope worker (INT-1) | never runs | `rust/thixotrope-ironhorse-worker/src/main.rs:118-180`, `:308-334` | XS collects | — | yes (memory lens) | S |
| Collection within a crank (MEM-1) | none, so the ceilings bound cumulative allocation; HeapExhausted halt | `rust/engine/ironhorse-vm/src/interp/gc.rs:6-14`; `rust/engine/RECLAMATION.md:63` | XS collects under allocation pressure | contributes to the RegExp aborts | yes (memory lens) | L |
| Host `define_global` with a heap `Slot` (BOOT-12) | Halt::NotImplemented `compartment:heap-endowment`, at evaluation time | `rust/engine/ironhorse-vm/src/compartment.rs:463-467`, `:612-627` | host API policy | — | no: reject by type and classify as Refused | S |
| Global attenuation for guest compartments | always `global_names: None` | `rust/engine/ironhorse-vm/src/interp/natives/compartment.rs:113-117` | — | — | optional | S |
| Engine `lockdown` on an unfrozen Machine | not bound | `rust/engine/ironhorse-vm/src/interp/realm.rs:756-758` | deliberate | — | keep | — |

## Findings

Ordered by severity, then by theme.
Within medium: language and the Hardened JavaScript surface, then built-ins, then Intl and
Temporal, then limits that end the crank.

### RGX-1 — Long greedy matches and huge quantifier bounds halt uncatchably (high)

The backtracking matcher retains one state for each position matched by an unbounded greedy
quantifier and refuses the 65,537th retained state (or more than 64 MiB).
The VM turns that refusal into Halt::HeapExhausted, which ends the crank and which no
`try`/`catch` observes, although the heap is not exhausted.
Ordinary successful matches over long subjects therefore stop the machine: `/a*/` on 65,536
characters, `/(?:a|b)*/` on 32,768 (two states per character), `/^(.*)$/` on an 80,000-character
line, `"x".repeat(100000).replace(/x+$/, "")`, a base64 check over 100,000 characters.
Node and the XS oracle complete all of them; XS's `fxPushState`
(`c/moddable/xs/sources/xsre.c:2716-2734`) allocates states without a count cap.
A second path ends the same way: the pattern parser returns `CompileError::ResourceLimit` for a
quantifier bound above 2^31-1, which `build_regexp` maps to HeapExhausted, so
`new RegExp("b{" + Number.MAX_SAFE_INTEGER + "}")` halts at construction.
The spec makes that pattern compile and simply fail to match, and XS clamps the bound
(`c/moddable/xs/sources/xsre.c:1666`).
No design document records the state cap as a decision.

**Where:** `rust/engine/ironhorse-regexp/src/matcher.rs:127` (`MAX_MATCH_STATES = 65_536`),
`:152-174`, push sites `:339`, `:563`, `:647`, `:686`;
`rust/engine/ironhorse-vm/src/interp/natives/regexp.rs:556-558`;
`rust/engine/ironhorse-regexp/src/compile.rs:2221-2223` with
`rust/engine/ironhorse-vm/src/interp/natives/regexp.rs:348-349`.

**Evidence:** `../probes/regexp/p32_catch_ceiling.js`:

```js
let caught="no"; try { /a*/.exec("a".repeat(100000)); } catch(e){ caught="caught "+e.name; } throw new Error(caught);
```

IronHorse: `InternalError: ironhorse halted: HeapExhausted` (exit 1; the `catch` did not run).
Node: `Error: no`.
The threshold is exact: 65,535 characters give `Error: 65535` and 65,536 halt
(`../probes/regexp/p04_thresh_65536.js`).
`../probes/verify/regexp/q2.js` (`new RegExp("b{" + Number.MAX_SAFE_INTEGER + "}", "u")`) halts
at construction; Node compiles it.
`../probes/verify/regexp-pass2/a5.js` extracts a 70,000-character JSON string value with
`/"k":"([^"]*)"/`: IronHorse halts, Node returns 70000.
test262: 452 cases unsupported as `ironhorse-aborted-limit`, all in `built-ins/RegExp`: 444
`property-escapes/generated`, 4 `unicodeSets/generated`, 3
`CharacterClassEscapes/*-positive-cases.js` (state cap) and `quantifier-integer-limit.js`
(bound); feature `regexp-unicode-property-escapes` passes 173 of 681 cases.

**Fix:** Represent a greedy loop over a single-character atom (a literal or a class, with no
captures inside) without a retained state per iteration: scan the maximal run once and back off
by count.
Share one capture snapshot between states instead of cloning one per state.
Clamp quantifier bounds above 2^31-1 as XS does.
Bound whatever ceiling remains by the meter and the heap ceiling, and report it as a catchable
error (for example a `RangeError` "regular expression too complex"), not as HeapExhausted.

**Also:** T262-7 (same defect; its second verifier rated it medium because the halt is loud
rather than wrong, while RGX-1's second verifier kept high because realistic inputs reach it).
MEM-1 contributes: the harness's `buildString` loop consumes most of the chunk ceiling before
the match starts.

### NVAL-6 — Time zones are fixed standard-time offsets, and DST is ignored (high)

`resolve_time_zone` maps UTC aliases, numeric offsets, `Etc/GMT±N` and a hand table of 23 names
(22 zones plus the `Asia/Calcutta` alias) to one constant offset each, at standard time.
Temporal and `Intl.DateTimeFormat` both use it.
Every summer instant in a DST zone (New York, London, Paris, Sydney, ...) is rendered an hour
off with the wrong zone name, a `ZonedDateTime` string that carries the correct summer offset is
rejected as invalid, and every other IANA zone, including zones without DST such as
`America/Phoenix`, is a catchable `RangeError` worded as invalid input.
The code says "DST not modeled" and design decision 10 disclaims full ECMA-402 conformance, but
a zone the engine accepts must follow its rules: the engine answers wrongly where it should refuse.

**Where:** `rust/engine/ironhorse-vm/src/interp/temporal.rs:1409-1494`, `:1167-1178`;
`rust/engine/ironhorse-vm/src/interp/natives/intl.rs:450-459`.

**Evidence:** `../probes/verify/vm-natives-values-pass2/n6.js`:

```js
const f=(tz,t)=>new Intl.DateTimeFormat('en-US',{hour:'numeric',minute:'numeric',timeZone:tz,timeZoneName:'short'}).format(new Date(t));
const r=[f('America/New_York','2024-07-01T12:00Z'), f('America/New_York','2024-01-01T12:00Z'), Temporal.ZonedDateTime.from('2024-07-01T12:00[America/New_York]').offset];
let e; try{Temporal.ZonedDateTime.from('2024-07-01T12:00-04:00[America/New_York]')}catch(x){e=String(x)} r.push(e);
throw new Error(JSON.stringify(r));
```

IronHorse: July gives `7:0 AM GMT-5`, the same as January; the offset is `-05:00`; the string
with `-04:00` is `RangeError: Temporal.ZonedDateTime: invalid zoned date/time string`.
Node (`TZ=UTC`): `8:00 AM EDT` in July.
`../probes/verify/vm-natives-values/n6_tz.js`: `Pacific/Chatham`, `Europe/Kyiv`,
`Antarctica/Troll` and `America/Phoenix` throw `RangeError`; Node formats them.
test262, plain host: `built-ins/Temporal/ZonedDateTime` 495 of 901 and `intl402/DateTimeFormat`
122 of 244 pass, and 29 Temporal failures cite "invalid or unsupported time zone"; in the sweep,
`canonical-tz` passes 0 of 19.

**Fix:** Embed a frozen tzdb snapshot (for example `jiff-tzdb` or `chrono-tz` compiled data),
versioned with `INTL_DATA_VERSION` so replicas stay deterministic, and apply its transitions.
Until then, refuse a named zone that observes DST with a self-naming refusal rather than
answering with a wrong offset, and word the refusal of unknown zones as "unsupported", not
"invalid".

**Also:** NVAL-5 and NVAL-8 (same root: hand tables stand in for tzdb and CLDR data); NVAL-9 (an
unsupported zone is presented as invalid input).

### BOOT-7 — Modules run only as self-contained bodies; the module model is unconnected (medium)

The `MODULE` opcode runs one module body whose transfers are local or export-only.
It halts with Halt::NotImplemented for an imported transfer (`module:static-linking`, so any
`import` or `export … from`), for `import()` (`module:dynamic-import`), for `import.meta` and
for an async execute function (`module:top-level-await`).
Where XS's `fxPrepareModule` returns the module instance, it pushes `undefined`.
`module.rs` separately models CyclicModuleRecord linking and evaluation, namespaces and
`ModuleSource` over hand-built `BodyOp`s holding primitive values, but the interpreter never
consults it.
That model has no Errored status either: an evaluation error leaves the module Evaluating, a
later `evaluate()` reports success with no [[EvaluationError]], and the persist gate then
refuses the graph for good.
Any multi-module program, Endo archive or `compartment.import()` is refused.
The compiler map notes that no production path compiles the Module goal today.

**Where:** `rust/engine/ironhorse-vm/src/interp/dispatch.rs:4843-4880` (refusals), `:4919-4923`
(pushes `undefined`), `:4936-4945` (`import()`, `import.meta`);
`rust/engine/ironhorse-vm/src/module.rs:177-184`, `:626-643`;
`rust/engine/ironhorse-vm/src/module_snapshot.rs:23-34`;
`rust/engine/ironhorse-vm/src/compartment.rs:566-581`.

**Evidence:** static; the verifier re-read every refusal label and the
`self.push(Slot::undefined())` placeholder.
test262: unsupported 436 `module:dynamic-import`, 211 `module:top-level-await`, 134
`module:static-linking`, 34 `module:resolution-linking`, 21 `compiler-unimplemented:module` and
5 `module:import-meta`; `language/module-code` passes 202 of 599 cases and `language/import` 10
of 129.

**Fix:** Connect `XS_CODE_MODULE` transfers to a real module map: per-module closure cells keyed
by resolved specifier through the compartment's graph (replacing `BodyOp`), a namespace exotic
object returned from `MODULE`, and an Errored status that keeps the error.
Static linking of an already-registered graph is the cheapest first step and unlocks
`compartment.importNow`.
Dynamic import and top-level await need an async loader with deterministic job ordering.
Until `import()` is supported, reject its promise (the spec's failure channel when a host cannot
load a module) instead of halting.

**Also:** BOOT-8 (depends on this); the persistence refusal at
`rust/engine/ironhorse-vm/src/interp/persist.rs:590`; T262-5 (34 + 98 + 32 module rows filed as
infrastructure).
COV-10 (low): the parser discards the AWAITING flag that an `await` in a class heritage sets, so
`export class C extends fn(await foo) {}` compiles as a non-async module function and halts
`EngineInvariant` (`await:no-async-instance`) instead of reaching the `module:top-level-await`
refusal; 24 test262 cases (full entry: `../COVERAGE.md`).

### BOOT-8 — The guest Compartment lacks `import`, `importNow` and `ModuleSource` (medium)

`natives/compartment.rs` implements phase 1 of the guest Compartment: the `globals` and
`globalLexicals` options are honoured, `modules` is validated and then discarded, and `name` is
read and discarded.
`Compartment.prototype` has `globalThis`, `evaluate`, `constructor` and `@@toStringTag`; XS's
also has `import` and `importNow` (`c/moddable/xs/sources/xsModule.c:200-204`), and XS's
`ModuleSource` global (`c/moddable/xs/sources/xsModule.c:221`) is absent.
Guest `lockdown()` implements three of `fx_lockdown`'s five steps.
It skips the compartment-global template and the per-compartment `Date` and `Math`
(`c/moddable/xs/sources/xsLockdown.c:105-139`), so `c.evaluate('Date') === Date`; because
`Date.now()` returns 0 and `Math.random` is absent, that is a parity gap, not an authority leak.
The comment at `rust/engine/ironhorse-vm/src/interp/realm.rs:247-248` still says IronHorse has
no guest Compartment.
Workloads that call `compartment.import()` or `importNow()` or construct a `ModuleSource` fail,
and a machine that holds a live guest Compartment cannot be checkpointed at all
(`rust/engine/ironhorse-vm/src/interp/persist.rs:640`).

**Where:** `rust/engine/ironhorse-vm/src/interp/natives/compartment.rs:1-9`, `:84-97`;
`rust/engine/ironhorse-vm/src/interp/realm.rs:244-253`;
`rust/engine/ironhorse-vm/src/compartment.rs:574-581`.

**Evidence:** `../probes/vm-boot-realm-modules/p12_compartment_surface.js` on `ironhorse-xst`:
own keys of `Compartment.prototype`
`["globalThis","evaluate","constructor","Symbol(Symbol.toStringTag)"]`; `import`, `importNow`,
`name` and `ModuleSource` are all `"undefined"`.
`../probes/vm-boot-realm-modules/p13_date_lockdown.js`: `dateIdentity` and `mathIdentity` are
`true`; `Date.now()` is 0 in every compartment.
Not in test262; the hardened262 corpus's module phase is 56 `Compartment` files plus 7 in
`test/modules/` (`designs/ironhorse-guest-compartment.md`).

**Fix:** Correct the stale comment.
Implement the compartment-global template step for XS parity.
Implement `import`, `importNow`, `ModuleSource` and the `modules` option on BOOT-7's linking.
A `name` getter is SES parity, not XS parity; if wanted, label it as an SES extension.
Lift the persist-gate refusal of live compartments with the two-column table of the design's §7.

**Also:** BOOT-7; CMP-1 (the critical Function-constructor escape on the SES shim path is this
surface's security counterpart).

### CMP-3 — Class static blocks refuse direct declarations and share one scope (medium)

The scoper hoists every static field initializer and every static-block body of a class into one
synthesized `constructorInit` scope.
If that scope holds a declaration written directly in a static block (`let`, `const`, `var`,
`function` or `class`), the coder reports `ParseErrorKind::Unsupported` ("static block with
lexical declarations deferred").
Through `eval`, `Function` or `Compartment.evaluate`, the VM turns that into
Halt::NotImplemented `eval:compiler-unimplemented`, which ends the run; at top level it is a
compile error.
Because the blocks share a scope, two blocks that declare the same name fail earlier still, with
a spurious catchable `SyntaxError: duplicate variable`; ECMA-262 gives each ClassStaticBlock its
own function-like environment.
Wrapping the declarations in an inner `{ }` compiles correctly.
Static blocks appear in modern libraries and in TypeScript output that targets ES2022.

**Where:** `rust/engine/ironhorse-compile/src/coder.rs:3552-3568`;
`rust/engine/ironhorse-compile/src/scoper.rs:803-833`, `:1373-1376`;
`rust/engine/ironhorse-vm/src/interp/eval.rs:117-121`.

**Evidence:** `../probes/compile/v2/static_eval.js`:

```js
var r;
try { r = eval("class C { static { let x = 1; C.y = x; } } C.y"); } catch (e) { r = "caught " + e.name; }
throw new Error("result=" + r);
```

IronHorse: `InternalError: ironhorse halted: NotImplemented("eval:compiler-unimplemented")`.
Node: `Error: result=1`.
`../probes/compile/v2/static_blocks.js`, IronHorse then Node:

```text
two-let=SyntaxError:duplicate variable a | let-var-across=SyntaxError:duplicate variable b | plain=1
two-let=ok | let-var-across=ok | plain=1
```

test262: 4 cases: 3 unsupported as `parse-or-decode`, and
`language/statements/class/static-init-scope-lex-open.js` fails.

**Fix:** Give each static block its own function-kind scope chained under the class scope, and
reserve its frame like a method body; keep static field initializers in `constructorInit`.
Until then, surface a compiler `Unsupported` through `eval` and `Function` as a catchable
`SyntaxError`.

**Also:** CMP-6 (the same scope model merges environments ECMA-262 keeps apart); T262-6 (the
three unsupported cases are filed under a misleading reason).

### INT-3 — The thixotrope worker's compiler drops the direct-eval context (medium)

`SourceCompiler::compile_eval_units` has a default body that ignores the caller's `EvalContext`
and compiles with its strictness alone, so a direct eval's `super`, `new.target` and private
names become `SyntaxError`s.
`ironhorse-runtime`'s `IronhorseSourceCompiler` overrides it.
The thixotrope IronHorse worker does not depend on `ironhorse-runtime`; it re-implements the
compiler adapter and overrides only `compile_source` and `compile_source_units`.
In a thixotrope IronHorse vat, `eval('super.x')` in a method, `eval('new.target')` in a
constructor and `eval('this.#x')` in a method throw `SyntaxError`, and because every incomplete
crank is fatal in that worker, the worker dies.
The same code works on `ironhorse-xst`, on the endo seam and in Node.
The trait default compiles a different program instead of failing.

**Where:** `rust/thixotrope-ironhorse-worker/src/main.rs:17-116`; copy at
`rust/engine/wasm-worker-spike/src/session.rs:24-123`; trait default
`rust/engine/ironhorse-vm/src/interp.rs:300-312`; correct override
`rust/engine/ironhorse-runtime/src/lib.rs:107`.

**Evidence:** `../probes/integration-fuzz-oracle/e1_eval_context.js`:

```js
var out = [];
class B { get x() { return 42; } }
class C extends B { m() { return eval("super.x"); } }
out.push(new C().m());
var r; function F() { r = eval("new.target") === F; } new F(); out.push(r);
class P { #x = 7; m() { return eval("this.#x"); } }
out.push(new P().m());
throw new Error(JSON.stringify(out));
```

`ironhorse-xst` and Node: `Error: [42,true,7]`.
Through the real worker binary over NDJSON
(`../probes/verify/integration-fuzz-oracle/worker_eval.py`), each of the three expressions ends
the worker with `"op":"fatal"`, rendered `SyntaxError: invalid super`,
`SyntaxError: invalid new.target` and `SyntaxError: invalid private identifier`.

**Fix:** Make the worker (and the spike, or delete the spike) depend on `ironhorse-runtime` and
use `IronhorseSourceCompiler`.
Remove the trait default for `compile_eval_units`, or make it return
`SourceCompileError::Unsupported`, so a compiler that cannot honour the eval context fails loudly.

**Also:** INT-13 (the adapter's hand-maintained copies; this is the copy that has diverged).

### CORE-4 — The global object's `[[Prototype]]` is null (medium)

`Interp::new` allocates the global object with a null prototype; the comment says the
`%Object.prototype%` wiring "lands with the intrinsics seam", and nothing later re-points it.
`create_environment` allocates every Compartment global the same way.
SetRealmGlobalObject's default, XS, Node and browsers all chain the global to `%Object.prototype%`.
`GET_VARIABLE` and `SET_VARIABLE` add a `mop_has(object_proto, name)` fallback so that a bare
`toString` still resolves, which makes name resolution and [[HasProperty]] disagree:
`typeof toString` is `'function'` while `'toString' in globalThis` is false.
Guest-visible effects: `globalThis instanceof Object` is false, top-level
`this.hasOwnProperty('x')` throws `TypeError: call: not a function`, and `String(globalThis)`
throws.

**Where:** `rust/engine/ironhorse-vm/src/interp/boot.rs:62-66`;
`rust/engine/ironhorse-vm/src/interp/realm.rs:941-943`; workarounds at
`rust/engine/ironhorse-vm/src/interp/dispatch/environment.rs:114-141`, `:300-317`.

**Evidence:** `../probes/verify/vm-core-dispatch/c4_global.js` wraps each check in `try`, for
example `c("this-hasOwnProperty", function () { return this.hasOwnProperty("out"); })`.
IronHorse, then Node:

```text
["proto-null=true","instanceof-Object=false","isPrototypeOf=false",
 "this-hasOwnProperty=throw TypeError:call: not a function","in-toString=false",
 "bare-toString-typeof=function","String-global=throw TypeError:cannot coerce object to string"]
[false,true,true,true,true,"function","[object global]"]
```

`../probes/verify/vm-core-dispatch/c4_comp.js`:
`new Compartment().evaluate("Object.getPrototypeOf(globalThis) === null")` is `true`.
test262: 10 cases fail with this signature (PROP-7's list, for example
`built-ins/decodeURI/S15.1.3.1_A5.5.js` and `language/global-code/decl-lex.js`).

**Fix:** Once `%Object.prototype%` exists, set the prototype of the default global and of every
compartment global (boot already re-points the null prototypes of natives this way,
`boot.rs:1826-1849`).
Delete the two `mop_has` special cases, and check that snapshot and restore keep the link.

**Also:** PROP-7 (same defect); PROP-6.

### PROP-6 — `%Object.prototype%` is not an immutable-prototype exotic object (medium)

ECMA-262 §10.4.7 requires `%Object.prototype%.[[SetPrototypeOf]](V)` to return SameValue(V,
current).
`mop_set_prototype_inner` applies only the ordinary checks to every non-proxy object, so before
lockdown `Reflect.setPrototypeOf(Object.prototype, Object.create(null))` returns true and the
new prototype's properties appear on every object.
This is a spec divergence, not an escalation: code running before lockdown can add properties to
`Object.prototype` directly, and after lockdown the object is non-extensible, so the ordinary
check refuses.

**Where:** `rust/engine/ironhorse-vm/src/interp/property.rs:965-999`.

**Evidence:** `../probes/vm-property-model/js/immutable_proto2.js`:

```js
var out = [];
out.push('frozen:' + Object.isFrozen(Object.prototype) + ',ext:' + Object.isExtensible(Object.prototype));
var n = Object.create(null);
out.push('reflect:' + Reflect.setPrototypeOf(Object.prototype, n));
out.push('proto is n:' + (Object.getPrototypeOf(Object.prototype) === n));
n.injected = 'from n';
out.push('({}).injected=' + ({}).injected);
try { Object.setPrototypeOf(Object.prototype, null); out.push('reset ok'); } catch (e) { out.push('reset threw ' + e.name); }
throw new Error(out.join(' | '));
```

IronHorse, then Node:

```text
frozen:false,ext:true | reflect:true | proto is n:true | ({}).injected=from n | reset ok
frozen:false,ext:true | reflect:false | proto is n:false | ({}).injected=undefined | reset ok
```

test262: `built-ins/Object/prototype/setPrototypeOf-with-non-circular-values.js` and its
`__proto__` variant fail.

**Fix:** When the object is a realm's `%Object.prototype%` (the default realm's and each
compartment's), return `current == new_proto` before the ordinary checks.

**Also:** CORE-4.

### PROP-8 — Built-in iterators reuse one `{value, done}` object with non-writable fields (medium)

CreateIterResultObject must return a fresh ordinary object with writable, enumerable,
configurable `value` and `done` on every `next()`.
The Array, Map, Set and String iterators instead allocate one result object per iterator,
flagged `XS_DONT_DELETE | XS_DONT_SET`, and rewrite it in place on each `next()` through
`set_own_unmetered`, mirroring XS's `fxNewIteratorInstance`.
So `a = it.next(); b = it.next(); a === b` is true, `a.value` changes under the caller, the
descriptor reports `writable: false`, and code that collects result objects gets copies of the
final `{value: undefined, done: true}`.
Generator and RegExp String Iterator results are fresh.
The XS oracle behaves the same way, so the differential does not report it.

**Where:** `rust/engine/ironhorse-vm/src/interp/natives/array.rs:1369-1375`, `:1390`,
`:1541-1543`; `rust/engine/ironhorse-vm/src/interp/natives/collection.rs:625`, `:662`,
`:2040-2041`, `:2968-2969`; `rust/engine/ironhorse-vm/src/interp/environment.rs:334-356`.

**Evidence:** `../probes/vm-property-model/js/iter_reuse.js` and `iter_reuse2.js`: IronHorse
`same:true | a.value:2 | desc:{"value":2,"writable":false,"enumerable":true,"configurable":false}`
and `collected:,`; Node
`same:false | a.value:1 | desc:{"value":1,"writable":true,"enumerable":true,"configurable":true}`
and `collected:10,20`.

**Fix:** Allocate a fresh ordinary result object per `next()`.
If XS parity is kept on purpose, list it among the documented oracle divergences.
Restrict `set_own_unmetered` to engine-private objects.

**Also:** NOBJ-17 (another XS-model approximation in collection iteration).

### FN-18 — No proper tail calls, and the skip list hides it (low; medium as T262-8)

The compiler emits XS's `RUN_TAIL` opcodes for strict-mode calls in tail position, but the VM
treats them as ordinary `RUN`.
XS's `XS_CODE_RUN_TAIL_ALL` (`c/moddable/xs/sources/xsRun.c:780-794`) pops the caller frame and
moves the callee into its place.
A strict tail-recursive loop that runs in constant stack on XS therefore overflows here after
about 4,058 frames, with an uncatchable StackOverflow halt.
The harness pre-skips the `tail-call-optimization` feature while its doc comment calls the list
"the analogue of xst262.c's 13-entry gxFeatures"; XS's list contains neither
`tail-call-optimization` nor `IsHTMLDDA`.
No design document records the omission as a divergence from XS.

**Where:** `rust/engine/ironhorse-vm/src/interp/dispatch.rs:2452`;
`rust/engine/ironhorse-262/src/xst.rs:33-55`; `rust/engine/ironhorse-vm/src/opcode.rs:182-185`.

**Evidence:** `../probes/verify/vm-functions-async/v18_ptc.js`:

```js
"use strict"; function r(n){ if (n === 0) return "done"; return r(n-1); } var v; try { v = r(100000); } catch (e) { v = "caught " + e; } throw new Error(v);
```

IronHorse: `InternalError: ironhorse halted: StackOverflow(4058)`; the `catch` did not run.
The XS oracle completes 100,000-deep strict tail recursion
(`../probes/verify/test262-harness/mini262/test/probe/tco-xsonly.js` through `endot-ih`: covered).
test262: 35 cases not run (`feature:tail-call-optimization`), 31 of them `onlyStrict`.

**Fix:** Remove `tail-call-optimization` from the skip list so the gap is measured, and correct
the doc comment.
Then reuse the frame in `RUN_TAIL` when the frame has no `new.target` (mirroring
`mxFrameHasTarget`), or record the omission as an explicit profile divergence in
`rust/engine/ARCHITECTURE.md`.

**Also:** T262-8 (same defect); T262-10 (the 31 strict-only pre-skips are recorded under the
sloppy mode).

### NOBJ-12 — `%TypedArray%.prototype.toSorted`, `toReversed` and `with` are missing (medium)

The `%TypedArray%.prototype` roster has no `toSorted`, `toReversed` or `with`, so
`typeof new Int8Array([3,1,2]).toSorted` is `'undefined'` and calls throw
`TypeError: call: not a function`.
These ES2023 methods ship in every current engine.
The Array counterparts exist, and the TypedArray element codecs plus a corrected sort (NOBJ-2)
are all that is needed; TypedArrayCreateSameType uses the intrinsic constructor, not species.

**Where:** `rust/engine/ironhorse-vm/src/interp/boot.rs:742-768`; TypedArray routing in
`rust/engine/ironhorse-vm/src/interp/natives/dispatch.rs:2271-2317`; Array versions at
`rust/engine/ironhorse-vm/src/interp/natives/dispatch.rs:4816-4921` and
`rust/engine/ironhorse-vm/src/interp/natives/array.rs:4338`.

**Evidence:** `../probes/verify/vm-natives-objects/n12_ta.js`:

```js
const t = new Int8Array([3, 1, 2]);
const r = {};
for (const m of ['toSorted', 'toReversed', 'with']) r[m] = typeof t[m];
throw new Error(JSON.stringify(r));
```

IronHorse: `{"toSorted":"undefined","toReversed":"undefined","with":"undefined"}`.
Node: `"function"` for all three.
test262: 38 of 43 cases under `built-ins/TypedArray/prototype/{with,toSorted,toReversed}` fail.

**Fix:** Add three native methods, appended rather than inserted because the TypedArray
read-only numbering is positional, that implement TypedArrayCreateSameType plus an element copy
and share NOBJ-2's corrected sort; about 150 lines.

**Also:** MEM-4 and NOBJ-2 (the insertion sort to replace first).

### NOBJ-13 — Symbols as weak keys: `TypeError` on methods, Refused halt in constructors (medium)

ES2023's CanBeHeldWeakly admits non-registered symbols as WeakMap keys, WeakSet values, WeakRef
targets and FinalizationRegistry targets and tokens.
The engine, pinned to an XS build without symbol-key collection, refuses them in two ways.
`WeakMap.prototype.set`, `WeakSet.prototype.add`, `new WeakRef` and `register` throw a catchable
`TypeError`; `new WeakMap([[sym, v]])` and `new WeakSet([sym])` halt with Halt::Refused
`collection-constructor:weak-symbol-oracle-version`.
The constructor check runs before the registered-symbol distinction, so even `Symbol.for('a')`,
for which the spec requires a catchable `TypeError`, halts the crank.

**Where:** halt at `rust/engine/ironhorse-vm/src/interp/natives/collection.rs:316-330`;
`TypeError`s at `rust/engine/ironhorse-vm/src/interp/natives/collection.rs:92-94`, `:121-123`,
`:2577-2579` and `rust/engine/ironhorse-vm/src/interp/natives/weak.rs:22-27`.

**Evidence:** `../probes/verify/vm-natives-objects/n13_weak_sym_ctor.js`:

```js
let r;
try { new WeakMap([[Symbol('a'), 1]]); r = 'ok'; } catch (e) { r = e.name + ': ' + e.message; }
throw new Error(JSON.stringify(['ctor', r]));
```

IronHorse, then Node:

```text
InternalError: ironhorse halted: Refused("collection-constructor:weak-symbol-oracle-version")
Error: ["ctor","ok"]
```

`../probes/verify/vm-natives-objects/n13_weak_regsym_ctor.js`
(`new WeakSet([Symbol.for('a')])`): the same halt; Node throws `TypeError`.
test262: feature `symbols-as-weakmap-keys` passes 0 of 28 cases (5 unsupported as `refused:`, 23
fail); `upsert`'s symbol-key cases fail for the same reason.

**Fix:** Now: make the constructor path throw the same catchable `TypeError`, checking for
registered symbols first.
To support the feature: admit `Kind::Symbol` when `Symbol.keyFor(s)` is undefined and teach the
collector to treat symbol descriptors as weakly holdable; this needs an oracle that supports it,
or an oracle-independent expectation.

**Also:** the theme "uncatchable halts for ordinary programs".

### NOBJ-14 — `Atomics.wait`, `notify` and `waitAsync` halt before validation (medium)

The Atomics dispatcher returns Halt::Refused `atomics:wait-notify` for every operation numbered
10 or above before it validates any argument.
Outcomes the spec defines without blocking therefore also end the crank: `Atomics.notify` on a
non-shared `Int32Array` returns 0, `Atomics.wait` on non-shared memory throws `TypeError`, and
`wait` with a mismatched value returns `"not-equal"` (or `"timed-out"` with timeout 0).
In a single-agent engine only a wait that would actually block needs refusing.
The harness pre-skips every case whose source contains `$262.agent`, `Atomics.wait` or
`Atomics.notify` (228 files), but only 112 use `$262.agent`; the other 116 are single-agent
cases (36 notify, 32 wait, 48 waitAsync).
It also skips the two CanBlockIsFalse files, a rule copied from XS, whose agent can block;
IronHorse cannot block, so its [[CanBlock]] is false, and those files should run while the 7
CanBlockIsTrue files are skipped.

**Where:** `rust/engine/ironhorse-vm/src/interp/natives/buffer.rs:2231-2234`;
`rust/engine/ironhorse-262/src/xst.rs:1541-1561`.

**Evidence:** `../probes/verify/vm-natives-objects/n14_notify.js`:

```js
let r;
try { r = Atomics.notify(new Int32Array(4), 0, 1); } catch (e) { r = e.name; }
throw new Error(JSON.stringify(['notify-nonshared', r]));
```

IronHorse: `InternalError: ironhorse halted: Refused("atomics:wait-notify")`.
Node: `["notify-nonshared",0]`.
`../probes/verify/vm-natives-objects/n14_wait_ne.js` (shared buffer, mismatched value, timeout
0): the same halt; Node returns `"not-equal"`.
test262: all 230 cases under `built-ins/Atomics/{wait,notify,waitAsync}` are not run (228
`structural:multi-agent`, 2 `structural:can-block`); `Atomics.waitAsync` passes 0 of 101.

**Fix:** Validate in XS order and return the non-blocking results: `notify` returns 0 (on shared
memory too, since no agent waits), `wait` throws `TypeError` when [[CanBlock]] is false, and
`waitAsync` returns `{async: false, value: "not-equal"}` or `"timed-out"`, or a promise.
Refuse only a wait that would block, and then with a catchable error.
In the harness, pre-skip only `$262.agent` users, run CanBlockIsFalse files and skip
CanBlockIsTrue files.

**Also:** T262-4 (same defect).

### NVAL-7 — Temporal is an older, lax, unmetered subset the oracle cannot judge (medium)

Temporal follows an older proposal snapshot (`Temporal.Calendar` exists; the `iso8601` era is
`'ce'`) and omits much of the current spec: property-bag `overflow` handling, ISO date limits,
critical-annotation validation, leap-second clamping, and `largestUnit`/`smallestUnit` for
`Plain*.prototype.until` and `since`, whose options argument is never read (`'bogus'` is accepted).
`Instant.prototype.toZonedDateTimeISO` and `Date.prototype.toTemporalInstant` are missing,
calendars other than `iso8601` are refused, and `ZonedDateTime.prototype.toLocaleString` halts
NotImplemented.
No Temporal or Intl path charges the meter beyond the allocation of result strings.
The XS oracle has no Temporal, so the differential sweep files almost all of it as skipped and
cannot tell right from wrong.

**Where:** `rust/engine/ironhorse-vm/src/interp/temporal.rs:158-179`, `:181-252`, `:962-1019`;
`rust/engine/ironhorse-vm/src/interp/natives/temporal.rs:41-56`, `:432-438`, `:1780-1782`.

**Evidence:** `../probes/verify/vm-natives-values/n7_until.js`:

```js
const d = Temporal.PlainDate.from('2021-01-31'); const e = d.add({ days: 1000000 });
const u = e.until(d, { largestUnit: 'months' });
throw new Error(JSON.stringify([String(e), String(u), u.months, u.days, String(d.until(e, { largestUnit: 'months' })), String(d.until(e, { largestUnit: 'years' }))]));
```

IronHorse returns `P1000000D` whatever `largestUnit` says.
`../probes/verify/vm-natives-values/n7_temporal.js`:
`PlainDate.from({year:2021,month:2,day:31})` throws `TypeError` (the spec constrains it to
2021-02-28); `new Temporal.PlainDate(300000,1,1)` is accepted; `'2021-01-01[!u-ca=hebrew]'` is
accepted; `Instant.from('2020-01-01T00:00Z')` throws `RangeError`.
test262: `built-ins/Temporal` 2,023 of 4,603 and `intl402/Temporal` 112 of 2,029 cases pass;
feature `Temporal` has 4,576 of 6,711 cases not passing; 15 are unsupported as
`…toLocaleString:needs-intl`.

**Fix:** Adopt `temporal_rs` (the Rust Temporal implementation used by Boa and V8) behind the
existing side-table records, or gate Temporal off until it conforms.
Add an oracle-independent test262 gate for Temporal and `intl402`.
Meter parsing and field arithmetic.

**Also:** NVAL-4 (Temporal getters exist only on the static read path, the largest plain-host
failure class); NVAL-6; T262-1.

### NVAL-8 — The Intl "frozen profile" formats advertised locales with English data (medium)

`supportedLocalesOf` and ResolveLocale accept a set of languages, but each formatter keys its
own small table on the language subtag and silently falls back to English.
`new Intl.PluralRules('ar').resolvedOptions()` lists six categories while `select()` can only
return `one` or `other`.
`ListFormat`, `DateTimeFormat` and `Locale.prototype.maximize` use English or Latn/US defaults
for `de`, `ja`, `th` and `el`; `NumberFormat('xx')` resolves to `xx`; CanonicalizeLocaleList
does not apply ToObject, so an array-like locale list is a `RangeError`;
`Date.prototype.toLocaleDateString` ignores its locales; `DateTimeFormat` does not zero-pad minutes.
`Intl.RelativeTimeFormat`, `Intl.DisplayNames` and `Intl.DurationFormat` are absent, and
`NumberFormat`'s `formatRange` and non-English compact notation halt NotImplemented.

**Where:** `rust/engine/ironhorse-vm/src/interp/locale.rs:182-202`, `:225-248`, `:272-298`,
`:466-677`, `:816-901`; `rust/engine/ironhorse-vm/src/intl_number.rs:884-913`;
`rust/engine/ironhorse-vm/src/interp/natives/intl.rs:55-85`, `:313-328`;
`rust/engine/ironhorse-vm/src/interp/boot.rs:2766-2768`.

**Evidence:** `../probes/verify/vm-natives-values/n8_intl.js`, IronHorse then Node: PluralRules
`ru` `select(3)` `other` / `few`; `ar` `select(0)` `other` / `zero`; `ListFormat('de')`
`a, b, and c` / `a, b und c`; `DateTimeFormat('ja').format(0)` `1/1/1970` / `1970/1/1`;
`NumberFormat('fr')` `1.234.567,891` / `1 234 567,891`; `getCanonicalLocales({length:1,0:'en'})`
`RangeError` / `en`; both report all five locales as supported.
test262: on a plain host, non-Temporal `intl402` passes 673 of 1,328 cases (`Locale` 65 of 168,
`DateTimeFormat` 122 of 244, `NumberFormat` 166 of 249, `DisplayNames` 4 of 57,
`RelativeTimeFormat` 0 of 80, `DurationFormat` 0 of 110); the XS-oracle sweep skips 3,093 of
3,357 `intl402` cases.

**Fix:** Make one supported-locale predicate the single source of truth, and either ship CLDR
data for every advertised locale (ICU4X `icu_plurals`, `icu_list`, `icu_datetime`,
`icu_decimal`, from the family already in the lock file) or shrink the advertised set to `en`.
Implement CanonicalizeLocaleList per spec, route `Date.prototype.toLocale*String` through
`DateTimeFormat`, and zero-pad numeric minutes and seconds.

**Also:** NVAL-5, NVAL-6 (same root).

### NVAL-5 — `Intl.Collator` and `localeCompare` are not UCA (medium)

`collator_compare_units` orders strings by the code points of their NFC-normalized, lowercased
text, and falls back to the original code points to break ties at `case` or `variant`
sensitivity; that is not the Unicode Collation Algorithm.
Ordering is implementation-defined, so `'ä'` after `'z'` and upper-case-first ties are legal, if
unlike every browser.
Option semantics are not implementation-defined: `sensitivity: 'base'` still distinguishes `'a'`
from `'á'` and `'ß'` from `'ss'`, and `numeric: true` compares only the first digit run, so
`'b1'` sorts before `'a2'`.

**Where:** `rust/engine/ironhorse-vm/src/interp/locale.rs:903-962`, `:964-988`; callers at
`rust/engine/ironhorse-vm/src/interp/natives/string.rs:651-670` and
`rust/engine/ironhorse-vm/src/interp/natives/dispatch.rs:2828-2844`.

**Evidence:** `../probes/verify/vm-natives-values-pass2/n5.js` evaluates `Collator` base
`compare('a','á')`, numeric `compare('b1','a2')`, numeric `compare('a10b2','a10b10')` and a
German sort of `['ä','a','z']`: IronHorse `[-1,-1,1,"a,z,ä"]`, Node `[0,1,-1,"a,ä,z"]`.
test262, plain host: `intl402/Collator` 44 of 65 pass.

**Fix:** Use `icu_collator` with root data plus the advertised profile locales; otherwise
document collation as lowercase code-point order and stop advertising `sensitivity`, `numeric`
and `caseFirst` as honoured.
Cache the resolved collator instead of cloning its data on every compare.

**Also:** NVAL-6, NVAL-8 (same root).

### FN-10 — Calls with more than about 2,025 arguments halt uncatchably (medium)

`enter_call` checks `would_overflow(FRAME_OVERHEAD_SLOTS + argc)` before it truncates the
pending call tuple, but `stack_slots_in_use()` already counts those slots, so arguments count
twice against the 4,064 usable slots.
Any user-function call with more than about 2,025 arguments (`f.apply(null, a)`, `f(...a)`) is a
Halt::StackOverflow for the whole crank, where engines throw a catchable `RangeError` at much
larger counts.
Native callees take no value-stack check at all: `Math.max.apply(null, {length: 3e6})` completes
and grows the host stack to millions of slots.

**Where:** `rust/engine/ironhorse-vm/src/interp/frames.rs:347-350`, with `:13-15` and `:29-31`.

**Evidence:** `../probes/verify/vm-functions-async/v10_apply_3000.js`:

```js
function f(){return arguments.length} var a=[]; for (var i=0;i<3000;i++) a.push(i); var r; try { r = f.apply(null,a); } catch (e) { r = "caught " + e; } throw new Error("argc=3000 => " + r);
```

IronHorse: `InternalError: ironhorse halted: StackOverflow(8)`; 2,020 arguments succeed and
2,030 halt.
Node: `Error: argc=3000 => 3000`.

**Fix:** Count the pending arguments once.
Apply the same budget before pushing a native frame's argument list.
Throw a catchable `RangeError` for argument-list overflow and keep the uncatchable halt for true
frame-depth exhaustion only.

**Also:** CORE-5 (the native value stack is unbounded); FN-3 (bound arguments stored through
unbounded native `apply`).

### NOBJ-10 — 1,000,000-step iterator caps halt with StepLimit or truncate (medium)

Twelve loops in built-ins that drain a guest iterator are written `for _ in 0..1_000_000` and,
when the bound runs out, return Halt::StepLimit.
`rust/engine/ironhorse-vm/src/interp.rs:1669-1678` documents StepLimit as the bounded-run
harness's dispatch ceiling, "never produced by the default-unbounded `Interp::run`".
`new Set(it)`, `Array.from`, `TypedArray.from`, `Iterator.prototype.toArray`,
`Object.fromEntries`, the Map, Set, WeakMap and WeakSet constructors, the Promise combinators
and IterableToList halt on an iterator that yields 1,000,005 values.
`Map.groupBy` and `Object.groupBy` instead return the first 1,000,000 values with no error and
without closing the iterator.
Spread has no cap, and under a meter the caps are redundant.
In practice most loops of that length hit HeapExhausted first (MEM-1), so the cap bites with
fast-path array iterators or with iterators that reuse their result object.

**Where:** `rust/engine/ironhorse-vm/src/interp/natives/array.rs:435`, `:491`;
`rust/engine/ironhorse-vm/src/interp/natives/collection.rs:550`, `:613`, `:1324-1328`, `:1352`,
`:1431`, `:1580`, `:1843`, `:2784` (`groupBy`);
`rust/engine/ironhorse-vm/src/interp/natives/buffer.rs:905`;
`rust/engine/ironhorse-vm/src/interp/property/object.rs:213`;
`rust/engine/ironhorse-vm/src/interp/iterable.rs:179`, `:209`;
`rust/engine/ironhorse-vm/src/interp/natives/promise.rs:1741`, `:1790`;
`rust/engine/ironhorse-vm/src/interp/natives/intl.rs:883`.

**Evidence:** `../probes/verify/vm-natives-objects/n10_set.js`:

```js
const N = 1000005;
const a = []; for (let i = 0; i < N; i++) a.push(i);
let r;
try { r = new Set(a.values()).size; } catch (e) { r = e.name + ': ' + e.message; }
throw new Error(JSON.stringify(['set', r]));
```

IronHorse: `InternalError: ironhorse halted: StepLimit(17000137)`.
Node: `["set",1000005]`.
`../probes/verify/vm-natives-objects/n10_groupby_reuse.js`: IronHorse
`["map-groupBy",1000000,1000000,false]`, Node `["map-groupBy",1000005,1000006,false]`.
`../probes/verify/vm-functions-async/p11_million_cap.js` (`Promise.race` over 1,000,001
results): `StepLimit(19000126)`; Node settles.

**Fix:** Delete the caps and rely on the meter and the heap ceiling, as spread already does.
If a bound is policy, define it once as a named constant with one catchable outcome
(`RangeError`), and close the iterator when stopping.

**Also:** FN-13 (same defect).

### FN-14 — Async nesting past 126 levels or `yield*` past 50 to 70 levels halts (medium)

Each async function's synchronous start (`START_ASYNC`), and each generator resumed through the
native `.next()` path that `yield*` delegation uses, runs a nested `dispatch_at` on the host
stack and charges at least 16 units of the 2,048-unit `NATIVE_DEPTH_LIMIT`.
When the budget runs out the run ends with Halt::ReentryLimit, so a recursive async walk deeper
than 126 levels, or recursive `yield*` tree iteration a few dozen levels deep, kills the crank.
`rust/engine/STACK-DEPTH-REFACTOR.md` documents the 126-level ceiling (lines 688-689) and
records that the fix, C5, is deferred (line 2010).

**Where:** `rust/engine/ironhorse-vm/src/interp/suspend.rs:901-1121`, `:224-411`;
`rust/engine/ironhorse-vm/src/interp.rs:409`.

**Evidence:** `../probes/verify/vm-functions-async/v14_ystar_70.js`:

```js
function* t(n){ if (n>0) yield* t(n-1); else yield "leaf"; } var v; try { v = t(70).next().value; } catch (e) { v = "caught "+e; } throw new Error("yield* 70 => "+v);
```

IronHorse: `InternalError: ironhorse halted: ReentryLimit { depth: 2064, limit: 2048 }`; at 50
levels it returns `leaf`.
Node: `Error: yield* 70 => leaf`.
`../probes/verify/vm-functions-async/v14_async_130.js`
(`async function r(n){ if (n>0) await r(n-1); }` at 130 levels):
`ReentryLimit { depth: 2049, limit: 2048 }`; 120 levels complete.

**Fix:** Land C5 (`START_ASYNC` as a marker frame in the flat activation stack), and resume
`yield*` delegation to a same-segment generator in place, as C4 did for `RUN`'s direct `.next()`.
Until then, surface the limit as a catchable `RangeError` at the re-entry point.

**Also:** INT-14 (the stack-depth refactor patches no longer apply to HEAD); FN-10.

### NOBJ-11 — 2^24 "oversized-array-like" caps halt with Refused on sparse real Arrays (medium)

Generic Array algorithms guard against adversarial array-likes with 13 separate `1 << 24`
constants that raise Halt::Refused, and the guards also apply to genuine Arrays whose length is
large and whose items are few.
`a.length = 2**25; a.sort()` halts `Refused("Array.prototype.sort:oversized-array-like")` where
Node sorts the three items; at exactly 2^24, `sort` halts HeapExhausted instead, because it
reserves length × 24 bytes of scratch before looking at which indices are present.
`toReversed`, `with` and `toSpliced` refuse above 2^24 as well.
The per-iteration caps in `reverse`, `shift`, `unshift`, `splice`, `copyWithin` and `fill` are
unreachable for real Arrays today only because NOBJ-1's key-space exhaustion fires first, after
about 64k minted indices; fixing NOBJ-1 exposes them.

**Where:** `rust/engine/ironhorse-vm/src/interp/natives/array.rs:4539-4549` (`sort`,
`toSorted`), `:4427-4440` (`with`, `toReversed`, `toSpliced`), and the per-iteration caps at
`:2397-2423`, `:2558-2621`, `:2671-2674`, `:2781-2841`, `:2924-2929`, `:3005-3008`,
`:3357-3377`, `:3519-3580`, `:3658-3675`.

**Evidence:** `../probes/verify/vm-natives-objects/n11_sort_sparse_2p25.js`:

```js
const a = []; a.length = 2 ** 25; a[0] = 2; a[1] = 1; a[5] = 0;
a.sort();
throw new Error(JSON.stringify([a.length, a[0], a[1], a[2], 5 in a]));
```

IronHorse: `InternalError: ironhorse halted: Refused("Array.prototype.sort:oversized-array-like")`.
Node: `[33554432,0,1,2,false]`.
`../probes/verify/vm-natives-objects/n11_sort_sparse_2p24.js` (length 2^24): HeapExhausted after
0.008 s.

**Fix:** For a real Array, iterate the present keys rather than `0..length` and grow scratch
incrementally under admission.
Keep a cap only for proxies and exotic array-likes, as one constant with a catchable
`RangeError` or a meter bound.

**Also:** NOBJ-1 (fix it first); NOBJ-5 (shares the `sort` entry).

### NVAL-13 — JSON nesting deeper than 2,048 levels is an uncatchable ReentryLimit halt (medium)

Both JSON directions use explicit heap-allocated frame stacks, yet each nesting level still
charges one unit of the shared 2,048-unit native recursion budget, and exceeding it is
Halt::ReentryLimit.
`JSON.parse` of untrusted text with 3,000 nested brackets, about 6 KB, therefore kills the
crank, and so does `JSON.stringify` of a 3,000-deep array; Node handles both.
Stringify also copies each nested container's text into its parent at close, so a payload at
depth d is copied d times (a performance issue recorded in the same finding).

**Where:** `rust/engine/ironhorse-vm/src/interp/natives/json.rs:1323-1331`, `:828-840`,
`:1213-1251`; `rust/engine/ironhorse-vm/src/interp.rs:409`.

**Evidence:** `../probes/verify/vm-natives-values/n13_deep_catch.js`:

```js
try { JSON.parse('['.repeat(3000) + ']'.repeat(3000)); } catch (e) { throw new Error('caught ' + e.name); }
throw new Error('ok');
```

IronHorse: `InternalError: ironhorse halted: ReentryLimit { depth: 2049, limit: 2048 }`.
Node: `Error: ok`.

**Fix:** Give JSON its own depth budget that fails with a catchable `RangeError`, or no depth
budget at all, since its stacks are heap-allocated and admitted.
Serialize stringify into one output buffer and charge per output unit copied.

**Also:** NVAL-9.

### NVAL-9 — One "too large" or "not modelled" condition, five classifications (medium)

No rule decides whether an implementation limit or a profile gap becomes a catchable error, an
uncatchable halt or a silently wrong value.
`padStart` past 2^24 units halts Refused while `repeat` of the same size succeeds;
`repeat(2**28)` halts HeapExhausted; `repeat` past 2^31-1 is a catchable `RangeError`.
BigInt `**`, `<<`, `asIntN` and `asUintN` results past 64 Ki bits halt Refused, while `*` has no
cap.
JSON depth halts ReentryLimit.
`formatRange` and non-English compact notation halt NotImplemented, although
`rust/engine/ironhorse-vm/src/interp/natives/intl.rs:1298-1314` states a doctrine that the rest
of the file does not follow.
An unmodelled time zone or calendar is a catchable `RangeError` worded as invalid input, and
unmodelled locale data is silently English.

**Where:** Halt::Refused at `rust/engine/ironhorse-vm/src/interp/natives/string.rs:148-151`,
`:741-746`, `rust/engine/ironhorse-vm/src/interp/natives/bigint.rs:264-265`, `:338-349`,
`:638-640`, `rust/engine/ironhorse-vm/src/interp/natives/json.rs:664-667`, `:1045-1046`;
catchable `RangeError` at `rust/engine/ironhorse-vm/src/interp/natives/string.rs:603-608` and
`rust/engine/ironhorse-vm/src/interp/admission.rs:128-130`; HeapExhausted at
`rust/engine/ironhorse-vm/src/interp/admission.rs:131-133`; Halt::NotImplemented at
`rust/engine/ironhorse-vm/src/interp/natives/dispatch.rs:3152-3154`,
`rust/engine/ironhorse-vm/src/interp/natives/intl.rs:1316-1319`,
`rust/engine/ironhorse-vm/src/interp/natives/temporal.rs:1780-1782`; "unsupported" `RangeError`
at `rust/engine/ironhorse-vm/src/interp/natives/intl.rs:454-456` and the Temporal calendar and
zone sites.

**Evidence:** variants of `../probes/verify/vm-natives-values/n9_tmp.js`, each inside
`try`/`catch`, IronHorse then Node:
`'abc'.padStart(2**25)` → `Refused("String.prototype.pad:result-too-large")` / a string of
33,554,432 units;
`'abc'.repeat(2**28)` → `HeapExhausted` / a caught `RangeError`;
`10n ** 20000n` → `Refused("exponentiation:result-too-large")` / a value;
`new Intl.NumberFormat('en').formatRange(1,5)` →
`NotImplemented("Intl.NumberFormat:formatRange")` / `1–5`;
`new Intl.DateTimeFormat('en',{timeZone:'Europe/Kyiv'})` → a caught
`RangeError: … invalid or unsupported timeZone` / a formatter.
`../probes/verify/vm-natives-values/n9_cmp.js`: `'a'.repeat(2**25)` succeeds, then
`''.padStart(2**25,'a')` halts.
test262: 11 `formatRange` and 9 compact-notation cases are unsupported.

**Fix:** Define one taxonomy in `rust/engine/ironhorse-vm/src/halt_labels.rs`.
Implementation size limits become catchable `RangeError`s through `reserve_units`, as `repeat`
already does, against one shared limit.
Unmodelled features are NotImplemented everywhere, including Temporal calendars and zones and
Intl locale data.
Silent approximation is not allowed.
A test asserts that each label maps to exactly one class.

**Also:** NVAL-2 (BigInt `*` uncapped); NVAL-13; NVAL-6, NVAL-8.

### CMP-8 — Nesting caps refuse valid flat chains past about 2,040 terms (medium)

The parser refuses any tree deeper than `TREE_DEPTH_LIMIT` = 2,048 with a catchable
`SyntaxError: stack overflow`, and it charges 8 units of a 1,024-unit budget for every
expression-cascade re-entry.
Because the grammar folds flat sequences into left-deep trees, valid generated code with more
than about 2,040 terms in one chain (`a+b+…`, `a.b.c…`, call chains, else-if chains) is rejected.
Ternary and unary chains stop at about 987; parentheses, array literals, templates and arrow
chains at 89 or 90 levels.
The caps are deliberate, deterministic, pinned by `tests/recursion_bounds.rs` and always catchable.
They exist because drop glue and some passes recurse once per tree level, although the scoper
and the coder's chain walk are iterative, contrary to the `ast.rs` comment.
A 3,000-term string concatenation or a 3,000-arm else-if dispatch fails to load; Node accepts both.

**Where:** `rust/engine/ironhorse-compile/src/ast.rs:168-186`;
`rust/engine/ironhorse-compile/src/parser.rs:155-164`.

**Evidence:** `../probes/compile/v2/chains.js` bisects each shape through `Function`; IronHorse:

```text
plus=2041 strcat=2041 member=2040 call=2039 optchain=1019 logical=2041 comma=100000
elseif=2039 ternary=987 parens=89 array=90 blocks=500 funcs=500 arrows=89 not=986
assign=987 arrpattern=498 template=89
```

The map's Node 22 figures (not re-run) include `plus=100000`, `member=6942` and `parens=2146`.
No test262 case reaches a cap.

**Fix:** Give `Node` an iterative `Drop` and make the cover conversions iterative (CMP-5); then
raise `TREE_DEPTH_LIMIT` for left-deep chain spines, or exempt them.
Document the caps as part of the embedder's acceptance contract, and correct the comment at
`ast.rs:171-174`.

**Also:** CMP-5.

### CMP-12 — Annex B sloppy-mode syntax is refused or silently skipped (low)

The compiler implements none of Annex B's sloppy-mode syntax.
B.3.1 labelled function declarations are rejected ("labeled function"); B.3.4 function
declarations as `if` bodies are rejected with "no block (strict code)", even in sloppy code;
B.1.1 HTML-like comments are `SyntaxError`s.
Annex B's runtime errors for function call assignment targets are not modelled either: sloppy
`f() = 1`, `f()++` and `for (f() in o)` are early `SyntaxError: no reference`, where Annex B
defers them to a `ReferenceError` at evaluation (7 cases in
`annexB/language/expressions/assignmenttargettype/`).
B.3.3 block-level function hoisting is not refused but silently skipped:
`{ function q(){} } typeof q` is `'undefined'` at top level, in functions and in eval, where web
engines give `'function'`.
Annex B is normative only for web-browser hosts, so omitting it is permitted; the defects are
the misleading wording and the silent behaviour change.

**Where:** `rust/engine/ironhorse-compile/src/parser/stmt.rs:421`, `:483`;
`rust/engine/ironhorse-compile/src/lexer.rs:665-730` (comment scanning, no HTML-like branch);
`rust/engine/ironhorse-compile/src/scoper.rs` (no B.3.3 hoisting);
`rust/engine/ironhorse-compile/src/parser.rs:774-816` (`check_reference`, no call-expression arm).

**Evidence:** `../probes/verify/compile/annexb33.js`:

```js
var out = [];
{ function q() {} }
out.push(typeof q);
function f() { { function r() {} } return typeof r; }
out.push(f());
try { out.push(String((0, eval)("{ function s(){} } typeof s"))); } catch (e) { out.push(e.name); }
throw new Error(out.join(","));
```

IronHorse: `Error: undefined,undefined,undefined`.
Node: `Error: function,function,function`.
`../probes/compile/v2/annexb_top.js` (sloppy `if (true) function g(){}`): IronHorse
`SyntaxError: line 3: no block (strict code)`.
test262: in `annexB/language/{eval-code,function-code,global-code}`, 563 + 76 cases fail (the
B.3.3 family, shared with XS); `annexB/language/comments` fails 8 of 8; `annexB/language` passes
157 of 845.

**Fix:** Decide the Annex B profile and document it.
At minimum, change the message to "function declaration not allowed as a statement body".
If web scripts are a target, add HTML-like comments to the lexer (small) and B.3.3 hoisting to
the scoper (medium).

**Also:** none.

### CMP-11 — At most 65,534 distinct names per compile unit, reported at line 0 (low)

Symbol ids are 16-bit in the XS bytecode format, with id 0 reserved, and every distinct
identifier and non-index property key in a compile unit takes one.
The 65,535th name therefore gives `SyntaxError: too many symbols (maximum 65534)` with `line`
set to 0, outside the 1-based domain.
A generated data script with a 70,000-key object literal cannot be compiled; Node runs it.
The runtime's matching key-space limit raises a `RangeError` instead, so the same 16-bit limit
is classified two ways.

**Where:** `rust/engine/ironhorse-compile/src/coder.rs:296-312`, `:337-361`, `:365-371`.

**Evidence:** `../probes/compile/syms70k.js` (`var o={k0:0,k1:0,...}` with 70,001 keys) and
`../probes/compile/strkeys70k.js` (string keys): both
`SyntaxError: line 0: too many symbols (maximum 65534)`; Node completes both.

**Fix:** Document the ceiling for embedders and report the line of the first symbol past it.
Longer term, emit large literal key sets as runtime data rather than symbol operands, or widen
the id.

**Also:** PROP-2, BOOT-9 (the runtime half of the same namespace).

### T262-9 — `$262` has only `detachArrayBuffer`, and the module oracle has no `$262` (low)

Both engines install a `$262` with a single hook, `detachArrayBuffer`; `createRealm`,
`evalScript`, `global`, `gc`, `agent`, `IsHTMLDDA` and `AbstractModuleSource` are absent, and
the module-goal oracle path installs no `$262` at all.
Cases that use a missing hook cannot pass, so their counts measure the host, not the engine.
The 8 `AbstractModuleSource` failures are labelled as the oracle's missing `$262`, although
IronHorse fails them for lack of the stage 3 source-phase-imports surface, which XS's own
feature list skips.

**Where:** `rust/engine/ironhorse-vm/src/interp/boot.rs:2518-2541`;
`rust/engine/xs-oracle/csrc/xs_shim.c:399-416`, `:898`;
`rust/engine/ironhorse-262/src/xst.rs:1934-1961`.

**Evidence:** `../probes/skipped-features/hooks.py` over the oracle-off report, counting cases
whose own text uses each hook (`hooks.out`): `createRealm` 204 (200 fail, 4 not run),
`evalScript` 31 (28 fail, 3 pass), `agent` 112 (not run), `IsHTMLDDA` 35 (not run),
`AbstractModuleSource` 11 (8 fail, 3 unsupported).
Feature `cross-realm` passes 2 of 202 cases.

**Fix:** Add `evalScript` (the Script goal with GlobalDeclarationInstantiation on the current
realm, after T262-2) and `global`.
Install `$262` in the module oracle.
Add `source-phase-imports` to the feature skip list, as XS does, until it is implemented.
Treat `createRealm` as the multi-realm milestone.

**Also:** T262-2.

### T262-6 — A compiler panic or refusal on a positive case is filed as a skip (low)

`compile_for` maps a coder panic to `IronhorseCompile::Panicked` and an unported construct to
`Unsupported`, both with empty bytecode.
Negative cases treat Panicked as a Fail, but `evaluate_positive` never reads the compile
outcome: the empty bytecode stops the VM with Halt::Decode, and both outcomes become
`RunSkip("parse-or-decode")`.
The module path names panics `compiler-unimplemented:*`, so one condition has three classifications.
The CI gate `corpus_compiler_totality` compiles every test262 file in all five modes and fails
on any panic, so only the label is wrong today; the Unsupported leg is live for the 3
static-block cases (CMP-3).

**Where:** `rust/engine/ironhorse-262/src/lib.rs:412-421`;
`rust/engine/ironhorse-262/src/xst.rs:678`, `:1376`, `:1777-1790`, `:1853`.

**Evidence:** `../probes/verify/test262-harness/staticblock.js`
(`class C { static { let x = 1; } }`): `ironhorse-xst` prints
`InternalError: line 1: static block with lexical declarations deferred`; Node exits 0.
The expectation shards hold exactly 6 `parse-or-decode` rows: the three `static-init-scope-*`
files in both modes.

**Fix:** Classify the compile outcome before running, with one function shared by the positive,
negative and module paths: Panicked becomes `Fail("compiler-panicked:<goal>")` and Unsupported
becomes `RunSkip("compiler-unimplemented:<goal>")`.
Retire `parse-or-decode` for compile outcomes.

**Also:** T262-14; CMP-3.

### BOOT-9 — Key-space exhaustion is reported four ways, by entry path (low)

The u16 property-key space has a soft ceiling, which keeps 1,024 ids in reserve, and a hard
latch where the string and symbol id ranges meet.
The soft ceiling surfaces as a catchable `RangeError` from guest interning or eval relink; as
Halt::HeapExhausted from `environment_symbol` and `relink_unlinked_realm_program`; as
Halt::Decode(InvalidSymbols), "malformed input", from `Compartment::evaluate_with_symbols`,
which discards the TableFull/MalformedBytecode distinction; and as `TableFull` to direct
`relink_crank` callers.
The hard latch halts Refused.
A supervisor therefore sees "malformed message", "heap exhausted" or a guest exception for one
resource condition.
The outcome is deterministic per entry path, so replicas do not diverge.

**Where:** `rust/engine/ironhorse-vm/src/interp/property/keys.rs:53-58`;
`rust/engine/ironhorse-vm/src/interp/link.rs:1268-1271`;
`rust/engine/ironhorse-vm/src/interp/dispatch.rs:288-290`;
`rust/engine/ironhorse-vm/src/interp/natives/promise.rs:876-878`;
`rust/engine/ironhorse-vm/src/interp/realm.rs:1027-1030`, `:1048-1049`;
`rust/engine/ironhorse-vm/src/compartment.rs:783-786`.

**Evidence:** static, re-read at every site; `Halt::is_panic`
(`rust/engine/ironhorse-vm/src/interp.rs:1796-1811`) includes HeapExhausted and Decode but not
Refused.

**Fix:** Use one halt for the soft ceiling reached from host entry points (for example
`Halt::Refused("property-key:space-exhausted")`) and map `RelinkError::TableFull` to it; keep
`Decode(InvalidSymbols)` for `MalformedBytecode` only.

**Also:** INT-4 (the endo seam reports a full table as malformed bytecode); PROP-2; CMP-11.

### BOOT-12 — Heap endowments are refused late and as NotImplemented (low)

`Compartment::define_global(&str, Slot)` accepts any slot and refuses a heap-backed one only at
evaluation, as `Halt::NotImplemented("compartment:heap-endowment")`.
That is a deliberate policy with a documented replacement (`RootedValue`), and `halt_labels.rs`
reserves NotImplemented for unported features.
The same finding records that the VM crate's public API re-exports interpreter internals and
test hooks, and that `ModuleGraph::module` indexes an unscoped `ModuleId(pub usize)` without a
bounds check, so a host that passes an id from another graph panics.

**Where:** `rust/engine/ironhorse-vm/src/compartment.rs:463-467`, `:612-627`;
`rust/engine/ironhorse-vm/src/lib.rs:38-41`, `:55-60`, `:66-88`;
`rust/engine/ironhorse-vm/src/module.rs:61`, `:290-292`.

**Evidence:** static: `compartment.rs:624-626` reads
`CompartmentSkip::HeapEndowment => Halt::NotImplemented("compartment:heap-endowment")`; host
side only, not reachable from guest code.

**Fix:** Make `define_global` take primitives or a `RootedValue`, so heap slots are rejected by
type; classify the policy refusal as Refused.
Narrow the public surface, and make `ModuleId` opaque with a fallible lookup.

**Also:** BOOT-9.

### CORE-13 — Malformed-bytecode invariants are filed as skip-eligible NotImplemented (low)

Ten guards fire only on states the compiler does not produce: a private brand slot that is not a
closure cell, `super` with no home object, `CURRENT` at program level, `START_GENERATOR` or
`START_ASYNC_GENERATOR` with a `new.target`, a for-in or to-instance operand of a non-value
kind, and a template freeze failure.
They return Halt::NotImplemented with labels registered in `NOT_IMPLEMENTED_LABELS`, which both
differential instruments treat as honest skips.
Halt::EngineInvariant, defined for exactly this class and never skip-eligible, is already used
by sibling guards in the same functions.
A compiler regression that emitted such bytecode would be scored as an unported feature instead
of failing.

**Where:** `rust/engine/ironhorse-vm/src/interp/dispatch/private.rs:9`, `:113`, `:159`, `:218`;
`rust/engine/ironhorse-vm/src/interp/dispatch/super_property.rs:14`, `:78`;
`rust/engine/ironhorse-vm/src/interp/dispatch.rs:3488`, `:3656`, `:3694`, `:4280`, `:4415`;
`rust/engine/ironhorse-vm/src/interp/dispatch/iteration.rs:206`, `:288`; registry
`rust/engine/ironhorse-vm/src/halt_labels.rs:28-76`.

**Evidence:** `../probes/verify/vm-core-dispatch/c13_reach.js` exercises the guest-reachable
neighbours (for-in over primitives, `new` on generators, `Reflect.construct` with a generator,
`eval('super.x')` in methods and arrows, borrowed `super` methods) and matches Node exactly; no
test262 case reaches any of the ten labels.

**Fix:** Convert the sites to Halt::EngineInvariant and move their labels to the invariant set
pinned by `tests/halt_label_registry.rs`; keep NotImplemented for genuine gaps.

**Also:** FN-17 (same root, five more labels).
COV-10 (low) is the converse: a compiler defect makes the `EngineInvariant` guard
`await:no-async-instance` reachable where the honest outcome is the `module:top-level-await`
refusal, so an invariant halt is sound only once the compiler guarantees the state cannot occur
(full entry: `../COVERAGE.md`).

### FN-17 — Unreachable call guards are registered as NotImplemented declines (low)

Six guards return Halt::NotImplemented with the labels `call:non-user-function-receiver`,
`apply:non-user-function-receiver`, `bind:new-bound-target`, `callback:non-user-function`,
`proxy:construct-nonuser-target` and `async-generator:new-target`, all registered in
`NOT_IMPLEMENTED_LABELS`.
Each is unreachable by construction: every callable is a function row or a proxy, and async
generators are never constructors.
The harness maps a registered label to `RunSkip("unsupported-opcode:<label>")`, so a regression
that reached one would lower coverage silently.

**Where:** `rust/engine/ironhorse-vm/src/interp/apply.rs:273-275`, `:348-350`, `:528`;
`rust/engine/ironhorse-vm/src/interp/invoke.rs:76-78`, `:1169-1171`;
`rust/engine/ironhorse-vm/src/interp/dispatch.rs:4414-4417`;
`rust/engine/ironhorse-vm/src/halt_labels.rs:28-76`; `rust/engine/ironhorse-262/src/xst.rs:902-909`.

**Evidence:** static: `call_dot_call_native` returns false only when the native, method, bound
and proxy shapes are all absent, which is exactly the condition `enter_call_dot_call` requires
(`apply.rs:45-69`, `dispatch.rs:2583-2594`,
`rust/engine/ironhorse-vm/src/interp/function.rs:664-676`).

**Fix:** Reclassify the six as EngineInvariant labels and remove them from `NOT_IMPLEMENTED_LABELS`.

**Also:** CORE-13.

### INT-5 — The embedding classifies Halt four different ways (low)

`Halt::is_panic`, `ExecutionOutcome::classify`, `JsMachine`'s `classify` and `describe_halt`
disagree.
`ExecutionOutcome::classify` files NotImplemented and Refused as Panicked although its doc lists
them as non-panic halts, and it hits `debug_assert!(false)` for MachineBusy.
`JsMachineErrorKind` files EngineInvariant and HostAllocationFailed under `Halt` ("a guest throw
or a resource stop") and Decode, including key-table exhaustion, under `Engine`.
`describe_halt` has no arm for HeapExhausted or MachineBusy.
`MachineError::SymbolMismatch` is documented as the channel for relink refusals but is never
constructed.
A supervisor built on these classifiers would retry invariant violations as resource stops and
treat a full key table as malformed bytecode; none has a production consumer today, which is why
the finding is low.

**Where:** `rust/engine/ironhorse-vm/src/interp.rs:1796-1811`;
`rust/endo/src/ironhorse_engine.rs:193`, `:280-313`, `:370-394`, `:959`;
`rust/endo/src/engine/js_machine.rs:87-122`, `:342-356`.

**Evidence:** static: `ironhorse_engine.rs:378-392` reads
`halt @ (Halt::NotImplemented(_) | Halt::Refused(_)) => Panicked` and
`other => { debug_assert!(false, ...); Panicked(other) }`; `js_machine.rs:347-351` maps
`NotImplemented | Refused` to `Unavailable`, `Decode` to `Engine` and everything else to `Halt`;
`SymbolMismatch` occurs only as the variant, its `Display` arm and a doc mention.

**Fix:** Define one exhaustive classification over Halt (caused by the program, caused by the
host, engine defect; commit or discard) and derive `is_panic`, `ExecutionOutcome` and
`JsMachineErrorKind` from it.
Give `describe_halt` explicit arms, and either produce `SymbolMismatch` or delete it.

**Also:** INT-4, BOOT-9, INT-2.

### SNI-10 — Every persistence refusal is reported as a pending side table (low)

`stored_unpersistable_row` returns a free-text sentence, which
`MachineSnapshotError::PendingStateUnsupported` carries in a field named `row` and renders as
"heap holds live {row}: that side table does not travel yet".
The refusals are not side tables, and they fall into three classes: permanent policy (the
test262 `$262` host), unrepresentable by design (a guest Compartment on a machine with no
shared-realm primordial profile) and not yet carried (a live guest Compartment's environment
binding, compartment `globalLexicals`, heap-backed module cells).
The side-table ledger has no `Coverage::Pending` member, so "pending side table" names an empty set.
An embedder cannot tell whether to retry after an upgrade or never, and the message is
ungrammatical: "heap holds live a test262 `$262` host object, which no snapshot carries: that
side table does not travel yet".

**Where:** `rust/engine/ironhorse-snapshot/src/machine.rs:61-66`, `:77-82`, `:253-257`;
`rust/engine/ironhorse-vm/src/interp/persist.rs:590`, `:613`, `:640`, `:669`, `:674`, `:715`,
`:759`; `rust/engine/ironhorse-snapshot/src/sidetable.rs:181`, `:227-232`.

**Evidence:** static, re-read at each site; no code assigns `Coverage::Pending`.

**Fix:** Replace `row: &'static str` with a typed reason (`Policy`,
`NotYetCarried(GuestCompartment | CompartmentLexicals | HeapModuleCells)`, `Unrepresentable`,
`NonPersistingNative`, ...), render one message per class, and test that each `NotYetCarried`
entry corresponds to a design item.

**Also:** SNS-8, SNS-12, SNS-13 (the store side's failure classes).

### Cross-references

Findings whose substance belongs to another lens but that touch a skipped spec step or a refusal:

- CMP-1 (critical): CreateDynamicFunction skips the separate FormalParameters and FunctionBody
  parses; this is the SES-shim compartment escape.
- CORE-2 (high), same defect FN-1: `%AsyncFromSyncIteratorPrototype%` is not implemented, so
  `for await` over a sync iterable does not await values.
- NOBJ-8 (high): `AsyncDisposableStack.prototype.disposeAsync` does not await its disposers.
- NVAL-2 (high): BigInt `*` is uncapped while `**`, `<<` and `asIntN` are Refused-capped, and
  the work is charged after it is done.
- CORE-5 (high): spread into a native call grows the host value stack without bound.
- INT-1 (high) and MEM-1 (medium): no collection within a crank; the thixotrope worker never
  collects at all.
- NOBJ-1 (high, same defect PROP-1), PROP-2 (medium), INT-4 (low): the 16-bit key namespace is
  finite and never reclaimed.
- CORE-3 (medium) with RGX-2, RGX-3, NVAL-4, NOBJ-9: RegExp, Temporal, Intl and `disposed`
  accessors are emulated on the static read path and absent from the prototypes.
- FN-4, FN-5, FN-8 (medium): Promise fast paths skip NewPromiseResolveThenableJob,
  PromiseResolve's `constructor` check and the `finally` closures.
- T262-2 (medium): no global declarative record across Scripts; it also blocks `$262.evalScript`.
- T262-1, T262-5 (medium) and T262-14 (low): the harness labels differential agreement and
  refusals inconsistently.
- CMP-7 (medium): non-decimal literals are double-rounded, and sloppy `08.5` and `09e1` are
  rejected.
- RGX-6 (low): catastrophic backtracking is bounded only by an armed meter.
- NOBJ-17 (low): Map and Set iterators stop after `clear()` (XS purge model).
- SNS-8, SNS-12, SNS-13 (low): the store's failure taxonomy.
- INT-14 (low): the stack-depth refactor patches, including the path to FN-14's fix, no longer
  apply.

## Aborted conditions that should be exceptions

**Principle.**
A crank has a few budgets that may legitimately end it without the guest seeing anything: the
meter (MeterAbort), the heap ceilings (HeapExhausted), true frame depth (StackOverflow), host
allocation failure (HostAllocationFailed) and engine defects (EngineInvariant, Panic).
Every other deterministic limit a guest can reach should surface as a catchable error shaped as
the spec would shape it: `RangeError` for a size or a count, `SyntaxError` for source the engine
will not compile, `TypeError` where the spec's own check throws.
The same applies to a refusal of a feature the guest asked for.
A guest that can catch can degrade; an uncatchable halt turns a data-dependent condition (a 64
KB string, a 6 KB JSON document, a 2,100-element `apply`) into the loss of the whole crank, and
on the thixotrope worker, where every incomplete crank is fatal, the loss of the vat.
Determinism is unaffected either way, because the condition is deterministic.
The heap-ceiling budget is honest only once collection runs within a crank (MEM-1); today it
bounds cumulative allocation, not the live set.

**The label registry.**
`rust/engine/ironhorse-vm/src/halt_labels.rs` registers 46 NotImplemented labels (`:28-76`) and
49 Refused labels (`:80-130`), and both differential instruments treat a registered label as an
honest skip.
Of the 49 Refused labels, 20 are host-side policy (`host:*`, `machine:*`, `compartment:*`,
`lockdown:*`) and 29 are guest-reachable: 26 size caps plus `atomics:wait-notify`,
`collection-constructor:weak-symbol-oracle-version` and `property-key:id-space-exhausted`.
Of the 46 NotImplemented labels, verified findings show that 21 guard unreachable states
(CORE-13's 10, FN-17's 5 more, `typed-array-set:bigint`, and the 5 dead or unreachable natives
guards `concat:sparse-arg`, `join:reference-element`, `toString:reference-element`,
`array-species:symbol`, `typed-array-species:symbol`), one is a policy refusal
(`compartment:heap-endowment`), and about ten name real feature gaps (the module labels,
`compartment:dynamic-import`, two Intl and two Temporal features, `eval:compiler-unimplemented`).
The remaining dispatcher fallbacks (`Date:method`, `json:unmodeled`, `number:unmodeled`,
`string-method:unmodeled` and similar) were not classified by this review.
The compiler has a misfiling of the same class as CORE-13 and FN-17:
`emission_error` (`rust/engine/ironhorse-compile/src/coder.rs:6514`) reports an unknown or
malformed opcode emission, an internal invariant, under `ParseErrorKind::Unsupported`, the kind
for an unported construct (`../maps/compile.md:674`).
When the sites below change, the affected test262 cases move from "unsupported" to "pass" or
"fail", which is the honest outcome.

| Site | Condition | Current | Proposed | ID |
|---|---|---|---|---|
| `rust/engine/ironhorse-regexp/src/matcher.rs:127`; `rust/engine/ironhorse-vm/src/interp/natives/regexp.rs:556-558` | more than 65,536 retained match states | HeapExhausted | no error once the greedy fast path lands; otherwise `RangeError` ("regular expression too complex") | RGX-1 |
| `rust/engine/ironhorse-regexp/src/compile.rs:2221-2223`; `rust/engine/ironhorse-vm/src/interp/natives/regexp.rs:348-349` | quantifier bound above 2^31-1 | HeapExhausted at construction | no error: clamp the bound as XS does | RGX-1 |
| `rust/engine/ironhorse-vm/src/interp/frames.rs:347-350` | more than about 2,025 call arguments | StackOverflow | `RangeError`, with arguments counted once | FN-10 |
| `rust/engine/ironhorse-vm/src/interp/suspend.rs:901-1121`, `:224-411` | async nesting over 126, `yield*` over 50 to 70 | ReentryLimit | `RangeError` at the re-entry point until C5 removes the limit | FN-14 |
| `rust/engine/ironhorse-vm/src/interp/natives/json.rs:1323-1331`, `:828-840` | JSON nesting over 2,048 | ReentryLimit | no limit (heap stacks), or `RangeError` | NVAL-13 |
| 12 `0..1_000_000` loops (NOBJ-10's list) | more than 1,000,000 iterator steps | StepLimit; silent truncation in `groupBy` | no cap; if one is kept, `RangeError` and close the iterator | NOBJ-10 |
| `rust/engine/ironhorse-vm/src/interp/natives/array.rs:2397-4549` (13 constants) | array length above 2^24 | Refused; HeapExhausted at 2^24 in `sort` | iterate present keys; `RangeError` for exotic array-likes | NOBJ-11 |
| `rust/engine/ironhorse-vm/src/interp/natives/string.rs:741-746`, `:148-151` | `padStart`, `padEnd`, `String.raw` above 2^24 units | Refused | admit through `reserve_units`; `RangeError` only above the shared string limit | NVAL-9 |
| `rust/engine/ironhorse-vm/src/interp/natives/bigint.rs:264-265`, `:338-349`, `:638-640` | BigInt result above 64 Ki bits | Refused | `RangeError`, and the same cap on `*` | NVAL-9 |
| `rust/engine/ironhorse-vm/src/interp/natives/json.rs:664-667`, `:1045-1046`; `rust/engine/ironhorse-vm/src/interp/natives/regexp.rs:1666` | JSON lengths above u32; oversized `@@replace` result | Refused | `RangeError` | NVAL-9 |
| `rust/engine/ironhorse-vm/src/interp/admission.rs:131-133`; `rust/engine/ironhorse-vm/src/interp/natives/buffer.rs:2502` | one request larger than the heap ceiling (`repeat(2**28)`, a huge `ArrayBuffer`) | HeapExhausted | `RangeError` when the request alone exceeds the ceiling; cumulative exhaustion stays a halt | NVAL-9 |
| `rust/engine/ironhorse-vm/src/interp/natives/collection.rs:316-330` | symbol entry in a WeakMap or WeakSet constructor | Refused | `TypeError`, as the methods already throw, checking registered symbols first | NOBJ-13 |
| `rust/engine/ironhorse-vm/src/interp/natives/buffer.rs:2231-2234` | `Atomics.wait`, `notify`, `waitAsync` | Refused before validation | the spec's results; `TypeError` when [[CanBlock]] is false | NOBJ-14 |
| `rust/engine/ironhorse-vm/src/interp/eval.rs:117-121` | compiler `Unsupported` reached through `eval`, `Function` or `Compartment.evaluate` (static blocks) | NotImplemented `eval:compiler-unimplemented` | `SyntaxError` | CMP-3 |
| `rust/engine/ironhorse-vm/src/interp/natives/dispatch.rs:3152-3154`; `rust/engine/ironhorse-vm/src/interp/natives/intl.rs:1316-1319`; `rust/engine/ironhorse-vm/src/interp/natives/temporal.rs:1780-1782`, `:435` | `formatRange`, non-English compact notation, `ZonedDateTime.toLocaleString`, non-ISO `until`/`since` | NotImplemented | implement; until then a catchable error naming the unsupported feature | NVAL-9 |
| `rust/engine/ironhorse-vm/src/interp/dispatch.rs:4846`, `:4938` | `import()` | NotImplemented | a rejected promise, the spec's channel for a host that cannot load | BOOT-7 |
| `rust/engine/ironhorse-vm/src/interp/realm.rs:1027-1030`; `rust/engine/ironhorse-vm/src/compartment.rs:783-786` | property-key soft ceiling reached from a host entry point | HeapExhausted; Decode | one named Refused halt (host-side, so a halt is appropriate) | BOOT-9 |

The compile-time caps (CMP-8, CMP-11) and the regexp nesting cap already throw a catchable
`SyntaxError` and need no change of class.

## Recommended order

Criteria: real users first (Endo and the deployed thixotrope worker), then test262 cases
recovered per unit of effort, then how the gap fails (a halt that loses the crank is worse than
a wrong answer, which is worse than a loud refusal).

| Gap | IDs | test262 cases at stake (IronHorse verdict) | Effort | Who needs it |
|---|---|---|---|---|
| Direct-eval context in the thixotrope worker | INT-3 | 0 | S | the deployed worker, whose vat dies today |
| Caps that end the crank: 1M steps, JSON depth, argument count, weak-symbol constructors, size caps, quantifier clamp | NOBJ-10, NVAL-13, FN-10, NOBJ-13, NVAL-9, RGX-1 | 1 | S each | every guest that handles large data |
| Atomics validation and the CanBlock harness rule | NOBJ-14 | up to 118 | S | test262; correctness |
| Harness honesty: TCO skip, multi-agent substring, compile-outcome classifier, 21 unreachable NotImplemented guards | FN-18, NOBJ-14, T262-6, CORE-13, FN-17 | 0 directly (35 + 118 become measured) | S | the conformance report |
| Static module linking, then `importNow`, `import`, `ModuleSource` | BOOT-7, BOOT-8 | 134 + 34 + 6, and hardened262's 63 module files | L (staged) | Endo's native compartments |
| Persisting live compartments and `globalLexicals` | inventory (`persist.rs:640`, `:669`) | 0 | M | any Endo vat that creates a compartment |
| Greedy regexp fast path | RGX-1 | 451 | M | any regexp over input larger than 64 KB |
| Frozen tzdb snapshot | NVAL-6 | part of the plain-host failures (406 `ZonedDateTime`, 122 `DateTimeFormat`); 19 `canonical-tz` | M | anything that shows local time |
| Small standard built-ins: TypedArray change-by-copy, `Iterator.prototype.includes`, `chunks`, `windows`, `Iterator.zip`, `Atomics.pause`, `Date.prototype.toTemporalInstant` | NOBJ-12 and inventory | 38 + 40 + 69 + 77 + 5 + 8 = 237 | S each (`zip` M) | test262; library code |
| Spec-model fixes: global prototype, immutable `Object.prototype`, fresh iterator results | CORE-4, PROP-6, PROP-8 | 12 | S each | shims that probe `globalThis`; iterator consumers |
| Class static blocks | CMP-3 | 4 | M | modern libraries, ES2022 TypeScript output |
| `import()` and top-level `await` | BOOT-7 | 436 + 211 (+ 148 failing `dynamic-import` cases) | L | Endo dynamic loading |
| Nesting limits: C5, proper tail calls, flat chains | FN-14, FN-18, CMP-8 | 35 | M each | recursive async code; generated code |
| Temporal on `temporal_rs`; Intl data on ICU4X; an oracle-independent gate first | NVAL-7, NVAL-8, NVAL-5 | up to about 4,500 Temporal and 650 `intl402` | L | localized applications |
| Symbols as weak keys | NOBJ-13 | 28 | M | libraries keyed by symbols |
| Annex B.3.3 and HTML-like comments | CMP-12 | 563 + 76 + 8 | M | sloppy web scripts only |
| Multi-realm (`createRealm`), ShadowRealm, stage 3 proposals | T262-9 and inventory | 200 + 64 + about 450 | L | later |

In order:

1. **Stop the crank-killing halts and fix the deployed worker** (all S).
   INT-3 is a one-dependency change that keeps a thixotrope vat alive.
   Removing the 1M caps, giving JSON its own budget, counting call arguments once, throwing
   `TypeError` from the weak-symbol constructors, routing size caps through `reserve_units` and
   clamping regexp quantifier bounds recover almost no test262 cases, but each removes a way for
   ordinary data to end a crank.
2. **Make the harness measure what it hides** (S).
   Remove `tail-call-optimization` from the skip list, narrow the multi-agent pre-skip to
   `$262.agent` users and apply [[CanBlock]] = false, classify compile outcomes once, and move
   the 21 unreachable NotImplemented labels to EngineInvariant.
   Then implement the non-blocking Atomics results (NOBJ-14): up to 118 cases for a small change.
3. **Modules and the Compartment surface, for Endo** (L, staged).
   Static linking of a registered graph first (BOOT-7), which unlocks `importNow`; then
   `import`, `ModuleSource` and the `modules` option (BOOT-8); then lift the persist gate on
   live compartments and their `globalLexicals` (`designs/ironhorse-guest-compartment.md` §7),
   so a vat that creates a compartment can be checkpointed.
   `import()` and top-level `await` follow, with deterministic job ordering.
4. **RGX-1's greedy fast path** (M): the best ratio of test262 cases to effort among engine
   fixes (451 cases), and it removes a high-severity halt on realistic inputs.
5. **NVAL-6's tzdb snapshot** (M): a high-severity wrong answer on the main path of using a
   named zone.
6. **Small standard built-ins and spec-model fixes** (S each): about 250 cases.
   Decide `Math.random` explicitly (a host-seeded deterministic generator, or a documented
   throwing stub) rather than leaving it absent.
7. **CMP-3 static blocks** (M): few test262 cases, but real library code hits it, and through
   `eval` it currently ends the crank.
8. **FN-14 (C5), FN-18 (proper tail calls), CMP-8 (flat chains)** (M each): XS parity and
   generated code.
9. **Temporal and Intl** (L): put an oracle-independent gate in place first, so progress is
   visible, then adopt `temporal_rs` and ICU4X data; until then, refuse what is not modelled
   instead of answering in English or at standard time.
10. **NOBJ-13 symbols as weak keys** (M) once an oracle or an oracle-independent expectation exists.
11. **Annex B**: decide the profile.
    B.3.3 is 639 cases at M effort, but it serves only sloppy web scripts, and Hardened
    JavaScript code is strict; fix the "(strict code)" message now and implement hoisting only
    if web scripts become a target.
12. **Later**: `createRealm` and ShadowRealm, and the stage 3 proposals (`await-dictionary` 87
    cases, `import-defer` 160, `decorators` 22, immutable `ArrayBuffer` 64,
    `Iterator.prototype.join` 16, source-phase imports).

Not worth doing: `Function.prototype.toString` source retention (79 of the 80 tests pass once
T262-2's Script split is fixed, because the test helpers accept the NativeFunction form),
`$262.agent` multi-agent support, `IsHTMLDDA`, the legacy RegExp statics (Hardened JavaScript
removes them) and `Error.captureStackTrace` (in neither the spec nor XS).

## Leads that did not survive

Verifier corrections and downgrades relevant to this lens:

- CMP-3 was downgraded from high to medium: it refuses a spec feature; it is neither a host
  panic nor a wrong answer on a common path.
- T262-7 was raised to high by its first verifier and lowered to medium by its second, which
  judged the halt a loud deterministic bound rather than a wrong result; it is merged into
  RGX-1, whose second verifier kept high because realistic inputs reach it and no design
  document records the cap.
- NOBJ-14 was verified low on its own; the merge with T262-4 (medium) carries the harness's
  over-capture.
- T262-6 was downgraded from medium to low: the CI gate `corpus_compiler_totality` catches
  compiler panics before a sweep could misfile them.
- BOOT-9 was downgraded from medium to low: the outcome is deterministic per entry path and
  needs about 64k distinct names.
- INT-5 was downgraded from medium to low: neither `ExecutionOutcome` nor `JsMachine` has a
  production consumer.
- RGX-6 was downgraded from medium to low: exponential backtracking without a meter hangs Node
  and XS too; only `run_bounded`'s documented guarantee is broken.
- NVAL-5 was lowered from high to medium by its second verifier: collation order is
  implementation-defined and design decision 10 disclaims full ECMA-402; only the option
  semantics are spec violations.
- NVAL-6's second verifier kept high: accepting a zone and answering it wrongly is not covered
  by the disclaimer.
- CORE-4 was downgraded from high to medium: the global's prototype is host-defined and
  bare-name resolution is patched; PROP-7's verifier found 10 affected test262 cases, not 1.
- CMP-12's B.3.3 omission is a silent behaviour change, not a refusal (verifier's correction).
- NOBJ-11's per-iteration caps are unreachable for real Arrays today, because NOBJ-1's
  `RangeError` fires first; only the up-front caps are reachable.
- BOOT-7's map counts (1,582 dynamic-import and so on) were expectation-shard lines; the case
  counts are those quoted above.
- BOOT-8: relative to XS, only `import` and `importNow` are missing from
  `Compartment.prototype`; `load`, `module` and a `name` getter are SES parity.
- NOBJ-12's test262 impact is 38 failing cases, not the map's 76 rows.
- NVAL-8's non-Temporal `intl402` pass rate is 51 percent, not about 23 percent; the larger
  figure folds in `intl402/Temporal`.

The maps' own leads, and checks made for this lens:

- `Function.prototype.toString` source text, listed by two maps as 136 to 152 shared skips:
  assembled as single Scripts, 79 of 80 tests pass
  (`../probes/skipped-features/tostring_single_script.out`); the failures are T262-2's Script
  split, not a missing feature.
- `module:compiler-rejected` is 92 `import-defer` cases plus 6 arbitrary-module-namespace-name
  cases (`compiler_rejected.out`), not "97 + 1" as the harness map had it.
- The 108 `built-ins/RegExp/unicodeSets` shared failures belong to T262-2's harness artifact,
  not to the `v` flag.
- Generators, async functions, WeakRef, FinalizationRegistry and Proxy no longer refuse
  persistence; `Coverage::Pending` is empty (snapshot-image-codec map).
- RegExp's `CompileError::Unsupported` honest-skip surface is empty in practice (regexp map).
- `NotImplemented("concat:sparse-arg")` is unreachable behind a dense-operand guard
  (natives-objects map).
- Deep plain recursion halting StackOverflow at about 4,060 frames, and cyclic `[a].join()`
  halting ReentryLimit, are the engine-wide, xsnap-faithful policy (core-dispatch and
  natives-objects maps).
- Every over-deep source shape in the compiler is a catchable `SyntaxError`, including through
  `eval` and `Function` (compile map); RegExp nesting is capped at 512 with a catchable
  `SyntaxError` (regexp map).
- The unhandled opcodes `HOST`, `CODE_ARCHIVE_*`, `STRING_ARCHIVE_*` and `NO_CODE` are XS-only;
  the compiler emits none of them (core-dispatch map).
- No guest-reachable key-space poison latch was found; every exhaustion probe produced a
  catchable `RangeError` (property-model map).
- The comment calling fractional non-decimal `Number.prototype.toString` "an honest named skip"
  is stale; the feature is implemented and matches Node (natives-values map).

## What this lens did not cover

- Except for the `Function.prototype.toString` re-run and the test262 tallies, no probe was
  re-run for this lens; the evidence comes from the verification passes.
- The effort classes are judgments, not estimates from code sizing.
- Spec stages come from the pinned corpus's `features.txt`; they were not checked against TC39's
  current process document.
- About ten NotImplemented labels (dispatcher fallbacks such as `Date:method` and
  `json:unmodeled`) were not classified as gaps or invariants.
- XS's own behaviour at most limits (argument counts, JSON depth, async nesting) was not
  measured, except where a verifier ran the oracle.
- The Hardened JavaScript axis is not measured by test262 at this commit (`ses_mode` is `none`
  in both sweeps); the hardened262 file counts come from
  `designs/ironhorse-guest-compartment.md`, not from a run.
- The endo daemon's worker path and the wasm32 target were not exercised.
- Wrong-result defects, metering and memory, taxonomy beyond refusals, and harness scoring are
  covered by the correctness, performance, ontology and test262 lenses; they appear here only as
  cross-references.
