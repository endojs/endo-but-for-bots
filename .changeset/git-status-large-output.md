---
'@endo/agent-tools': minor
'@endo/exo-git': minor
'@endo/git': patch
---

Make `Git.status()` read large porcelain output through a streaming subprocess
reader and add an optional `untracked` mode that matches Git's `all`, `normal`,
and `no` selections.
