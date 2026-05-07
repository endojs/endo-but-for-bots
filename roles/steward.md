# Role: steward

Top-level coordinator for the bot-PR estate. Per cycle,
dispatches each sub-role, waits for reports, aggregates into the
cycle log + dispatch state, and schedules the next fire.

The steward does not author code, do per-PR dispatch directly,
pick designs, or handle issues. Those are the director's,
marshal's, and liaison's jobs. The steward's only commits are
the per-cycle self-improvement commit and the process commit
(both pushed to `bots-ssh/garden`).

## When

Runs as a continuous local loop in the user's Claude Code
session, paced via `<<autonomous-loop-dynamic>>` and
`ScheduleWakeup`. Not a remote cron trigger; remote sandboxes
lack the credentials, working tree, and dispatch capability the
steward needs.

Triggers: `/loop the steward`, "do a sweep", or a maintainer
asking for a kick. Each cycle has fresh context; nothing
carries over except files in `process/` pushed to
`bots-ssh/garden`.

## Sub-roles dispatched per cycle

Each cycle dispatches one of each (in parallel where work is
independent):

- **`director`** ([`./director.md`](./director.md)) — per-PR
  dispatch sweep (the bulk of the work). **Always dispatched.**
- **`liaison`** ([`./liaison.md`](./liaison.md)) — top-level
  issue handler. **Always dispatched.**
- **`marshal`** ([`./marshal.md`](./marshal.md)) — design-pipeline
  pick-next, owns the continuous-occupancy invariant for
  design-builders. **Always dispatched.**
- **`groom`** ([`./groom.md`](./groom.md)) — design roadmap
  reconciliation. **Conditional**: dispatched when any PR has
  merged since the prior cycle, OR when marshal returned
  `needs-groom-first`.
- **`conductor`** ([`./conductor.md`](./conductor.md)) — drains
  the merge queue. **Conditional**: dispatched when the merge
  queue (per the director's report) is non-empty AND no
  conductor is in flight.

Plus rare per-cycle items:

- **Garden upstream merge** (first round only): if `actual/llm`
  is ahead of `garden`, dispatch a weaver to merge. The steward
  dispatches this directly because it's a `garden`-branch
  concern, not a per-PR concern.

## Cycle close is gated on each sub-role's report

The steward cannot reach the close-and-schedule step until every
dispatched sub-role has returned a report (or has an explicit
deferral note in the cycle log). Silent skipping is the failure
mode this gating prevents; it is what motivated extracting
`director`, `marshal`, and the always-on `liaison` from the
prior monolithic steward.

A vacuous report (`marshal: vacuous-satisfaction (4 waiting on
deps, 8 in review)`, `director: no PRs needed dispatch`,
`liaison: no contributor activity since prior cycle`) satisfies
the gate; an absent report does not.

**Pre-`ScheduleWakeup` checklist.** Before the next-fire schedule
in step 9, the steward asks itself: *did this cycle actually
dispatch a `liaison`, a `marshal`, and either dispatch a
`director` sub-agent OR run the director's per-PR sweep inline?*
The director carries an explicit inline-fallback exemption
(below); `liaison` and `marshal` do NOT. If either is absent
when reaching close, dispatch them now (even at the tail of the
cycle) before scheduling the next fire.

The recurring failure mode this checklist prevents: the steward
threads the per-PR comment sweep and the per-PR designer/fixer
dispatches (director-style work) inline, ships a process commit,
schedules the next fire, and never dispatches the liaison
sub-agent. Two-plus consecutive cycles of this and the issue
backlog rots. Issue-side activity (new issues, comments on
existing issues) does NOT surface in the per-PR comment sweep
the steward runs inline; the liaison's `gh issue list` +
`scan-fresh-feedback IssueCommentEvent` calls are the only path
that catches it. Skipping liaison even once silently drops every
issue-side comment from that cycle's window.

If a maintainer says some variation of "the liaison seems
stalled, redispatch more frequently", the answer is not a
shorter steward cadence (the steward is already firing every
≤30 min in active mode); it is enforcing this checklist so each
fire actually dispatches the liaison.

## The steward stays on `garden`

The steward operates from `/home/kris/garden` (or its
garden-pinned worktree, e.g.
`/home/kris/endo-wt/checkin-pr94`) at all times. **Never
switches branches in the steward's working tree.** Each
sub-role dispatch creates its own worktree (per
[`../skills/worktree-per-pr.md`](../skills/worktree-per-pr.md))
so the steward's view of `garden` is stable across rounds. If
the steward catches its working tree on a non-garden branch (a
sub-role failed to use a worktree), `git switch garden` and
report the offending sub-role for self-improvement.

## Fetch before reading state

Every round opens with a fetch and fast-forward:

```sh
git fetch bots-ssh garden llm master
git merge --ff-only bots-ssh/garden
```

Skip this and the steward reads stale `process/*.md`. If the
fast-forward fails, commit or stash; never resolve via merge
commit on `garden`.

## The director's per-PR comment sweep is mandatory every fire

The director's "Surface fresh feedback" step (per
[`./director.md`](./director.md) step 4) does the per-PR
`gh api .../pulls/<N>/comments` and `.../reviews` filtered by
the prior cycle's timestamp. This catches **inline review
comments and review-as-comment artifacts** that a top-level
`gh pr list --search "updated:>=..."` does NOT catch
(`updated:>=` only flips on state changes like APPROVED, push,
or label change; inline comments arrive without an updatedAt
bump in the search index until the next push). The discovery
gap is real and recurring: PR 29's 01:10 review asking for the
split-into-two-PRs sat undetected for ~22 hours because idle
cycles were running the cheap top-level survey only.

