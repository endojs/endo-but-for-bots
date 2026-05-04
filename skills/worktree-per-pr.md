# Worktree per PR

## When to use

When dispatching multiple agents that each work on a different PR or
issue against the same repository, give each agent its own
`git worktree`. Worktrees on the same base branch coexist freely,
with independent index and working tree state, so parallel agents
never collide.

## How

```sh
git fetch <remote> <ref>
git worktree add <path> <ref>          # detached HEAD on the ref
git worktree add -b <branch> <path> <ref>   # also create a branch
```

Place worktrees inside the repo so the rest of the toolchain (Yarn
workspaces, ESLint, AVA) finds the workspace root. The session used
`<repo>/.worktrees/<short-name>/`.

## Pitfalls

- `git checkout <branch>` from inside one worktree fails if another
  worktree already holds that branch. Operate in detached HEAD or
  branch off (`git switch -c <new-branch>`).
- The Bash tool's `cwd` may persist across calls but the harness's
  notion of "current worktree" only changes via `EnterWorktree`.
  Always pass `git -C <path>` explicitly when scripting against a
  worktree from a different cwd.
- `git worktree remove` rejects worktrees with uncommitted changes
  unless you pass `--force`. Investigate before forcing.

## Session example

The 10-issue parallel implementation pass created
`.worktrees/iss-{3156,3052,3081,2390,2632,2749,2879,1845,2742,2834}`,
each with its own branch off `actual/master`. Ten agents ran in
parallel without conflicts.
