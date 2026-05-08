---
"@endo/daemon": minor
"@endo/cli": minor
---

Add IntervalScheduler agent tool: a host-controlled capability that lets an
agent register periodic heartbeats delivered as inbox messages. The kit
exposes makeInterval(label, periodMs, opts?), list(), per-interval cancel
and setPeriod, and a control facet with pause/resume/setMaxActive/
setMinPeriodMs/revoke. Persists active entries to disk and recovers them
on daemon restart.

Mail-mode tick delivery (the actual `E(agentHandle).receive(...)` call into
the agent inbox) is **disabled by default** in this PR: the current call
path rejects with "Mail fraud: unrecognized parcel" because `receive()`
expects an envelope previously enrolled in the sender's outbox. Wiring the
agent mailbox `deliver()`/`agent.send()` into the maker scope is a deeper
plumbing change tracked as a follow-up. While disabled, the scheduler still
advances on each period (so timers, persistence, and the IntervalControl
surface stay exercised), and a single warning is logged per scheduler
instance. Opt in with `endo interval-scheduler --mail-mode-enabled` (or
`{ mailModeEnabled: true }` in the API) once the follow-up lands. The CLI
command `endo interval-scheduler --name <petname>` provisions one for the
host's agent.
