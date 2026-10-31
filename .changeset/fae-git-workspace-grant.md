---
'@endo/fae': minor
---

A Fae agent can now be given a workspace as a capability:
`createAgent(name, { workspace: { git, remote? } })` names a `Git` (and
optionally a `GitRemote`) in the factory's store. The agent's driver holds
them, and the inbox loop adds the `@endo/agent-tools` file and git tools over
that `Git`'s worktree — plus fetch, pull and push when a remote is given — as
built-in tools. Commits carry the identity the `Git` formula fixed, not one
the model chooses. A read-only `Git` gets only the reader tools. Agents
created without a workspace are unchanged, and subagents do not inherit their
parent's workspace.
