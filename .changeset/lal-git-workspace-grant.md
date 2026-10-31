---
'@endo/lal': minor
---

Lal's agent form can now name a `Git` and optional `GitRemote` to register confined file and git workspace tools for the worker.
Writable grants are narrowed to ordinary writer authority, while read-only grants omit mutation tools and cannot be paired with a remote.
