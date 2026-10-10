# Moddable SDK 10.0.0 to IronHorse port plan

| | |
|---|---|
| **Created** | 2026-10-10 |
| **Author** | kriscendobot (prompted) |
| **Status** | Proposed |

## What is the problem being solved?

Moddable SDK 10.0.0 contains a concentrated set of XS engine corrections made
between 2026-09-04 and 2026-10-08. IronHorse intentionally follows XS in many
places, but following an older XS implementation can preserve a defect after XS
has fixed it. This plan classifies every requested release item against
`rust/engine` at `7d2eb307a`, identifies the actual IronHorse gaps, and turns
only those gaps into review-held implementation jobs.

The annotated `10.0.0` tag points at
`5f215f776f93039755343dbe75a09aa2615045f4`. That commit's author date is
2026-07-21, its committer date is 2026-10-09, and its diff is Pebble platform
glue only. It is therefore the release identity but has no IronHorse engine
work of its own. The version-file commit is `80a253cadc6908ed616d8b156917c8fe8badbe53`
(`version 10.0.0`, 2026-10-07). This resolves the apparent date/content
discrepancy without pulling Pebble into scope.

The four classifications are exclusive:

- `already-conformant`: the named IronHorse path already has the corrected
  behavior.
- `needs-port`: IronHorse has the old behavior or lacks a required proposal
  surface it intends to support.
- `not-applicable`: the entire prerequisite feature is deliberately absent, so
  the correction has no reachable IronHorse analogue.
- `Temporal/host-excluded`: the behavior belongs to a host capability the
  single-agent deterministic runtime refuses.

ECMA-419, device, Piu, board, TypeScript, xsdb, and the tagged Pebble change are
out of scope: the source inventory found no `rust/engine` impact from them.

## Release classification

Expectation paths below are under
`rust/engine/ironhorse-262/expectations/whole-tree/`; code paths are under
`rust/engine/` unless stated otherwise. “Missing case” means targeted Rust
coverage is required even when the current test262 slice is green.

