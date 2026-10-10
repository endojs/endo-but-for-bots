# Moddable SDK 10.0.0 to IronHorse port plan

| | |
|---|---|
| **Created** | 2026-10-10 |
| **Updated** | 2026-10-10 (panel rounds 1 to 3) |
| **Author** | kriscendobot (prompted) |
| **Status** | Proposed |

## What is the Problem Being Solved?

IronHorse (`rust/engine`) is this repository's Rust JavaScript engine. It
deliberately tracks the semantics of XS, the C engine in the Moddable SDK, and
it is tested differentially: `ironhorse-262` runs the test262 conformance corpus
on IronHorse and on an **oracle**, an `xst` build of XS compiled from the
`c/moddable` submodule, and records each case's result in checked-in
**whole-tree expectations**. The **covered set** is the list of cases IronHorse
passes; the **ratchet floor** is the dated covered set that no later change may
shrink, and a **candidate** is a freshly generated covered set proposed to
replace it.

Moddable SDK 10.0.0 contains a concentrated set of XS engine corrections made
between 2026-09-04 and 2026-10-08. An engine that copies the behavior of an
older XS can keep a defect that XS has since fixed. The oracle is still XS 8.3.1, so it
cannot reveal those defects either. This plan classifies every requested
release item against `rust/engine` at `7d2eb307a`, identifies the actual
IronHorse gaps, and turns only those gaps into review-held implementation jobs.

The order of the work follows from that. Because the oracle is old, it cannot
check the ports, so each port is checked by targeted Rust tests whose expected
values come from the specification. The oracle pin moves last, in a separate
validation job, only after every port has finished, so that a regenerated
expectation tree cannot record an unfinished port as the new normal.

The oracle pin target is the annotated `10.0.0` tag,
`5f215f776f93039755343dbe75a09aa2615045f4`. That commit is Pebble platform glue
only; the `version 10.0.0` commit is
`80a253cadc6908ed616d8b156917c8fe8badbe53`. Every engine correction below is an
ancestor of the tag target, so pinning the tag picks them all up without
bringing Pebble into scope.

The pin move spans more than the audited window. The current pin is
`23b4d6b0a65f` (XS 8.3.1), and moving it to the 10.0.0 tag brings in every XS
change between the two. This plan classified only the requested corrections
made from 2026-09-04 to 2026-10-08; other XS changes in the pin-to-pin range
were not audited. Child 6 therefore treats any result change that no row below
explains as **unclassified oracle drift** and triages it (§ Oracle, matrix, and
ratchet change control).

The four classifications are exclusive:

- `already-conformant`: the named IronHorse path already has the corrected
  behavior.
- `needs-port`: IronHorse has the old behavior or lacks a required proposal
  surface it intends to support.
- `not-applicable`: the prerequisite feature is not implemented in IronHorse,
  so the correction has no reachable IronHorse analog.
- `host-excluded`: the feature is refused on purpose by the single-agent,
  deterministic host policy, and stays refused.

ECMA-419, device, Piu, board, TypeScript, xsdb, and the tagged Pebble change are
out of scope: the source inventory found no `rust/engine` impact from them.

## Release classification

### Summary

| Classification | Count | Items and owning child |
|---|---:|---|
| `needs-port` | 10 | R01 revoked Proxy callability (1); R02 scope-slot limit, R03 labeled exit from `switch` (2); R04 `Math.round`, R05 `repeat`, R06 `Array.from` ToLength order (3); R17 TypedArray length-constructor order, R18 `set` order, R19 constructor content type (4); R22 immutable ArrayBuffer (5) |
| `already-conformant` (provisional) | 12 | R07 to R16 (3), R20 and R21 (4). Reading-based until each row's probe lands; see § Evidence basis |
| `not-applicable` | 2 | R23 `setFromHex`, R24 ArrayBuffer `resize` |
| `host-excluded` | 2 | R25 `Atomics.wait`, R26 `Math.irandom` |

### Evidence basis

IronHorse evidence was gathered by reading the named functions at `7d2eb307a`.
The test262 column quotes the checked-in expectation files at the same commit,
not a fresh run. Expectation files are under
`rust/engine/ironhorse-262/expectations/whole-tree/`, one file per directory
(for example `language%2Fexpressions%2Ftypeof%40%400000.txt`). Any row's claim
can be reproduced with `grep -rh '^<test-path>' .` in that directory; for
example:

```sh
cd rust/engine/ironhorse-262/expectations/whole-tree
grep -rh '^language/expressions/typeof/proxy.js' .
```

Each expectation line starts with the test path, then the mode and the result.
The command above prints, among others:

```text
language/expressions/typeof/proxy.js strict fail:"ironhorse failed a harness assertion the oracle passed: Test262Error: Expected SameValue(«\"object\"», «\"function\"») to be true"
```

