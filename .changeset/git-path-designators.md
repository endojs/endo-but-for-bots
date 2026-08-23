---
'@endo/exo-git': minor
'@endo/agent-tools': minor
---

Allow Git writer mutators to accept worktree-relative string paths alongside
lineage-bearing path entries. String paths are resolved through the Git
capability's own confined mount, and the agent-tool catalog now exposes `add`
and `checkoutConflict` directly with JSON string-path inputs.

A string path normalizes the way the previous mount-bridged tools normalized
it: empty components (leading, doubled, or trailing separators) and `.` steps
collapse, so `a/b`, `a//b`, `./a/b`, and `a/b/` designate the same path. A `..`
segment is still contained by the mount, clamped at the worktree root, and a
designator that resolves to the worktree root itself is rejected before any
repository mutation.