| Release item | Classification | IronHorse evidence | test262 expectation |
|---|---|---|---|
| Immutable ArrayBuffer | `needs-port` | `ironhorse-vm/src/interp/boot.rs` binds no `immutable`, `sliceToImmutable`, or `transferToImmutable`; buffer, TypedArray, and DataView writes carry no immutable bit. `ironhorse-vm/tests/ses_boot_intrinsics.rs::FROZEN_REALM_FORECLOSURE` explicitly depends on the native methods being absent. | `ArrayBuffer/prototype/{immutable,sliceToImmutable,transferToImmutable}` is mostly `skip:shared-*` or resizable-buffer skips; `sliceToImmutable/this-is-not-detached.js` is only a vacuous pass. Add native-surface, write-rejection, transfer, slice, persistence, and SES-boot cases. |
| `Math.round` subnormals | `needs-port` | `ironhorse-vm/src/interp/natives/number.rs`, `Math1::Round`, uses `a.is_normal()` and the old strict ±(2^52−1) window, leaving ±`Number.MIN_VALUE` unchanged. | `built-ins/Math/round` is green but has no subnormal case. Add ±`Number.MIN_VALUE`, signed-zero, and boundary regressions. |
| `charAt` / `charCodeAt` truncation | `already-conformant` | `natives/string.rs::call_string_indexed` uses `array_to_integer_or_infinity`; f64-to-i64 saturation prevents 32-bit wrap. | `String/prototype/{charAt,charCodeAt}` passes; retain targeted ±Infinity and `2**32+1` coverage. |
| `setFromHex` validation order | `not-applicable` | No `Uint8Array.prototype.setFromHex`, `fromHex`, or base64 native exists. | `Uint8Array/prototype/setFromHex` records missing-surface failures; the detached case passes only because the missing call throws a TypeError. Do not port an ordering fix without the feature. |
| Revoked Proxy IsCallable / IsConstructor | `needs-port` | `ironhorse-vm/src/interp/function.rs::{slot_is_callable,slot_is_constructor}` return false when `ProxyData.revoked` is set, losing the proxy's immutable `[[Call]]`/`[[Construct]]` shape. Snapshot rows must retain the shape independently of the cleared target. | `typeof/proxy.js`, revoked-function-proxy creation/revocation, and revoked base-constructor cases fail while the 8.3.1 oracle passes. |
| TypedArray length constructor: ToIndex before prototype read | `needs-port` | `natives/dispatch.rs::native_ctor_buffer`, `Native::TypedArray` length arm, calls `to_number_f64`, then `typed_array_prototype`, then `index_from_number`; the comment names the old XS order. | `TypedArrayConstructors/ctors/length-arg` is largely hidden by resizable-buffer skips. Add a `newTarget.prototype` getter plus negative/oversized/throwing lengths. |
| TypedArray `fill` coercion and detached check | `already-conformant` | `natives/buffer.rs`, `NativeMethod::TypedArrayFill`, coerces value, start, and end, then checks `detached_buffers`; `ironhorse-262/tests/typed_array_mutators.rs` pins single coercion and detachment during coercion. | `TypedArray/prototype/fill` has covered cases plus named resizable skips; no port. |
| TypedArray `set` array-like offset/read/detach order | `needs-port` | `natives/buffer.rs`, `NativeMethod::TypedArraySet`, rejects offsets above `i32::MAX` before `arraylike_length`, and throws after each array-like element detaches the target where the spec performs the failed integer-indexed set without that throw. | `set/array-arg-targetbuffer-detached-on-get-src-value-no-throw.js` fails; resizable-dependent order cases skip. Add a huge-offset/source-length order case. |
| TypedArray constructor content type | `needs-port` | The source-TypedArray arm in `natives/dispatch.rs::native_ctor_buffer` copies zero elements without checking BigInt-versus-Number domain, so empty cross-domain construction succeeds. | `ctors*/typedarray-arg/src-typedarray-{big,not-big}-throws.js` is masked by resizable-buffer setup. Add zero-length cross-domain cases. |
| TypedArray species content type | `already-conformant` | `natives/buffer.rs::typed_array_species_create` compares source and target element domains and throws TypeError. | Species content-type cases agree when reachable; resizable-buffer cases remain named skips. |
| String `repeat` with an empty receiver and huge finite count | `needs-port` | `natives/string.rs`, `NativeMethod::StringRepeat`, rejects `n > 0x7fff_ffff` before its empty-content fast return. | `String/prototype/repeat` passes because test262 stops at 2^31−1. Add empty-string cases at 2^31 and `Number.MAX_SAFE_INTEGER`, while Infinity and negative counts keep throwing. |
| String `replace` / `replaceAll` / RegExp `@@replace` Proxy callability | `already-conformant` | `function.rs::slot_is_callable` follows live proxy targets and the replace/RegExpExec paths in `natives/regexp.rs` use that predicate. | `String/prototype/{replace,replaceAll}` and RegExp `Symbol.replace` expectations pass; retain callable-Proxy replacer and `exec` probes. |
| String index/search methods with no argument | `already-conformant` | `natives/string.rs::call_string_indexed` supplies `undefined` and then ToString for omitted search values in `indexOf`, `lastIndexOf`, `includes`, `startsWith`, and `endsWith`. | All five expectation files pass. This item is not `String.prototype.search`, which had no corresponding release change. |
| `Symbol.for()` with no argument | `already-conformant` | `natives/dispatch.rs`, `NativeMethod::SymbolFor`, receives the missing argument as `undefined`, applies ToPrimitive/ToString, and uses `symbol_registry`. | `Symbol/for` passes apart from unrelated metadata expectations. |
| `Array.from` ToLength / Construct order | `needs-port` | `natives/array.rs::array_from_inner` computes ToLength correctly, but the array-like path rejects a length above `u32::MAX` before `Construct(C)`; `ironhorse-262/tests/error_messages_async.rs` locks the old early error. | Ordinary `Array/from/source-object-length.js` passes; there is no test262 case proving `C` is called for length `2**32`. Add that order case. |
| `Array.from` non-callable iterator order | `already-conformant` | `array_from_inner` reads `@@iterator` and rejects a non-callable method before constructing the target. | `Array/from/get-iter-method-err.js` and custom-constructor iterator cases pass. |
| `Reflect.apply` / `Reflect.construct` argument read order | `already-conformant` | `natives/reflect.rs::reflect_call_operands` validates, calls `arraylike_to_vec`, then dispatches the target/trap; the opcode fast path shares it. | Both `Reflect/{apply,construct}` trees pass, including proxy order cases. |
| `Object.prototype.toString` through a handler | `already-conformant` | `natives/dispatch.rs`, `NativeMethod::ObjectToString`, determines Array/callable brand first and reads `@@toStringTag` through the ordinary MOP, so a proxy `get` trap observes it. | `Object/prototype/toString/proxy-*` passes. |
| `Array.fromAsync` non-object `next` result | `already-conformant` | `natives/array.rs::from_async_resume_next` rejects the result promise with a TypeError when the awaited iterator result is not a reference. | `Array/fromAsync` passes the non-object result cases. |
| ArrayBuffer resize rejection order | `not-applicable` | `natives/dispatch.rs`, `NativeMethod::ArrayBufferResize`, always returns `Halt::NotImplemented("array-buffer-resize:unsupported")`; resizable construction is also refused. | `ArrayBuffer/prototype/resize` is uniformly a named unsupported-opcode skip. |
| Set methods with size above 2^31−1 | `already-conformant` | `natives/collection.rs::get_set_record` retains `size` as f64/Infinity and every branch compares that full value. | Set operation trees pass the large fake-size cases such as `size-is-a-number.js`. |
| `Atomics.wait` leak/deadlock and post-coercion revalidation | `Temporal/host-excluded` | `natives/buffer.rs::atomics_dispatch` refuses wait/notify/waitAsync before allocating a waiter or taking a lock; the single-agent fixed-buffer profile has no resizable view to revalidate. | `Atomics/wait*` is pre-skipped as `structural:can-block` / `structural:multi-agent`. Keep the refusal test; do not add waiter machinery. |
| `Math.irandom` | `not-applicable` | `ironhorse-vm/src/interp/realm.rs` and `interp/native_ids.rs` omit nondeterministic `Math.random`; the XS-only `irandom` and `imod` extensions are absent by the same deterministic-host policy. | No test262 item exists. |
| More than 65,535 scope slots | `needs-port` | `ironhorse-compile/src/coder.rs::width_select_index_plus_one_family` selects beyond the `_2` opcode family and truncates the operand; the scoper has no 65,535-slot cap, so corrupt bytecode reaches a private opcode. | XS implementation limit, no test262 case. Add 65,535-accepted and 65,536-SyntaxError compiler tests, including tagged-template temporaries. |
| Labelled `break` / `continue` leaving `switch` | `needs-port` | `coder.rs::code_switch` pops the discriminant only at its own break target; `code_break_continue` ignores `Target.stack_level`, leaking one stack value per labelled exit. | No focused test262 expectation. Add looped continue, labelled break, nested switch, and try/finally cases; update only byte-identity fixtures whose intentional POP changes. |
| `String.prototype.replace` capture-group memory safety | `already-conformant` | `natives/regexp.rs::{regexp_generic_substitution,regexp_get_substitution,string_plain_substitution}` append to a bounds-checked `Vec` in one pass. `$<name>` performs one `mop_get` and ToString per occurrence; indices are clamped, saturated, or checked before every slice. The crate forbids unsafe code. | `RegExp/prototype/Symbol.replace/named-groups*` and `result-coerce-groups*` pass. Add a long second getter result only as a permanent memory-safety regression; no engine change is required. |

