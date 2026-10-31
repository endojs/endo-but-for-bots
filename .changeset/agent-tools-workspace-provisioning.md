---
'@endo/agent-tools': minor
---

Add the capability-based workspace provisioning adapter (`@endo/agent-tools/workspace.js`).
`makeWorkspaceTools({ filesystem, git, remote, shell, http })` composes one flat tool catalog from already-granted daemon capabilities.
A tool group is present only when its capability is granted, and a duplicate tool name fails closed.
The `http` grant contributes the confined client's `fetch` and `allowedOrigins` tools without exposing its policy controller or the unfettered transport.
`provisionWorkspaceTools` derives the `Filesystem` from the granted `Git`'s worktree, so one `Git` grant yields both file and versioning tools.
`provisionHistoryTools` composes read-only file tools over `Git.filesystemAt(ref)`.
Commit attribution rides the granted `Git`'s formula-owned identity.
