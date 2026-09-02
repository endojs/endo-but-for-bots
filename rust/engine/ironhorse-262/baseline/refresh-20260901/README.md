# Ratchet refresh snapshot — 2026-09-01 (round 2)

The authoritative whole-corpus totals at the head of the round-2
`feat/ironhorse-test262-compliance-ratchet` PR
(endojs/endo-but-for-bots#1113), produced by
`scripts/full-run.sh --jobs 14` (oracle on, whole `test/**` tree) against
the same pinned corpus (`../../TEST262_REVISION`,
`tc39/test262@be13516fb644`) and Moddable XS oracle (`23b4d6b0a65f`,
XS 8.3.1) as the 2026-08-29 refresh in [`../refresh-20260829/`](../refresh-20260829/).

This refresh supersedes that one as the **ratchet floor**, under the same
invariants:

1. **No path in [`covered.txt`](./covered.txt) may regress.**
2. **[`baseline.json`](./baseline.json)'s `failures` list is the complete
   permitted `ironhorse-failure` set**; any new entry is a regression
   unless a demonstrated oracle/harness cause reattributes it to
   infrastructure.
3. The exact-metering corpus under `../../cases/**` stays passing
   (`cargo test -p ironhorse-262`, which drives `--gate-meter-exact`).

## What this round changed

Measured at the round-2 branch point (llm @ `97d8de25da`, the same corpus
and oracle pins), the fresh before-sweep found **21 conformance failures**
against the previous refresh's zero — regressions introduced between the
08-29 refresh and the 09-01 branch point, in two clusters, both fixed on
this branch and locked by the dual-run suite
`../../tests/not_callable_caught_raise.rs`:

- **Caught not-callable raise corruption** (14 divergences + an
  `ironhorse-aborted` class): `enter_call`'s not-callable arm returned the
  catch-handler pc as a callee `body_start`, so `call_cross_segment`
  dispatched the handler as a nested function body in the wrong frame.
- **Uncatchable native validation TypeErrors** (the dominant wrong-throw
  slice of the ~5.6k `ironhorse-aborted` pool): sixteen native
  argument/descriptor-validation sites escaped as bare host `Halt::Throw`
  without consulting live handlers; every `assert.throws(TypeError, …)`
  over them recorded an ironhorse-only abort.

The remaining 7 of the 21 (`RegExp/property-escapes/generated/*`
`ironhorse-hang`) were wall-clock flakes of the contended 16-job sweep
(each case completes in ~2s standalone); they pass in this refresh's run.

The `ironhorse-aborted` skip family is now split by halt kind
(`:unsupported:<op>`, `:wrong-throw:<ctor>`, `:decode`, `:stack-overflow`,
`:meter`), so `report.json` ranks the remaining backlog by root cause.

## Totals

| Category | 2026-08-29 refresh | round-2 branch point | this refresh |
| --- | ---: | ---: | ---: |
| covered | 29,867 | 30,006 | 30,232 |
| ironhorse-failure | 0 | 21 | 0 |
| unsupported | 14,113 | 13,956 | 13,712 |
| skipped | 7,378 | 7,374 | 7,414 |
| infrastructure | 618 | 619 | 618 |

Every 2026-08-29 `covered.txt` path is covered in this refresh (superset
verified, zero lost), and the `failures` list is empty. Refresh run:
`full-run.sh --jobs 14` at branch head `299b57fb3a` (engine pin in
[`baseline.json`](./baseline.json) provenance).