## Capture-group memory safety

The Moddable fix `db0490c5bcd55842b95f4fa3f10b708fc34ad4c5` removes a two-pass
allocation bug: XS formerly sized from one `Get`/ToString result and copied a
second, potentially longer result into that allocation. IronHorse has no
equivalent sizing/copy split. Its substitution routines reserve only capacity,
grow the vector safely, and never hold a user-derived unchecked pointer or
slice. The acceptance test must still use a named-capture getter whose second
occurrence returns a longer string and assert the getter count and full output;
this pins the safety argument without manufacturing a port.

## Ownership map

| Boundary | Mechanism | Policy | Durable state | Lifecycle / commit authority | Value crossing |
|---|---|---|---|---|---|
| Moddable source → `xs-oracle` | `c/moddable` supplies XS sources; `xs-oracle/build.rs` compiles the differential oracle and checked overlays. | This design selects the exact 10.0.0 tag target; the port PR decides whether overlays still apply, never silently patches upstream behavior. | Git submodule SHA and overlay source live in the repository. | The final implementation PR owns the pin commit; the ratchet process owns later floor promotion. | XS bytecode/results, named as oracle evidence rather than IronHorse policy. |
| `ironhorse-vm` / `ironhorse-compile` → `ironhorse-262` | The engine implements guest semantics; `ironhorse-262` assembles and classifies test262 runs. | Engine code decides execution; the runner decides covered/failure/skip categories and preserves deliberate host exclusions. | Targeted Rust tests, whole-tree expectations, and candidate refresh artifacts belong to `ironhorse-262`. | Each child owns its tests; only the authorized ratchet can promote a new covered floor. | An execution result or compile result, never a “crank” or commit result. |
| Engine → `packages/hardened262` | Native immutable buffers provide the raw-agent surface consumed by `view-behavior-matrix.js`. | The matrix declares which host/mode should run; it must not infer support from an XS version string. | Five host baseline trees (`xs`, `sesXs`, `ironhorse`, `sesIronhorse`, `sesNode`) own their mode-specific results. | The immutable-buffer child updates the matrix and baselines in the same reviewed PR. | Observable view behavior by host/mode. |

