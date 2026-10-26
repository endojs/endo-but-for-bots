---
'@endo/exo-agent-factory': minor
---

Add the recursive child-agent spawner and provider-neutral inference driver
maker.
Each logical child owns a derived namespace, so stopping it revokes every
descendant without giving the child host authority.
The inference maker gives a driver only a child-scoped inference capability,
derives a fresh `GuestToolProjection` for each turn, and keeps credentials
inside the selected `InferenceBackend`.
Fae, Lal, Claude CLI, and Claude Agent SDK expose adapters over their existing
drivers and backends.
