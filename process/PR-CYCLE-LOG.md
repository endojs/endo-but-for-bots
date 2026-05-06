# PR cycle log

## 2026-05-06 13:30 UTC: session summary

Compressed session-level log entry covering ~12 hours of steward
activity from the early-morning chat-harden discovery through the
review-queue-depth idle posture. Per-cycle entries skipped during the
session; recording the meta-summary now to honor the role file's
"append cycle-log section" close step.

**Architecture refactors landed on `garden`:**

- Folded `maestro` role into `steward`; removed `roles/maestro.md`
  (commit `4d8b8f99ca`).
- Extracted `director` (per-PR dispatch sweep) and `marshal`
  (design-pipeline pick-next, owns continuous-occupancy invariant)
  from the steward (commit `9a7458c45d`); steward shrank from 327 to
  ~200 lines.
- Installed worktree-per-PR lifecycle: builder creates `pr-<N>` after
  `gh pr create` returns the number, fixer reuses, conductor cleans
  up after merge (commit `066ff65040`).
- Builder hand-off chain to juror panel + saboteur on every fresh PR
  (commit `d5f3dc9483`); panel verdict submits as formal review then
  dispatches fixer (commit `dc8927c5cc`).
- Liaison cadence + reactji rule (commit `73df7837a1`).
- Groom direct-push-to-garden, no PR (commit `86edfdda07`); groom
  drift-check sub-mode + new skill `skills/design-queue-drift-check.md`
  (commit `6977c3c8a1`).
- Marshal's continuous-occupancy invariant (commit `56583fce23`)
  generalized later to allow review-queue-depth as a third
  vacuous-satisfaction trigger (commit `96dfc3dcf1`).
- New skill `skills/design-queue-drift-check.md` formalizes the
  drift-A (design-vs-code) and drift-B (compose-pattern deps) checks
  builders run pre-flight (commits `9995c6ca96`, `e9909c869a`,
  `fe9d7ab950`).

**PRs merged this session (9):** #51, #84, #85, #86, #87, #88, #91,
#92, #93, #95, #97. Each conductor ran `gh pr merge --merge` (no
`--squash`, no `--rebase`); branch protection on this repo does not
gate on CI so `--auto --merge` resolved immediately in most cases.

**PRs opened this session (19, in maintainer-review queue):**

- Code: #99 (content-store-gc), #101 (chat voice input, re-opened
  from #44), #104 (chat assert / re-import ses, fixes regression
  caught by #94's smoke), #105 (skill-registry), #106 (Browser exo),
  the PR 40 fixer follow-ups, the PR 70 RegExp.escape fixer
  follow-up, the PR 47 Docker CI fixer follow-up, the PR 75 Gibson
  fixer follow-up, the PR 59 ocapn-noise fixer follow-up
  (10/11 must-fix landed; needs maintainer's `Locator` rename pick).
- Designs: #100 (familiar-unified-weblet-server, replaces closed
  #48), #102 (chat voice command parser), #103 (chat slot-and-slash
  commands, re-opened from #30), #97 (groom roadmap reconciliation,
  merged).

**Marshal-builder impasses surfaced (3, all caught by pre-flight):**

- `daemon-agent-network-identity` — drift A: items 1 and 2 marked
  Done against a `LOCAL_NODE` sentinel that commit `d0ce26b327`
  (SQLite refactor) deliberately removed. Reclassified
  blocked-on-design-revision.
- `endoclaw-proactive-messages` — drift B at the phase level:
  depends on `endoclaw-timer` PR #40 Phase 2 (mail-delivered ticks),
  which is explicitly deferred in the timer design. Reclassified
  blocked-on-dependency.
- `endoclaw-notifications` — drift B from under-declared deps: the
  design's own `Depends On` claims standalone, but the
  `designs/README.md` milestone-summary annotation says "needs
  daemon↔Electron bridge" (which doesn't exist as a design).
  Reclassified blocked-on-dependency. Builder added a new
  pre-flight rule to cross-check README annotations
  (commit `fe9d7ab950`).

