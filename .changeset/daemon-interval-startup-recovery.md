---
'@endo/daemon': minor
---

The `@endo/daemon` interval scheduler now recovers its intervals on daemon
startup. When the daemon reincarnates its persisted formula graph, every
surviving `interval-scheduler` is eagerly incarnated rather than left dormant
until an agent happens to look it up: it re-reads its persisted interval
entries, re-arms the active ones, and for any ticks missed while the daemon was
down delivers a single coalesced catch-up `interval-tick` (carrying
`missedTicks > 0`) instead of a storm of per-tick messages. Scheduled work is
therefore no longer silently dropped across a restart. As a consequence, a
scheduler with an overdue interval now incarnates its owning agent (and worker)
at startup to deliver the catch-up tick, work that was previously deferred until
the scheduler was first looked up.
