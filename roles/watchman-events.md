# Role: watchman-events

Owns the GitHub events poll daemon's contract, the `Monitor`
arming, the wake-on-event regex, and the post-wake routing into
sub-role dispatches.

The watchman-events is **not** an independent agent dispatch;
it is an inline subsection of the
[`steward`](./steward.md)'s per-cycle procedure.
The cycle-close-is-gated discipline already in
[`steward.md`](./steward.md) exists because the steward kept
silently skipping always-on sub-roles; a separate-agent watchman
would re-introduce that risk.
Inlining keeps the gating tight: the cycle log must contain a
labeled `watchman-events:` section per cycle, exactly as it must
for [`liaison`](./liaison.md) and [`marshal`](./marshal.md) today.

See [`../designs/watchmen.md`](../designs/watchmen.md) for the
design rationale and the audit that motivates this split.

## When

Runs on every steward cycle as the first half of the per-cycle
sweep (alongside [`watchman-schedule`](./watchman-schedule.md)
for date-keyed engagements).
The watchman-events answers "what GitHub activity happened since
the prior cycle's close, and what dispatches does that imply?"

## State files

- `/tmp/poll-events.log` — the poll daemon's stdout log; the
  source of truth for events since the prior cycle.
- `/tmp/poll-events.err` — the daemon's stderr log; per-event
  detail.
- `~/.cache/endo-events-poll-state` — the daemon's ETag plus
  last-seen `created_at` cache; persists across daemon restarts
  so a fresh daemon does not replay every prior event.

The daemon log is the source of truth.
The live `Monitor` is only an early-wake optimization.

## The poll daemon contract

