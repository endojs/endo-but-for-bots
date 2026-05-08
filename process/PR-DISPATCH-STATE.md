# PR dispatch state

Last cycle: 2026-05-08 (conductor PR 136 merge).
Prior cycle: 2026-05-07 (conductor PR 137 merge).
Earlier: 2026-05-07 (conductor PR 119 merge).
Earlier: 2026-05-07 (conductor PR 99 merge).
Earlier: 2026-05-07 14:55 UTC (PR 119 contributor review).
Earlier: 2026-05-07 07:00 UTC (master synced; fixer for PR 114; PR 111 fold-in dispatched).

## Cycle 2026-05-08 (conductor PR 136)

PR 136 merged → `9573569c48226a74926fee050b25fe24f777f1f0` (merge commit
to `llm`).
`design(sandbox): mirror PLAN/endo_posix_sandbox.md into designs/`,
designer-authored mirror for milestone calibration.
At survey: APPROVED (kriskowal 01:18 with two minor cleanup comments),
isDraft=true, MERGEABLE/UNSTABLE, reviewDecision=APPROVED.
Addressed both review comments on `designs/endo-posix-sandbox.md`:
removed kriskowal from the Author field (replaced with `kriscendobot
(prompted by kriskowal)`); fixed phase-progression table column
alignment by hand (Prettier with default config does not auto-align
markdown table cells, but the column widths now match throughout).
Force-pushed `08bf2a5e8e` with `--force-with-lease`.
Replied to both review comments (3205638470, 3205640040) with `Done.
<sha>` confirmations.
Marked PR ready for review (was draft); `gh pr merge --auto --merge
--delete-branch` resolved as direct merge immediately (branch
protection does not gate on CI).
state=MERGED on first verify.
Local `design/sandbox-roadmap` branch deleted; `design-sandbox-roadmap`
worktree removed.

## Cycle 2026-05-07 (conductor PR 137)

