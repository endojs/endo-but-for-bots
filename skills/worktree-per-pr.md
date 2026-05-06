# Worktree per PR

## When to use

Every dispatched sub-role that mutates a branch — builder, fixer,
weaver, shepherd, cleaner, conductor — works inside a dedicated
`git worktree`. The steward's own working tree stays pinned to
`garden`; sub-roles never switch branches in the steward's tree.
The cost of an extra worktree is one `git worktree add` and a
~30 MB checkout; the cost of a branch-swap race in the shared
tree is hours of recovery (other agents' edits stash-disappear,
commits land on the wrong tip).

## Lifecycle: one worktree per PR, hand off across roles

The worktree at `/home/kris/endo-wt/pr-<N>` is the canonical
location for **all** work on PR `<N>`. The builder creates it,
the fixer reuses it across rounds, and the conductor cleans it
up after merge. Same worktree across all three roles; no
re-checkout per role; no per-role suffix in the path.

### Builder (creates, then renames after PR opens)

The builder doesn't know the PR number until after `gh pr
create` returns. Create the worktree under the branch slug
first, then move it to `pr-<N>` once the number is known:

```sh
mkdir -p /home/kris/endo-wt
git fetch bots-ssh llm
git worktree add /home/kris/endo-wt/<branch-slug> \
  -b <branch-name> bots-ssh/llm
cd /home/kris/endo-wt/<branch-slug>
# … implement, push, gh pr create …
N=$(gh pr view --json number --jq .number)
cd /home/kris/garden  # leave the worktree before moving it
git worktree move /home/kris/endo-wt/<branch-slug> \
  /home/kris/endo-wt/pr-${N}
```

The `git worktree move` updates internal pointers; a plain `mv`
breaks the worktree. Do the move from outside the worktree
(`git worktree move` requires the worktree not be the cwd).

### Fixer (reuses if present, else creates fresh)

Before creating a worktree, check if one already exists for the
PR:

```sh
N=70   # the PR number you're working on
WT=/home/kris/endo-wt/pr-${N}
if [ -d "$WT" ]; then
  cd "$WT"
  git fetch bots-ssh <head-ref>
  git reset --hard bots-ssh/<head-ref>
else
  git fetch bots-ssh <head-ref>
  git worktree add "$WT" bots-ssh/<head-ref>
  cd "$WT"
fi
```

The reuse path skips the ~30 MB re-checkout cost when the
builder's worktree is still around. The `git reset --hard`
makes sure the worktree's branch tip matches the PR's current
head (in case the maintainer pushed manually between fixer
dispatches).

### Conductor (removes after merge + deletes the branch)

The conductor's last act for each PR is cleanup: remove the
worktree and delete both local and remote branches. The merge
commit on the base preserves the history; the feature branch is
dead weight.

```sh
# After successful merge
N=<PR-number>
BRANCH=<head-ref-name>
WT=/home/kris/endo-wt/pr-${N}

cd /home/kris/garden  # leave the worktree before removing
[ -d "$WT" ] && git worktree remove "$WT"
git branch -D "$BRANCH" 2>/dev/null  # local copy if any
gh api -X DELETE \
  "repos/endojs/endo-but-for-bots/git/refs/heads/$BRANCH" 2>/dev/null \
  || true  # may already be gone if --delete-branch was used
```

`gh pr merge --merge --delete-branch` would clean up the remote
branch automatically, but the local worktree and local branch
need explicit cleanup; the `--delete-branch` flag does not
touch your local clone. Always do all three steps.

## Worktree naming

- **`/home/kris/endo-wt/pr-<N>`** — the canonical location for
  any open PR's work, for any role.
- **`/home/kris/endo-wt/<slug>`** — temporary, only during the
  pre-PR window of a builder dispatch. Move to `pr-<N>` as soon
  as the PR opens.
- **`/home/kris/garden`** (or another garden-pinned worktree) —
  reserved for the steward and any cycle-level work that
  modifies `garden`. Never switch branches here.

## Pitfalls

- `git checkout <branch>` from inside one worktree fails if
  another worktree already holds that branch. Operate in detached
  HEAD or branch off (`git switch -c <new-branch>`).
- The Bash tool's `cwd` may persist across calls but the
  harness's notion of "current worktree" only changes via
  `EnterWorktree`. Always pass `git -C <path>` explicitly when
  scripting against a worktree from a different cwd.
- `git worktree remove` rejects worktrees with uncommitted
  changes unless you pass `--force`. Investigate before forcing
  (the changes may be unmerged work the next role needs).
- `git worktree move` rejects if the source IS the cwd. Always
  `cd /home/kris/garden` first, then `git worktree move`.
- A previously-merged PR's worktree might already have been
  cleaned up by the conductor. The fixer's reuse-if-present
  guard handles this; do not assume the worktree exists.
- **Reused worktrees can hold stale absolute paths to since-pruned
  sibling worktrees in their `node_modules/.bin/*` shims and
  `.pnp.cjs` resolvers.** When the first call to `npx corepack
  yarn format` (or any other yarn-installed CLI) fails with
  `MODULE_NOT_FOUND` pointing at a path like `/home/kris/endo-wt/
  <some-other-slug>/node_modules/.store/...`, re-run `npx corepack
  yarn install` in the reused worktree to rewrite the store
  references to the current path. This is one install cycle, not
  a re-checkout, and resolves the cross-worktree leakage that
  yarn 4's portable store creates when sibling worktrees come and
  go. (Session example: PR 101 fixer reused the builder's pr-101
  worktree weeks later; the `.bin/prettier` shim still pointed at
  a deleted sibling `voice-fresh` worktree until the reinstall.)

## Session example

The 10-issue parallel implementation pass created
`.worktrees/iss-{3156,3052,3081,2390,2632,2749,2879,1845,2742,2834}`,
each with its own branch off `actual/master`. Ten agents ran in
parallel without conflicts. After standardizing on the
`pr-<N>` naming, the same pattern works for any active PR:
each PR has exactly one worktree, owned by whichever role is
working on it at the moment.
