# Ratchet refresh snapshot — 2026-09-04 (round 2)

The authoritative whole-corpus totals **measured at the head of the round-2
`feat/ironhorse-test262-compliance-ratchet` PR** (endojs/endo-but-for-bots#1113),
produced by `scripts/full-run.sh --jobs 14` (oracle on, whole `test/**` tree)
against the pinned corpus (`../../TEST262_REVISION`, `tc39/test262@be13516fb644`)
and Moddable XS oracle (`23b4d6b0a65f`, XS 8.3.1) — the same pins as the
2026-08-29 refresh in [`../refresh-20260829/`](../refresh-20260829/).

Provenance sha is the engine commit the sweep ran on
(`baseline.json` `provenance.endo_sha`); the only commit after it on this branch
is the one that adds this snapshot (no engine change), so these totals describe
the tree that would merge. It replaces the PR's earlier `refresh-20260901`
snapshot (30,232 covered), which was measured two engine-mutating commits below
its own head and never lands; this re-measures at the true head after this
round's panel fixes.

This snapshot is the **ratchet floor**, under these invariants:

1. **No path in [`covered.txt`](./covered.txt) may regress.**
2. **[`baseline.json`](./baseline.json)'s `failures` list is the complete
   permitted `ironhorse-failure` set** (empty here); any new entry is a
   regression unless a demonstrated oracle/harness cause reattributes it to
   infrastructure.
3. The exact-metering corpus stays passing — `cargo test -p ironhorse-262`,
   which drives `--gate-meter-exact` over the dual-run suites under
   [`../../tests/`](../../tests/) (the fixtures were consolidated there; there
   is no `cases/` directory).

## What this round changed

The round-2 branch resolved the 21 conformance failures the fresh before-sweep
found at the branch point (llm @ `97d8de25da`), then closed the round-1 and
round-2 jury panels. The engine changes, each locked by a dual-run suite:

- **Caught not-callable raise corruption** — 14 of the 21 failures.
  `enter_call`'s not-callable arm returned the catch-handler pc as a callee
  `body_start`. Lock: [`../../tests/not_callable_caught_raise.rs`](../../tests/not_callable_caught_raise.rs).
- **Uncatchable native-validation TypeErrors** — an `ironhorse-aborted`
  wrong-throw class (not a `Fail`): sixteen native argument/descriptor sites
  escaped as bare host `Halt::Throw`, now raised through the catchable chain
  (`catchable_type_error_with_message`). Lock:
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
`RegExp/property-escapes/generated/*` `ironhorse-hang` classifications — wall-clock
non-terminations of a contended sweep, not engine defects; the per-case timeout
(`cfg.per_case_timeout_seconds`) reclassifies rather than regresses them, and
this refresh's `--jobs 14` run records zero failures over that subtree.

### The `ironhorse-aborted` skip family

`OracleOnlyComplete` (ironhorse aborted where the oracle completed) is split by
halt kind so `report.json` ranks the backlog by root cause. The **emittable**
tokens are:

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

## Regenerating this artifact

```sh
# 1. Sweep the pinned corpus at head (endo_sha in baseline.json provenance):
scripts/full-run.sh --test262-dir <tc39/test262@be13516fb644 checkout> \
  --no-fetch --jobs 14 --oracle on --output <out>
# 2. covered.txt is every `report.json` case with category "covered",
#    byte-sorted (locale-pinned, so the file does not reorder under a
#    non-C LC_COLLATE):
python3 -c 'import json,sys; print("\n".join(sorted((c["path"] for c in json.load(open(sys.argv[1]))["cases"] if c["category"]=="covered"), key=lambda s:s.encode())))' \
  <out>/report.json | LC_ALL=C sort -c /dev/stdin && \
  python3 -c 'import json,sys; print("\n".join(sorted((c["path"] for c in json.load(open(sys.argv[1]))["cases"] if c["category"]=="covered"), key=lambda s:s.encode())))' \
  <out>/report.json > covered.txt
# 3. baseline.json's totals_by_category, infrastructure_reasons, and provenance
#    are report.json's `summary.by_category`, the infrastructure reason tally,
#    and `provenance`.
```
