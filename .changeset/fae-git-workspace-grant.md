---
'@endo/fae': minor
---

A Fae agent can now be given a git workspace as a capability with `createAgent(name, { workspace: { git, remote? } })`, naming a `Git` and optionally a `GitRemote` in the factory's store.
The agent gets file and git tools over that `Git`'s worktree, plus `fetch`, `pull` and `push` when a remote is given.
Commits carry the identity the `Git` formula fixed, not one the model chooses.
A read-only `Git` gets only the read tools and cannot be combined with a remote.
Agents created without a workspace are unchanged, and subagents do not inherit their parent's workspace.
The former `setup-fs-tools` command and its unconfined `FAE_CWD` path-root tool caplets have been removed.
