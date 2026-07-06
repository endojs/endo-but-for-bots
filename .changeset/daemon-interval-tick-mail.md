---
'@endo/daemon': minor
---

The `@endo/daemon` interval scheduler now delivers its heartbeat ticks as
`interval-tick` mail messages in the agent's inbox rather than through an
internal callback. Each tick is delivered from the scheduler's own handle and
carries a one-shot `TickResponse` capability — a guarded exo with `resolve()`
and `reschedule()` — that the agent invokes to advance or retry the tick. Ticks
therefore gain the mail system's persistence, ordering, and restart replay, and
appear alongside an agent's other messages via `followMessages()`. A superseded,
timed-out, or post-restart tick response is inert.