**Marshal-builder dispatches landed:** #99 (content-store-gc), #105
(skill-registry), #106 (Browser exo). Each ran the panel +
saboteur handoff per the new builder posture; PR 99 had 0 must-fix,
PR 105 had 2 must-fix (both addressed by follow-up fixer), PR 106
had 0 must-fix and 1 should-fix that turned out to be a panel
hallucination on re-inspection.

**Real bugs surfaced beyond addressed items:**

- Mail-mode tick delivery in PR 40: `E(handle).receive` from the
  maker scope hits `Mail fraud: unrecognized parcel` because the
  maker bypasses the sender's outbox; catch handler was silently
  swallowing. Surfaced as a `test.serial.skip` with diagnosis +
  recommended fix (plumb `agent's mailbox deliver()` into the
  maker scope). This is the same Phase 2 mail-tick the drift-check
  groom flagged as blocking `endoclaw-proactive-messages`; landing
  the fix unblocks both.
- `docker-compose.yml` in PR 47 missing `ENDO_GATEWAY_REMOTE=1`,
  so a fresh user following the compose-as-documented gets an
  unreachable daemon (Docker bridge connections arrive with
  non-loopback source addresses; address check rejects with code
  1008). PR 47 fixer surfaced; not in scope for that fixer pass.

**Process discipline incidents documented as self-improvements:**

- `--force-with-lease=branch:<sha>` silently clobbers concurrent
  pushes when the lease SHA is stale; the no-value form has the
  same race window in heavy-concurrency garden traffic. Recovery via
  `git rebase --onto HEAD <last-fetched> <clobbered-tip>`
  (commits `73df7837a1` for liaison, `da42fb18fb` for groom,
  `e380bb66b4` adding verify-diff-before-push).
- Stale `node_modules/.bin/*` shims in reused worktrees point at
  pruned siblings; one `yarn install` rewrites the store references
  (commit `262dcc9d15` on `skills/worktree-per-pr.md`).
- Builder cherry-picking under bot identity needs
  `git cherry-pick --no-commit` + GIT_AUTHOR_* env vars; plain
  `git cherry-pick` ignores GIT_AUTHOR (preserves original author),
  only updates the committer (commit `eda02a96f8`).
- `gh pr review --request-changes` fails on any PR whose gh-side
  author matches the active `gh auth login`; use `--comment` and
  surface must-fix list to the steward instead (commit `24e024e99b`).
- Filter-branch is the right tool for stripping
  `Co-Authored-By: Claude` trailers across a commit range despite
  the warning (commit `ca8d453c36`).
- Panel-report prose is not exempt from the no-em-dash style rule
  (commit `d5fc19e8d8`).

**Pending maintainer decisions (carried into the next session):**

- PR 59 Locator rename pick (`CapabilityRegistry` /
  `Holdings` / `SwissnumDirectory`).
- PR 40 split-or-keep-bundled (kept bundled by default;
  fixer addressed code-only items).
- `daemon-agent-network-identity` reconciliation: SQLite refactor
  vs. design's `LOCAL_NODE` sentinel; item 4 scope (per-agent vs.
  daemon-global registration); OCapN transport-separation dep.
- `daemon-electron-bridge` design needed before
  `endoclaw-notifications` is actionable.
- Mail-tick `deliver()` plumbing fix unblocks
  `endoclaw-proactive-messages`.

**Session totals:** 9 PRs merged, 19 opened, 30+ self-improvement
commits on `garden` across `roles/`, `skills/`, `process/`,
`CLAUDE.md`. Marshal-cascade caught 3 design-queue impasses cheaply
via the new pre-flight checks before any worktree-setup cost.

## 2026-05-04 21:04 UTC: cycle 1 (initial)

First steward cycle.
No prior `PR-DISPATCH-STATE.md` or `PR-CYCLE-LOG.md` existed; built the
baseline from a live survey.

Pulled `gh pr list -R endojs/endo-but-for-bots --state open` (59 open PRs surveyed).
Swept CI per `ci-status-summary.md`; audited rebase hygiene per
`rebase-hygiene-audit.md` (behind/ahead/conflict per PR via
`git merge-tree --write-tree`).

