---
'@endo/agent-tools': minor
'@endo/fae': major
'@endo/lal': minor
---

Fae and Lal agents can now be given a git workspace as a capability rather than a host path.

- `@endo/agent-tools`: `makeWorkspaceTools` and `provisionWorkspaceTools` accept a `gitFacet` option (`'reader'` or `'writer'`, default `'writer'`) that selects the git-tool catalog, so a read-only `Git` can be provisioned without advertising verbs it would refuse.
  The new `provisionGitWorkspaceTools({ git, remote?, maxChars? })` refuses a capability that is not a `Git`, narrows a writable `Git` to its writer facet, offers only reader tools over a read-only `Git`, and refuses a `GitRemote` beside a read-only `Git`.
- `@endo/fae`: `createAgent(name, { workspace: { git, remote? } })` names a `Git` and optionally a `GitRemote` in the factory's `workspaces` directory, the only names a factory caller may grant.
  The agent gets file and git tools over that `Git`'s worktree, plus `fetch`, `pull` and `push` when a remote is given; commits carry the identity the `Git` formula fixed.
  `createAgent` provisions the workspace before creating anything, so an invalid grant rejects without leaving an agent behind.
  Agents created without a workspace are unchanged, and subagents do not inherit their parent's workspace.
  **Breaking:** the `yarn setup-fs-tools` command, its `setup-fs-tools.js` script and the unconfined `FAE_CWD` path-root tool caplets are removed; grant a `Git` through `workspace` instead.
- `@endo/lal`: the agent form can name a `Git` and optional `GitRemote` in the manager's `workspaces` directory to register the same confined tools for a worker; a bad grant is answered with an error before the worker starts.
