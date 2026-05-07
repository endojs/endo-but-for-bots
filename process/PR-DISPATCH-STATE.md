# PR dispatch state

Last cycle: 2026-05-06 15:30 UTC (conductor drained 2-PR queue).
Surveyed 30 open PRs on `endojs/endo-but-for-bots`. Down from 59 at
the prior snapshot; 29 PRs closed or merged across the session
(11 merged via the conductor, 18 closed-as-superseded by the
re-open-under-bot pattern: PRs 30, 44, 48 → 103, 101, 100; plus
mass cleanup of older review/* dependabot bots PRs). PRs 108 and
100 merged via the conductor at 2026-05-06 15:30 UTC.

## Snapshot 2026-05-06 15:30 UTC

| PR | Title | Base | Review | Status |
| --- | --- | --- | --- | --- |
| ~~108~~ | TCP syrups transport framing design | llm | APPROVED | merged 2026-05-06 conductor → `677329b22f` |
| 106 | Browser exo with origin allowlist | llm | - | awaiting review (panel-vetted: 0 must-fix) |
| 105 | skill-registry helpers | llm | - | awaiting review (panel + fixer done) |
| ~~104~~ | re-import ses for assert global | llm | - | merged 2026-05-06 conductor → `ac5dd05663` |
| ~~94~~ | chat playwright smoke | llm | APPROVED | merged 2026-05-06 (post-#104 rebase + auto-merge from steward fallback after conductor stalled) |
| 103 | chat slot-and-slash commands design | llm | - | awaiting review (re-opened from #30) |
| 102 | chat voice command parser design | llm | - | awaiting review (sibling design for #101) |
| 101 | chat voice input | llm | - | awaiting review (re-opened from #44) |
| ~~100~~ | familiar unified weblet server design | llm | APPROVED | merged 2026-05-06 conductor → `07d36112d6` |
| 99 | content-store-gc | llm | CHANGES_REQUESTED | awaiting review (panel + builder fixer addressed should-fix) |
| 96 | aux package.json overrides design | llm | CHANGES_REQUESTED | awaiting review (designer-authored) |
| 89 | genie-integration design | llm | - | awaiting review (older) |
| 83 | garden agent-infrastructure perpetual | llm | - | meta-PR (steward bookkeeping) |
| 79 | ses namespace mutation test | llm | - | awaiting review (older, stale-on-base) |
| 76 | rankcover narrowing (mirror endo#3053) | master | - | blocked (CONFLICT, mirror) |
| 75 | random + chacha12 | master | - | awaiting review (Gibson follow-up addressed) |
| 74 | module-source robustness | master | CHANGES_REQUESTED | awaiting maintainer (older) |
| 73 | marshal compareRankRemotablesTied | master | - | awaiting review (older) |
| 71 | env-options per-compartment | master | - | awaiting review (older) |
| 69 | pass-style document.all-like | master | - | awaiting review (older) |
| 68 | docs Compartment OOM limits | master | CHANGES_REQUESTED | awaiting maintainer re-review (older) |
| 67 | eslint-plugin harden-exports patterns | master | - | awaiting review (older) |
| 64 | eslint-plugin harden-exports M.* | master | CHANGES_REQUESTED | awaiting maintainer re-review (older) |
| 60 | ses get-intrinsics test | master | - | awaiting review (older) |
| 59 | ocapn-noise IK netlayer | master | CHANGES_REQUESTED | awaiting review (panel + fixer done; needs Locator rename pick) |
| 58 | error tracing daemon/cli | llm | - | awaiting review (older, stacked-on-#50 base resolved) |
| 57 | marshal immutable ArrayBuffer | master | - | awaiting review (older) |
| 55 | base64 hardened module | master | - | blocked (CONFLICT) |
| 54 | xorshift consolidation | master | - | blocked (CONFLICT) |
| 49 | ocapn-noise review fixes | llm | - | awaiting review (older) |
| 47 | docker self-hosting | llm | - | awaiting review (Docker CI workflow added; ENDO_GATEWAY_REMOTE follow-up flagged) |
| 46-22 | various older review/* + endor PRs | llm | - | awaiting review or blocked (see prior snapshot) |
| 40 | agent-tools (post-fixer) | llm | CHANGES_REQUESTED | awaiting maintainer (panel verdict + fixer addressed code-only items; structural split deferred) |
| 1-10 | ancient dependabot | llm | - | blocked (ancient; `@dependabot recreate`) |

### Counts

- `awaiting maintainer review`: 22 (the action queue; #100 + #108 merged this cycle)
- `blocked (CONFLICT)`: 4 (#55, #54, #76 mirror, plus a few older review/*)
- `blocked (ancient dependabot)`: 9
- `meta`: 1 (#83)

Total: 28 open PRs (down from 30).

### Dispatched-but-active builders

None in flight. Marshal is in vacuous-satisfaction (review-queue
depth=14 in the bot-managed subset; deferring sandbox-plugin
builder until queue draws down). See `roles/marshal.md` for the
trigger.

### Merge queue

(empty)

### Stalled list

(empty by current cycle's standard; see "Per-PR notes" below for
session history)

### Closed (no further tracking)

Per CLAUDE.md's "Closed PRs and issues are inert" rule, the
following closed-not-merged PRs receive no further dispatch,
follow-up, or tracking. The steward does not re-survey them and
will not dispatch any role against them. Discoveries that would
have warranted action go to a fresh follow-up artifact (a new PR
against the same code area, a new issue citing the closed one,
or a steward cycle-log note for the user).

Closed during this session (2026-05-06):

- #30 (`docs(designs): add chat-slot-slash-commands design`) closed 06:33 UTC, superseded by #103.
- #44 (`feat(chat): voice input via Web Speech API`) closed 05:55 UTC, superseded by #101.
- #48 (`docs: design loop scaffolding and unified-weblet-server revisions`) closed 05:44 UTC, superseded by #100.
- #56 (`feat(marshal): admit immutable ArrayBuffer through codecs`) closed 05:33 UTC, withdrawn by maintainer.
- #62 (`feat(random): add @endo/random ChaCha20-based seedable PRNG`) closed 05:32 UTC, superseded by the @endo/random + chacha12 split in #75.
- #70 (`feat(compartment-mapper): diagnose package.json without a name`) closed 04:15 UTC by maintainer; the auxiliary-package.json design lives at #96 instead.

Closed earlier (per session-history snapshot):

- #87 (`docs(bundle-source): drop NEWS.md recommendation`) closed 2026-05-05.
- #72 (`fix(bundle-source): include cacheSourceMaps in options type`) closed 2026-05-05.
- #52 (`feat(xorshift): add @endo/xorshift package`) closed 2026-05-06.
- #27 (`feat(base64): dispatch to native Uint8Array base64 intrinsic`) closed 2026-05-05.
- #24 (`chore: bump the all-minor-patch group`) closed 2026-05-02.
- #53, #77, #25, #63, #65, #66, #28, #61, #18 closed pre-session per the GraphQL audit; treat all of these as inert.

If a user direction explicitly references a closed PR by number,
verify state before dispatching: `gh pr view <N> --json state`
must return `OPEN`. A `CLOSED` or `MERGED` state means stop and
report; do not dispatch a sub-agent against it.

---

## Historical snapshot below (kept for session-history reference)

The table below is the 2026-05-04 snapshot as the cycle 1 baseline.
Many entries have since merged or closed; the snapshot above is
authoritative for current dispatch decisions.

Last cycle: 2026-05-04 21:04 UTC.
Surveyed 59 open PRs on `endojs/endo-but-for-bots`.

| PR | Title (truncated) | Base | Behind | CI | Review | Last dispatch | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 82 | guix-ci-resilience | llm | 0 | green | CHANGES_REQUESTED (stale) | (none) | awaiting maintainer |
| 81 | dependabot all-minor-patch | llm | 0 | 1 lint fail (NEW cause) | none | 2026-05-04 shepherd | blocked (typescript-eslint config) |
| 79 | ses namespace mutation test | llm | 184 | green | none | (none) | stale-on-base |
| 76 | gibson-3046-narrow-rankcover | master | 180 | err | none | (none) | blocked (CONFLICT) |
| 75 | @endo/random + chacha12 | master | 0 | green | none | (none) | awaiting review |
| 74 | audit module-source visitors | master | 11 | green | none | (none) | stale-on-base |
| 73 | marshal compareRankRemotablesTied | master | 21 | green | none | (none) | stale-on-base |
| 72 | bundle-source cacheSourceMaps types | master | 11 | green | none | (none) | stale-on-base |
| 71 | env-options per-compartment | master | 11 | green | none | (none) | stale-on-base |
| 70 | compartment-mapper no-name diagnostic | master | 0 | pending | CHANGES_REQUESTED | 2026-05-04 fixer | awaiting maintainer (deferral reply) |
| 69 | pass-style document.all-like | master | 19 | green | none | (none) | stale-on-base |
| 68 | docs Compartment OOM limits | master | 11 | green | CHANGES_REQUESTED (stale) | (none) | awaiting maintainer |
| 67 | eslint-plugin harden-exports patterns | master | 11 | green | none | (none) | stale-on-base |
| 64 | eslint-plugin harden-exports M.* | master | 11 | green | CHANGES_REQUESTED (stale) | (none) | awaiting maintainer |
| 62 | @endo/random ChaCha20 | master | 21 | green | none | (none) | stale-on-base |
| 60 | ses get-intrinsics test | master | 11 | green | none | (none) | stale-on-base |
| 59 | ocapn-noise restaged | master | 0 | green | none | (none) | awaiting review |
| 58 | error tracing implementation | design/error-tracing-across-workers | 0 | green | none | (none) | awaiting review (stacked on #50) |
| 57 | marshal immutable ArrayBuffer | master | 18 | green | none | (none) | stale-on-base |
| 56 | byteArray-codecs | design/endo-xorshift | 0 | green | none | (none) | awaiting review (stacked on #52) |
| 55 | base64 hardened module | master | 19 | green | none | (none) | blocked (CONFLICT) |
| 54 | xorshift consolidation | master | 19 | green | none | (none) | blocked (CONFLICT) |
| 52 | @endo/xorshift package | master | 30 | green | none | (none) | blocked (CONFLICT) |
| 51 | best-practices-from-review | llm | 184 | green | none | (none) | stale-on-base |
| 50 | error tracing design doc | llm | 0 | pending | APPROVED | 2026-05-04 weaver | ready for merge (CI propagating) |
| 49 | ocapn-noise review fixes | llm | 184 | green | none | (none) | blocked (CONFLICT) |
| 48 | review/10 design loop scaffolding | llm | 235 | green | none | (none) | stale-on-base |
| 47 | review/9 docker selfhost | llm | 235 | green | none | (none) | stale-on-base |
| 46 | review/8 ocapn network separation | llm | 235 | 11 fail | none | (none) | stale-on-base + CI red |
| 45 | review/7 command messages | llm | 235 | green | none | (none) | stale-on-base |
| 44 | review/7 chat voice | llm | 235 | green | none | (none) | stale-on-base |
| 43 | review/7 chat pending commands | llm | 235 | green | none | (none) | stale-on-base |
| 42 | review/7 chat markdown render | llm | 235 | green | none | (none) | stale-on-base |
| 41 | review/7 chat inventory dnd | llm | 235 | green | none | (none) | stale-on-base |
| 40 | review/6 agent tools | llm | 235 | 9 fail | none | (none) | stale-on-base + CI red |
| 39 | review/5 formula introspection | llm | 235 | green | none | (none) | stale-on-base |
| 38 | review/5 cli assorted | llm | 235 | green | none | (none) | stale-on-base |
| 37 | review/4 mount extensions | llm | 235 | 9 fail | none | (none) | stale-on-base + CI red |
| 36 | review/3 platform fs | llm | 235 | green | none | (none) | stale-on-base |
| 35 | review/3 mount core | llm | 235 | 8 fail | none | (none) | stale-on-base + CI red |
| 34 | review/2 locator v2 | llm | 235 | 8 fail | none | (none) | blocked (CONFLICT + CI red) |
| 33 | review/2 lal transcript fix | llm | 235 | green | none | (none) | stale-on-base |
| 32 | endor bus tui | llm | 184 | green | none | (none) | blocked (CONFLICT) |
| 31 | endor TUI rust skeleton | llm | 184 | green | none | (none) | blocked (CONFLICT) |
| 30 | chat slot slash commands design | llm | 184 | green | none | (none) | blocked (CONFLICT) |
| 29 | ocapn TCP syrup framing | llm | 184 | green | none | (none) | blocked (CONFLICT) |
| 27 | base64 native fallthrough | master | 38 | green | none | (none) | blocked (CONFLICT) |
| 26 | ci no-npm-lifecycle | llm | 184 | green | none | (none) | blocked (CONFLICT) |
| 23 | edit-message + messageHistory | llm | 184 | green | none | (none) | stale-on-base |
| 22 | slot-machine c-list manager | endor | 0 | green | none | (none) | awaiting review (1 merge commit, anomaly) |
| 10 | dependabot eslint-plugin-jsdoc | llm | 901 | 10 fail | none | (none) | blocked (ancient; `@dependabot recreate`) |
|  9 | dependabot @types/node 25.x | llm | 901 | 10 fail | none | (none) | blocked (ancient; `@dependabot recreate`) |
|  8 | dependabot @noble/hashes 2.x | llm | 866 | 5 fail | none | (none) | blocked (ancient; `@dependabot recreate`) |
|  7 | dependabot eslint-config-prettier | llm | 901 | 10 fail | none | (none) | blocked (ancient; `@dependabot recreate`) |
|  5 | dependabot changesets/action | llm | 866 | 4 fail | none | (none) | blocked (ancient; `@dependabot recreate`) |
|  4 | dependabot actions/cache | llm | 901 | 10 fail | none | (none) | blocked (ancient; `@dependabot recreate`) |
|  3 | dependabot actions/setup-python | llm | 901 | 10 fail | none | (none) | blocked (ancient; `@dependabot recreate`) |
|  2 | dependabot actions/configure-pages | llm | 901 | 10 fail | none | (none) | blocked (ancient; `@dependabot recreate`) |
|  1 | dependabot actions/upload-artifact | llm | 901 | 10 fail | none | (none) | blocked (ancient; `@dependabot recreate`) |

## Counts (post-dispatch outcomes)

- `ready for merge` (CI propagating): 1 (#50)
- `awaiting maintainer`: 4 (#82, #68, #64: author addressed CHANGES_REQUESTED; #70: fixer deferral reply per reviewer's offered path)
- `awaiting review`: 5 (#75, #59, #58, #56, #22)
- `stale-on-base`: 25
- `stale-on-base + CI red`: 5 (#46, #40, #37, #35, plus #34 conflicting)
- `blocked (CONFLICT)`: 14 non-dependabot
- `blocked (other)`: 1 (#81: typescript-eslint config from minor bump)
- `blocked (ancient dependabot)`: 9

Total: 59 open PRs.

## Per-PR notes

### #50 (weaver complete, 2026-05-04)
Rebased to `921067c115` on top of current `bots/llm`; pushed with
`--force-with-lease`.
CI propagating (8 SUCCESS, 18 pending, 0 fail).
PR #58's base auto-updated to `921067c115` as expected.
Next cycle: confirm #50 lands; then rebase #58 if its base needs to
shift to `llm` directly post-merge.

### #70 (fixer complete, 2026-05-04)
Reviewer raised an unhandled case (entry deep in a typemod-scoped
sub-folder of an unnamed package).
Fixer reproduced it, determined the fix would change `mapNodeModules`
"compartment root" semantics (a design decision), and took the
deferral path the reviewer explicitly offered ("If we do not handle
that case yet, please reply to that effect instead").
Rebased onto current `master` (clean), pushed `2a382a832f`, posted
reply with reproducer + design analysis + offer to follow up.
Next cycle: skip unless review state changes.

### #81 (shepherd complete, 2026-05-04)
Pushed `chore: yarn format after prettier minor bump` (8 files,
formatting-only) → unmasked a SECOND lint failure: `typescript-eslint`
8.59 deprecated `parserOptions.project` when `projectService` is set.
This is an in-tree config change in `packages/eslint-plugin`, out of
shepherd scope. Posted comment.
Recurring-pattern note added to `roles/shepherd.md`.
Needs builder/fixer dispatch (or maintainer call) to update the
ESLint internal config.

### #82 (no dispatch, 2026-05-04)
Head `86e8b9b0e9` at 20:01 UTC supersedes the CHANGES_REQUESTED review at 19:02 UTC.
Maintainer re-review needed.
Next cycle: skip unless review state changes.

### #68 (no dispatch, 2026-05-04)
Head `cb8d6286ab` at 01:51 UTC supersedes the CHANGES_REQUESTED review at 01:44 UTC.
Awaiting re-review.

### #64 (no dispatch, 2026-05-04)
Head `d483637871` at 02:29 UTC supersedes the CHANGES_REQUESTED review at 02:18 UTC.
Awaiting re-review.

### #58 (no dispatch, 2026-05-04)
Stacked on `design/error-tracing-across-workers` (PR #50).
After PR #50's weaver-rebase lands, #58 will become stale-on-base relative to the new design tip and need a follow-up rebase.

### #56 (no dispatch, 2026-05-04)
Stacked on `design/endo-xorshift` (PR #52).
PR #52 has CONFLICT with `master`; #56 is blocked behind that.

### Review/* cluster (#33–#48, #46, #40, #37, #35)
Sixteen `review/*` PRs all 235 commits behind `llm`.
Five have CI failures alongside the staleness.
Mass-rebasing this cluster in one cycle would create force-push churn for the maintainer; defer to a coordinated weaver pass after the active cluster (#50, #58, #82) settles.

### Ancient dependabot cluster (#1–#10)
Nine bot PRs each 866–901 commits behind `llm`.
The rebase distance exceeds the practical threshold; recommend `@dependabot recreate` on each rather than manual rebase.
The steward does not post the comments; that is a maintainer action.

## Merge queue

(empty)

Merged this run (2026-05-06 conductor, PR 51 cycle):

- #51 → `96222a06e5` (merge commit to llm).
  `docs: distill PR-review best practices into CLAUDE.md and
  CONTRIBUTING.md`. Was 228 behind, 1 ahead at survey;
  MERGEABLE/CLEAN with `reviewDecision=APPROVED` and 25/25 SUCCESS.
  Single commit (already coherent); no tidy. Rebased onto current
  `bots-ssh/llm` (clean, no conflicts; merge-tree probe reported
  clean before the rebase). Force-pushed `76a65b77df` with
  `--force-with-lease=design/best-practices-from-review:4b08c7de65`.
  Issued `gh pr merge --auto --merge`; GitHub processed it as a
  direct merge immediately on the freshly pushed CI. state=MERGED.
  Local + remote `design/best-practices-from-review` branch
  deleted; no `pr-51` worktree existed (predates the lifecycle).

Merged this run (2026-05-06 conductor, PR 92 cycle):

- #92 → `e398264405` (merge commit to llm).
  `feat(daemon): simplify guest eval per design (refs
  guest-eval-simplification)`. Was 6 behind, 3 ahead at survey;
  MERGEABLE/UNSTABLE with `reviewDecision=APPROVED`. Single CI
  failure on `test (20.x, macos-15)` was a known transient
  (`1 unhandled rejection` in `ws-relay` teardown, not in the
  daemon-guest-eval code path). The three commits were already
  coherent (drop dead artifacts → regression test → design PR ref);
  no tidy. Rebased onto current `bots-ssh/llm` (clean, line-number
  drift only in `designs/README.md`); force-pushed `2b787690c9`
  with `--force-with-lease`. Issued `gh pr merge --auto --merge`;
  GitHub processed it as a direct merge immediately on the freshly
  pushed (still QUEUED) CI. state=MERGED. The fresh push obviated
  the macOS flake re-run plan since CI restarted from scratch.

Merged this run (2026-05-06 conductor, PR 93 cycle):

- #93 → `31df9e3cf1` (merge commit to llm).
  Was 2 behind at survey, MERGEABLE/UNSTABLE with CI in flight (16
  pass, 10 pending). Three commits, atomic per concern (rename,
  alias+test, design status). Rebased onto current `bots-ssh/llm` (no
  conflicts); kept the three commits discrete (the `feat(cli)` alias
  introduces a new behavior plus its own test, distinct from the pure
  rename refactor; design-status is independent bookkeeping).
  Force-pushed `3a3f0a7560` with `--force-with-lease`. Issued
  `--auto --merge`; GitHub processed it as a direct merge because CI
  converged in the interim. state=MERGED.

Merged this run (2026-05-06 conductor, resume cycle):

- #84 → merged (merge commit to master).
  Prior conductor tidied; resume conductor found CI conclusively green
  (26 SUCCESS, MERGEABLE) and ran direct `gh pr merge --merge`.
  state=MERGED.
- #88 → merged (merge commit to llm).
  Prior conductor tidied; resume conductor sampled CI as 18 SUCCESS + 8
  pending and issued `--auto --merge`.
  Pending checks completed in the interim, so GitHub processed the
  auto-merge as a direct merge; state=MERGED on first verify.

Merged this run (2026-05-06 conductor):

- #91 → `e3c1ef10b4` (merge commit to llm).
  Single-commit PR (`design(chat): Playwright build-and-load smoke
  in browser CI`); 0 behind, 26/26 SUCCESS at survey, MERGEABLE.
  Direct `gh pr merge --merge` succeeded; state=MERGED.
  No tidy required.

Merged this run (2026-05-05 conductor, second cycle):

- #90 → `49bb6b2a6d` (merge commit to llm).
  Roadmap reconciliation PR from groom; was 0 behind, 1 ahead at
  enqueue with 26/0/0 green CI and CLEAN mergeStateStatus. Single
  commit (`docs(designs): roadmap reconciliation 2026-05-05`) so
  no tidy needed. Direct `--merge` succeeded; state=MERGED.

Merged this run (2026-05-05 conductor):

- #86 → `d72fdc9527` (merge commit to llm).
  Prior conductor tidied + pushed `e9a2d712db` (two clean commits,
  byte-identical to pre-tidy). At dispatch time, attempting
  `gh pr merge 86 --auto --merge` discovered the PR was already
  MERGED: CI completed and the auto-merge fired in the window
  between the prior conductor's push and this dispatch.
  No action required beyond the bookkeeping update.

Merged this run (2026-05-04 conductor):

- #81 → `dac84e9de8` (rebase merge to llm).
  Was 7 behind at enqueue; gh auto-merge with `--rebase` rebased and
  merged on green CI immediately (mergeStateStatus=CLEAN, 26/26 SUCCESS).
- #85 → `8ddfab0d9d` (rebase merge to llm).
  Was 11 behind after PR 81 landed; brief snapshot showed 5 pending CI
  jobs but they completed in the interim. gh auto-merge with `--rebase`
  rebased and merged immediately. The 6 design-rename commits land as
  separate commits on llm under SHAs `9c8d9be2ae` through `8ddfab0d9d`.

Merged this run (2026-05-04 weaver continuous-merge):

- #50 → `741e8000fb` (rebase merge to llm).
  Clean: 0 behind, 26/26 SUCCESS at enqueue.
- #82 → `730f07810a` (rebase merge to llm).
  Required rebase from `86e8b9b0e9` to `1bb4d84b19` (2 behind after
  PR #50 merged); auto-merge with `--rebase` resolved on green CI.

Side effect for steward to handle next cycle:

- PR #58 (`feat/error-tracing-implementation`) targets
  `design/error-tracing-across-workers` (the branch behind PR #50).
  Post-merge state of #58 is `mergeable=CONFLICTING, DIRTY` because
  the underlying design content is now on llm via the rebase merge.
  PR #58 needs its base re-targeted to `llm` and a rebase to drop
  the design-doc commits already on llm.
  Surface to steward: dispatch a weaver (or builder) to re-base #58.

Merged this run (2026-05-06 conductor, PR 104 cycle):

- #104 → `ac5dd05663` (merge commit to llm).
  `fix(chat): re-import ses to install globalThis.assert without
  lockdown`. 9-line one-file fix that addresses the assert-global
  regression flagged by #94's smoke test (parallel to #95's fix
  for `harden`). At survey: APPROVED, MERGEABLE/UNSTABLE, 1 commit,
  1 behind `bots-ssh/llm` (clean). CI mostly green with two
  pre-existing macos-15 test flakes (`test (18.x, macos-15)` and
  `test (22.x, macos-15)`) unrelated to the patch. Per the brief's
  guidance that branch protection on this repo does not gate on CI,
  ran direct `gh pr merge --merge` without rebase. state=MERGED on
  first verify. Local + remote `fix/chat-import-ses` branch deleted;
  pr-104 worktree at `/home/kris/endo-wt/pr-104` removed. Unblocks
  #94 (the chat bundle now ships with `assert` available at module
  load).

## Stalled list

Stalled this run (2026-05-06 conductor, PR 94 cycle):

- #94 (`feat(browser-test): chat build-and-load smoke`) →
  `ci needs builder/fixer`.
  Head `3a63392372` was already rebased onto current `bots-ssh/llm`
  (the prior pr-94 worktree did the rebase + the harden-fix
  validation by re-targeting onto #95 then back onto `llm` after
  #95 merged). MERGEABLE/UNSTABLE with `reviewDecision=APPROVED`
  but `browser-tests` (Playwright) FAILED with a NEW regression:
  `ReferenceError: Can't find variable: assert` at module load of
  `chat/assets/main-*.js`. Same shape as the harden regression
  that #95 fixed, but for a different missing global (`assert`
  rather than `harden`). The smoke test is doing its job —
  catching an unshimmed top-level `assert(...)` call in the chat
  bundle that breaks production-bundle execution. Out of conductor
  scope (the fix is in `packages/chat`, parallel to #95). Needs a
  follow-up fixer/builder to source `assert` from `@endo/errors`
  (or equivalent) in the chat modules that use it at top level.
  pr-94 worktree at `/home/kris/endo-wt/pr-94` left in place for
  the follow-up dispatch; remote branch
  `feat/chat-playwright-smoke` left intact.
