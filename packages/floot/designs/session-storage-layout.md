# Factory-owned session storage

Each registered session owns exactly one directory in the factory host:
`floot-private-sessions/<session-id>/`.
The directory is administrative storage, never an endowment of the session guest.
The existing schema marker remains `{ version: 2, sessionId }`; journal record names
and payload formats are unchanged.

Alongside journal, network-policy, and attachment records, the directory contains:

| Name | Purpose |
| --- | --- |
| `handle` | Session mail handle |
| `guest` | Session guest administration |
| `environment-admin` | Optional native environment lifecycle and network control |
| `environment-shell` | Interrupted shell publication, removed after guest publication |
| `pending` | Durable submission queue and bounded duplicate receipts |
| `scratch-temp`, `git-temp`, `code-mount-temp` | Interrupted preset provisioning |

Factory endowment names stay stable.
Registry snapshots remain in the profile with their existing four-record bound.
Adding sessions increases the children of `floot-private-sessions`, without adding
per-session names to the controller profile itself.
Retained transcript history still consumes storage within each session; this change
is not a transcript retention policy or a claim that total history is bounded.

## Upgrade and recovery

On startup, every registered session passes a shared layout barrier before guest
revival, pending-queue recovery, or environment administration.
Stopped sessions reach it through queue readiness, creating sessions through creation
recovery, and deleting or failed sessions through terminal cleanup.
The barrier requires the existing ownership schema, checks every known destination
for identity conflicts, then copies each exact legacy binding before removing its
old alias.
All capabilities, queue records, and journals retain identity during the move.
A failed or lost acknowledgement retries matching aliases; different identities fail
closed and remain available for inspection.
Unknown or unregistered historical bindings are not automatically adopted or deleted.

The queue uses a restricted storage adapter, so its durable record and dispatch
recovery algorithm are unchanged.
A previously dispatching entry still becomes interrupted and is never replayed
merely because its storage moved.
Environment administration remains private, and a failed native disposal retains
its administrator and owned directory for retry.

Terminal deletion stops writers and native work before dropping the session's
control aliases and unlinking the owned directory.
A lost unlink acknowledgement does not cache a nonexistent directory: deletion can
finish on the next retry without recreating the session or its pending queue.
Creation rollback without acknowledged terminal intent retains journals and schema.
Interrupted creation recovery stops live writers and hosted native execution,
retaining durable native state rather than destroying it, before reusing a complete guest
and handle pair, preserving the workspace and Shell already published into it.
A truly incomplete pair cannot silently mint a replacement guest on ordinary reopen;
terminal cleanup can still remove the remaining half.

Deploy the four runtime files together: `agent.js`, `src/session-storage-layout.js`,
`src/development-environment.js`, and `src/private-turn-storage.js`.
The migration is performed by normal startup; a separate live-name mover is neither
needed nor safe while the previous factory is running.
Do not roll back to a factory that only understands flat session names after migration:
it could mint replacement guests and overlook queue or environment cleanup state.
Use a forward fix or an offline, identity-checked reverse migration.
Historical endo-host maintenance scripts that refer to `session-agent-*`,
`floot-environment-admin-*`, or `floot-pending-*` are not current-layout maintenance
interfaces; use the factory lifecycle API, or explicitly update an inspected script
to the owned directory paths before using it.

Regression coverage includes interrupted and lost-acknowledgement migration,
conflicting bindings, shared startup barriers, pending dispatch recovery, retained
session namespace growth, create/reopen/delete, failed native disposal, and lost
terminal unlink acknowledgements.
