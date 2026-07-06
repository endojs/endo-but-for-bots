---
'@endo/daemon': minor
---

`@endo/daemon` now provides an `interval-scheduler` formula and a host-side
`HostInterface.makeIntervalScheduler(petName, opts?)` command, so an agent can
hold a scheduled-interval (heartbeat) capability. The scheduler delivers
start-to-start interval ticks with resolve/reschedule semantics and bounded
exponential backoff, host-controlled limits (`maxActive` / `minPeriodMs`),
pause/resume/revoke, and crash-safe per-interval persistence with missed-tick
coalescing on startup recovery. The scheduler is collected with its owning agent
and disarms every timer when the formula is cancelled.