IronHorse owns execution classification and no durable supervisor state. The
test runners own expectation artifacts, not engine semantics. The implementation
PR author decides which generated changes to commit; the authorized ratchet
alone decides whether a candidate covered set replaces its floor. Restart and
replay remain outside this plan. The inner/outer naming check passes: no new
engine type uses `crank`, `commit`, `snapshot`, `replay`, or another outer
lifecycle word.

## Implementation children

Every child is independently claimable and contains only `needs-port` items.
Sizes use the roadmap's calibrated categories.

| Order | Parked basename | Size | Scope and acceptance |
|---:|---|---|---|
| 1 | `moddable-10-0-0-ironhorse-callability-port` | M, 2–3 days | Preserve callable/constructable proxy shape through revocation and persistence; pass the four failing revoked-proxy expectations plus snapshot round trips. |
| 2 | `moddable-10-0-0-ironhorse-compiler-safety-port` | M, 2–3 days | Reject >65,535 scope slots with SyntaxError and unwind switch temporaries on every labelled exit; targeted compiler/runtime and byte-identity tests. |
| 3 | `moddable-10-0-0-ironhorse-builtins-order-port` | S, 1–2 days | Port `Math.round`, empty-string `repeat`, and `Array.from` large-length/Construct ordering with narrow regression tests. |
| 4 | `moddable-10-0-0-ironhorse-typedarray-port` | M, 2–3 days | Port length-constructor ordering, array-like `set` ordering/detachment, and empty cross-domain constructor checks without disturbing already-conformant `fill` or species logic. |
| 5 | `moddable-10-0-0-ironhorse-immutable-arraybuffer-port` | XL, 2–3 weeks | Implement immutable buffers and write guards, update the oracle and validation surfaces described below, run the complete comparison, and produce the candidate ratchet evidence. Depends on 1–4 so the final 10.0.0 comparison does not baseline known port gaps. |

The recommended orchestration is
`moddable-10-0-0-ironhorse-ports`, **serial**, in the exact order above,
with `on-child-failure: halt`. The first four touch mostly disjoint code, but a
single parallel orchestration cannot express their required barrier before the
oracle/matrix/floor child. Serial execution is the safe available shape and
also avoids concurrent edits to shared whole-tree expectations. A failed
semantic port must halt the campaign; continuing would let the final child
normalize a known defect into generated expectations.