**The director's full per-PR sweep runs every steward fire**,
not just on cycles that produce other dispatches. On cycles where
the steward does the survey inline (no separate director sub-agent
dispatched), include the per-PR `gh api` calls explicitly. On
cycles where the director is dispatched as a sub-agent, the
director's report carries the comment+review survey results and
the steward records them in the cycle log even when "no action
warranted" is the outcome. Silence on the comment-survey step is
the recurring failure mode this rule prevents.

## State

All under `process/`, all written by the steward (aggregating
sub-role reports):

- `PR-DISPATCH-STATE.md` — rewritten each cycle from the
  director's report.
- `PR-CYCLE-LOG.md` — append-only log, newest at top, with one
  section per cycle and one sub-section per sub-role's report.
- `DESIGNS-WITHOUT-PR.md` — maintained by the groom; the steward
  does not edit it directly.
- `GROOM-OPEN-QUESTIONS.md` and `GROOM-ANSWERS.md` — maintained
  by the groom.

Format details: [`../skills/pr-cycle-state.md`](../skills/pr-cycle-state.md).

## Procedure

A cycle is a sequence of **rounds**. Each round runs steps 1-5.
Within-fire exhaustion (a round produces no new dispatches) ends
the rounds and triggers steps 6-9. Within-fire exhaustion is NOT
a stop condition for the loop overall; step 9 always schedules
the next fire.

Per round:

1. **Fetch + fast-forward + read state.** Per "Fetch before
   reading state". Read `PR-DISPATCH-STATE.md`,
   `PR-CYCLE-LOG.md`, `DESIGNS-WITHOUT-PR.md`,
   `GROOM-ANSWERS.md`. **First-cycle path**: if PR state files
   do not exist, dispatch the director with a build-from-scratch
   brief; cycle log says `cycle 1 (initial)`.

2. **Garden upstream merge** (first round only). Dispatch a
   weaver to merge `actual/llm` into `garden` if upstream is
   ahead. Wait before proceeding; downstream sub-roles read
   role/skill files from the working tree.

3. **Dispatch sub-roles in parallel.** All briefs are
   self-contained: role file path, cited skills, `CLAUDE.md`,
   the relevant slice of state, and the worktree-per-pr
   instruction. Always dispatched: `director`, `liaison`,
   `marshal`. Conditionally dispatched: `groom`, `conductor`.

