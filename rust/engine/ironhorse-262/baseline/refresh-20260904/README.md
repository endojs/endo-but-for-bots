# Ratchet refresh snapshot — 2026-09-04 (round 2)

This is the historical whole-corpus measurement at
`54e438c8d1d03664fca8caba0d925a1191a9b2dd`, retained as the round-2 comparison
snapshot for PR #1113.
It was produced with `scripts/full-run.sh --jobs 14` (oracle on), against
`tc39/test262@be13516fb6441b950ba8a3df97eb34062c186972` and Moddable XS
`23b4d6b0a65f` (XS 8.3.1).
The provenance commit predates the final iterator fix and the September 7 rebase.
These totals do not describe the current PR head or certify a zero-failure merge.

The covered paths remain comparison evidence against the
[August 29 snapshot](../refresh-20260829/).
Floor comparisons are performed manually; no CI job consumes this `covered.txt`.
Historical snapshots remain in-tree to make those comparisons reproducible.
A new run must distinguish engine regressions from changes to the runner's verdict
policy and must investigate timeout differences rather than automatically dismiss them.
The current base reports unexpected throws as conformance failures and escaped
internal control flow as engine failures, where this historical runner recorded skips.

Result agreement in the differential suites is separate from the exact-metering
contracts in the [test suites](../../tests/).
A passing result-only test does not establish computron agreement.

## What this round changed

The measured round-2 branch resolved the 21 conformance failures the fresh before-sweep
found at the branch point (llm @ `97d8de25da`), then closed the round-1 and
round-2 jury panels. The engine changes, each locked by a dual-run suite:

- **Caught not-callable raise corruption** — 14 of the 21 failures.
  `enter_call`'s not-callable arm returned the catch-handler pc as a callee
  `body_start`. Lock: [`../../tests/not_callable_caught_raise.rs`](../../tests/not_callable_caught_raise.rs).
- **Uncatchable native-validation TypeErrors** — an `ironhorse-aborted`
  wrong-throw class (not a `Fail`): sixteen native argument/descriptor sites
  escaped as bare host `Halt::Throw`, now raised through the catchable chain
  (`catchable_type_error_with_message` in the measured tree). Lock:
  [`../../tests/not_callable_caught_raise.rs`](../../tests/not_callable_caught_raise.rs).
- **Three inherited floor regressions** (descriptor `ToBoolean`, generic-walk
  id-space exhaustion, TypedArray-from-array snapshot). Lock:
  [`../../tests/inherited_floor_regressions.rs`](../../tests/inherited_floor_regressions.rs).
- **The native `mxTry` fence** on `run_callback_catching_throw` and, this
  round, its sibling `call_any_catching_throw` (the `Array.fromAsync` mapper /
  promise-reaction boundary). Lock:
  [`../../tests/native_mxtry_boundary.rs`](../../tests/native_mxtry_boundary.rs).
- **round-2 panel fixes:** `getOwnPropertyDescriptor(Symbol, k)` answers
  `undefined` via the honest path (a Symbol exotic has no own properties) rather
  than probing the symbol's internal descriptor slot; the TypedArray-from-array
  snapshot is gated on the intact default array iterator (an overridden
  `@@iterator` takes the array-like interleaving path, which is skipped honestly
  as `native-call:TypedArray:from-array-like`); `array_generic_has`/`get` share
  one non-interning index probe so a `get`-only caller
  (`find`/`includes`/`at`) is id-safe too. Locks:
  [`../../tests/symbol_keyed_properties.rs`](../../tests/symbol_keyed_properties.rs)
  and the extended `inherited_floor_regressions.rs` /
  `native_mxtry_boundary.rs`.

The remaining 7 of the 21 branch-point failures were
`RegExp/property-escapes/generated/*` `ironhorse-hang` classifications.
This refresh's `--jobs 14` run records zero failures over that subtree.
The before-run used 16 jobs, so these observations alone do not isolate contention
from an engine change or establish a per-case timing bound.

### The `ironhorse-aborted` skip family

In the measured tree, `OracleOnlyComplete` (ironhorse aborted where the oracle
completed) was split by
halt kind so `report.json` ranks the backlog by root cause. The tokens emitted by that historical runner were:

- `ironhorse-aborted:wrong-throw:<ctor>` — a behavioral divergence (ironhorse
  threw where the oracle completed);
- `ironhorse-aborted:stack-overflow`, `ironhorse-aborted:meter` — resource
  limits;
- `ironhorse-aborted:internal:<variant>` — a control-flow token
  (`resume`/`yield`/`await`/`step-limit`) that reached the classifier; these are
  relapse canaries surfacing a pre-existing backlog (162 `:internal:resume` this
  refresh) that the earlier bare bucket hid — the exact Halt::Resume-escape
  class this arc fences, now named instead of laundered into a plain skip;
- bare `ironhorse-aborted` — the residual.

A surface gap (`Halt::Unsupported`) and a decode/parse failure return **before**
this split as `unsupported-opcode:<op>` / `parse-or-decode` regardless of
agreement, so there is no `ironhorse-aborted:unsupported`/`:decode` token — the
missing-surface backlog lives under those two reasons.

## Totals

| Category | 2026-08-29 refresh | round-2 branch point | this refresh (2026-09-04) |
| --- | ---: | ---: | ---: |
| covered | 29,867 | 30,006 | 30,233 |
| ironhorse-failure | 0 | 21 | 0 |
| unsupported | 14,113 | 13,956 | 13,711 |
| skipped | 7,378 | 7,374 | 7,414 |
| infrastructure | 618 | 619 | 618 |

Superset verified, zero lost: every path in `../refresh-20260829/covered.txt`
(29,867) **and** in the PR's earlier round-2 sweep (30,232) is covered here; the
one net gain over that sweep is a `DisposableStack` disposal case the
sibling-boundary fence unblocked, and the `failures` list is empty.

## Regenerating a comparison

Run from `rust/engine/ironhorse-262` at the commit being measured.
To reproduce the historical measurement, use the recorded provenance commit.
A run at a different commit is a new comparison and must preserve its own provenance.

```sh
scripts/full-run.sh --test262-dir <pinned-test262-checkout> \
  --no-fetch --jobs 14 --oracle on --output <out>
python3 - <out>/report.json > covered.txt <<'PYTHON'
import json
import sys

with open(sys.argv[1]) as report_file:
    report = json.load(report_file)
paths = {case["path"] for case in report["cases"]
         if case["category"] == "covered"}
for path in sorted(paths, key=str.encode):
    print(path)
PYTHON
LC_ALL=C sort -c covered.txt
```

The category totals and provenance come from `report.json`'s
`summary.by_category` and `provenance` fields.
The infrastructure reasons are the reason tally for infrastructure cases.
