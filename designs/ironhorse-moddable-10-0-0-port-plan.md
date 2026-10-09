# IronHorse: porting the Moddable SDK 10.0.0 XS changes

| | |
|---|---|
| **Created** | 2026-10-09 |
| **Author** | kriscendobot (prompted) |
| **Status** | Proposed |
| **Source** | [Moddable SDK 10.0.0](https://github.com/Moddable-OpenSource/moddable/releases/tag/10.0.0) (pre-release 2026-10-09, commit `5f215f776f93`; becomes the default release on 2026-10-12) |

## What is the Problem Being Solved?

Moddable SDK 10.0.0 contains the XS changes made from 2026-09-04 to 2026-10-08.
The release notes list about 25 conformance fixes, one memory-safety fix,
Immutable ArrayBuffer enabled by default, and two compiler fixes.
IronHorse (`rust/engine`) is checked for parity against an XS oracle.
This document decides which of those changes IronHorse must mirror, and in what
order, given how the oracle and the test262 ratchet measure IronHorse.

Evidence below comes from the 40 XS commits under `xs/sources` and `xs/tools`
in `9.5.0...5f215f776f93`, not only from the release notes.
IronHorse is measured at `llm` `7d2eb307a`. Implementations are cited by
symbol, and test262 status comes from
`rust/engine/ironhorse-262/expectations/whole-tree/`.
Two release-note items, #1703 and #1704, are still open upstream issues.
Their behaviour ships inside the commits for #1726 and #1702.

## Oracle facts this plan depends on

- **The IronHorse oracle is still XS 8.3.1.** The `c/moddable` gitlink is
  `23b4d6b0a65f` (8.3.1). `xs-oracle/build.rs` builds from it, and
  `baseline/provenance.json` records it. XS 9.0.0 and 9.5.0 never reached
  the IronHorse oracle. (`designs/ironhorse-known-defects.md` says "XS 9.0
  oracle"; the pin says otherwise.)
- **The same gitlink also builds `rust/endo/xsnap`**, the production XS for
  the daemon. The 8.3.1 bump left the gitlink alone because xsnap's
  `fxInitializeSharedCluster` FFI arity had to change at the same time
  (job `port-endor-oracle-bump-8-3-1`).
- **The hardened262 CI `xst` is a separate pin**: `MODDABLE_VERSION: 9.0.0`
  in `.github/workflows/ci.yml`.
- **What the classifier does when the engines disagree**
  (`ironhorse-262/src/test262.rs`, `classify`):
  - IronHorse completes where the oracle aborts → `Divergent`, which counts
    as an IronHorse failure.
  - IronHorse aborts where the oracle completes → `Divergent`.
  - Both abort with an equal value → `Covered`.

  So fixing IronHorse ahead of the oracle adds failures, and bumping the
  oracle ahead of IronHorse turns cases where both share a bug into
  failures. A fix that the pinned corpus exercises must land **in the same
  change** as the oracle that agrees with it.

## Classification

Key: **conformant** means IronHorse already shows the post-fix behaviour.
**port** means work is needed. **n/a** means not applicable.
**host** means the item is excluded by the host or by agents.
None of these items involves Temporal.

| XS change (commit / issue) | IronHorse evidence | Class |
|---|---|---|
| `Math.round` subnormal (`7b3bd375`, #1698) | `natives/number.rs` `Round` arm still guards with `is_normal()`. Positive subnormals give 0 by accident; `Math.round(-5e-324)` returns the subnormal instead of `-0`. The corpus has no test for it. | **port** (XS) |
| `charAt`/`charCodeAt` 32-bit truncation (`6099bb0d`, #1699) | `string.rs` `call_string_indexed` uses saturating `array_to_integer_or_infinity`. charAt 60/60 and charCodeAt 50/50 pass. | conformant |
| `setFromHex` validates the target before the odd-length check (`c97c28ec`, #1700) | `Uint8Array` base64/hex is not implemented (setFromHex 4 pass / 20 fail). | n/a until base64/hex lands; that port must validate the target first |
| Revoked Proxy accepted where IsCallable is required (`1e71939f`, #1702) | `function.rs` `slot_is_callable` walks the target and returns false once the proxy is revoked, and revocation nulls the target. `typeof` of a revoked function proxy is `"object"`. `Proxy/create-target-is-revoked-function-proxy.js` and `Proxy/revocable/target-is-revoked-function-proxy.js` fail. | **port** (M) |
| Proxy newTarget whose target is a revoked proxy (#1704) | `slot_is_constructor` returns false for a revoked link. `get_prototype_from_constructor` has no GetFunctionRealm revoked-proxy TypeError: `Function/internals/Construct/base-ctor-revoked-proxy.js` fails. | **port**, in the same change as #1702 |
| `TypedArray.prototype.set` offset ordering (#1703, `2d059eba` #1726) | `buffer.rs` `TypedArraySet` checks detachment before ToIntegerOrInfinity(offset), and applies the int32 RangeError before the array-like `length` read. It also throws when the target is detached mid-loop: `array-arg-targetbuffer-detached-on-get-src-value-no-throw.js` fails. | **port** (S) |
| `TypedArray.prototype.fill` converts the value first (`2d530640`, #1711) | The `TypedArrayFill` arm coerces the value before start/end. 20 pass, 0 fail. | conformant |
| TypedArray constructor: ToIndex(length) before reading the prototype (`df98bbac`, #1718) | `dispatch.rs` length form runs `to_number_f64` → `typed_array_prototype` → `index_from_number`, so a negative or huge length throws after the prototype getter has run. | **port** (XS) |
| TypedArray species content-type check (`c645752e`, `d19b9da1`, #1723) | `buffer.rs` `typed_array_species_create` already rejects a BigInt/Number mismatch, including for subarray. | conformant |
| `ArrayBuffer.prototype.resize` rejection order (`b4e0cab1`, #1724) | Resizable buffers are not implemented; `ArrayBufferResize` halts `NotImplemented`. | n/a (an optional TypeError stub is folded into the ordering batch) |
| ArrayBuffer slice/transfer conformance (`add95da9`) | `array_buffer_slice` handles a detached result and a source that shrinks (66/66). Transfer passes 38. `concat` is an XS-only extension that halts. | conformant; `concat` n/a |
| `"".repeat(2**53-1)` and repeat count conversion (`4b1afbc4`, #1705) | `string.rs` `StringRepeat` throws "count too big" before the empty-string return. `tests/error_messages_numeric_string.rs` asserts the old behaviour. | **port** (S) |
| `Symbol.for()` with no argument (`912290f4`, #1706) | The `SymbolFor` arm defaults to undefined and gives the key `"undefined"`. | conformant |
| String search methods with no argument (`4340468f`, #1708) | indexOf, lastIndexOf, includes, startsWith and endsWith search for `"undefined"`. All pass. | conformant |
| `Array.from` applies ToLength (`eb7d6de2`, #1715) | `array_from_inner` uses `to_length_value`. It is closer to spec than XS 10, which wraps `2**32` to 0. | conformant |
| `String.prototype.replace` with a Proxy replacer; `exec` IsCallable (`dca752b7`, #1716) | `regexp.rs` uses `is_callable_value`. Only the revoked-proxy edge case remains, and it is closed by #1702. | conformant |
| `Reflect.apply`/`construct` read arguments before the Proxy trap (`7abe778a`, #1717) | `reflect_call_operands` always runs `arraylike_to_vec` before invoking, and the trap receives a fresh array. | conformant |
| `Array.from` checks iterator callability before construction (`a795d3e9`, #1720) | The callability check in `array_from_inner` comes before `array_from_make_target`. | conformant |
| `Object.prototype.toString` reads the tag through the handler (`477da580`, #1721) | The `ObjectToString` arm reads via `mop_get` and takes the callable bit before the read. The revoked case is closed by #1702. | conformant |
| `Array.fromAsync` with a non-object `next` result (`fbbd2cbb`, #1722) | `from_async_resume_next` rejects with TypeError. 186 pass. | conformant |
| Set methods with `size > 2**31-1` (`0768ebb7`, #1725) | `get_set_record` keeps the size as `f64` and never narrows it. | conformant |
| `Atomics` revalidate after coercion (`83ab166a`) | Coercing an object value halts (`atomics:coerce`), so user code cannot run mid-operation. Separately, `atomics_dispatch` never checks detachment. | n/a now; the adjacent detached check goes in the ordering batch |
| `Atomics.wait` leak/deadlock (`e1fa1b78`) | wait/notify/waitAsync are refused (`atomics:wait-notify`), and there are no agents. | host |
| `Math.irandom` integer math (`d17c0de3`) | A non-standard XS extension that IronHorse does not expose. | n/a |
| SyntaxError above 65535 scope slots (`cfe72a8c`) | `ironhorse-compile` has no limit. `width_select_index_family` steps from a `_2` opcode into the next opcode (`RESERVE_2+…` → `RESET_CLOSURE_1`), so it **emits corrupt bytecode** where it should report an error. | **port** (XS), compiler |
| `switch` labelled `break`/`continue` stack leak (`051b31b2`) | `coder.rs` `code_switch` keeps the discriminant on the operand stack (`XS_CODE_DUB` per case, `POP` after). `code_break_continue` pops nothing, so each `continue outer` out of a switch leaks one slot. | **port** (S), compiler |
| `$<name>` capture group read once (`db0490c5`, memory safety) | `regexp.rs` `regexp_generic_substitution` makes one pass into a growable `Vec`, with one `mop_get` + ToString per occurrence. There is no size-then-fill pair, so the overflow cannot occur. | conformant (no analogous defect) |
| Iterator result flags (`2302ae6f`) | Generator results stay spec-writable on purpose. The protected array/map/set iterator result already matches XS, and the difference is recorded in `ironhorse-262/tests/xs_departures.rs`. | n/a (intentional departure) |
| Immutable ArrayBuffer enabled by default (`f98758c9`, `33cc1b4b`) | Not implemented: no `transferToImmutable`, `sliceToImmutable`, `immutable`, or read-only state. About 50 immutable tests are shared skips because 8.3.1 also lacks the feature. | **port** (M–L), tied to the oracle |
| `detachArrayBuffer` for fuzzilli (`b2a085e3`) | IronHorse already has `$262.detachArrayBuffer`. | n/a |

Out of scope, with no engine relevance found: ECMA-419, `device`, Piu,
boards, TypeScript, xsdb, `-fno-strict-float-cast-overflow` (an oracle C
build flag only), and the UBSan/ASan hygiene commits.

## Port work

All children are builder jobs on `endojs/endo-but-for-bots` with base `llm`,
each opening a draft PR whose completion stages the gauntlet.
Recommended shape: **one serial orchestration with `on-child-failure: halt`**,
because children 3 and 4 have to be measured against the oracle that child 2
installs. Children are parked `go-ahead` until the open questions below are
answered. No port starts until then.

| # | Child base | Scope | Size |
|---|---|---|---|
| 1 | `ironhorse-xs10-proxy-callable-flags` | Record [[Call]]/[[Construct]] presence on `ProxyData` when the proxy is created, and carry it through `snapshot_rows.rs` `ProxyRow`, `persist.rs`, and `restore.rs`. Use it in `slot_is_callable`, `slot_is_constructor`, and `proxy_construct_refused`. Add the GetFunctionRealm revoked-proxy TypeError to `get_prototype_from_constructor`. Update `xs_departures.rs` and `new_on_non_constructors.rs`. The 8.3.1 oracle already passes the affected corpus tests, so this child does not depend on the oracle. | M |
| 2 | `ironhorse-xs-oracle-bump-10-0-0` | Move the oracle pin from 8.3.1 to 10.0.0 per open question 1. Set `mxImmutableArrayBuffers=0` explicitly in `xs-oracle/build.rs`, so this change does not alter the oracle's feature set. Audit the `xs/sources` delta 8.3.1→9.5.0, which this plan does not cover. Mirror, in the same PR, every compiler delta that byte identity needs: the `switch` temporary local (`code_switch` plus the scoper's push/pop of one variable) and the 65535-slot "too many variables" SyntaxError. Also mirror any delta whose corpus rows would otherwise turn `Covered` into `Divergent`. Re-run the stage-1 harness, the compile-diff corpora, and the whole tree, then regenerate `whole-tree/` and a new `baseline/refresh-<date>/` at the new oracle. Run no earlier than 2026-10-12, after 10.0.0 is marked latest. | L |
| 3 | `ironhorse-xs10-builtin-ordering` | `Math.round` `is_finite`; `String.prototype.repeat` ordering, clamping, and the "count infinite" message; TypedArray constructor ToIndex before the prototype read; `TypedArray.prototype.set` offset ordering and no throw for a target detached mid-loop; optional `ArrayBuffer.prototype.resize` TypeError stub with name/length; the `Atomics` detached-buffer check. Update the regression rows that pin the old behaviour. | S |
| 4 | `ironhorse-immutable-arraybuffer` | Implement the proposal (read-only buffer state, the three members, mutable checks on every write path including DataView, TypedArray mutators, Atomics, slice/species destinations and from/of, and snapshot persistence). In the same PR, flip the oracle's `mxImmutableArrayBuffers` to 1 so the ~50 shared skips become `Covered` rather than `Divergent`. | M–L |
| 5 | `endo-ci-xst-10-0-0` | Bump the hardened262 CI `MODDABLE_VERSION` from 9.0.0 to 10.0.0 and regenerate the `@endo/hardened262` xs baseline. This does not depend on the IronHorse children. | S |

Rough cost: about 20M tokens across the five children (1: 3M, 2: 8M, 3: 2M,
4: 5M, 5: 1.5M).

To start the work, the maintainer says "go ahead" and the liaison runs:

```sh
scripts/jobs/post-orchestration.sh --serial --on-child-failure halt --adopt-go-ahead \
  orch-ironhorse-moddable-10-0-0-ports \
  ironhorse-xs10-proxy-callable-flags ironhorse-xs-oracle-bump-10-0-0 \
  ironhorse-xs10-builtin-ordering ironhorse-immutable-arraybuffer endo-ci-xst-10-0-0
```

## Oracle and ratchet impact

These changes alter the oracle `xst` version or the ratchet baseline:

- **Child 2 changes the IronHorse oracle pin.** The ratchet verifier
  (`context/operations/ironhorse-ratchet-evidence.md`) requires the corpus and
  oracle pins of the floor to match. Every crank measured across the bump is
  therefore `incompatible`, and the delegation may not reinterpret
  `incompatible` as permission to replace the floor. Child 2 needs the ratchet
  delegation paused (`ironhorse-ratchet.sh pause`) and no open crank PR
  (crank 3 is draft PR 1359). It also needs explicit maintainer authorization
  to promote a floor re-measured at oracle 10.0.0.
- **Child 4 changes the oracle's feature set.** It changes the floor as well,
  but only by adding `Covered` cases, provided the flip and the implementation
  land together.
- **Child 5 changes the hardened262 `xst`** and its committed baseline, not the
  IronHorse ratchet.
- Children 1 and 3 only move cases from failing to `Covered`. Child 3's items
  have almost no corpus coverage.

## Open questions

1. Should the oracle bump also move xsnap? The `c/moddable` gitlink also
   builds `rust/endo/xsnap`. The alternatives are a separate oracle-only pin
   (for example a second submodule read by `xs-oracle/build.rs`), or bumping
   xsnap together with its FFI and snapshot-compatibility changes
   (`XS_MAJOR_VERSION` 17, and the minor version now counts Immutable
   ArrayBuffer).
2. Will the maintainer authorize promoting a new ratchet floor measured at
   oracle 10.0.0, and should child 2 wait for crank 3 (PR 1359) to resolve?
3. Should the oracle target 10.0.0 directly, or step through 9.0.0 and 9.5.0,
   whose engine deltas this plan has not audited?
4. Is child 5 (the hardened262 CI `xst` bump) wanted now, or should the CI
   pin stay at 9.0.0?
