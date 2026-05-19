---
'@endo/daemon': minor
---

Add the `persona` capability to the daemon: an agent's Handle now carries
an immutable epithet chain that the daemon stamps at delegation time and
that other holders can verify by asking the principal directly. See
`designs/daemon-capability-persona.md`.

API surface (all backward-compatible; opt in via the new `epithets` option):

- `Handle.epithets()` returns the chain (most-recent first), each entry
  shaped `{ relationship: string, principal: Handle }`. The chain is empty
  for handles that carry no delegation claims (the default).
- `Handle.verify(subordinateHandle, relationship)` returns true iff the
  subordinate's most-recent epithet names this handle as principal under
  the given relationship. The default policy is confirm-when-stamped-by-me
  and deny otherwise; richer policies (confirm-all, deny-all, selective)
  are open follow-up work tracked in the design.
- `EndoHost.provideGuest(petName, { epithets: [{ relationship }, ...] })`
  and `EndoHost.provideHost(petName, { epithets: [...] })` stamp the new
  handle with `{ relationship, principal: <creator handle id> }` and
  prepend the creator's inherited chain so the persisted chain is the
  full delegation path.

The chain is persisted on the `handle` formula as
`epithets?: Array<{ relationship: string; principal: FormulaIdentifier }>`;
existing handle formulas without the field continue to work and report an
empty chain.