PR 137 merged → `6a5aecd01d133e807b2666102a6450ea12487d29` (consolidation
of OCapN noise stack #111+#112+#113); source PRs #111/#112/#113 left
open per kriskowal's reopen at 23:57 (history/discussion). At survey:
APPROVED (kriskowal), MERGEABLE/UNSTABLE (CI propagating: 18/29
SUCCESS, 11 pending, 0 fail), 0 behind `bots-ssh/llm`, 4 ahead. Four
commits read coherently (`feat(ocapn): codec injection +
network/transport split`, `feat(ocapn-noise): Noise IK netlayer with
browser portability`, `test(ocapn-noise): integration, transports,
fabrics`, `chore: update yarn.lock for ocapn + ocapn-noise` — the
lockfile per yarn-lock-separate-commit convention). Skipped tidy and
skipped rebase (0 behind). Issued `gh pr merge --auto --merge
--delete-branch`; GitHub resolved as direct merge immediately (branch
protection does not gate on CI). state=MERGED on first verify. Local
`feat/ocapn-noise` branch in `~/endo.repo` deleted; worktrees
`~/endo-wt/feat-ocapn-noise` and `~/endo-wt/conductor-pr137` removed.
Source PRs #111/#112/#113 NOT closed — the maintainer's reopen at
23:57 overrode the bot's prior close, signalling intent to keep them
open for history/discussion.

## Cycle 2026-05-07 (conductor PR 119)

Merged this run:

- #119 → `42a452928dfea2938f18e2ff0fb79375fe5d325d` (merge commit
  to `llm`). `feat(sandbox): provide default $PATH derived from
  rootfs`, original author jcorbin. At survey: APPROVED (kriscendobot
  21:11), MERGEABLE/CLEAN, 27/27 CI SUCCESS at brief, 3 behind
  `bots-ssh/llm`, 3 ahead. Three commits at entry read coherently:
  `feat(sandbox): provide a fallback $PATH semantics`,
  `chore(sandbox): fix dead TODO/ vs TADA/ citation paths`
  (shepherd's citation fix), and `fix(sandbox): mounted bin paths
  have predictable dependencies` (jcorbin's iterative refinement
  with new TADA/25 design doc). Skipped tidy — discrete commits
  document discrete concerns. Rebased onto `bots-ssh/llm` cleanly
  (no conflicts), force-pushed `ac19b79d59` with `--force-with-lease`.
  Per role guidance, rebase moots brief's "direct `--merge`" claim;
  used `--auto --merge --delete-branch`. GitHub resolved as direct
  merge immediately (branch protection does not gate on CI).
  state=MERGED on first verify. Local `shepherd/pr-119` branch
  deleted; `shepherd-119` worktree removed.

## Cycle 2026-05-07 (conductor PR 99)

Merged this run:

- #99 → `eefbff0b2ad185ef07a9a59a7480f444a13eee04` (merge commit
  to `llm`). `feat(daemon): garbage-collect content store and
  scratch-mount dirs` + adversarial test coverage. At survey:
  APPROVED, MERGEABLE/CLEAN, 19 behind `bots-ssh/llm`, 3 ahead.
  Rebased onto `bots-ssh/llm` cleanly (no conflicts). Three
  commits at entry: `feat(daemon)`, `test(daemon)`,
  `fix(daemon): mark transitive hashes retained ... (#99 review)`.
  The third was a review-followup that addressed a defect in the
  feat commit (transitive tree-hash sweep), so reordered it to
  position 2 and absorbed via `fixup`. Tree byte-identical
  against pre-tidy `1f425236d1` (empty `git diff`). Reworded the
  feat commit message to drop the "out of scope, tracked as a
  follow-up" caveat and instead document the
  `collectTransitiveTreeHashes` helper that the absorbed fix
  introduced. Force-pushed `8c0d7d8493` with
  `--force-with-lease`. Issued `gh pr merge --auto --merge
  --delete-branch`; GitHub processed it as a direct merge
  immediately (branch protection does not gate on CI). state=MERGED
  on first verify. Local + remote `feat/daemon-content-store-gc`
  branch deleted; `pr-99` worktree removed.

Many vacuous cycles between 08:00 and 14:30 UTC — both liaison + marshal returned `no state change since prior` each fire; no contributor activity, no merges, no maintainer feedback. Estate steady.

## Cycle 2026-05-07 14:55 UTC

- **PR 119** (`feat(sandbox): provide default $PATH derived from
  rootfs`, jcorbin, +1598/-17, 11 files) opened at 14:53 UTC.
  First non-bot, non-maintainer activity in 7 hours. Touches
  `packages/sandbox/` — same package the daemon-os-sandbox-plugin
  reclassification surfaced.
- **Panel review** posted as `CHANGES_REQUESTED` (review
  `pullrequestreview-4245100904`): 10 approve/comment-only, 2
  request-changes. Must-fix:
  1. Empty PR body for a 1.6 kLOC cross-cutting change spanning
     11 files and 3 TADA design docs. Add summary cross-linking
     `TADA/21..23`.
  2. Six dead doc citations: source code references
     `TODO/22_sandbox_bwrap_path_refinements.md` and
     `TODO/23_sandbox_podman_path.md`, but those files actually
     live in `TADA/`. Sites: `src/drivers/path.js` (lines 13, 14,
     217), `src/drivers/bwrap.js` (line 335),
     `test/bwrap.test.js` (line 906),
     `test/podman.test.js` (line 660).
- **Saboteur findings** posted as PR comment
  (`issuecomment-4398264566`): 4 concrete fix targets across 7
  attack vectors:
  1. `realpath` survivors in `filterAmbientPathForHostBind`
     (symlink farm bypasses the `/tmp` blocklist).
  2. Reject `:` / control chars in `joinPathEntries`
     (delimiter injection via `mount.innerPath`).
  3. Early-return `[]` in `probeMountRootfsBinPaths` when
     `hostPath` is non-absolute.
  4. Document or change empty-probe `mount`-rootfs fallback
     (currently falls back to host-shaped DEFAULT_PATH that
     doesn't exist in the slice).
- **Hand-off**: PR is a contributor PR (jcorbin), so the bot does
  NOT auto-dispatch a fixer. Findings surfaced to jcorbin +
  kriskowal via the review + comment. If jcorbin doesn't address
  before merge, the maintainer can request a bot fixer dispatch
  via the steward.
- **Saboteur self-improvement**: new skill
  `skills/saboteur-adversarial-review.md` (commit `6c0665ee23`)
  captures the rootfs-derived environment derivation attack class
  for future reuse on `drivers/path.js`-shaped code.

## Cycle 2026-05-07 07:30 UTC

PR 115 merged via conductor → `12e8600e8c`. Liaison surfaced new
issue #118 (OCapN/Daemon integration). Marshal vacuous (awaiting
your reclassification of `daemon-os-sandbox-plugin`). Groom
reconciled post-merge state (`bbc7448951`).

Merged this cycle (2026-05-07 conductor, PR 115 cycle):

- #115 → `12e8600e8c3315ab4d797d4fe1766e0fb178b861` (merge commit
  to llm). `design(daemon): filesystem watchers (closes #110)`.
  At survey: APPROVED, MERGEABLE/CLEAN, 0 behind `bots-ssh/llm`,
  3 ahead. Three commits: the original design doc plus two
  follow-up tweaks (fold-in of maintainer answers, then
  `entry`→`type` rename) — both clear fixups against the doc
  introduced in the first commit. Interactive-rebase absorbed
  both as `fixup` into the base commit; tree byte-identical
  (empty `git diff` against pre-tidy `cd4a9d1bc6`). Force-pushed
  `b952c8bb54` with `--force-with-lease`. Issued `--auto --merge
  --delete-branch`; GitHub processed it as a direct merge
  immediately (branch protection here does not gate on CI).
  state=MERGED on first verify. Local + remote
  `design/filesystem-watchers` branch deleted; `pr-115`
  worktree removed. Next-up PR 114 has CI green; awaiting
  kriskowal approval before queueing.

## Cycle 2026-05-07 07:00 UTC

- **PR 115** approved by kriskowal at 06:38 UTC (review
  `pullrequestreview-4241651383`). Add to merge queue once a
  conductor cycle is dispatched.
- **PR 114** fixer landed: master synced (bots-ssh/master moved
  from `4cb1ed4d26` to `f37c4b2d8f`, preserving 2 design-doc
  commits on top of `actual/master`); PR 114 rebased onto the
  new master; HEAD now `482ad077dc` (was `a8f1243f3b`); panel +
  saboteur fixes folded; saboteur tests added; CI in flight at
  cycle close (10 SUCCESS, 16 PENDING; mergeStateStatus=UNSTABLE
  pending CI). Re-requested review from kriskowal.
- **PR 111** received an 8-comment review batch from kriskowal
  06:39-06:53 UTC. Reactji'd 👀 on all 8. Note: a transient
  GitHub indexing anomaly hid these comments from the PR's
  review-thread API endpoint; comment bodies were captured from
  the events API payload. Fixer landed: 5 fold-ins applied
  (changeset omit, captp Slot type restore, `@endo/hex` adoption,
  drop deprecated `diagnosticEquals` shim, drop ava-duplicative
  `equals` helper + empty-file removal); 1 stalled with reply
  (cancelled-Promise<never> threading needs maintainer guidance);
  2 architectural-only replies (passable-CBOR extraction,
  sturdyreftracker vs noncelocator). HEAD `0116aa1283` (was
  `459d52c4aa`). 556 tests passed, lint clean. Re-requested
  review from kriskowal. Fold-in replies posted as one top-level
  summary (inline-reply API was 404'ing for these comments per
  the GitHub indexing anomaly). **Stack follow-up**: PRs 112 and
  113 stacked on 111; expect CONFLICTING/DIRTY after force-push;
  restage as separate steward concern.
- **Liaison cycle landed** (after this dispatch state was first
  written): issue #98 was closed upstream, tracking file deleted.
  Issue #116 (`Frugal use of CI`, kriskowal 04:55 UTC) opened;
  reactji + reply posted, `process/tracking/116.md` created.
  **Surface to steward for next marshal cycle**: #116 needs a
  researcher dispatch to survey change-impact-aware test selection
  for a primarily-Node monorepo (turborepo affected-by, nx
  affected, lerna `--since`, GH Actions path filters), with
  smaller C/Go/Rust components; deliverable is a proposal, not an
  implementation. Maintainer disprefers Bazel-scale solutions if
  lighter approach suffices.

- **Marshal cycle landed**: maintainer removed the review-queue
  back-pressure threshold ("It is sufficient to cap concurrent
  builder projects"); marshal.md updated. With 0 builders in
  flight and 1 eligible design, marshal would now dispatch a
  builder against `daemon-os-sandbox-plugin` (M5 capability,
  516-line spec, external deps only).
- **Builder dispatched**: `daemon-os-sandbox-plugin` — STALLED
  at pre-flight. The design's `Status: Not Started` is stale:
  `bots-ssh/llm` ships `packages/sandbox/` (Phase 0/1/1.5/2 done:
  bwrap + podman drivers, scratch mounts, network profiles,
  Landlock probe, seccomp, prlimit caps) under a substantially
  richer interface (`SandboxFactory.make(opts).spawn(args) →
  ProcessHandle`) than the design specifies (`SandboxMaker
  .describe(endowments).run(cmd, args) → {stdout, stderr,
  exitCode}`). The builder added a pre-flight rule to
  `roles/builder.md` ("Not Started but actually shipped under
  different name is impasse, not greenfield") and surfaced for
  reclassification. **Surface for maintainer**: pick one of three
  paths:
  1. Revise the design to describe the shipped `@endo/sandbox`
     shape (mounts as remotables, network profiles by name,
     ProcessHandle with reader/writer streams) → bumps to
     `Status: Complete`.
  2. Supersede with a new design that layers on `@endo/sandbox`
     (e.g. a thin `Sandbox.run(cmd, args) → {stdout, stderr,
     exitCode}` convenience wrapper).
  3. Mark obsolete if `@endo/sandbox` is the canonical answer.
  In-flight design-builder count remains 0 / ceiling 3 (no
  builder dispatched). Marshal's eligibility list now empty
  pending the reclassification.

- **Master sync** moved bots-ssh/master to incorporate ~5 commits
  of actual/master drift; affects all PRs based on master (75,
  73, 74, 71, 69, 68, 67, 64, 60, 59, 57, 55, 54, 76, 114).
  Most are now N commits behind their new base; rebases will be
  triggered as those PRs progress.

## Cycle 2026-05-07 06:30 UTC

Discovery: scan-fresh-feedback surfaced an 11-comment review batch
from kriskowal on PR 115 (1 inline) and PR 117 (10 inline + review
summary), 06:00-06:17 UTC. All comments reactji'd 👀; both
designer dispatches landed in the same cycle:

- **PR 115** (`design/filesystem-watchers`): renamed
  `entry: 'file' | 'directory'` discriminator to `type`
  (alias `MountEntryType`); HEAD `cd4a9d1bc6` (was `2244e30c9b`);
  re-requested review from kriskowal.
- **PR 117** (`design/namehub-interface-unification`): adopted
  `ReadableNameHubInterface` as the unified abstraction;
  established `maybeLookup` as the primitive with `lookup`
  derived; narrowed mount surface (no locator methods, no
  formula-implying methods); converted Open Questions to
  Decisions; flagged future `link(namePath, resultName)` design.
  HEAD `1bebbaa383` (was `610b907d6f`); re-requested review from
  kriskowal.

Designer self-improvement landed on garden as `2c655756d5`:
"convert open questions to decisions on settled review".


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

PR 143 merged → 1c1e792c61 (chronicler proposal: roles/chronicler.md + roles/scribe.md + roles/README.md)
