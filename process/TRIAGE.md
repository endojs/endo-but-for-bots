# Triage Report — Open Issues and PRs Whose Work Has Already Landed

Twelve subagents audited the 338 open issues and 251 open/draft PRs against
the local mirrors at `issues/` and `changes/`.
This file consolidates their findings.

Conventions:

- **LIKELY-LANDED** — a merged PR plainly addresses the request.
- **PARTIAL** — a merged PR addresses some of the request; remaining work noted.
- **LANDED-ELSEWHERE** — an open or draft PR's change has been merged via a
  different PR.
- **LIKELY-OBSOLETE** — the PR cannot land as-is (DO NOT MERGE in title, dead
  base branch, references nonexistent package, or refactor superseded the
  approach).
- **STALE-DRAFT** — open ≥18 months with no recent activity and no clear
  successor.

## Open issues whose implementation has merged

### Likely-landed (close)

- [#390](./issues/390.md) — Need new test that tests something like obsolete
  `get-intrinsics.test.js` — landed by #372 (2020-07): the deletion PR
  introduced a new whitelist/intrinsics architecture with extensive tests in
  its place.
- [#423](./issues/423.md) — Endo: thread powers by policy — landed by #1262
  + #1491 (2023-02): policy enforcement (per-compartment imports/globals/
  builtins) reaches LavaMoat feature parity.
- [#522](./issues/522.md) — Remove `location` argument from
  `StaticModuleRecord` constructor — landed by #521 (2020-11) + #2345 (2024-07
  rename to `ModuleSource`).
- [#636](./issues/636.md) — Node console confused if `constructor` is an
  accessor — landed by #637 (2021-03) + #2934 (2025-08).
- [#676](./issues/676.md) — Replace `toString` overrides with `@@toStringTag` —
  landed by #1962 + #1972 (2024-01).
- [#912](./issues/912.md) — Module shims lexicals leak internal live bindings
  object — landed by #1343 (2022-10): removed `globalLexicals` entirely.
- [#913](./issues/913.md) — Decouple `stackFiltering` from `stackShortening` —
  landed by #2747 (2025-05): added `'omit-frames'` and `'shorten-paths'`
  options.
- [#929](./issues/929.md) — Support IDE breakpoints when debugging Endo
  archives — landed by #930 + #932 (2021-11).
- [#1217](./issues/1217.md) — Evasive transform for apparent HTML comments in
  quoted strings — landed by #3026 (2026-02): AST-based meaning-preserving
  evasive transform; commit message confirms "we get a fix for #1217 for free".
- [#1682](./issues/1682.md) — env-options README — landed by #1710 (2024-01).
- [#1688](./issues/1688.md) — Make `async_hooks` mitigation less intrusive in
  `unsafe-fast` — landed by #3085 (2026-02): moved to opt-in entrypoint.
- [#1769](./issues/1769.md) — Docs say `lockdown()` freezes `globalThis` —
  landed by repo-wide doc reorg (commit `fe81477bf8`).
- [#1776](./issues/1776.md) — compartment-mapper policy types — landed by
  #1839 (2024-01).
- [#2023](./issues/2023.md) — CLI dot-delimited petname paths — landed by
  #2034 / #2296 / #2325 (2024-02 to 2024-06).
- [#2036](./issues/2036.md) — Bundler integration tests — landed by #2735
  (2025-03).
- [#2129](./issues/2129.md) — Browser tests on canary browsers — landed by
  #1978 (2024-04).
- [#2203](./issues/2203.md) — Compartment Mapper "imports" directive — landed
  by #3048 (2026-04).
- [#2265](./issues/2265.md) — Subpath pattern exports — landed by #3048
  (2026-04).
- [#2894](./issues/2894.md) — Compartment Map Transforms — landed by #2988
  (2025-12): comprehensive universal hook system with `packageDataHook` etc.
- [#2898](./issues/2898.md) — Compartment-map support for `package.json`
  imports — landed by #3048 (2026-04).

### Partially landed

- [#400](./issues/400.md) — XS native Compartments for Vat Workers — most of
  the bundle/compartment-mapper module-descriptor refactor merged via #2294,
  #2306, #2321, #2345, #2350, #2352, #2353, #2380; missing: full XS-native
  execution path through `import-bundle`.
- [#488](./issues/488.md) — Source-prefix stackframe filter — basic stack
  filtering and verbose/concise modes shipped via #728, #2747, #2817; missing:
  configurable per-source-prefix filter coordinated with console output.
- [#551](./issues/551.md) — `WeakRef`/`FinalizationGroup` start-compartment
  only — kriskowal noted partial handling 2024-01; missing: requested
  `InertWeakRef`/`InertFinalizationRegistry` constructors.
- [#629](./issues/629.md) — Package name integrity in compartment maps —
  policy enforcement landed via #1262/#1491; missing: hardened resolution
  against bundled-dep / URL-dep name spoofing (test still in draft #1967).
- [#661](./issues/661.md) — React Native Compat tracking epic — Hermes shim
  (#2334), `hostEvaluators` (#2723), and tighter v8 sniff (#2952 draft) cover
  the major boxes; tracker remains since some sub-items are open.
- [#805](./issues/805.md) — SES log all error lines to stderr — taming/removal
  warnings now go to stderr via #949; missing: full "all console output to
  stderr" reform.
- [#882](./issues/882.md) — Tame XS `Object.freeze` second arg — XS shim
  variant papers over the parity gap via #2471; missing: equivalent in the
  default ses shim.
- [#903](./issues/903.md) — Fail-safe for environments without `unsafe-eval`
  CSP — `evalTaming` (#961), kebab-case (#2739), `hostEvaluators` (#2723);
  missing: removing dynamic eval from SES init itself.
- [#934](./issues/934.md) — Sync XS interpretation of `Date()`/`Math.random()`
  — censored-property poisoned getters via #1718 + #2357; missing: explicit
  confirmation of throw behavior under SES.
- [#944](./issues/944.md) — Bare `Error` instance does not log correctly —
  `makeReporter` uses current causal console via #2934; missing: full root
  cause around `Error.prototype.constructor` override.
- [#1153](./issues/1153.md) — `import.meta.url` and `require.resolve` —
  `import.meta.url` plumbed via #1141 + #1202; missing: `require.resolve`/
  `require.cache` and bundle/archive integration.
- [#1254](./issues/1254.md) — Export explicit types — `promise-kit`,
  `import-bundle`, `init`, `marshal` exported via #1307 + #1366; most other
  packages on the checklist remain unchecked.
- [#1429](./issues/1429.md) — Error codes not discoverable — comment-URL
  suggestion at throw sites via #1431 (2023-01); missing: inline URL or
  search-engine surface.
- [#1551](./issues/1551.md) — Compartment with no evaluators exposed — global
  `hostEvaluators: 'none'` lockdown option via #2723 (2025-04); missing: per-
  Compartment opt-in described in the issue.
- [#1582](./issues/1582.md) — `makeMarshal` for Google Apps Script — Apps
  Script support threaded through `@endo/nat`/`marshal`/`ocapn` via #3058;
  missing: UMD/single-file build.
- [#1610](./issues/1610.md) — Pet Daemon Spikes (tracking) — many spike items
  shipped via the `endo` branch merge in #2082; missing: most listed bridges.
- [#1739](./issues/1739.md) — `passStyleOf` must validate `isWellFormed` —
  feature flag `ONLY_WELL_FORMED_STRINGS_PASSABLE` added via #2002; flag
  defaults to `'disabled'` so enforcement is opt-in.
- [#1816](./issues/1816.md) — `bundle-source` strips comments — #2444
  (2025-03) "Preserve formatting" via Babel; missing: explicit empty/types-
  only-module confirmation.
- [#1882](./issues/1882.md) — SourceMap cache key must vary with original
  source — per-user source-map cache via #1689 (2023-07); missing: hash of
  original source captured in `compartment-map.json`.
- [#1926](./issues/1926.md) — Bundle transform mishandles trailing comments —
  format preservation via #2444 (2025-03); missing: explicit regression test.
- [#2113](./issues/2113.md) — Compare strings by codepoint — `ENDO_RANK_STRINGS`
  env-option via #2873 (2025-07); missing: default flip (#2875 draft) and
  migration plan.
- [#2201](./issues/2201.md) — `importNowHook` — `compartment.importNow` and
  `ImportNowHook` via #2202 (2024-04); missing: full integration with
  `compartment-mapper` dynamic-require path.
- [#2230](./issues/2230.md) — Test on pre-release platforms — `setup-node@latest`
  in CI via #2231 (2024-04); missing: full canary cadence beyond the smoke
  test.
- [#2243](./issues/2243.md) — Reënable Windows CI — Yarn 4 prerequisite via
  #2222; missing: CapTP EPIPE (#2242) still open and Windows CI still off.
- [#2299](./issues/2299.md) — Document `CopySet`/`CopyTagged` — patterns README
  cross-links via #2442 (2024-12); missing: explicit `getCopySetKeys()` doc.
- [#2331](./issues/2331.md) — Upgrade some actions — `actions/checkout` 3→4
  via #2552 (2024-10), deploy-pages via #2827 (2025-05); missing: `setup-node`
  v3→v4 (#2543 closed unmerged, #2933 closed unmerged).
- [#2388](./issues/2388.md) — Compartment-map tags-to-conditions migration —
  premature schema rename reverted via #2389 (2024-07); missing: actual
  migration with schema-version negotiation.
- [#2410](./issues/2410.md) — Tolerate non-normative `compartment-map.json`
  fields — underscore-prefix design via #3182 (2026-04); missing: full
  validator-level tolerance.
- [#2671](./issues/2671.md) — Same as #2410 (companion issue) — partially
  via #3182.
- [#2761](./issues/2761.md) — SES Hermes improvements (tracking) — `host
  Evaluators` (#2723) and #2855 done; most checkboxes still open.
- [#3050](./issues/3050.md) — OpenSSF Security Scorecard — Pinned-Dependencies
  automation via #3066 (2026-01); missing: Token-Permissions / least-privilege
  workflow scoping.

### Unclear (epics, philosophical, "we should think about X")

A separate cluster of ~30 issues are scoped as epics, design discussions, or
"we should think about X someday" items that don't map onto a single PR.
Examples: #22 (earliest platforms), #26 (test262 epic), #105 (TC39 override
mistake), #289, #310, #486, #870, #879 (Pet Daemon epic), #1003, #1191
(TypeScript environment), #2117, #2244, #2752, #2823, #2859, #3019, #3024,
#3140.
These should be reviewed by a maintainer rather than auto-closed.

## Open or draft PRs whose change has merged elsewhere

### Landed elsewhere — close as superseded

- [#1506](./changes/1506.md) → superseded by **#1507** (2023-07): own
  description says "Abandoned in favor of #1507".
- [#1779](./changes/1779.md) → superseded by **#2615** (2024-10): repo-wide
  jsdoc/recommended-typescript-flavor enabled.
- [#2204](./changes/2204.md) → superseded by **#2720** (2025-02): `@endo/
  benchmark` package using the same `eshost`+`esvu` runner.
- [#2989](./changes/2989.md) → superseded by **#3008** (2026-02): `@endo/
  harden` introduced with `hardened`/`shallow`/`noop-harden` modes.
- [#3061](./changes/3061.md) → superseded by **#3172** (2026-04): `CopyArray<T>`
  is now `readonly T[]`.
- [#3063](./changes/3063.md) → made obsolete by **#3172** (was the analysis
  sub-PR of #3061).
- 12 Dependabot bump PRs from 2024-09 → all superseded by **#2866** group bump
  (2025-08), or by removal of the dependency (Rollup is no longer a direct dep
  of `bundle-source` or `evasive-transform`):
  #2523, #2526, #2530, #2535, #2537, #2538, #2545, #2548, #2555, #2571,
  #2572, #2701.

### Likely-obsolete — close without porting

- ~10 explicit "DO NOT MERGE" / diagnostic / dead-base-branch drafts: #1014,
  #1075, #1494, #1505, #1630, #1632, #2031, #2395.
- ~43 Dependabot per-package c8/eslint bumps now centralized via the **catalog
  refactor (#2966)**: every `chore: bump c8 in /packages/*` and `chore: bump
  eslint in /packages/*` PR opened before the catalog landed.
- ~10 ContribAI scaffolding submissions for nonexistent packages: #3139,
  #3142, #3143, #3144, #3145, #3146, #3148, #3166, #3167, #3168, #3169, #3170.
  These reference `packages/regexp-escape`, `packages/smallcaps`, `packages/
  fs`, `packages/agent`, etc. that do not exist in the tree; they were
  drive-by submissions in October 2026.

### Stale drafts (open ≥18 months, no successor)

- ~38 Dependabot per-package c8/eslint/ava bumps from 2024-10 plus older
  security bumps (#1361, #1389, #1483, #2479–#2494).
- ~25 feature/bug drafts last touched in 2022–2024: #1149, #1168, #1256,
  #1408, #1410, #1412, #1416, #1572, #1573, #1608, #1620, #1692, #1709,
  #1722, #1804, #1813, #1877, #1967, #2044, #2051, #2057, #2119, #2401,
  #727, #892.
- 12 newer drafts that have been quiet but may still have intent: #2871,
  #2875, #2924, #2926, #2931, #2961, #2997, #3000, #3006, #3033, #3049,
  #3068, #3075, #3090, #3099, #3118, #3121, #3124, #3134, #3154, #3164,
  #3175, #3187, #3197, #3205, #3206 (boneskull `parser-pipeline` stack and
  `llm`-branch Cursor-agent drafts).

## Suggested actions

The highest-leverage cleanup, in order:

1. **Close the 20 likely-landed issues** — quick maintainer pass with the PR
   citation. Each costs roughly one comment and one click.
2. **Close the 18 PRs in "Landed elsewhere" with a one-line "superseded by
   #N" comment** — they're all clear-cut.
3. **Close the ~50 Dependabot bumps superseded by the catalog refactor** —
   ideally as a single batch comment per bot run, with a link to #2966.
4. **Triage the ContribAI scaffolding submissions** — uniformly close as
   "unrelated to current package layout" unless a maintainer sees value.
5. **Revisit the partially-landed issues** for whether the residual scope is
   worth a separate ticket vs. closing the existing one once the merged
   portion is documented.

## Auxiliary inputs

- `/tmp/iss-batch-{1..9}.txt` — input lists for the issue audits.
- `/tmp/pr-batch-{1..3}.txt` — input lists for the PR audits.
- `issues/<N>.md` and `changes/<N>.md` — the source documents.
- `issues/README.md` — earlier classification of issues by area.
- `changes/<N>.md` `## Summary` block — searchable theme/state index.
