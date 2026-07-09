---
'@endo/cli': minor
---

Add mount-scoped path verbs to the CLI so a mount's confined tree can be
traversed from the shell: `endo ls <mount> [path...]` lists entries within a
mount, `endo cat <mount> <path...>` reads a file within a mount, and the new
`endo write <mount> <path...>` streams standard input into a file within a
mount (creating parents, honoring read-only and symlink confinement). The
mount-scoped forms are additive — `endo ls`/`endo cat` keep their existing
capability-graph behavior and switch to mount traversal only when trailing
in-mount path segments are supplied.
