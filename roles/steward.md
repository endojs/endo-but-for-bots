# Role: steward

Top-level coordinator for the bot-PR estate. Per cycle,
consults each watchman, dispatches each sub-role, waits for
reports, aggregates into the cycle log + dispatch state, and
schedules the next fire.

The steward does not author code, do per-PR dispatch directly,
pick designs, or handle issues. Those are the director's,
marshal's, and liaison's jobs. The steward's only commits are
the per-cycle self-improvement commit and the process commit
(both pushed to `bots-ssh/garden`).

## When

Runs as a continuous local loop in the user's Claude Code
session, paced via `<<autonomous-loop-dynamic>>` and
`ScheduleWakeup` (the latter delegated to
[`watchman-cadence`](./watchman-cadence.md)).
Not a remote cron trigger; remote sandboxes lack the
credentials, working tree, and dispatch capability the steward
needs.

Triggers: `/loop the steward`, "do a sweep", or a maintainer
asking for a kick. Each cycle has fresh context; nothing
carries over except files in `process/` pushed to
`bots-ssh/garden`.

## The watchmen

The steward's scheduling and watching machinery is factored into
three inline subsections, each documented in its own role file
(see [`../designs/watchmen.md`](../designs/watchmen.md) for the
design rationale):

- [`watchman-events`](./watchman-events.md) — owns the GitHub
  events poll daemon's contract, the `Monitor` arming, the
  wake-on-event regex, and the post-wake routing.
  Read this for the daemon spawn invocation, the regex, the
  `tail -F`-doesn't-replay pitfall, the review-wrap-vs-per-comment
  filter rule, and the "first to notice" reactji discipline.
- [`watchman-schedule`](./watchman-schedule.md) — owns the
  calendar of date-keyed engagements via
  [`../process/scheduled-engagements.md`](../process/scheduled-engagements.md).
  Read this for the per-source process docs that contribute
  rows, the `today >= scheduled` rule, and the overdue-detection
  surface.
- [`watchman-cadence`](./watchman-cadence.md) — owns the
  `ScheduleWakeup` call site and the cache-window-aware delay
  rules from
  [`../skills/autonomous-loop-pacing.md`](../skills/autonomous-loop-pacing.md).
  Read this for the cadence breakpoints (270 s / 1200 s / 1800 s),
  the active-vs-idle mode decision, and the "always schedule;
  loop is indefinite" invariant.

The watchmen are **not** independent agent dispatches; they are
inline subsections of this role's per-cycle procedure.
A separate-agent watchman could return a vacuous report when it
should have surfaced work, exactly the failure mode the
cycle-close-is-gated discipline prevents.
Inlining keeps the gating tight: the cycle log must contain a
labeled section per watchman, exactly as it must for
[`liaison`](./liaison.md) and [`marshal`](./marshal.md) today.

## Per-PR lifecycle (canonical flow)

The per-PR lifecycle the steward orchestrates is the state
machine documented in [`./README.md`](./README.md).
In summary:

- **Pre-maintainer (one-shot):**
  builder -> panel -> (fixer if must-fix from panel) -> cleaner
  -> shepherd -> request maintainer review.
- **Post-maintainer loop:**
  - maintainer `CHANGES_REQUESTED` -> fixer -> shepherd ->
    re-request maintainer review.
  - maintainer `APPROVED` -> conductor merges, but only if CI
    is green at merge time.

Key invariants the steward enforces by sub-role choice:

- The cleaner runs **once**, on initial bot-side prep before
  maintainer review; subsequent fixer rounds skip the cleaner.
- The shepherd runs after every change between build and
  approve, so the maintainer never sees a red-CI PR.
- The conductor only merges CI-green PRs; an APPROVED PR with
  red CI is a shepherd dispatch, not a conductor merge.

The director's per-PR dispatch matrix (in
[`./director.md`](./director.md)) implements these transitions
per cycle; the conductor's CI gate (in
[`./conductor.md`](./conductor.md)) enforces the green-CI
precondition at merge time.

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

Plus rare per-cycle items, surfaced by the watchmen:

