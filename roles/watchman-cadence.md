# Role: watchman-cadence

Owns the `ScheduleWakeup` call, the cadence rules from
[`../skills/autonomous-loop-pacing.md`](../skills/autonomous-loop-pacing.md),
the cache-window-aware delay selection, and the active-vs-idle
mode decision.

The watchman-cadence is **not** an independent agent dispatch;
it is the final inline subsection of the
[`steward`](./steward.md)'s per-cycle close.
The Monitor-as-primary-wake-signal plus
ScheduleWakeup-as-fallback pattern means the cadence is the
heartbeat that keeps the loop alive even when the events daemon
is silent or dead.

See [`../designs/watchmen.md`](../designs/watchmen.md) for the
design rationale and the audit that motivates this split.

## When

Runs as the last step of every steward cycle's close, after the
cycle log is written and the process commit is pushed.
The watchman-cadence answers "when does the loop fire next?"

The steward stops calling `ScheduleWakeup` directly; the
watchman-cadence is the single call site.

## State files

None of its own.
Reads:

- The most recent cycle close from
  [`../process/PR-CYCLE-LOG.md`](../process/PR-CYCLE-LOG.md) for
  in-flight signals.
- The director's report (already in the cycle log) for active-mode
  triggers (CI propagating, recent maintainer touch, non-empty
  merge queue, sub-agent in flight).
- [`../process/scheduled-engagements.md`](../process/scheduled-engagements.md)
  for the next upcoming engagement date (the wakeup must fire no
  later than `min(next-engagement-date, 9-hour-cap)`).

## The redundancy story

The watchman-cadence's `ScheduleWakeup` is the safety-net wake.
The [`watchman-events`](./watchman-events.md) Monitor is the
early-wake optimization layered on top.
Both paths converge on the same `/loop the steward` re-entry.
If the events daemon dies or the Monitor is gone (turn-boundary
death), the cadence wakeup still fires.

The cadence wakeup is also the only path that fires for events
the daemon-log-as-source-of-truth recovery picks up at cycle
start: the watchman-events sweep needs the cycle to fire at all,
and the cadence is the only thing that guarantees that.

## Per-cycle discipline

1. **Compute the cadence**: active mode (≤ 1800 s) if any
   active-mode trigger fires (a sub-agent is in flight, CI is
   propagating on a recent push, a maintainer touched any open
   PR within the prior lookback, a PR is `awaiting maintainer
   re-review`, or the merge queue is non-empty); otherwise idle
   mode (between active and 9 h).
2. **Cap the delay at the next-engagement date** if applicable.
   A scheduled engagement at 04:00 tomorrow caps an idle-mode
   wakeup at the seconds-until-04:00; without this cap, a
   long idle delay would step past the engagement date.
3. **Pick the within-mode delay** per the cache-window rules
   (270 s / 1200 s / 1800 s).
4. **Call `ScheduleWakeup`** with the chosen delay, a
   one-sentence reason, and the standard
   `<<autonomous-loop-dynamic>>` prompt.

```text
ScheduleWakeup({
  delaySeconds: <60..32400>,
  reason: "<one-sentence explanation>",
  prompt: "<<autonomous-loop-dynamic>>",
})
```

## Cadence rules

The Anthropic prompt cache has a 5-minute TTL.
Sleeping past 300 s means the next wake-up reads the full
conversation context uncached: slower and more expensive.
The natural breakpoints:

- **Under 5 minutes (60 s–270 s)**: cache stays warm.
  Right for active polling (a build that is about to finish, a
  dispatched sub-agent within minutes of returning).
- **5 minutes (300 s)** is the worst choice: cache miss without
  amortizing the wait.
  Either drop to 270 s (stay warm) or commit to 1200 s+ (one
  cache miss buys a much longer wait).
  Don't pick 300 s.
- **20–30 minutes (1200 s–1800 s)**: idle ticks with no
  specific signal to watch.
  Pays one cache miss per hour, not 12.
  This is the default for active mode without a tighter trigger.
- **1 hour (3600 s)**: genuinely idle waits.

For the steward's loop specifically:

- **Hard upper bound: 32400 s (9 hours).**
  Catches a returning contributor within a workday.
- **Active mode: ≤ 1800 s (30 min)** when any active-mode
  trigger fires (see step 1 above).
  Catches a cluster of contributor activity within ~30 min.
- **Idle mode: between active and 9 h**, biased shorter when
  contributor engagement is plausible.

`endo-but-for-bots` is guarded against non-contributor comments;
only contributor feedback matters and tends to cluster.

## Always schedule; the loop is indefinite

The watchman-cadence ALWAYS schedules the next fire.
The steward does not self-terminate.
The loop stops only on user action (kill the wakeup, send stop,
`TaskStop`).

A cycle that produces no dispatches is not a stop signal; the
next cycle still fires per the cadence rules.
Within-fire exhaustion (a round produces no new dispatches) ends
the rounds and triggers the close, but the close still ends with
a `ScheduleWakeup`.

## Cycle-close-is-gated, tied to schedule-next

The cycle-close-is-gated discipline (no labeled
`watchman-events:`, `watchman-schedule:`, `liaison:`, or
`marshal:` line in the cycle log = no close) MUST run before the
watchman-cadence schedules the next fire.
Once the process commit is queued, the temptation to
ship-and-schedule overrides re-dispatch.
The gate is at section-draft time, not at schedule-wakeup time.

If the cycle-log section being drafted is missing any required
labeled line, dispatch the missing role now and append its report
when it returns.
Only then call `ScheduleWakeup`.

## The cron alternative (deferred)

The Anthropic `CronCreate` tool fires session-independent
remote-agent triggers on a cron schedule.
For the steward's main loop, `ScheduleWakeup` is the right
substrate: it preserves the working tree, in-flight git state,
and ambient credentials.
`CronCreate` is appropriate for engagements whose trigger is
calendar-style and independent of in-flight per-PR state (the
[`major-general`](./major-general.md)'s weekly sweep is a
candidate), but the watchman-cadence does not own those
triggers; if a future engagement uses cron, the cron trigger
writes a marker file or opens a draft PR that the steward picks
up on the next cycle, keeping the watchman-cadence in the loop
for sub-role coordination.

See
[`../designs/watchmen.md`](../designs/watchmen.md)'s
"Cron alternative" section for the full tradeoff.

## Skills

- [`../skills/autonomous-loop-pacing.md`](../skills/autonomous-loop-pacing.md) —
  the cadence rules and cache-window selection.
- [`../skills/relative-paths-rule.md`](../skills/relative-paths-rule.md),
  [`../skills/em-dash-style-rule.md`](../skills/em-dash-style-rule.md).

## Posture

- **Single call site for `ScheduleWakeup`.**
  The steward delegates to the watchman-cadence; no other inline
  subsection calls `ScheduleWakeup` directly.
- **Always schedule.**
  The loop is indefinite; the watchman-cadence is the only place
  that decides when the next fire happens.
- **Cap on next-engagement date.**
  An idle-mode wakeup that would step past a scheduled
  engagement is shortened to fire at the engagement date.
- **Cache-window discipline.**
  Don't pick 300 s.
  Either 270 s (warm) or 1200 s+ (amortized cache miss).
- **Cycle-log gate before schedule.**
  No labeled `watchman-events:`, `watchman-schedule:`,
  `liaison:`, or `marshal:` line in the cycle log = no close,
  no schedule.

## Self-improvement

Final task of every engagement: update this role file with
patterns that recur across cycles.
See
[`../skills/self-improvement.md`](../skills/self-improvement.md).
