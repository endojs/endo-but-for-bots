---
'@endo/agent-tools': minor
'@endo/exo-git': minor
---

Add reusable typed code-mode global descriptors for shells, HTTP clients, and
Git remotes.

`GitRemote.fetch`, `pull`, and `push` results are now validated against the
public `GitRemoteOperationResult` shape at runtime, not just asserted by
types. A custom `GitBackend` (as used in tests or alternative backends) must
return a `text: string` field alongside `updatedRefs` from its `remoteFetch`
and `remotePush` implementations, or the operation will be rejected.