The five children remain `gate: go-ahead` until this draft design is reviewed
and implementation is authorized. Activation is one atomic
`post-orchestration.sh --serial --on-child-failure halt --adopt-go-ahead`
operation naming the orchestration and these five children; no port starts as
part of the design PR.

## Oracle, matrix, and ratchet change control

Only child 5 may change these surfaces:

1. **Oracle `xst` version.** Move `c/moddable` from
   `23b4d6b0a65f` (XS 8.3.1) to the annotated 10.0.0 tag target
   `5f215f776f93039755343dbe75a09aa2615045f4`; update the stale pin message and
   re-audit every source overlay in `xs-oracle/build.rs`. Record `xst -v`, the
   submodule SHA, and the test262 SHA. No earlier child may change the pin.
2. **Immutable-ArrayBuffer matrix.** Re-run
   `packages/hardened262/test/ArrayBuffer/view-behavior-matrix.js` across every
   recorded mode for `xs`, `sesXs`, `ironhorse`, `sesIronhorse`, and `sesNode`.
   The current tree already lists the case as passed for raw XS module mode and
   skipped for raw XS sloppy/strict; therefore the audit claim that it appears
   in no baseline is not carried forward. Change only results demonstrated by
   the run, keep `onlyRaw` unless the test's intended host scope itself changes,
   and update `FROZEN_REALM_FORECLOSURE` from measured SES-boot behavior.
3. **IronHorse ratchet baseline.** Generate a new dated candidate from the full
   `ironhorse-262/scripts/full-run.sh` procedure and compare its covered set to
   `baseline/refresh-20260904/covered.txt`. No covered case may be lost, timeout
   changes must be investigated, and the report must separate policy changes
   from engine changes. A newer directory is not adopted by date. Promotion of
   the candidate floor is reserved to the authorized
   `ironhorse-test262-ratchet` process after exact-head review and merge; this
   orchestration neither borrows that delegation nor uses its PR marker.

The test262 pin stays unchanged unless child 5 proves that the immutable cases
needed for acceptance do not exist at `be13516fb6441b950ba8a3df97eb34062c186972`.
If it must move, that is a separately reported corpus-input change in the same
candidate comparison, not an incidental lockfile-like update.

## Test plan

- Each child runs its nearest `ironhorse-vm`, `ironhorse-compile`, snapshot, and
  `ironhorse-262` tests and adds direct cases for every test262 coverage hole
  named in the classification table.
- Run the affected whole-tree slices in sloppy and strict modes with the oracle
  on. A skip is acceptable only when it is the existing named prerequisite
  exclusion; a new generic skip is a failure.
- Child 5 additionally runs the full engine workspace, the complete bounded
  whole-tree sweep, the hardened262 five-host matrix, SES boot tests, and
  snapshot persistence/restore tests for immutable buffers and revoked proxies.
- Use sanitizer-enabled oracle builds for the capture-group long-result case;
  no change is accepted merely because both engines produce the same string.

## Considered and rejected

- Porting every 10.0.0 commit was rejected: most requested items are already
  conformant, absent with their prerequisite feature, or intentionally
  host-excluded.
- Treating the 8.3.1 oracle as the specification was rejected: several
  `needs-port` rows are precisely fixes made after that pin.
- Updating generated baselines per child was rejected: it obscures whether the
  final oracle change or an engine port caused a classification move.

## Prompt

> Synthesize the source inventory and IronHorse audit into a project design for
> the Moddable SDK 10.0.0 release range (2026-09-04 through 2026-10-08) and tag
> target `5f215f776f93039755343dbe75a09aa2615045f4`. Classify every requested
> release item with named IronHorse and test262 evidence, explicitly cover the
> replace capture-group memory-safety issue, decompose only `needs-port` work
> into held implementation children, recommend their orchestration, and flag
> every oracle, immutable-buffer matrix, or ratchet-floor change. Do not start
> the ports.
