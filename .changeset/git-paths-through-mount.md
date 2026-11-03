---
'@endo/exo-git': minor
'@endo/agent-tools': minor
---

`Git.diff` and `Git.stashPush` now resolve their `paths` option through the
worktree mount, as `add` already did, instead of passing strings to git. A
leading `..` clamps at the worktree root, and git can no longer answer with a
diagnostic that names the worktree's host path. A path that denotes the
worktree root, such as `.`, is now refused; omit `paths` to cover the whole
worktree.

The `diff` agent tool's schema now documents its `cached`, `base`, `head`, and
`paths` options, where it previously described an opaque options record.
