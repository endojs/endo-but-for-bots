---
'@endo/agent-tools': minor
---

Add the capability-based workspace provisioning adapter
(`@endo/agent-tools/workspace.js`).
`makeWorkspaceTools({ filesystem, git, remote, shell, http })` composes one
flat tool catalog from already-granted capabilities. A tool group is present
only when its backing capability is granted, and colliding Shell, GitRemote,
and HTTP method names are qualified in the workspace catalog.
`provisionWorkspaceTools` derives the content-layer `Filesystem` from the
granted `Git`'s worktree mount, so one `Git` grant yields both file and
versioning tools over the same worktree. `provisionHistoryTools` composes
read-only file tools over `Git.filesystemAt(ref)` for historical inspection.
Commit attribution rides the granted `Git`'s formula-owned identity; the
adapter never restates it.