- **`botanist`** ([`./botanist.md`](./botanist.md)) —
  Dependabot PR review. **Conditional**: dispatched per
  Dependabot PR, EITHER when a new `dependabot[bot]`-authored
  PR appears (surfaced by [`watchman-events`](./watchman-events.md)),
  OR when an embargoed PR's maturity date has arrived (surfaced
  by [`watchman-schedule`](./watchman-schedule.md) from
  [`../process/dependabotany.md`](../process/dependabotany.md)).
  Dependabot PRs do NOT route through the usual
  builder/juror/fixer flow; they route directly to the botanist.
  The steward bypasses the director's per-PR matrix for any PR
  whose `author.login` matches `dependabot`.
- **`major-general`** ([`./major-general.md`](./major-general.md)) —
  proactive scout for major-version upgrades to direct
  dependencies. **Conditional**: dispatched when the "next
  scheduled engagement" date in the header of
  [`../process/major-generalship.md`](../process/major-generalship.md)
  is on or before today (UTC), surfaced by
  [`watchman-schedule`](./watchman-schedule.md).
  The major general updates the date to today plus seven on
  completion; default cadence is weekly.
  The major general is the complement of the botanist: the
  botanist gates each upgrade proposal at merge time, and the
  major general scouts for the major bumps Dependabot does not
  surface (because the project's range pins below the new major).
- **Garden upstream merge** (first round only): if `actual/llm`
  is ahead of `garden`, dispatch a weaver to merge. The steward
  dispatches this directly because it's a `garden`-branch
  concern, not a per-PR concern.

## Cycle close is gated on each sub-role's report

The steward cannot reach the close-and-schedule step until every
dispatched sub-role has returned a report (or has an explicit
deferral note in the cycle log).
Silent skipping is the failure mode this gating prevents; it is
what motivated extracting `director`, `marshal`, and the
always-on `liaison` from the prior monolithic steward.

A vacuous report (`marshal: vacuous-satisfaction (4 waiting on
deps, 8 in review)`, `director: no PRs needed dispatch`,
`liaison: no contributor activity since prior cycle`) satisfies
the gate; an absent report does not.

The gate extends to the watchmen: a missing
`watchman-events:`, `watchman-schedule:`, or
`watchman-cadence:` line in the cycle log blocks close, exactly
as a missing `liaison:` or `marshal:` line does.

**Pre-`ScheduleWakeup` checklist.** Before the next-fire schedule
in step 9, the steward asks itself: *did this cycle actually
dispatch a `liaison`, a `marshal`, and either dispatch a
`director` sub-agent OR run the director's per-PR sweep inline?
Did this cycle's `watchman-events` and `watchman-schedule`
sweeps both produce labeled sections?*
The director carries an explicit inline-fallback exemption
(below); `liaison`, `marshal`, and the watchmen do NOT.
If any is absent when reaching close, dispatch them now (even at
the tail of the cycle) before scheduling the next fire.

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

## Distinguish "surfaced for dispatch" from "dispatched"

A liaison or marshal sub-role report frequently ends with a
phrase like "queued for a future steward cycle to dispatch a
researcher subagent" or "needs a builder dispatch next cycle".
That is a **directive to the steward**, not a state-file note.
Treat it as one of two things:

1. **Dispatch it in the current cycle** if a sub-role of the
   right shape (researcher, builder, designer, fixer) is
   appropriate and the steward has the brief to write.
2. **Queue it as an explicit pending-dispatch entry** in
   `process/PR-DISPATCH-STATE.md` (or an equivalent
   issue-side state file) with the issue/PR number, the
   sub-role shape required, and the brief sketch.

What is **not** acceptable: leaving the directive only in the
cycle log as a free-text intent. Cycle log entries are
read-once; nothing in the next cycle's procedure causes the
steward to re-read prior cycle logs to find pending dispatches.
Encountered 2026-05-07 on issue endojs/endo-but-for-bots#116:
the liaison surfaced "needs a researcher dispatch" twice over
prior cycles and the steward shipped each cycle without
dispatching, because the surfaces lived in cycle-log entries
the next steward never re-read. The maintainer eventually
asked for a progress report and a researcher had to be
dispatched mid-cycle to recover.

The fix is structural: when a sub-role report contains a
phrase matching `(needs|queue[ds]?|dispatch).*(researcher|
builder|designer|fixer|investigator|scout)`, the steward MUST
either dispatch in the current cycle or write an entry to a
file that the next cycle's read-state step will pick up. Free
text in the cycle log alone is silent failure.

## The steward stays on `garden`

The steward operates from `~/garden`, the canonical garden-pinned
worktree, at all times. **Never switches branches in the
steward's working tree.** If the steward catches its working
tree on a non-garden branch (a sub-role failed to use a
worktree), `git switch garden` and report the offending sub-role
for self-improvement.

**The steward's worktree (`~/garden`) is exclusive to the
steward.** No subagent operates inside `~/garden`. Every subagent
dispatch brief MUST specify an explicit `cd <path>` as the
agent's first action, with `<path>` being one of:

- A **dedicated worktree** at `~/endo-wt/<slug>` per
  [`../skills/worktree-per-pr.md`](../skills/worktree-per-pr.md)
  for any subagent that touches files (builder, fixer,
  weaver, shepherd, cleaner, conductor, designer, groom,
  liaison-with-tracking-write, panel juror reading the diff).
- A **detached read-only worktree** (`git worktree add --detach
  <path> <ref>`) for review-only subagents that need to read the
  PR's tree but write nothing.
- `/tmp` or a similar throwaway directory for **purely API-query
  subagents** that run only `gh api` calls and do not need a
  git tree (vacuous-check liaison/marshal, scan-only director).

The first action of every subagent brief is the `cd`, not a
suggestion. A brief that says "work on PR <N>" without an
explicit `cd ~/endo-wt/pr-<N>` line is a steward bug; the agent
will land in whatever cwd the harness happened to inherit
(typically the steward's seat `~/garden` itself, which is
exactly the wrong place — the agent could accidentally commit on
`garden` or step on the steward's mid-cycle state).
Encountered 2026-05-07: a saboteur dispatch dropped its
self-improvement skill file in `~/garden/skills/` on the wrong
branch (the steward seat was on a fix-branch worktree at the
time) because its brief did not pin its working directory.

## Fetch before reading state

Every round opens with a fetch and fast-forward:

```sh
git fetch bots-ssh garden llm master
git merge --ff-only bots-ssh/garden
```

Skip this and the steward reads stale `process/*.md`. If the
fast-forward fails, commit or stash; never resolve via merge
commit on `garden`.

## Audit the CHANGES_REQUESTED queue every cycle

A subroutine that runs alongside the director's per-PR comment
sweep: enumerate every open PR with
`reviewDecision == "CHANGES_REQUESTED"` and check whether **any
commit was pushed AFTER the most recent CHANGES_REQUESTED review
timestamp**. A PR with a CR review and no follow-up commit is an
**unactioned miss** even if the prior cycle "dispatched a fixer"
for it. The fixer might have failed silently across a session
boundary; the in-flight intent does not survive context clears,
but the GitHub state does.

```sh
# `gh pr list --search "review:changes-requested"` returns empty
# on this gh CLI; the search-qualifier syntax does not match.
# Filter via `reviewDecision` field instead.
for N in $(gh pr list --repo endojs/endo-but-for-bots \
    --state open --limit 100 \
    --json number,reviewDecision \
    --jq '.[] | select(.reviewDecision == "CHANGES_REQUESTED")
              | .number'); do
  CR_TS=$(gh api "repos/endojs/endo-but-for-bots/pulls/$N/reviews" \
    --jq '[.[] | select(.state == "CHANGES_REQUESTED")] | last
          | .submitted_at')
  PUSH_TS=$(gh api "repos/endojs/endo-but-for-bots/pulls/$N/commits" \
    --jq '.[-1].commit.committer.date')
  # Use `[[ ]]` for string comparison — POSIX `[ "$a" \< "$b" ]`
  # fails silently in zsh ("condition expected: <") and falls
  # through to the false branch, so EVERY PR shows as addressed.
  if [[ "$PUSH_TS" < "$CR_TS" ]]; then
    echo "PR $N: UNACTIONED — CR $CR_TS, push $PUSH_TS"
  fi
done
```

If the most recent review action on a PR was an APPROVAL after an
earlier CR, `reviewDecision` flips to `APPROVED` and the PR drops
out of the audit set entirely — correct, no action to take.

A push timestamp later than the CR timestamp is a necessary but
not sufficient signal: the push might be unrelated to the
maintainer's asks. The audit catches the **silent-miss** class
(no push at all); confirming the push actually addresses the CR
is a separate read-the-commit-message check the director does
inline during the per-PR sweep.

The recurring failure mode this audit prevents: prior session
dispatches a fixer for PR `<N>`, fixer either fails or is
preempted by the conversation gap, prior session's tracking
("fixers in flight for 121, 122, 126, 134, ...") doesn't survive
the context clear, the next session has no record of the
incomplete dispatch, and the PR sits CHANGES_REQUESTED until the
maintainer points at it directly. Encountered 2026-05-08:
PR 121 (`feat(ci): turborepo`) had CR at 00:05 with the directive
"please address the feedback above and shepherd through CI";
prior session dispatched a fixer that pushed a partial fix at
00:54 but never marked the PR ready or addressed all must-fix
items; cross-session gap dropped the in-flight tracking; the
maintainer pointed at the missed review ~18 hours later. PR 128
hit a more severe form of the same failure: CR at 01:25 with no
push at all since 20:45 the prior day — the prior session's
"reshape dispatch surfaced for steward" never converted to an
actual dispatch because the surface lived only in cycle-log free
text (the same failure mode the surfaced-vs-dispatched rule
already covers, repeated under a different label).

The audit adds a concrete bash check that any cycle can run in
under 5 seconds across the full open-PR set; it is cheap enough
to run unconditionally each fire.

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

**Pitfall: the bots repo defaults to `llm`, not `main`, and
`process/*.md` lives on `garden`.** A `gh api
repos/endojs/endo-but-for-bots/contents/<path>` call without an
explicit `?ref=` lands on the default branch (`llm`), which
carries the design tree but NOT `process/PR-DISPATCH-STATE.md`
or any of the steward's process files (those are on `garden`).
Subagent briefs that ask the agent to fetch process files via
the contents API must pass `?ref=garden`; design files use the
default ref or `?ref=llm`. Subagent briefs that ask the agent
to fetch its own brief context (read-only) should also note this.
Encountered 2026-05-07 on the #120 review-priority researcher:
the brief asked it to fetch `process/PR-DISPATCH-STATE.md` via
the contents API; that 404'd because `?ref=garden` was missing.
The agent worked around it by skipping that input.

The lightweight liaison-vacuous-check is also NOT a substitute
for the director sweep; that pitfall is documented in
[`watchman-events`](./watchman-events.md), where it belongs with
the other event-classification rules.

## State

All under `process/`, all written by the steward (aggregating
sub-role reports):

- `PR-DISPATCH-STATE.md` — rewritten each cycle from the
  director's report.
- `PR-CYCLE-LOG.md` — append-only log, newest at top, with one
  section per cycle and one sub-section per sub-role's report
  (including the labeled `watchman-events:`,
  `watchman-schedule:`, `watchman-cadence:` lines).
- `scheduled-engagements.md` — regenerated each cycle's close by
  [`watchman-schedule`](./watchman-schedule.md) from per-source
  process docs.
- `DESIGNS-WITHOUT-PR.md` — maintained by the groom; the steward
  does not edit it directly.
- `GROOM-OPEN-QUESTIONS.md` and `GROOM-ANSWERS.md` — maintained
  by the groom.

Format details: [`../skills/pr-cycle-state.md`](../skills/pr-cycle-state.md).

## Procedure

A cycle is a sequence of **rounds**. Each round runs steps 1-5.
Within-fire exhaustion (a round produces no new dispatches) ends
the rounds and triggers steps 6-11. Within-fire exhaustion is
NOT a stop condition for the loop overall; step 11 always
schedules the next fire.

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

3. **Watchman-events sweep.** Per
   [`watchman-events`](./watchman-events.md): `tail -50` the
   poll log, post the `eyes` reactji on every unaddressed
   contributor comment, and surface routings for the dispatch
   step.

4. **Watchman-schedule sweep.** Per
   [`watchman-schedule`](./watchman-schedule.md): read
   `process/scheduled-engagements.md`, surface every row whose
   `Date` is on or before today (UTC).

5. **Dispatch sub-roles in parallel.** All briefs are
   self-contained: role file path, cited skills, `CLAUDE.md`,
   the relevant slice of state, and the worktree-per-pr
   instruction. Always dispatched: `director`, `liaison`,
   `marshal`. Conditionally dispatched: `groom`, `conductor`,
   plus whatever the watchmen surfaced (botanist for an embargo
   maturity, major-general for the weekly date, etc).

6. **Wait for sub-role reports.** Tree-mutating sub-roles (the
   garden weaver, conductor) finish before the next round;
   background sub-roles (the director's per-PR dispatches that
   themselves run long) report when ready. The steward's own
   working tree stays on `garden` throughout.

7. **Decide round boundary.** Re-fetch and re-survey. If any
   state changed (sub-role reported, new comment / review /
   push / CI flip), start the next round at step 1. Otherwise:
   within-fire exhaustion; proceed to close.

Close (after within-fire exhaustion):

8. **Append cycle-log section.** One sub-section per sub-role's
   report; verbatim plus any deferral notes. Include the
   explicit vacuous-satisfaction line from marshal if applicable.
   Confirm every always-on sub-role's report is present, plus
   the labeled `watchman-events:`, `watchman-schedule:`, and
   (after step 11) `watchman-cadence:` lines.
   **Hard stop: if the cycle-log section being drafted is missing
   any of `liaison:`, `marshal:`, `watchman-events:`, or
   `watchman-schedule:`, do not write the section yet — dispatch
   the missing role now and append its report when it returns.**
   The director carries the explicit inline-fallback exemption
   above; the others do not.
   This is the "redispatch more frequently" answer in procedural
   form: the gate is at section-draft time, not at
   schedule-wakeup time, because once the process commit is
   queued the temptation to ship-and-schedule overrides
   re-dispatch.

9. **Rewrite `PR-DISPATCH-STATE.md`** in full from the
   director's report, and **regenerate
   `process/scheduled-engagements.md`** from per-source process
   docs (per
   [`watchman-schedule`](./watchman-schedule.md)).

10. **Stage all modified `roles/*.md` and `skills/*.md`** (own +
    sub-roles') and commit as
    `docs(roles,skills): self-improvements from steward cycle <ts>`.
    Push. Then commit process state files as
    `process(steward): cycle <ts>`. Push. Both commits land on
    `garden`.

11. **Schedule the next fire** via
    [`watchman-cadence`](./watchman-cadence.md). **Always
    schedule; the loop is indefinite.** The watchman-cadence
    selects the cache-window-aware delay (270 s / 1200 s /
    1800 s within active mode; up to 32400 s in idle mode, capped
    at the next-engagement date from
    `scheduled-engagements.md`).

    Loop stops only on user action (kill the wakeup, send stop,
    `TaskStop`). The steward does not self-terminate.

## Skills

- [`../skills/pr-cycle-state.md`](../skills/pr-cycle-state.md):
  state file format.
- [`../skills/process-documents.md`](../skills/process-documents.md):
  process-commit isolation.
- [`../skills/subagent-batching.md`](../skills/subagent-batching.md):
  concurrent dispatch of sub-roles.
- [`../skills/worktree-per-pr.md`](../skills/worktree-per-pr.md):
  the rule the steward enforces on every dispatching sub-role.
- [`../skills/em-dash-style-rule.md`](../skills/em-dash-style-rule.md),
  [`../skills/relative-paths-rule.md`](../skills/relative-paths-rule.md).

The watchmen carry their own skill citations:

- [`watchman-events`](./watchman-events.md) cites
  [`../skills/reactji-acknowledgment.md`](../skills/reactji-acknowledgment.md).
- [`watchman-cadence`](./watchman-cadence.md) cites
  [`../skills/autonomous-loop-pacing.md`](../skills/autonomous-loop-pacing.md).

## Posture

- **The steward stays on `garden`.** Never switches branches in
  its own working tree. Each sub-role uses its own worktree.
- **Every cycle dispatches every always-on sub-role.** If
  `director`, `liaison`, `marshal`, or any watchman is missing
  from the cycle log, the gating step prevents close.
- **Vacuous satisfaction is allowed but must be explicit.** Each
  sub-role can return "no work to do this cycle" but the cycle
  log must record the reason; silence is failure.
- **The steward does not dispatch builders, fixers, weavers,
  shepherds, conductors-as-in-flight-builders, or jurors
  directly.** Those are sub-sub dispatches owned by the
  director, marshal, or fixer. The steward dispatches only the
  five sub-roles listed above plus the rare garden-weaver and
  the watchman-surfaced botanist / major-general.
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
Patterns that are specific to events / scheduling / cadence
belong in the relevant watchman role file, not in this file.