A `fail:` line means IronHorse's result differs from the oracle's and the
oracle passed; it records an IronHorse gap, not an oracle defect.

A passing expectation proves nothing for a case that a skip hides or that the
corpus does not contain. Every `already-conformant` verdict is therefore
provisional, and each such row names a child that adds a targeted Rust probe
for the corrected behavior. Until the probe lands, the row is a reading-based
verdict; if the probe fails, the row becomes a `needs-port` item in the same
child, subject to the probe-failure limit under § Implementation children. The
child's PR changes each probed row from `already-conformant` (provisional) to
`already-conformant` (or to `needs-port`) in this table, so a grep for
`(provisional)` lists exactly the rows whose probe has not landed.

Code paths are under `rust/engine/` unless stated otherwise. The XS commit
column links `https://github.com/Moddable-OpenSource/moddable/commit/<sha>`.

### Items

Each row has a stable ID (R01 to R26), and the table is sorted by owning child,
with the rows that no child owns listed last. To find a child's work, read the Child column;
§ Implementation children lists the same IDs per child.

| ID | Release item | XS commit | Classification | Child | IronHorse evidence | test262 expectation |
|---|---|---|---|---|---|---|
| R01 | Revoked Proxy IsCallable / IsConstructor | `1e71939f630a` | `needs-port` | 1 | `ironhorse-vm/src/interp/function.rs::{slot_is_callable,slot_is_constructor}` return false when `ProxyData.revoked` is set, losing the proxy's immutable `[[Call]]`/`[[Construct]]` shape. Snapshot rows must retain the shape independently of the cleared target. | `typeof/proxy.js`, revoked-function-proxy creation/revocation, and revoked base-constructor cases fail while the 8.3.1 oracle passes. |
| R02 | More than 65,535 scope slots | `cfe72a8cfcd2` | `needs-port` | 2 | `ironhorse-compile/src/coder.rs::width_select_index_plus_one_family` selects beyond the `_2` opcode family and truncates the operand; the scoper has no 65,535-slot cap, so corrupt bytecode reaches a private opcode. | XS implementation limit, no test262 case. The counting rule is pinned below under child 2. |
| R03 | Labeled `break` / `continue` leaving `switch` | `051b31b2dc09` | `needs-port` | 2 | `coder.rs::code_switch` pops the discriminant only at its own break target; `code_break_continue` ignores `Target.stack_level`, leaking one stack value per labeled exit. | No focused test262 expectation. Add looped continue, labeled break, nested switch, and try/finally cases; update only byte-identity fixtures whose intentional POP changes. |
| R04 | `Math.round` subnormals | `7b3bd37515af` | `needs-port` | 3 | `ironhorse-vm/src/interp/natives/number.rs`, `Math1::Round`, uses `a.is_normal()` and the old strict +/-(2^52 - 1) window, so `Number.MIN_VALUE` and its negation come back unchanged. | `built-ins/Math/round` is green but has no subnormal case. Pinned results, from the specification and the XS change from `c_isnormal` to `c_isfinite`: `Math.round(Number.MIN_VALUE)` is `+0`, `Math.round(-Number.MIN_VALUE)` is `-0`, and `Math.round(0.49999999999999994)` is `+0` (the current `floor(a + 0.5)` form gives `1`). Add those plus signed-zero and boundary regressions. |
| R05 | String `repeat` with an empty receiver and huge finite count | `4b1afbc46e3f` | `needs-port` | 3 | `natives/string.rs`, `NativeMethod::StringRepeat`, rejects `n > 0x7fff_ffff` before its empty-content fast return. | `String/prototype/repeat` passes because test262 stops at 2^31 - 1. Add empty-string cases at 2^31 and `Number.MAX_SAFE_INTEGER`, while Infinity and negative counts keep throwing. |
| R06 | `Array.from` ToLength / Construct order | `eb7d6de2802c` | `needs-port` | 3 | `natives/array.rs::array_from_inner` computes ToLength correctly, but the array-like path rejects a length above `u32::MAX` before `Construct(C)`; `ironhorse-262/tests/error_messages_async.rs` locks the old early error. | Ordinary `Array/from/source-object-length.js` passes; there is no test262 case proving `C` is called for length `2**32`. Add that order case. |
| R07 | `charAt` / `charCodeAt` truncation | `6099bb0d146b` | `already-conformant` (provisional) | 3 | `natives/string.rs::call_string_indexed` uses `array_to_integer_or_infinity`; f64-to-i64 saturation prevents 32-bit wrap. | `String/prototype/{charAt,charCodeAt}` passes. Probe: positive and negative Infinity, and `2**32+1`. |
| R08 | String `replace` / `replaceAll` / RegExp `@@replace` Proxy callability | `dca752b707d4` | `already-conformant` (provisional) | 3 | `function.rs::slot_is_callable` follows live proxy targets and the replace/RegExpExec paths in `natives/regexp.rs` use that predicate. | `String/prototype/{replace,replaceAll}` and RegExp `Symbol.replace` expectations pass. Probe: callable-Proxy replacer and `exec`. |
| R09 | String index/search methods with no argument | `4340468ff9c8` | `already-conformant` (provisional) | 3 | `natives/string.rs::call_string_indexed` supplies `undefined` and then ToString for omitted search values in `indexOf`, `lastIndexOf`, `includes`, `startsWith`, and `endsWith`. | All five expectation files pass, but none calls the method with zero arguments. Probe: each method with no argument. This item is not `String.prototype.search`, which had no corresponding release change. |
| R10 | `Symbol.for()` with no argument | `912290f420e4` | `already-conformant` (provisional) | 3 | `natives/dispatch.rs`, `NativeMethod::SymbolFor`, receives the missing argument as `undefined`, applies ToPrimitive/ToString, and uses `symbol_registry`. | `Symbol/for` passes except `cross-realm.js`, a named shared skip. No case calls it with zero arguments. Probe: `Symbol.for() === Symbol.for("undefined")`. |
| R11 | `Array.from` non-callable iterator order | `a795d3e926d3` | `already-conformant` (provisional) | 3 | `array_from_inner` reads `@@iterator` and rejects a non-callable method before constructing the target. | `Array/from/get-iter-method-err.js` and custom-constructor iterator cases pass. Probe: a counting constructor that must not be called. |
| R12 | `Reflect.apply` / `Reflect.construct` argument read order | `7abe778a17a2` | `already-conformant` (provisional) | 3 | `natives/reflect.rs::reflect_call_operands` validates, calls `arraylike_to_vec`, then dispatches the target/trap; the opcode fast path shares it. | Both `Reflect/{apply,construct}` trees pass with no skips. Probe: a Proxy target whose trap logs before or after the argument-list reads. |
| R13 | `Object.prototype.toString` through a handler | `477da5802658` | `already-conformant` (provisional) | 3 | `natives/dispatch.rs`, `NativeMethod::ObjectToString`, determines Array/callable brand first and reads `@@toStringTag` through the ordinary MOP, so a proxy `get` trap observes it. | `Object/prototype/toString/proxy-*` passes. Probe: a callable Proxy whose `get` trap records the `@@toStringTag` read. |
| R14 | `Array.fromAsync` non-object `next` result | `fbbd2cbb8d42` | `already-conformant` (provisional) | 3 | `natives/array.rs::from_async_resume_next` rejects the result promise with a TypeError when the awaited iterator result is not a reference. | `Array/fromAsync` passes all 186 recorded rows, including the non-object result cases. |
| R15 | Set methods with size above 2^31 - 1 | `0768ebb7c6a8` | `already-conformant` (provisional) | 3 | `natives/collection.rs::get_set_record` retains `size` as f64/Infinity and every branch compares that full value. | Set operation trees pass the large fake-size cases such as `union/size-is-a-number.js`. |
| R16 | `String.prototype.replace` capture-group memory safety | `db0490c5bcd5` | `already-conformant` (provisional) | 3 (IronHorse probe), 6 (oracle run) | `natives/regexp.rs::{regexp_generic_substitution,regexp_get_substitution,string_plain_substitution}` append to a bounds-checked `Vec` in one pass. `$<name>` performs one `mop_get` and ToString per occurrence; indexes are clamped, saturated, or checked before every slice. The crate forbids unsafe code. | `RegExp/prototype/Symbol.replace/named-groups*` and `result-coerce-groups*` pass. See the capture-group note in the appendix. |
| R17 | TypedArray length constructor: ToIndex before prototype read | `df98bbacb808` | `needs-port` | 4 | `natives/dispatch.rs::native_ctor_buffer`, `Native::TypedArray` length arm, calls `to_number_f64`, then `typed_array_prototype`, then `index_from_number`; the comment names the old XS order. | `TypedArrayConstructors/ctors/length-arg` is largely hidden by resizable-buffer skips. Add a `newTarget.prototype` getter plus negative, oversized, and throwing lengths. |
| R18 | TypedArray `set` array-like offset/read/detach order | `2d059ebaee86` | `needs-port` | 4 | `natives/buffer.rs`, `NativeMethod::TypedArraySet`, rejects offsets above `i32::MAX` before `arraylike_length`, and throws after each array-like element detaches the target where the spec performs the failed integer-indexed set without that throw. | `set/array-arg-targetbuffer-detached-on-get-src-value-no-throw.js` fails; resizable-dependent order cases skip. Add a huge-offset/source-length order case. |
| R19 | TypedArray constructor content type | `c645752e4b44` | `needs-port` | 4 | The source-TypedArray arm in `natives/dispatch.rs::native_ctor_buffer` copies zero elements without checking BigInt-versus-Number domain, so empty cross-domain construction succeeds. | `ctors*/typedarray-arg/src-typedarray-{big,not-big}-throws.js` is masked by resizable-buffer setup. Add zero-length cross-domain cases. |
| R20 | TypedArray `fill` coercion and detached check | `2d530640aed4` | `already-conformant` (provisional) | 4 | `natives/buffer.rs`, `NativeMethod::TypedArrayFill`, coerces value, start, and end, then checks `detached_buffers`; `ironhorse-262/tests/typed_array_mutators.rs` pins single coercion and detachment during coercion. | `TypedArray/prototype/fill` has 22 passing cases and 82 named resizable skips. The existing `typed_array_mutators.rs` cases are the probe; child 4 confirms they cover the XS order. |
| R21 | TypedArray species content type | `c645752e4b44`, `d19b9da1e009` | `already-conformant` (provisional) | 4 | `natives/buffer.rs::typed_array_species_create` compares source and target element domains and throws TypeError. | Species content-type cases agree when reachable; resizable-buffer cases remain named skips. Probe: `filter`, `map`, `slice`, and `subarray` with a cross-domain species constructor. |
| R22 | Immutable ArrayBuffer | `f98758c91a2d` (default on), `33cc1b4bf1ce` | `needs-port` | 5 | `ironhorse-vm/src/interp/boot.rs` binds no `immutable`, `sliceToImmutable`, or `transferToImmutable`; buffer, TypedArray, and DataView writes carry no immutable bit. `ironhorse-vm/tests/ses_boot_intrinsics.rs::FROZEN_REALM_FORECLOSURE` explicitly depends on the native methods being absent. | `ArrayBuffer/prototype/{immutable,sliceToImmutable,transferToImmutable}` is mostly `skip:shared-*` or resizable-buffer skips; `sliceToImmutable/this-is-not-detached.js` is only a vacuous pass. Add native-surface, write-rejection, transfer, slice, persistence, and SES-boot cases. |
| R23 | `setFromHex` validation order | `c97c28ec568a` | `not-applicable` | none | No `Uint8Array.prototype.setFromHex`, `fromHex`, or base64 native exists. | `Uint8Array/prototype/setFromHex` records missing-surface failures; the detached case passes only because the missing call throws a TypeError. Do not port an ordering fix without the feature. |
| R24 | ArrayBuffer resize rejection order | `b4e0cab143c7` | `not-applicable` | none | `natives/dispatch.rs`, `NativeMethod::ArrayBufferResize`, always returns `Halt::NotImplemented("array-buffer-resize:unsupported")`; resizable construction is also refused. Resizable buffers are unimplemented rather than banned by policy. | `ArrayBuffer/prototype/resize` is uniformly a named unsupported-opcode skip. |
| R25 | `Atomics.wait` leak/deadlock and post-coercion revalidation | `e1fa1b788922`, `83ab166a0386` | `host-excluded` | none | `natives/buffer.rs::atomics_dispatch` refuses wait/notify/waitAsync before allocating a waiter or taking a lock; the single-agent fixed-buffer profile has no resizable view to revalidate. | `Atomics/wait*` is pre-skipped as `structural:can-block` / `structural:multi-agent`. Keep the refusal test; do not add waiter machinery. |
| R26 | `Math.irandom` | `d17c0de3099b` | `host-excluded` | none | `ironhorse-vm/src/interp/realm.rs` and `interp/native_ids.rs` omit nondeterministic `Math.random`; the XS-only `irandom` and `imod` extensions are absent by the same deterministic-host policy. | No test262 item exists. |

