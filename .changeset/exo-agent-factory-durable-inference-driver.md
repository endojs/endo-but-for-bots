---
'@endo/exo-agent-factory': minor
---

Run inference-backed children on a real daemon with durable turns.
The inference driver maker no longer stores an unnameable `ChildInference`
in the driver guest, which a daemon rejects; it stores itself and each runner
incarnation asks it for its child's grant.
The inference runner waits for its child to commit, applies the child's
instructions, and journals every turn with the turn ledger, so a restart
neither re-infers nor republishes a published turn.
The turn ledger now reads the daemon's exo-stream message reader and accepts
an optional per-turn projection, message filter, and post-publication hook.
