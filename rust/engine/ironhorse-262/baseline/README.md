# Ironhorse test262 completion — starting baseline (immutable)

This directory is the **immutable starting snapshot** for the Ironhorse
JavaScript-completion work. It is committed once, and every later change in that
effort measures its regression invariant against it.

> **Current ratchet floor: [`refresh-20260904/`](./refresh-20260904/)**
> (round 2, endojs/endo-but-for-bots#1113). Successor chain, each a verified
> superset of the last: this immutable snapshot →
> [`refresh-20260829/`](./refresh-20260829/) → `refresh-20260904/`. The totals
> and `covered.txt` below are the *starting* measurement, not the enforced
> floor; enforce against the current floor's `covered.txt`.

> **Provenance gap (read before trusting the totals as a HEAD measurement).**
> The engine pin below (`14f26d0a6…`) is the head of the sibling reporting PR the
> harness was cherry-picked from, **not** an ancestor of this branch, and it
> predates later behavior changes: the per-case wall-clock bound, real early-error
> negative adjudication (`evaluate_negative_early`), strict-mode execution, and
> additional parser/regexp early errors.
> So a fresh whole-tree run **at this PR head** will differ from the frozen
> snapshot in predictable ways, and that delta is expected, not a regression:
> the three non-terminators are now attributed to the oracle when Ironhorse
> terminates alone (`oracle-nontermination:…`), rather than retaining the
> hand-authored `engine-hang:…` strings in `baseline.json`; and parse/resolution
> negatives that were blanket run-skips can now land as `covered`,
> `compiler-unimplemented:*`, an over-acceptance `Fail`, or an
> `negative-oracle-unexpected` skip when both parsers accept (the early-error verdict is
> decided at the parse phase, comparing ironhorse-compile's acceptance against
> the oracle's own parse signal). The
> report-refresh that closes this effort re-measures at the merged head and
> republishes; until then, treat these totals as the *pre-bound* starting line.

## The measured starting point

Taken verbatim from the published authoritative full-suite report:

- Report (HTML): <https://kriscendobot.github.io/garden/reports/ironhorse-test262/20260808-14f26d0a6/report.html>
- Report (JSON): <https://kriscendobot.github.io/garden/reports/ironhorse-test262/20260808-14f26d0a6/report.json>

Exact pins (see [`provenance.json`](./provenance.json)):

| Pin | Value |
| --- | --- |
| Engine / report source (endo) | `14f26d0a6989f5bb93cd1c1ca731dc7e1bc383d6` |
| test262 corpus | `tc39/test262@be13516fb6441b950ba8a3df97eb34062c186972` (2026-08-07) |
| Moddable XS oracle | `23b4d6b0a65f35209d9118c4c13c6c9b3e68784d` (XS 8.3.1) |

## Starting totals (52,092 cases)

| Category | Count |
| --- | ---: |
| covered | 4,740 |
| ironhorse-failure | 19 |
| unsupported | 38,400 |
| skipped | 8,932 |
| infrastructure | 1 |

The frozen snapshot's 19 ironhorse-failures are the 16
`language/identifiers/start-unicode-*` identifier-start over-acceptances plus
the 3 non-terminating `*-invalid-assignment-next-expression-for` cases
(`await-using` / `const` / `using`). The later oracle-only attribution fix
demonstrates that those three are XS non-terminations, not Ironhorse defects;
a fresh run at this head moves them to infrastructure. The snapshot's 1
infrastructure case is `language/global-code/decl-lex-restricted-global.js`
(see the re-audit note below).

## The regression invariant every later child must hold

1. **No covered case regresses.** Every path in [`baseline.json`](./baseline.json)
   `covered` must remain covered.
2. **No new `ironhorse-failure`.** The `failures` list is the only permitted
   member of that category unless a child removes one by fixing it. A documented
   reattribution from failure to infrastructure is permitted when an oracle or
   harness cause is demonstrated; it must preserve the case path and reason in
   the comparison output.
3. **The proprietary exact-metering / byte-identity corpus under `../cases/**`
   stays passing** with unchanged computron expectations
   (`ironhorse-xst --gate-meter-exact ...cases`).

[`baseline.json`](./baseline.json) carries the provenance, the per-category
totals, the full `failures`/`infrastructure` lists, and the complete sorted
`covered` set, so any child can check the invariant deterministically with no
network fetch. Do **not** edit it; the orchestration's final report-refresh
child publishes the new authoritative report that supersedes this snapshot.

## Re-audit: the lone `negative-oracle-unexpected` case

`language/global-code/decl-lex-restricted-global.js` is a `phase: runtime`
`SyntaxError` negative whose body is `let undefined;` — a lexical declaration
that collides with the *restricted global property* `undefined`
(`HasRestrictedGlobalProperty`), which the spec turns into a runtime
`SyntaxError` during `GlobalDeclarationInstantiation`. The XS **oracle shim**
hosts the program without a real restricted-global global object, so XS itself
does not raise the collision — the differential oracle cannot serve as the
authority here. It is therefore classified **infrastructure** (an oracle/host
exclusion), **not** an Ironhorse engine gap and **not** a failure. This is the
"specifically justified host-only exclusion" the acceptance bar allows, not a
case to relabel or fix in the engine.