### Worked example: revoked Proxy

```js
const { proxy, revoke } = Proxy.revocable(function () {}, {});
revoke();
typeof proxy;
```

The specification says a Proxy's `[[Call]]` slot is fixed when it is created,
so `typeof proxy` stays `"function"` after revocation, and only an actual call
throws a TypeError. XS 10.0.0 (`1e71939f630a`) and the 8.3.1 oracle both return
`"function"`. IronHorse returns `"object"`, because `slot_is_callable` checks
`ProxyData.revoked` first. The checked-in expectation records exactly this:
`language/expressions/typeof/proxy.js` fails with
`Expected SameValue("object", "function")`. Child 1 keeps the callable and
constructable shape on the proxy row itself, so it survives revocation and a
snapshot round trip, and that expectation turns to `pass`.

## Implementation children

Every child is independently claimable. Each one adds the targeted Rust tests
for its rows, including the probes for its `already-conformant` rows. Sizes use
the calibrated categories in the roadmap's
[Size and Time Estimates](README.md#size-and-time-estimates).

| Child | Parked basename | Size | Scope and acceptance |
|---|---|---|---|
| 1 callability | `moddable-10-0-0-ironhorse-callability-port` | M, 2 to 3 days | R01. Preserve callable/constructable proxy shape through revocation and persistence; pass the four failing revoked-proxy expectations plus snapshot round trips. Follows the snapshot-golden rule under § Orchestration. |
| 2 compiler safety | `moddable-10-0-0-ironhorse-compiler-safety-port` | M, 2 to 3 days | R02, R03. Port the XS scope-slot limit with the counting rule below, and unwind switch temporaries on every labeled exit; targeted compiler/runtime and byte-identity tests. |
| 3 built-ins order | `moddable-10-0-0-ironhorse-builtins-order-port` | M, 2 to 3 days | Ports R04, R05, R06; probes R07 to R16. The R08 and R13 probes cover revoked as well as live callable proxies, and are re-run after child 1 merges, because child 1 changes the `slot_is_callable` predicate they rest on. R16 has a partner check in child 6 (the capture-group oracle run). |
| 4 TypedArray | `moddable-10-0-0-ironhorse-typedarray-port` | M, 2 to 3 days | Ports R17, R18, R19; probes R20 and R21 without changing their logic. |
| 5 immutable ArrayBuffer | `moddable-10-0-0-ironhorse-immutable-arraybuffer-port` | L, 1.5 to 2 weeks | R22. Opens with a short design note (below) before any write-path code. Implement immutable buffers and write guards with direct native-surface, write-rejection, transfer, slice, detached-precedence, snapshot, and SES-boot tests; update `FROZEN_REALM_FORECLOSURE` from measured behavior. Follows the snapshot-golden rule under § Orchestration. Does not move the oracle pin, the hardened262 matrix, or the ratchet. |
| 6 oracle validation | `moddable-10-0-0-ironhorse-oracle-validation` | M, 3 to 5 days | Refuses to start unless the ports completion is clean (§ Orchestration). Move the oracle pin, re-audit overlays, triage unclassified oracle drift, run the hardened262 matrix and the R16 capture-group oracle check, and produce the candidate ratchet comparison, all described under change control below. |

Children 1 to 5 run in parallel; the numbers identify children and do not
give an execution order. Only child 6 runs after the others.

Every expected value in a port child's tests cites the specification step or
the XS 10.0.0 diff hunk it comes from, in a comment beside the assertion, so a
reviewer can check the spec reading separately from the code.

**Probe-failure limit.** A probe that fails in children 3 or 4 is ported in the
same child only while that child has at most two failed probes. At the third,
the child stops, reports the failed probes, and each becomes its own parked
`gate: go-ahead` follow-up job for the maintainer to size and authorize; the
child's sizes above assume no more than two such conversions. This matches the
stop-and-report rule for child 2.

The basenames name the area each child changes. They share the
`moddable-10-0-0-ironhorse-` prefix with the orchestration
`moddable-10-0-0-ironhorse-ports`, so a prefix search on the board returns the
whole campaign; that is intended.

### Immutable ArrayBuffer design note (child 5)

Child 5 touches the buffer, TypedArray, and DataView write paths, transfer and
slice semantics, snapshot persistence, and the SES-boot foreclosure test. Its
first commit is a short design note, reviewed before write-path code lands,
that decides three things:

- **Representation.** Where the immutable bit lives (on the buffer row, or in a
  side table keyed by buffer), and how every write path reaches it.
- **Precedence.** The order of the detached and immutable checks on each write,
  `transfer`, and `slice` path, taken from the specification.
- **Persistence.** Whether the bit changes the snapshot row format. If it does,
  the note names the format-version bump and the golden fixtures it
  regenerates, under the snapshot-golden rule in § Orchestration.

### Scope-slot counting rule (child 2)

XS commit `cfe72a8cfcd2` adds, in `xs/sources/xsScope.c`, the check
`if (binder->scopeMaximum > 65535) fxReportParserError(..., "too many variables")`
after `fxScopeBound` in `fxFunctionNodeBind`, `fxModuleNodeBind`, and
`fxProgramNodeBind`. `scopeMaximum` is the peak number of scope slots the binder
reserves at once for one function, module, or program, counting both declared
variables and compiler temporaries. The IronHorse `+1` in
`width_select_index_plus_one_family` is an operand encoding detail, not part of
the count. Child 2 must apply the same rule to the equivalent IronHorse scoper
peak, and must port the XS regression `tests/xs/issues/scope-count-limit.js`
verbatim: a function with 65,535 `let` bindings compiles and one with 65,536
throws a SyntaxError. A tagged-template chain that exceeds the limit through
temporaries alone, the case ClusterFuzz found, is the second required case. If
IronHorse's peak count differs from XS's on either case, child 2 reports the
difference and stops rather than choosing a new rule.

## Orchestration

Some garden terms used in this section: the **board** is the garden's job queue; a
**parked** job waits in its plan area and does nothing until promoted;
`gate: go-ahead` marks a parked job that waits for maintainer authorization;
and an **orchestration** is a job that promotes a set of parked children and
writes a **completion record** (`jobs/tada/<orchestration>.md` on the garden
journal) when they are all done. That record's `orchestration-status` field
shows `complete` when every child succeeded, or `complete-with-failures` with
the failed children listed under `failed-children`. The mechanics are in
garden `skills/orchestration/SKILL.md`.

Children 1 to 5 change different engine code, but some of them regenerate the
same generated artifacts, so they are not fully disjoint. Each shared artifact
has a rule:

- **Snapshot goldens.** Child 5 binds new `ArrayBuffer` methods in `boot.rs`,
  which moves the boot fingerprint, and adds a persisted immutable bit. Child 1
  may change what a proxy row persists. Either change can bump the snapshot
  format version (`ironhorse-snapshot/src/format.rs`) and regenerate the
  `ironhorse-snapshot/tests/fixtures/state_golden*.tsv` corpora for both math
  providers and their inline digests. These files are regenerated, never
  hand-merged. Children 1 and 5 are not ordered against each other: whichever
  merges second rebases onto the first, regenerates the goldens, takes the next
  format version, and says so in its PR. Any other child whose change turns out
  to move a golden follows the same rule.
- **Byte-identity fixtures.** Only child 2 changes emitted bytecode, and it
  updates only the fixtures whose intentional `POP` changes.
- **Whole-tree expectations.** No port child regenerates the whole tree. If a
  child's change makes a recorded expectation flip, the child edits only the
  rows of its own test262 directories. If two children flip rows in the same
  per-directory file, the second to merge regenerates that file after rebasing.
- **Oracle-wrong rows.** The 8.3.1 oracle is wrong on some rows a child ports.
  When a child's specified result disagrees with the 8.3.1 oracle, the child
  records the row as the run reports it, lists it in its PR as an expected
  oracle divergence citing the specification and the XS 10.0.0 commit, and
  never changes the engine toward the oracle. Child 6 re-classifies these rows
  after the pin moves.

The artifacts that force an order belong to child 6: the `c/moddable` pin, the
full regenerated expectation tree, the five hardened262 host baselines, and the
candidate covered set. Child 6 must measure all six children's code together.

So the campaign runs in two stages:

1. **Ports, parallel.** One orchestration, `moddable-10-0-0-ironhorse-ports`,
   runs children 1 to 5 with `--parallel --on-child-failure continue`. A stuck
   or failed child does not hold up the others, and in particular a TypedArray
   problem cannot hold the immutable-buffer work.
2. **Validation, held.** Child 6 stays parked at `gate: go-ahead` until the
   ports orchestration's completion record shows
   `orchestration-status: complete` with no `failed-children`. Only then is it
   promoted. A `blocked_on` edge onto the orchestration cannot express this,
   because it would also fire on `complete-with-failures` and would baseline a
   known defect.

The gate is child 6's own deterministic self-check, the first step of its job
body; it is the sole enforcing mechanism. `promote-plan.sh --require-tada` and
the maintainer's look at the record are advisory: the flag only refuses while
the ports orchestration has no completion record, and it accepts
`complete-with-failures`. The self-check passes only when both hold:

- **Every port child completed cleanly.** Either the ports completion record
  shows `orchestration-status: complete` with no `failed-children`, or, for
  each child listed under `failed-children`, a later clean completion report
  of a re-run of that same basename exists (`jobs/tada/<child>.md`, dated after
  the orchestration's record, not marked `orchestration-failed`).
- **Every port child's PR is merged.** A completion report records that a job
  finished, not that its PR merged, so the self-check also confirms through
  `gh pr view` that each of the five children's PRs is merged into the base
  child 6 builds on.

Otherwise child 6 stops, changes nothing, and reports which child or PR failed
the check; the maintainer fixes the cause and promotes child 6 again. An
inattentive promotion therefore still cannot move the pin over a known defect.

If a port child fails, re-run that child alone after fixing the cause (the
other children's merged work stands). The re-run's clean completion report is
what the self-check reads in place of the orchestration's failure entry, so no
new orchestration record is needed. While child 6 is held, the oracle stays at 8.3.1,
so the port children are validated by their own targeted Rust tests, not by the
oracle. For the rows the 8.3.1 oracle gets wrong (the ordering fixes and
`Math.round`), the expected values in those tests come from the specification
and the XS 10.0.0 commit cited in the table, never from the 8.3.1 oracle.

All six children stay at `gate: go-ahead` until this design is reviewed and
implementation is authorized. Activation is two commands. First adopt the five
port children into the ports orchestration:

```sh
scripts/jobs/post-orchestration.sh --parallel --on-child-failure continue \
  --adopt-go-ahead moddable-10-0-0-ironhorse-ports \
  moddable-10-0-0-ironhorse-callability-port \
  moddable-10-0-0-ironhorse-compiler-safety-port \
  moddable-10-0-0-ironhorse-builtins-order-port \
  moddable-10-0-0-ironhorse-typedarray-port \
  moddable-10-0-0-ironhorse-immutable-arraybuffer-port
```

`--adopt-go-ahead` retags the parked `go-ahead` children as orchestrated in the
same commit as the orchestration record, so no child can be promoted outside
it. Then, once the ports have finished, the maintainer may look at the record
first (advisory; child 6's self-check is the gate):

```sh
grep -E '^(orchestration-status|failed-children)' \
  journal/jobs/tada/moddable-10-0-0-ironhorse-ports.md
```

and promote child 6:

```sh
scripts/jobs/promote-plan.sh --require-tada moddable-10-0-0-ironhorse-ports \
  moddable-10-0-0-ironhorse-oracle-validation
```

No port starts as part of the design PR.

## Oracle, matrix, and ratchet change control

Only child 6 may change these surfaces:

1. **Oracle `xst` version.** Move `c/moddable` from
   `23b4d6b0a65f` (XS 8.3.1) to the annotated 10.0.0 tag target
   `5f215f776f93039755343dbe75a09aa2615045f4`; update the stale pin message and
   re-audit every source overlay in `xs-oracle/build.rs`. Record `xst -v`, the
   submodule SHA, and the test262 SHA. No earlier child may change the pin.
2. **Immutable-ArrayBuffer matrix.** Re-run
   `packages/hardened262/test/ArrayBuffer/view-behavior-matrix.js` across every
   recorded mode for `xs`, `sesXs`, `ironhorse`, `sesIronhorse`, and `sesNode`.
   The current tree already lists the case as passed for raw XS module mode and
   skipped for raw XS sloppy/strict, so this plan drops the audit's claim that
   the case appears in no baseline. Change only results demonstrated by
   the run, and keep `onlyRaw` unless the test's intended host scope itself
   changes.
3. **IronHorse ratchet baseline.**
   - *Procedure.* Generate a new dated candidate from the full
     `ironhorse-262/scripts/full-run.sh` procedure and compare its covered set
     to `baseline/refresh-20260904/covered.txt`.
   - *Acceptance.* No covered case may be lost, timeout changes must be
     investigated, and the report must separate policy changes (the oracle
     move) from engine changes (children 1 to 5).
   - *Unclassified oracle drift.* The pin move crosses XS changes this plan
     did not audit. Every result change that no row R01 to R26 explains is
     listed in its own section of the report with one triage verdict: the
     oracle now agrees with IronHorse; a new IronHorse gap, which becomes a new
     parked follow-up job and is not fixed in child 6; a **port mismatch**,
     where the 10.0.0 oracle disagrees with a result a port child pinned from
     the specification, which becomes a parked follow-up job naming the
     disputed spec reading; or a harness or overlay change. A case IronHorse passes that leaves the covered set only because
     the 10.0.0 oracle now fails it is reported in this section, not counted
     silently as a loss or accepted. Acceptance waits until every drift entry
     has a verdict.
   - *Authority.* A newer directory is not adopted by date. Promotion of the
     candidate floor is reserved to the authorized `ironhorse-test262-ratchet`
     process after exact-head review and merge; this orchestration neither
     borrows that delegation nor uses its PR marker.

The test262 pin stays unchanged unless child 6 proves that the immutable cases
needed for acceptance do not exist at `be13516fb6441b950ba8a3df97eb34062c186972`.
If it must move, that is a separately reported corpus-input change in the same
candidate comparison, not an incidental lockfile-like update.

## Test plan

- Each child runs its nearest `ironhorse-vm`, `ironhorse-compile`, snapshot, and
  `ironhorse-262` tests and adds direct cases for every test262 coverage hole
  and every `already-conformant` probe the classification table assigns it.
- Each port child runs the affected whole-tree slices in sloppy and strict
  modes with the 8.3.1 oracle on, to catch regressions outside its rows. A skip
  is acceptable only when it is the existing named prerequisite exclusion; a
  new generic skip is a failure.
- Child 5 additionally runs the full engine workspace, SES boot tests, and
  snapshot persistence/restore tests for immutable buffers.
- Child 6 runs the full engine workspace, the complete bounded whole-tree sweep,
  the hardened262 five-host matrix, and snapshot tests for immutable buffers and
  revoked proxies, all on the 10.0.0 oracle.

## Considered and rejected

- Porting every 10.0.0 commit was rejected: most requested items are already
  conformant, absent with their prerequisite feature, or intentionally
  host-excluded.
- Treating the 8.3.1 oracle as the specification was rejected: several
  `needs-port` rows are precisely fixes made after that pin.
- Updating generated baselines per child was rejected: it obscures whether the
  oracle change or an engine port caused a classification move.
- Running all children serially with `halt` was rejected: the only artifacts
  children 1 to 5 share are regenerated goldens, which the rebase-and-regenerate
  rule in § Orchestration handles, and a halt in one small child would block the
  largest, independent one.
- Folding the oracle pin and ratchet comparison into the immutable-buffer child
  was rejected: an oracle-pin regression and a feature defect would land in one
  PR, and the pin would wait on the slowest feature work.

## Appendix: capture-group memory safety

The Moddable fix `db0490c5bcd5` removes a two-pass allocation bug: XS formerly
sized from one `Get`/ToString result and copied a second, potentially longer
result into that allocation. IronHorse has no equivalent sizing/copy split. Its
substitution routines reserve only capacity, grow the vector safely, and never
hold a user-derived unchecked pointer or slice.

There are two separate checks, owned by two children:

- **IronHorse (child 3).** A plain Rust regression with a named-capture getter
  whose second occurrence returns a longer string, asserting the getter count
  and the full output. This pins IronHorse's single-read behavior; no engine
  change is expected.
- **Oracle (child 6).** The 8.3.1 oracle still has the bug, so a differential
  run of that case could read past an allocation and still report matching
  output. Child 6 adds the case to the differential set only after moving to
  the 10.0.0 oracle, and checks that the 10.0.0 oracle's output matches
  IronHorse's pinned output. An AddressSanitizer build of the oracle is not
  part of this plan: it would need sanitizer build support in `xs-oracle` that
  this plan neither specifies nor sizes, and it would check the harness rather
  than IronHorse. If the maintainer wants that stronger check, it is a
  separate, separately sized job.

## Appendix: ownership map

This table follows the repository's ownership-map convention for designs: for
each boundary the change crosses, it names the code that does the work
(mechanism), what decides how it behaves (policy), where results persist
(durable state), who may commit or discard those results, and what kind of
value crosses the boundary.

| Boundary | Mechanism | Policy | Durable state | Lifecycle / commit authority | Value crossing |
|---|---|---|---|---|---|
| Moddable source -> `xs-oracle` | `c/moddable` supplies XS sources; `xs-oracle/build.rs` compiles the differential oracle and checked overlays. | This design selects the exact 10.0.0 tag target; child 6 decides whether overlays still apply and never silently patches upstream behavior. | Git submodule SHA and overlay source live in the repository. | Child 6 owns the pin commit; the ratchet process owns later floor promotion. | XS results, labeled as oracle evidence. |
| `ironhorse-vm` / `ironhorse-compile` -> `ironhorse-262` | The engine implements guest semantics; `ironhorse-262` assembles and classifies test262 runs. | Engine code decides execution; the runner decides covered/failure/skip categories and preserves deliberate host exclusions. | Targeted Rust tests, whole-tree expectations, and candidate refresh artifacts belong to `ironhorse-262`. | Each child owns its tests; only the authorized ratchet can promote a new covered floor. | An execution or compile result. |
| Engine -> `packages/hardened262` | Native immutable buffers provide the raw-agent surface consumed by `view-behavior-matrix.js`. | The matrix declares which host/mode should run; it must not infer support from an XS version string. | Five host baseline trees (`xs`, `sesXs`, `ironhorse`, `sesIronhorse`, `sesNode`) own their mode-specific results. | Child 6 updates the matrix and baselines in one reviewed PR. | Observable view behavior by host/mode. |

IronHorse owns execution classification and no durable supervisor state. The
test runners own expectation artifacts, not engine semantics. The authorized
ratchet alone decides whether a candidate covered set replaces its floor.
Restart and replay remain outside this plan, and the plan adds no engine type.

## Prompt

> Synthesize the source inventory and IronHorse audit into a project design for
> the Moddable SDK 10.0.0 release range (2026-09-04 through 2026-10-08) and tag
> target `5f215f776f93039755343dbe75a09aa2615045f4`. Classify every requested
> release item with named IronHorse and test262 evidence, explicitly cover the
> replace capture-group memory-safety issue, decompose only `needs-port` work
> into held implementation children, recommend their orchestration, and flag
> every oracle, immutable-buffer matrix, or ratchet-floor change. Do not start
> the ports.
