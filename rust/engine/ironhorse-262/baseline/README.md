# Ironhorse test262 completion — starting baseline (immutable)

This directory is the **immutable starting snapshot** for the Ironhorse
JavaScript-completion PR. It is committed once, by the foundation child
(`ironhorse-js-00-report-harness-foundation`), and every later child in the
completion orchestration measures its regression invariant against it.

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

The 19 ironhorse-failures are the 16 `language/identifiers/start-unicode-*`
identifier-start over-acceptances plus the 3 non-terminating
`*-invalid-assignment-next-expression-for` cases (`await-using` / `const` /
`using`), which the engine spins on because assigning to a `const`/`using`
binding in a `for` update does not throw the required `TypeError`. The 1
infrastructure case is `language/global-code/decl-lex-restricted-global.js`
(see the re-audit note below).

## The regression invariant every later child must hold

1. **No covered case regresses.** Every path in [`baseline.json`](./baseline.json)
   `covered` must remain covered.
2. **No new `ironhorse-failure` and no new `infrastructure`.** The `failures`
   and `infrastructure` lists are the only permitted members of those
   categories unless a child *removes* one by fixing it.
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