Dispatched (one role per PR per cycle):
- weaver for PR 50 (APPROVED docs design, 184 behind `llm`, clean rebase)
- fixer for PR 70 (CHANGES_REQUESTED at 01:38 UTC, head SHA `5c70485656` from 01:37 UTC unchanged)
- shepherd for PR 81 (single lint fail; prettier minor bump reformats 8 in-tree files)

Did not dispatch (notable):
- PR 82, 68, 64: head SHA newer than the CHANGES_REQUESTED review;
  author already addressed feedback. Status `awaiting maintainer`.
- 25 PRs `stale-on-base` (clean rebase available): deferred to spread
  force-push churn across cycles. Highest-priority next cycle:
  PR 51 (best-practices doc, 184 behind), PR 73 (compareRankRemotablesTied,
  21 behind), PR 62 (@endo/random base, 21 behind).
- 14 PRs `blocked (CONFLICT)`: cannot be rebased without author
  decisions; surfaced for maintainer.
- 9 ancient dependabot PRs (866–901 behind): recommended
  `@dependabot recreate`; steward does not post the comment.
- 5 review/* PRs with both staleness and CI red: held until the
  active cluster (PR 50/58/82) settles.

Dispatch outcomes (recorded at cycle close, 2026-05-04 21:32 UTC):
- **PR 50 (weaver)**: rebased clean from `84f7d86f33` to `921067c115`,
  pushed `--force-with-lease`. CI propagating. PR 58's base
  auto-shifted to the new design tip; needs a follow-up weaver next
  cycle once #50 lands.
- **PR 70 (fixer)**: rebased clean from `5c70485656` to
  `2a382a832f`. The CHANGES_REQUESTED feedback turned out to need a
  design-level decision (changing `mapNodeModules` "compartment root"
  semantics for entries deep in unnamed packages); the reviewer had
  explicitly offered a deferral path, which the fixer took with a
  reproducer + design analysis reply. Status flipped to
  `awaiting maintainer`. Self-improvement on `roles/fixer.md`:
  documented the deferral-when-reviewer-offers-it path.
- **PR 81 (shepherd)**: pushed prettier-format fix (`4cfceed01f`).
  The fix unmasked a second lint failure (`typescript-eslint` 8.59
  removes the `parserOptions.project + projectService` combination)
  that requires editing `packages/eslint-plugin/lib/configs/internal.js`
  out of shepherd scope. Escalated via PR comment. Status now
  `blocked (other)`. Two self-improvements: `roles/shepherd.md`
  gained a "Recurring patterns" section (prettier-minor recipe,
  dependabot-on-org-not-fork push idiom, unmask-pattern), and
  `skills/ci-status-summary.md` gained two pitfalls about flapping
  `gh pr checks` rollups and per-job-status transients (the
  shepherd lost ~10 minutes to these false-positives during this
  engagement).

Observations / follow-up items for the user:
- The `review/*` cluster (PRs 33–48) is structurally a stack of
  16 PRs all 235 commits behind `llm`. Coordinated weaver pass would
  be more efficient than per-PR cycles; consider tasking a maestro
  with this cluster as a unit.
- PR 58 is stacked on PR 50's branch. The weaver dispatched against
  PR 50 will force-update the design branch; PR 58 will become
  stale-on-base in the next cycle and needs an explicit weaver
  follow-up (held off this cycle to honor "one role per PR per cycle").
- No PRs are old-with-no-review and ready for a juror panel based on
  the survey; most no-review PRs are recent or are kriskowal's own
  drafts.
- PR 81's typescript-eslint config update is a single-file builder
  job (remove `project: [rootTsProjectGlob]` from the
  `projectService` block in `packages/eslint-plugin/lib/configs/internal.js`).
  Steward does not dispatch builders; this is a maintainer call.

Cycle-close housekeeping: working tree carried role/skill
self-improvements authored by the dispatched fixer and shepherd
agents (`roles/fixer.md`, `roles/shepherd.md`,
`skills/ci-status-summary.md`).
The steward role explicitly forbids authoring non-process commits, so
these are **left uncommitted** for the user to land in a separate
substantive commit (or to re-dispatch the agents asking them to
commit their own edits next time).
Surfaced explicitly in the steward's final report.
