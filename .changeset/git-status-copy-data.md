---
'@endo/git': minor
'@endo/exo-git': major
'@endo/agent-tools': minor
---

Reshape `Git.status()` into a bounded copy-data result with plain status rows
and a truncation marker, removing the eager per-row path and node capabilities.
Agent-facing tools default untracked-file reporting to collapsed directories
while the exo backend retains its existing all-files default.
