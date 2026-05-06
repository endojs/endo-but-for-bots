---
"@endo/daemon": minor
"@endo/cli": minor
---

Add IntervalScheduler agent tool: a host-controlled capability that lets an
agent register periodic heartbeats delivered as inbox messages. The kit
exposes makeInterval(label, periodMs, opts?), list(), per-interval cancel
and setPeriod, and a control facet with pause/resume/setMaxActive/
setMinPeriodMs/revoke. Persists active entries to disk and recovers them
on daemon restart. Mail-mode tick delivery is fire-and-forget: the
scheduler advances to the next period as soon as the agent's inbox
accepts (or rejects) the tick. The CLI command `endo interval-scheduler
--name <petname>` provisions one for the host's agent.
