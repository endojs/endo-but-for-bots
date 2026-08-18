---
'@endo/exo-git': minor
'@endo/git': patch
---

Fix: `GitRemote`'s `fetch` / `pull` / `push` results are network-sourced — a remote (or a compromised transport) previously could return an arbitrarily large `text` or an arbitrarily long `updatedRefs` array, which `@endo/exo-git`'s `GitRemoteInterface` guard accepted structurally (it checked element type but not size) and `GitRemote` then retained in its durable audit log.

`makeGitRemote` now transparently truncates an oversized `text` (with a `"... (truncated, N chars total)"` marker, matching `@endo/git`'s existing `truncateOutput` convention) and caps an oversized `updatedRefs` array, reporting the count of dropped entries in a new optional `droppedUpdatedRefsCount` field on the result and on the corresponding audit-log entry. Ref-name and OID strings (`GitRef.name`/`.oid`, `RemoteRefUpdate.remote`) are truncated the same way. A failure audit entry's error message is bounded identically.

The bounds are configurable per remote via `makeGitRemote`'s new `resultLimits` option (`{ text?, updatedRefs?, refString? }`), each defaulting to (and clamped to never exceed) a hard structural ceiling on `GitRemoteInterface`'s `RemoteOperationResultShape` / `GitRefShape` guards: a result that is still oversized after bounding is rejected at the guard, regardless of which backend produced it.

`@endo/git`'s `native-git-backend.js` plain (no-credential) `remoteFetch` path is documented as already bounded via `runGit`'s own `truncateOutput`, matching the askpass path.
