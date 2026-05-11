# Watchmen: a refactor of the steward's scheduling and watching machinery

**Status:** Proposed
**Created:** 2026-05-10
**Updated:** 2026-05-10
**Closes:** [endojs/endo-but-for-bots#201](https://github.com/endojs/endo-but-for-bots/issues/201)
**Related:** [endojs/endo-but-for-bots#200](https://github.com/endojs/endo-but-for-bots/issues/200)
(major general role; the weekly cadence rests on the
`watchman-schedule` primitive proposed here).

## Summary

The [`steward`](../roles/steward.md) currently owns four mostly
independent concerns:

1. The per-cycle PR sweep ([`director`](../roles/director.md) work).
2. Event-driven response to GitHub activity (the 30 s ETag-conditional
   poll daemon plus a `Monitor` task watching its log).
3. Scheduled engagements keyed to calendar dates (per-PR
   [`botanist`](../roles/botanist.md) embargo maturity dates today;
   weekly major general dispatch soon).
4. Cycle pacing (`ScheduleWakeup` fallback heartbeat with
   cache-window-aware delays).

These share one role file and one runtime context.
Scheduled engagements lack a reliable trigger: the steward's cycle
log is read-once, the cycle-pacing heuristic does not know about
calendar dates, and there is no dedicated discipline for "wake at
time T and dispatch role R against artifact A."

This document proposes factoring the steward's scheduling and watching
responsibilities into three narrowly focused **watchmen** sub-roles:
`watchman-events`, `watchman-schedule`, and `watchman-cadence`.
Each owns one wake mechanism and one source of truth.
The steward becomes the orchestrator that on each wake asks the
watchmen what is due, dispatches the surfaced sub-roles, aggregates
their reports, and closes the cycle.

The watchmen are **not** independent agent dispatches.
They are inline subsections of the steward's per-cycle procedure,
each with its own state file and its own structured discipline.
A separate-agent watchman could return a vacuous report when it
should have surfaced work, exactly the failure mode the existing
`cycle-close-is-gated` rule prevents for
[`liaison`](../roles/liaison.md) and
[`marshal`](../roles/marshal.md).
Inlining keeps the gating tight.

## Problem statement

### What the steward does today

[`roles/steward.md`](../roles/steward.md) carries a "When" section
that mixes three wake mechanisms:

- A long-lived background daemon
  ([`scripts/poll-events-conditional.sh`](../scripts/poll-events-conditional.sh))
  polls the GitHub events API every 30 s with `If-None-Match` ETag
  conditional GETs.
  304 responses (the steady state) cost no rate limit.
  When the API returns 200 with new events, the daemon writes one
  trigger line per batch to its stdout log.
  A `Monitor` task arms a `tail -F` over the log file with a regex
  that matches terminal-state event classes and fires a
  `<task-notification>` within 30 s of any new contributor event.
- A `ScheduleWakeup` fallback heartbeat with cadence rules from
  [`skills/autonomous-loop-pacing.md`](../skills/autonomous-loop-pacing.md):
  active mode under 1800 s, idle mode out to 32400 s
  (9 h hard upper bound).
  The wakeup fires regardless of whether the daemon or the Monitor
  is alive.
- An implicit calendar mechanism buried in
  [`process/dependabotany.md`](../process/dependabotany.md): the
  "Steward's per-cycle scan" instructs the steward to re-read the
  embargo table at cycle start and re-dispatch the
  [`botanist`](../roles/botanist.md) for any row whose maturity date
  has arrived.

### Where the conflation hurts

The known failure modes documented in
[`roles/steward.md`](../roles/steward.md) all trace to the same
root: every wake mechanism, every routing decision, and every
state-file convention lives in one prose surface.

- The **"Pre-`ScheduleWakeup` checklist"** exists because the steward
  repeatedly shipped cycles without dispatching the
  [`liaison`](../roles/liaison.md) or
  [`marshal`](../roles/marshal.md).
  The closing-time checklist is a band-aid over the fact that the
  per-cycle "always dispatch" list is one rule among many in a long
  prose role file.
- The **"Distinguish surfaced for dispatch from dispatched"** section
  exists because cycle-log free text is read-once.
  Scheduled re-dispatches buried in a prior cycle's narrative do
  not survive the next context clear.
  Per-PR [`botanist`](../roles/botanist.md) re-dispatch on an
  embargo maturity date is exactly this shape; the only reason it
  works today is the table in
  [`process/dependabotany.md`](../process/dependabotany.md).
  The discipline lives in the process doc, not the role file.
- The **"`tail -F` does not replay history; read the log at cycle
  start"** pitfall exists because the live `Monitor` dies at every
  conversation-turn boundary.
  The daemon keeps writing during the gap, so the only reliable
  recovery is a `tail -50` of the log on every cycle's first
  action.
  This makes the live `Monitor` an early-wake optimization, not the
  source of truth.
- The **"lightweight liaison-vacuous-check"** pitfall exists because
  the issue-side scan and the per-PR-comment scan are different
  queries against the same events API, and the prose role file
  gives them parallel but distinct dispatch shapes.

Each is a symptom of one root cause: the steward owns every wake
mechanism, every state file involved in waking, and every routing
decision in one prose surface.

### Why scheduled engagements need their own discipline

The proposed
[major general](https://github.com/endojs/endo-but-for-bots/issues/200)
role wants a weekly dispatch.
The [`botanist`](../roles/botanist.md) wants per-PR date-keyed
re-dispatches.
A future role might want monthly or quarterly cadence.
None of these align with the cycle-pacing heuristic the steward
uses today, which is keyed to GitHub activity rather than to
calendar.

The "schedule a calendar engagement" pattern is therefore
independent of "schedule the next steward fire."
Today the two share one mechanism (`ScheduleWakeup`) and one
source of truth (whatever process doc the role-author remembers to
update).
The result is brittle: a maturity date is honored only if the
steward re-reads the right table on the right cycle AND the cycle
fires at or after the date.
There is no mechanism for "the date passed; fire now."

## Audit of current machinery

### `roles/steward.md`

The "When" section ([lines 26-153](../roles/steward.md)) covers
the poll daemon's lifecycle, the `Monitor` arming, the wake
regex, the state cache, the wake-handling protocol (read, eyes
reactji per
[`skills/reactji-acknowledgment.md`](../skills/reactji-acknowledgment.md),
dispatch), the `tail -F`-doesn't-replay pitfall, and the
during-draft event exclusion.

The "Sub-roles dispatched per cycle" section names
[`director`](../roles/director.md),
[`liaison`](../roles/liaison.md),
[`marshal`](../roles/marshal.md),
[`groom`](../roles/groom.md),
[`conductor`](../roles/conductor.md),
[`botanist`](../roles/botanist.md), and the rare garden-weaver.
Of these, the [`botanist`](../roles/botanist.md) is the only one
whose dispatch is gated on a calendar date today (per the
"OR when an embargoed PR's maturity date has arrived" clause).

The "Cycle close is gated on each sub-role's report" section is
the existing safety net.
The "Pre-`ScheduleWakeup` checklist" is the per-fire enforcement.
The "Procedure" section's step 9 owns the `ScheduleWakeup` call
with cache-window selection delegated to
[`skills/autonomous-loop-pacing.md`](../skills/autonomous-loop-pacing.md).

### `scripts/poll-events-conditional.sh`

The poll daemon is unconfined infrastructure.
It runs as `nohup bash` from `~/garden` (or another garden-pinned
worktree) with `STATE_FILE=$HOME/.cache/endo-events-poll-state`.
It writes one line per new event batch to **stdout** in the form
`[HH:MM:SS] NEW <count> on <repo>: <type>/<action>@#<number>, ...`
and per-event detail to **stderr**.
The state cache persists ETag and last-seen `created_at` across
restarts, so a fresh daemon does not replay every prior event.
GitHub event IDs are not monotonic across event types, so the
filter compares ISO timestamps, not numeric IDs.

The `Monitor` arms a `tail -F` over the stdout log with this regex:

```text
NEW [0-9].*(IssueCommentEvent/|IssuesEvent/|PullRequestEvent/|PullRequestReviewEvent/|PushEvent/)|HTTP [45][0-9][0-9]|curl failed|polling stopped
```

### `skills/autonomous-loop-pacing.md`

Cadence rules:

- Under 5 min (60-270 s): cache stays warm; right for active polling.
- 5 min (300 s) is worst-of-both; either drop to 270 s or commit
  to 1200 s+.
- 20-30 min (1200-1800 s): default for idle ticks.
- 1 hour (3600 s): genuine idle waits.

The rules apply inside `<<autonomous-loop-dynamic>>` invocations
and are the substrate the steward uses for `ScheduleWakeup`'s
`delaySeconds`.

### `process/dependabotany.md` and `roles/botanist.md`

The dependabotany "Per-PR posture" table is the
[`botanist`](../roles/botanist.md)'s authoritative state per PR
(verdict, maturity date, current state).
The "Steward's per-cycle scan" is a one-line directive to re-read
the table each cycle.
The "Scheduled engagements" sub-table is currently empty; intended
for date-keyed engagements that span multiple PRs.
The botanist role file delegates calendar discipline entirely to
the steward and to the dependabotany doc.

### Wake mechanisms in use

| Mechanism | Trigger | Reliability |
|---|---|---|
| `Monitor` over poll daemon log | New event matching the regex | Dies at turn boundary; daemon log is the source of truth |
| `ScheduleWakeup` heartbeat | Timer expiry | Reliable while session is alive |
| Per-cycle re-read of [dependabotany.md](../process/dependabotany.md) | Cycle start | Reliable as long as a cycle fires at or after the date |
| `<<autonomous-loop-dynamic>>` re-entry | `ScheduleWakeup` fire | Bound to session liveness |

Note the absence of a cron-style, session-independent mechanism.
The Anthropic `CronCreate` tool is available but is not used today
by the steward.

### Failure modes the audit surfaces

- **Silent skipping** of always-on sub-roles, addressed by the
  cycle-close gate but still recurring.
- **Missed scheduled re-dispatches** when a session ends and the
  next session starts well after the date.
  No mechanism reminds the maintainer that the engagement was
  overdue.
- **Monitor death at turn boundary** combined with daemon writes
  during the gap, mitigated only by the cycle-start `tail -50`.
- **Routing-shape conflation** between issue-side and PR-side
  events in the prose role file.

## Proposed refactor

Three watchmen, each a steward subsection rather than an agent
dispatch.

### `watchman-events`

**Owns:** the GitHub events poll daemon's contract, the `Monitor`
arming, the wake-on-event regex, the post-wake routing.

**State files:** `/tmp/poll-events.log` (the daemon's stdout,
source of truth); `~/.cache/endo-events-poll-state` (managed by
the daemon); `process/event-handlers.md` (new; routing table).

**Per-cycle discipline:**

1. `tail -50 /tmp/poll-events.log` and find any `NEW [0-9]` line
   newer than the prior cycle's close timestamp.
   The daemon log is the source of truth; the live `Monitor` is
   only an early-wake optimization.
2. For each new event line, look up the routing in
   `process/event-handlers.md` (event class plus PR shape gives
   the dispatch shape).
3. Post the `eyes` reactji per
   [`skills/reactji-acknowledgment.md`](../skills/reactji-acknowledgment.md)
   on every comment in scope (including inline comments older than
   the wrap, recovered via `pull_request_review_id`).
4. Surface a list of `(event, routed-role, brief-sketch)` tuples
   to the steward's per-cycle dispatch step.

The watchman does **not** dispatch sub-roles itself; it surfaces
routings.
The steward does the dispatch (or queues it in
[`process/PR-DISPATCH-STATE.md`](../process/PR-DISPATCH-STATE.md)
if out-of-order dispatch would conflict with in-flight sub-roles).

### `watchman-schedule`

**Owns:** the calendar of date-keyed engagements.
Reads one index file per cycle, surfaces what is due, regenerates
the index at close from the per-source docs.

**State files:** `process/scheduled-engagements.md` (new; the
index); per-engagement source-of-truth docs continue to live where
they do today
([`process/dependabotany.md`](../process/dependabotany.md) for
embargoes; an eventual `process/major-generalship.md` for the
weekly cadence).

**Per-cycle discipline:**

1. Read `process/scheduled-engagements.md`.
2. For every row whose `date` column is `<= today`, surface a
   dispatch tuple `(role, brief, source-doc-row-id)` to the
   steward.
3. After dispatch and report, the dispatched role updates **its
   source-of-truth doc** (e.g. dependabotany.md) with the new
   verdict and the next-engagement date if applicable.
4. The steward's close step rewrites
   `process/scheduled-engagements.md` from the per-source docs
   (one row per due-or-future engagement).
   The index is regenerated, never hand-edited; this avoids drift
   between index and truth.

**Why an index file at all:** the watchman-schedule needs O(1)
per cycle to know whether anything is due.
Reading every per-source doc per cycle would be O(n) and would
re-introduce the silent-skipping risk.

### `watchman-cadence`

**Owns:** the `ScheduleWakeup` call, the cadence rules from
[`skills/autonomous-loop-pacing.md`](../skills/autonomous-loop-pacing.md),
the cache-window-aware delay selection, and the active-vs-idle
mode decision.

**State files:** none of its own.
Reads the most recent cycle close (from
[`process/PR-CYCLE-LOG.md`](../process/PR-CYCLE-LOG.md)) for
in-flight signals; the director's report for active-mode triggers
(CI propagating, recent maintainer touch, non-empty merge queue);
and `process/scheduled-engagements.md` for the next upcoming
engagement date (the wakeup must fire no later than
`min(next-engagement-date, 9-hour-cap)`).

**Per-cycle discipline:**

1. Compute the cadence: active mode (≤ 1800 s) if any active-mode
   trigger fires, otherwise idle mode (between active and 9 h).
2. Cap the delay at the next-engagement date if applicable
   (a scheduled engagement at 04:00 tomorrow caps an idle-mode
   wakeup at the seconds-until-04:00).
3. Pick the within-mode delay per the cache-window rules
   (270 s / 1200 s / 1800 s).
4. Call `ScheduleWakeup` with the chosen delay, a one-sentence
   reason, and the standard `<<autonomous-loop-dynamic>>` prompt.

The steward stops calling `ScheduleWakeup` directly; the cadence
watchman is the single call site.

### Steward becomes the orchestrator

After the refactor, the steward's per-cycle procedure is:

1. Fetch + fast-forward + read state. (Unchanged.)
2. Garden upstream merge (first round only). (Unchanged.)
3. **Watchman-events sweep.** Surface event-driven dispatches.
4. **Watchman-schedule sweep.** Surface date-driven dispatches.
5. Dispatch sub-roles in parallel: always-on
   [`director`](../roles/director.md),
   [`liaison`](../roles/liaison.md),
   [`marshal`](../roles/marshal.md), plus what the watchmen
   surfaced, plus conditional
   [`groom`](../roles/groom.md) and
   [`conductor`](../roles/conductor.md).
6. Wait for sub-role reports. (Unchanged.)
7. Decide round boundary. (Unchanged.)
8. Append cycle-log section, with explicit per-watchman
   sub-sections so the gating rule extends naturally
   (no watchman line, no close).
9. Rewrite state files: `PR-DISPATCH-STATE.md` from the director;
   `scheduled-engagements.md` from the per-source docs.
10. Self-improvement commit + process commit. (Unchanged.)
11. **Watchman-cadence schedule next fire.**

The steward's role file shrinks: each watchman is a separate role
file under `roles/watchman-*.md` that the steward references.
The "When", "Pre-`ScheduleWakeup` checklist", and
"Distinguish surfaced for dispatch from dispatched" sections all
become per-watchman concerns.

## State files

### `process/scheduled-engagements.md` (new)

The cycle-start index.
One row per pending engagement, sortable by date.

```markdown
# Scheduled Engagements

The watchman-schedule reads this doc at the top of every cycle
and surfaces every row whose `date` column is on or before today.
Per-engagement source-of-truth lives in the per-role process doc
named in the `source` column.
This index is regenerated from those source docs at every cycle's
close; do not hand-edit.

| Date | Action | Role | Source doc |
|---|---|---|---|
| 2026-05-17 | re-dispatch botanist on PR #N for embargo maturity | botanist | dependabotany.md row for #N |
| 2026-05-11 | weekly major general sweep | major-general | major-generalship.md |
```

### `process/event-handlers.md` (new, optional)

Today's "what event class routes to what sub-role" decision is
implicit in the steward's prose role file.
Making it explicit reduces silent skipping.

```markdown
# Event Handlers

Routing table for the watchman-events sweep.
Looked up at cycle start for every new event in
`/tmp/poll-events.log`.

| Event class | Actor predicate | PR/issue shape | Routed role | Notes |
|---|---|---|---|---|
| PullRequestReviewEvent | non-bot | open PR | director | enumerate inline comments by `pull_request_review_id` |
| IssueCommentEvent | non-bot | open PR | director | fixer or shepherd depending on substance |
| IssueCommentEvent | non-bot | issue | liaison | issue-side handling |
| IssuesEvent (opened) | non-bot | n/a | liaison | new issue |
| PushEvent | contributor (non-self) | open PR | director | re-survey CI |
| PullRequestEvent (opened) | dependabot[bot] | n/a | botanist | bypass per-PR matrix |
| PullRequestEvent (opened) | non-bot | n/a | director | new PR triage |
```

### Existing process docs

Each becomes the source of truth for its own engagements.
[`process/dependabotany.md`](../process/dependabotany.md) holds
per-PR maturity dates and verdicts; an eventual
`process/major-generalship.md` holds the weekly cadence and
prior-cycle outcomes;
[`process/PR-DISPATCH-STATE.md`](../process/PR-DISPATCH-STATE.md)
holds per-PR pending-dispatch entries (already exists; unchanged).

The `scheduled-engagements.md` index never holds substance; it
always points at the source doc for the per-engagement detail.
Each role remains responsible for its own state.

## Reliable scheduling

The "Focus on reliable scheduling" directive in
[issue #201](https://github.com/endojs/endo-but-for-bots/issues/201)
deserves its own treatment.

### Calendar dates vs cycle ticks

The steward fires every 25-30 min in active mode and out to 9 h
in idle mode.
A scheduled engagement keyed to a calendar date is checked once
per cycle by reading the date and comparing to today.
This works as long as the steward fires at least once per day.

If a session ends and the next session starts after the date, the
engagement still fires on first cycle: the date check is
"today >= scheduled," not "today == scheduled."
This is the cheapest reliable mechanism for date-keyed engagements
and is the recommended substrate for the watchman-schedule.

The mechanism's failure modes are limited:

- The cycle does not fire at all (session is dead, no
  `ScheduleWakeup` is in flight, no maintainer kick has arrived).
  Recoverable on the next maintainer interaction.
- The cycle fires but skips the watchman-schedule sweep.
  This is the silent-skipping failure mode and is exactly what
  the per-watchman labeled subsection in the close-gate prevents.

### Monitor death recovery

The `Monitor` over `/tmp/poll-events.log` dies at every
conversation-turn boundary.
The daemon keeps writing during the gap.
The recovery rule from [`roles/steward.md`](../roles/steward.md)
becomes the watchman-events' first action:

```sh
tail -50 /tmp/poll-events.log | awk -v since="$PRIOR_CYCLE_CLOSE" \
  '/^\[[0-9:]*\] NEW / { if ($1 > since) print }'
```

The daemon log is the source of truth; the `Monitor` is the early
wake.
The watchman-events role file documents this contract so any
future change to the daemon's log format or the `Monitor` arming
preserves the recovery path.

### Cron alternative

The Anthropic `CronCreate` tool fires session-independent
remote-agent triggers on a cron schedule.
Different costs from `ScheduleWakeup`:

| Property | `ScheduleWakeup` | `CronCreate` |
|---|---|---|
| Fires while session is alive | Yes | Yes |
| Fires after session closes | No | Yes |
| Working tree available | Yes (`~/garden`) | No |
| Credentials available | Yes | Limited (sandbox) |
| In-flight git state preserved | Yes | No |
| Suitable for cycle pacing | Yes | No (no ambient context) |

The `CronCreate` substrate is appropriate when the cadence is
calendar-style (weekly, daily, monthly) AND the trigger is
independent of in-flight per-PR state.

The major general's weekly cadence is a candidate for
`CronCreate`: the role's first action is to enumerate top-level
direct dependencies via `gh api`, which needs only credentials,
not a working tree.
The per-PR [`botanist`](../roles/botanist.md) re-dispatch on a
maturity date is a candidate for state-doc lookup
(via watchman-schedule), because the dates are highly variable
per PR and re-dispatching from a fresh sandbox would have to
re-read the dependabotany table to know what to do.

The watchmen design recommends:

- `watchman-cadence` continues to use `ScheduleWakeup` for the
  steward's main loop.
- `watchman-schedule` uses state-doc lookup for date-keyed
  engagements that need ambient context.
- For weekly engagements that do not need ambient context, prefer
  `CronCreate` to back the schedule, and have the cron trigger
  write a marker file or open a draft PR that the steward picks
  up on the next cycle.
  This keeps the cron trigger small and keeps the steward in the
  loop for sub-role coordination.

### Overdue detection

The watchman-schedule sweeps every row in
`scheduled-engagements.md`, not just rows whose date matches today.
A row whose date is, say, 8 days in the past fires now (because
"today >= date") regardless of why it sat overdue.

If overdue by more than 7 days, the watchman-schedule also
surfaces a maintainer note: "scheduled engagement X was overdue by
N days; verify the prior cycles' state."
A 7-day overdue is incompatible with the steward's 9-h cadence
upper bound; it indicates the loop was dead for that period and
the maintainer should know.

## Migration plan

The migration is mostly prose moves and ref additions; no behavior
changes in the first PR.

1. **Extract events-poll prose** from
   [`roles/steward.md`](../roles/steward.md) into
   `roles/watchman-events.md`.
   Update [`roles/steward.md`](../roles/steward.md) to reference
   it.
   Cited skills move with the prose.
2. **Create `process/scheduled-engagements.md`** with initial
   content from
   [`process/dependabotany.md`](../process/dependabotany.md)'s
   "Scheduled engagements" sub-table (currently empty).
3. **Create `roles/watchman-schedule.md`.**
   Update [`roles/steward.md`](../roles/steward.md)'s
   per-cycle-start prose to reference it.
4. **Create `roles/watchman-cadence.md`.**
   Update [`roles/steward.md`](../roles/steward.md)'s
   `ScheduleWakeup` paragraphs to reference it.
5. **Write a steward refactor PR** that is mostly ref additions
   and prose moves, no behavior change.
   The PR's tests are: a manual cycle that walks through the
   refactored procedure end-to-end and confirms the same
   dispatches fire on the same triggers as before.
6. **Pilot the new state-doc lookup** against the dependabotany
   maturity-date use case (the first scheduled engagement that
   will need it).
7. (Deferred) **Cron-back the major general** after the role
   lands and runs once via state-doc lookup.

## Open Questions

### Q1. Watchmen as agent dispatches or as steward subsections?

**Recommendation: steward-inline subsections.**
The cycle-close-is-gated discipline already in
[`roles/steward.md`](../roles/steward.md) exists because the
steward kept silently skipping always-on sub-roles.
A separate-agent watchman would re-introduce that risk.
Inlining keeps the gating tight: the cycle log must contain a
labeled section per watchman, exactly as it must for
[`liaison`](../roles/liaison.md) and
[`marshal`](../roles/marshal.md) today.
Maintainers who prefer parallelism can revisit after the inline
version is stable; the prose moves are the same either way.

### Q2. Is the events-poll daemon's lifecycle a watchman concern?

**Recommendation: infrastructure, but watchman-events documents
the contract.**
The daemon spawns from session start and runs across many steward
sessions; it is not a per-cycle resource.
The watchman-events role file documents the daemon's contract
(input format, output format, state cache location) so future
changes do not silently break the recovery path.
If the daemon dies, the `ScheduleWakeup` heartbeat still fires
and the watchman-events sweep degrades gracefully to "no events
to surface" if the log is gone.

### Q3. `scheduled-engagements.md`: append-only or live-edited?

**Recommendation: live-edited for current state; the audit trail
lives in commit history.**
An append-only file would grow without bound and would force the
watchman-schedule to scan and filter for current rows.
A live-edited table is O(rows-still-relevant) per cycle.
A maintainer who wants the audit trail can
`git log -p process/scheduled-engagements.md`.

### Q4. How does watchman-schedule detect a missed engagement?

**Recommendation: read all rows; "today >= date" fires it now,
regardless of how long it has been overdue; if overdue by more
than 7 days, also surface to the maintainer.**
The "today >= date" rule covers the standard recovery case.
The overdue-by-7-days surface covers the pathological case
(session was down for a week or more); the maintainer needs to
know the loop was dead, not silently absorb the engagement as if
it were on time.

### Q5. Cron-vs-`ScheduleWakeup` boundary?

**Recommendation: prefer `ScheduleWakeup` plus state-doc lookup
unless the engagement (a) has a strict calendar cadence (weekly,
daily, monthly) AND (b) does not need ambient working-tree
context.**
The cost of `CronCreate` is a fresh sandbox per fire: no working
tree, no in-flight git state, no ambient credentials beyond what
the trigger explicitly provides.
That cost is worth paying when the trigger is independent (the
major general's weekly sweep can begin from `gh api` calls
alone).
That cost is not worth paying when the trigger needs ambient
context (a per-PR botanist re-dispatch wants the steward's
`~/garden` and the existing dependabotany state).
A hybrid pattern is also available: a `CronCreate` trigger that
opens a draft PR or writes a marker file; the steward's
watchman-events sees the marker on the next cycle and dispatches
the appropriate role with full ambient context.

### Q6. Should the `Monitor` over the poll log be replaced by an explicit daemon-to-steward IPC?

**Recommendation: not in this design.**
The `Monitor` mechanism is good enough as the early-wake
optimization, given the daemon-log-as-source-of-truth recovery
path.
A more elaborate IPC (named pipe, socket, kqueue/inotify wrapper)
would buy lower wake latency but would not change the reliability
story.
If a future maintainer wants lower latency, the watchman-events
role file is the right place to evaluate.

### Q7. Should the watchman-cadence read open-PR signals directly, or via the director's report?

**Recommendation: read the director's report.**
The director already does the per-PR sweep every cycle.
Re-querying GitHub from the cadence watchman would be redundant
and would risk inconsistency between "what the cadence watchman
saw" and "what the director surfaced."
Reading the director's report (active-mode triggers are all
visible there) keeps the watchman cheap and consistent.

## Summary of changes

After this design lands and is implemented:

- Three new role files:
  `roles/watchman-events.md`,
  `roles/watchman-schedule.md`,
  `roles/watchman-cadence.md`.
- One new process doc: `process/scheduled-engagements.md`.
- Optionally one more: `process/event-handlers.md`.
- [`roles/steward.md`](../roles/steward.md) shrinks: the "When"
  section, the close checklist, the `ScheduleWakeup` paragraph,
  and the "Distinguish surfaced for dispatch" rule all reference
  the relevant watchman role file rather than carrying the prose
  inline.
- The cycle-close gate extends to the watchmen: a missing
  per-watchman cycle-log subsection blocks close, exactly as a
  missing [`liaison`](../roles/liaison.md) or
  [`marshal`](../roles/marshal.md) line does today.
- Behavior is preserved: every dispatch that fires today fires
  after the refactor; every cadence delay computed today is
  computed the same way after the refactor.
- The major general's weekly cadence
  (per [issue #200](https://github.com/endojs/endo-but-for-bots/issues/200))
  rests on the watchman-schedule index and (optionally)
  `CronCreate` for session-independent firing.
