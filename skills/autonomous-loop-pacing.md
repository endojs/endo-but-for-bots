# Autonomous loop self-pacing

## When to use

`<<autonomous-loop-dynamic>>` invocations let the assistant continue
working between user messages, with the assistant deciding when to
wake up. Use it when there are background tasks or external events
(CI runs, polling agents) you'd want to check on without burdening
the user.

## How

After a checkpoint of useful work, schedule the next tick:

```
ScheduleWakeup({
  delaySeconds: <60..3600>,
  reason: "<one-sentence explanation>",
  prompt: "<<autonomous-loop-dynamic>>",
})
```

To **stop** the loop, just don't schedule another wakeup.

## Choosing delaySeconds

- **Under 5 minutes (60s–270s)**: prompt cache stays warm. Use for
  active polling (a build that's about to finish).
- **5 minutes (300s)** is the worst choice: cache miss without
  amortizing the wait. Either drop to 270s (stay warm) or commit to
  1200s+ (one cache miss buys a much longer wait).
- **20–30 minutes (1200s–1800s)**: idle ticks with no specific
  signal to watch. Pays one cache miss per hour, not 12.
- **1 hour (3600s)**: the maximum, for genuinely idle waits.

## What to do during a tick

The autonomous loop is for *making progress*, not just polling. On
each tick:

1. Sweep CI status across in-flight PRs (`ci-status-summary.md`).
2. Address any failing checks if the fix is one-liner-obvious
   (e.g., revert an unnecessary fixture change that broke lint).
3. If everything is green, schedule the next tick or end the loop.
4. Don't dispatch *new* agents on a wakeup unless the user has
   asked for ongoing work; let scheduled-but-incomplete agents
   finish their own runs first.

## Pitfalls

- "Idle 5-min poll" is the most common mis-pick. Resist it.
- Don't keep a `<<autonomous-loop-dynamic>>` going indefinitely.
  When all in-flight work is settled, end the loop with a status
  line and stop scheduling.
- `Bash` calls during a wakeup count against the same context budget
  as user-driven calls. Keep ticks short.

## Session example

The session ran several wakeup cycles while CI matrices on PRs
59–75 propagated. Each tick used `gh pr checks <N> --json state`
batched across all open PRs to produce a one-line-per-PR status
summary, then either fixed an outlier (PR 70's lingering lint
failure on a fixture rename) or scheduled the next tick. The loop
ended cleanly when all 16 active PRs were SUCCESS=26 and there were
no foreground agents.