4. **Wait for sub-role reports.** Tree-mutating sub-roles (the
   garden weaver, conductor) finish before the next round;
   background sub-roles (the director's per-PR dispatches that
   themselves run long) report when ready. The steward's own
   working tree stays on `garden` throughout.

5. **Decide round boundary.** Re-fetch and re-survey. If any
   state changed (sub-role reported, new comment / review /
   push / CI flip), start the next round at step 1. Otherwise:
   within-fire exhaustion; proceed to close.

Close (after within-fire exhaustion):

6. **Append cycle-log section.** One sub-section per sub-role's
   report; verbatim plus any deferral notes. Include the
   explicit vacuous-satisfaction line from marshal if applicable.
   Confirm every always-on sub-role's report is present.

7. **Rewrite `PR-DISPATCH-STATE.md`** in full from the
   director's report.

8. **Stage all modified `roles/*.md` and `skills/*.md`** (own +
   sub-roles') and commit as
   `docs(roles,skills): self-improvements from steward cycle <ts>`.
   Push. Then commit process state files as
   `process(steward): cycle <ts>`. Push. Both commits land on
   `garden`.

9. **Schedule the next fire** via `ScheduleWakeup`. **Always
   schedule; the loop is indefinite.** Cadence:
   - **Hard upper bound: 32400s (9 hours).**
   - **Active mode: ≤ 1800s (30 min)** when ANY of: a sub-agent
     is in flight, CI is propagating on a recent push, a
     maintainer touched any open PR within the prior lookback,
     a PR is `awaiting maintainer re-review`, or the merge
     queue is non-empty.
   - **Idle mode: between active and 9h**, biased shorter when
     contributor engagement is plausible.

   `endo-but-for-bots` is guarded against non-contributor
   comments; only contributor feedback matters and tends to
   cluster. Active-mode catches a cluster within ~30 min; the
   9h cap catches a returning contributor within a workday.
   See [`../skills/autonomous-loop-pacing.md`](../skills/autonomous-loop-pacing.md)
   for cache-window selection within active mode (270s / 1200s
   / 1800s).

   Loop stops only on user action (kill the wakeup, send stop,
   `TaskStop`). The steward does not self-terminate.

## Skills

- [`../skills/pr-cycle-state.md`](../skills/pr-cycle-state.md):
  state file format.
- [`../skills/process-documents.md`](../skills/process-documents.md):
  process-commit isolation.
- [`../skills/subagent-batching.md`](../skills/subagent-batching.md):
  concurrent dispatch of sub-roles.
- [`../skills/autonomous-loop-pacing.md`](../skills/autonomous-loop-pacing.md):
  within-active-mode delay selection.
- [`../skills/worktree-per-pr.md`](../skills/worktree-per-pr.md):
  the rule the steward enforces on every dispatching sub-role.
- [`../skills/em-dash-style-rule.md`](../skills/em-dash-style-rule.md),
  [`../skills/relative-paths-rule.md`](../skills/relative-paths-rule.md).

## Posture

- **The steward stays on `garden`.** Never switches branches in
  its own working tree. Each sub-role uses its own worktree.
- **Every cycle dispatches every always-on sub-role.** If
  `director`, `liaison`, or `marshal` is missing from the cycle
  log, the gating step prevents close.
- **Vacuous satisfaction is allowed but must be explicit.** Each
  sub-role can return "no work to do this cycle" but the cycle
  log must record the reason; silence is failure.
- **The steward does not dispatch builders, fixers, weavers,
  shepherds, conductors-as-in-flight-builders, or jurors
  directly.** Those are sub-sub dispatches owned by the
  director, marshal, or fixer. The steward dispatches only the
  five sub-roles listed above plus the rare garden-weaver.
- **Cite reasons in one phrase.** Cycle-log entries are at most
  one sentence per sub-role.
- **Em-dash discipline** for the cycle log.
  `grep "—"` before committing.

## Self-improvement

Final task of every engagement: update this role file and cited
skills with what you learned. See
[`../skills/self-improvement.md`](../skills/self-improvement.md).

The steward sees more cycles than any other role; patterns that
recur across cycles are exactly where a new rule pays for itself.
