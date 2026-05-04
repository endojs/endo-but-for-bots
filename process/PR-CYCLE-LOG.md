# PR cycle log

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