A 30s conditional-GET poll against the GitHub events API runs as
a long-lived background process feeding a `Monitor` task.
The script is
[`../scripts/poll-events-conditional.sh`](../scripts/poll-events-conditional.sh);
it spawns once per session from `~/garden` (or wherever the
steward's garden-pinned worktree lives) as:

```sh
nohup bash scripts/poll-events-conditional.sh \
  > /tmp/poll-events.log 2> /tmp/poll-events.err &
```

The poll uses ETag conditional GETs, so 304 responses (the steady
state) are free against the API rate limit.
When the API returns 200 with new events, the daemon writes one
trigger line per batch to **stdout** in the form
`[HH:MM:SS] NEW <count> on <repo>: <type>/<action>@#<number>, ...`
and per-event detail to **stderr**.

The daemon's PID and log files live in `/tmp`, so a session
restart needs to re-spawn it.
GitHub event IDs are not monotonic across event types, so the
daemon's filter compares ISO timestamps, not numeric IDs.

The bot's own pushes are filtered out by the daemon's `$self`
filter at the data layer, so wake-on-`PushEvent/` only fires for
contributor pushes (CI state changes, etc).

## The Monitor arming

The steward arms a `Monitor` watching the log files for the
distinctive `NEW <count>` trigger line.
The monitor fires a `<task-notification>` within 30s of any new
contributor event, waking the steward immediately rather than
waiting for the next ScheduleWakeup.

The Monitor's regex matches **terminal-state** event classes only:

```text
NEW [0-9].*(IssueCommentEvent/|IssuesEvent/|PullRequestEvent/|PullRequestReviewEvent/|PushEvent/)|HTTP [45][0-9][0-9]|curl failed|polling stopped
```

The early-wake mechanism is **redundant** with
[`watchman-cadence`](./watchman-cadence.md)'s `ScheduleWakeup`:
the safety-net wakeup still fires per the cadence rules even if
the daemon or the monitor dies.
Both paths converge on the same `/loop the steward` re-entry.

### Wake on review-wrap, not on per-comment-during-draft

A maintainer drafting a PR review fires
`PullRequestReviewCommentEvent` per inline comment as they're
added; only when they hit "Submit review" does
`PullRequestReviewEvent` fire (state COMMENTED / APPROVED /
CHANGES_REQUESTED).
Waking on every per-comment event during the draft creates
notification thrash and tempts the steward to act on partial
context.

`PullRequestReviewEvent/` (the wrap) is not a substring of
`PullRequestReviewCommentEvent/` (they diverge at `Event/` vs
`CommentEvent/`), so the regex cleanly excludes the per-comment
class.

Edge case: a single inline comment posted via the "Add single
comment" button bypasses the review-wrap and fires a standalone
`PullRequestReviewCommentEvent` with no following
`PullRequestReviewEvent`.
The Monitor stays silent until the next periodic steward-cycle
log-tail (max 25-30 min via ScheduleWakeup).
Acceptable: the unwrapped-single-comment case is rare; the
periodic safety net catches it.

## Pitfall: `tail -F` doesn't replay history; read the log at cycle start

A `Monitor` armed with `tail -F /tmp/poll-events.log` only
streams lines added AFTER the Monitor's tail starts; it does NOT
replay lines that the daemon wrote while the prior Monitor was
dead (Monitors die at conversation-turn boundaries — the
`bg2kx8s47`-style task IDs from before the boundary are gone the
next time `TaskList` is called).
Combined with the turn-boundary-monitor-death pattern, this
means: events that fire during the gap between turns are written
to the log but never delivered as `<task-notification>`.

**Fix**: every steward cycle's first action is `tail -50
/tmp/poll-events.log` (or whatever depth covers the time since
the prior cycle's wake-up).
Treat any `NEW [0-9]` line newer than the prior cycle's close as
an event the watchman-events must action, exactly as if it had
arrived as a notification.
The daemon log is the source of truth; the Monitor is just the
early-wake optimization.

```sh
tail -50 /tmp/poll-events.log | awk -v since="$PRIOR_CYCLE_CLOSE" \
  '/^\[[0-9:]*\] NEW / { if ($1 > since) print }'
```

Encountered 2026-05-07: kriskowal submitted a review on PR 119
at 18:15:58, the daemon caught it at 18:16:24 and wrote
`NEW 2 ... PullRequestReviewEvent/...@#119` to the log, but the
Monitor armed at 18:25 only saw lines after 18:25 and never
fired on the 18:16 line.
The maintainer pointed at the missed review directly.

## Per-cycle discipline

1. `tail -50 /tmp/poll-events.log` and find any `NEW [0-9]` line
   newer than the prior cycle's close timestamp.
2. For each new event line, decide the dispatch shape (event
   class plus PR/issue shape gives the routing).
3. Post the `eyes` reactji per
   [`../skills/reactji-acknowledgment.md`](../skills/reactji-acknowledgment.md)
   on every comment in scope BEFORE surfacing the dispatch
   (including inline comments older than the wrap, recovered via
   `pull_request_review_id`).
4. Surface a list of `(event, routed-role, brief-sketch)` tuples
   to the steward's per-cycle dispatch step.

The watchman-events does **not** dispatch sub-roles itself; it
surfaces routings.
The steward does the dispatch (or queues it in
[`../process/PR-DISPATCH-STATE.md`](../process/PR-DISPATCH-STATE.md)
if out-of-order dispatch would conflict with in-flight sub-roles).

### On a PullRequestReviewEvent wake, enumerate ALL inline comments

The draft-then-wrap pattern means inline comments can be hours or
days older than the review submission.
A timestamp filter ("comments since the wake-up time") will miss
everything written before the maintainer hit "Submit review".
The reliable query is by review id:

```sh
REVIEW_ID=<the review's databaseId from the event>
gh api "repos/endojs/endo-but-for-bots/pulls/<N>/comments" \
  --jq "[.[] | select(.pull_request_review_id == $REVIEW_ID)]"
```

Reactji and process every comment in that set, including the ones
older than the wrap.

Encountered 2026-05-07: PR 119 review id 4246586901 wrapped at
18:15 with three inline comments, the oldest at 18:10 (a
directive to mirror `PLAN/endo_posix_sandbox.md` into
`designs/`); the steward's narrow timestamp window ("comments
since 18:25") missed the 18:10 comment for ~2 hours until the
maintainer pointed at it directly.

## The `eyes` reactji at triage time

Per
[`../skills/reactji-acknowledgment.md`](../skills/reactji-acknowledgment.md),
the reactji belongs to the role that first notices the activity
and begins formulating a response.
For Monitor-driven wakes (`PullRequestReviewEvent`,
`IssueCommentEvent`, `PullRequestReviewCommentEvent`), that role
is the watchman-events.
The ordered cycle on each wake is:

1. Read the comment(s) and any inline thread under the review id.
2. **Post the `eyes` reactji on each unaddressed comment** (and
   on each inline thread comment under the review id) BEFORE
   surfacing the dispatch.
   The reactji is the under-30-seconds-after-post acknowledgment
   the human sees; worker-dispatch latency (10-30 minutes from
   dispatch to first action) is unacceptable for the receipt
   signal.
3. Decide the dispatch shape (fixer / builder / shepherd /
   conductor / cleaner / weaver / etc.).
4. Surface the routing to the steward with a brief that includes
   the comment context.
   The dispatched worker does NOT re-react on comments the
   watchman-events already pre-surfaced; the worker's reading is
   for substance.

The exception is when the worker discovers comments the triage
brief did not pre-surface (older drafts, side-thread comments,
comments that arrive while the worker's dispatch is in flight).
Those get the worker's reactji at the moment of discovery, per
the "first to notice" rule.

## Pitfall: the lightweight liaison-vacuous-check is NOT a substitute

A common shortcut on quiet cycles is to dispatch a 50-word
"liaison: scan and report vacuous if no
`IssueCommentEvent|IssuesEvent`" subagent.
That filter is intentionally narrow — it's the issue-side check —
and it **misses** the inline review classes
`PullRequestReviewCommentEvent` and `PullRequestReviewEvent`.
The lightweight-liaison output `liaison: vacuous` therefore says
nothing about whether a maintainer left an inline comment on an
open PR; the watchman-events sweep (or the director sweep, or an
inline equivalent that greps for `Review` / `Comment` more
broadly) is the only path that catches those.

Encountered 2026-05-07: the maintainer left `Please finish this
job.` on PR 114 line 37 at 07:06 UTC; the 07:30
lightweight-liaison cycle reported vacuous; the steward shipped
the cycle without dispatching a director PR sweep; the comment
sat undetected for ~10 hours until the maintainer pointed at it
directly.
Fix: a vacuous lightweight-liaison report does NOT discharge the
watchman-events gate.
Either broaden the scan to include the review event classes, or
dispatch the director sweep separately.

## Skills

- [`../skills/reactji-acknowledgment.md`](../skills/reactji-acknowledgment.md) —
  the "first to notice" reactji rule the watchman-events enforces
  on every contributor comment surfaced from the poll log.
- [`../skills/relative-paths-rule.md`](../skills/relative-paths-rule.md),
  [`../skills/em-dash-style-rule.md`](../skills/em-dash-style-rule.md).

## Posture

- **Daemon-log-as-source-of-truth.**
  The live Monitor is convenient but unreliable across
  conversation-turn boundaries.
  Cycle start ALWAYS reads the log; Monitor is bonus.
- **Reactji before dispatch.**
  The receipt signal must reach the human inside 30s; dispatch
  latency is too slow.
- **Surface, do not dispatch.**
  The watchman-events surfaces tuples to the steward; the
  steward decides whether to dispatch in the current cycle or
  queue in `PR-DISPATCH-STATE.md`.
- **Cycle-log gating.**
  A cycle without a labeled `watchman-events:` line in the
  cycle log does not close.

## Self-improvement

Final task of every engagement: update this role file with
patterns that recur across cycles.
See
[`../skills/self-improvement.md`](../skills/self-improvement.md).
