# Worktree per PR

## When to use

**Every dispatched subagent operates outside the steward's
working tree, full stop.** The steward stays pinned to a
garden-only worktree (typically `~/garden`);
no subagent touches that path. Three lanes:

1. **Mutating subagents** (builder, fixer, weaver, shepherd,
   cleaner, conductor, designer, groom, liaison writing tracking
   files) work inside a **dedicated `git worktree`** at
   `~/endo-wt/<slug>` or `pr-<N>`.
2. **Read-only-on-tree subagents** (panel jurors reading the
   diff, saboteur perspective on a contributor PR) work in a
   **detached read-only worktree** created with
   `git worktree add --detach <path> <ref>`. They never commit;
   the worktree is removed at end of dispatch.
3. **API-only subagents** (vacuous-check liaison/marshal that
   just runs `gh api` queries, scan-only director) don't need a
   git tree at all; their brief specifies `cd /tmp` (or a
   similar throwaway location) as their first action so they
   don't accidentally land in the steward's worktree.

The cost of an extra worktree is one `git worktree add` and a
~30 MB checkout; the cost of a branch-swap race in the shared
tree is hours of recovery (other agents' edits stash-disappear,
commits land on the wrong tip).

**Every subagent dispatch brief leads with an explicit `cd <path>`
line.** A brief that omits the cd and says "work on PR <N>"
delegates the cwd to whatever the harness inherited — typically
the steward's seat (`~/garden` itself), which is the worst
possible default: the subagent can accidentally commit to
`garden` or step on the steward's mid-cycle state. Encountered
2026-05-07 when `~/garden` was temporarily pinned to a fix-branch
(`fix/pr70-regexp-escape`): a saboteur dispatch wrote its
self-improvement skill file to `~/garden/skills/` on the wrong
branch because its brief did not pin cwd. The steward had to
rescue the file manually. Cheap to prevent: the cd line is one
sentence in the brief.

## Lifecycle: one worktree per PR, hand off across roles

The worktree at `~/endo-wt/pr-<N>` is the canonical
location for **all** work on PR `<N>`. The builder creates it,
the fixer reuses it across rounds, and the conductor cleans it
up after merge. Same worktree across all three roles; no
re-checkout per role; no per-role suffix in the path.

### Builder (creates, then renames after PR opens)

The builder doesn't know the PR number until after `gh pr
create` returns. Create the worktree under the branch slug
first, then move it to `pr-<N>` once the number is known:

```sh
mkdir -p ~/endo-wt
git fetch bots-ssh llm
git worktree add ~/endo-wt/<branch-slug> \
  -b <branch-name> bots-ssh/llm
cd ~/endo-wt/<branch-slug>
# … implement, push, gh pr create …
N=$(gh pr view --json number --jq .number)
cd ~/garden  # leave the worktree before moving it
git worktree move ~/endo-wt/<branch-slug> \
  ~/endo-wt/pr-${N}
```

The `git worktree move` updates internal pointers; a plain `mv`
breaks the worktree. Do the move from outside the worktree
(`git worktree move` requires the worktree not be the cwd).

### Fixer (reuses if present, else creates fresh)

Before creating a worktree, check if one already exists for the
PR:

```sh
N=70   # the PR number you're working on
WT=~/endo-wt/pr-${N}
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
WT=~/endo-wt/pr-${N}

cd ~/garden  # leave the worktree before removing
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

- **`~/endo-wt/pr-<N>`** — the canonical location for
  any open PR's work, for any role.
- **`~/endo-wt/<slug>`** — temporary, only during the
  pre-PR window of a builder dispatch. Move to `pr-<N>` as soon
  as the PR opens.
- **`~/garden`** (or another garden-pinned worktree) —
  reserved for the steward and any cycle-level work that
  modifies `garden`. Never switch branches here.

**Keep the pre-PR slug short for any dispatch that runs the
`packages/daemon/` test suite.** The daemon tests construct Unix
domain socket paths under `<worktree>/packages/daemon/tmp/<test-slug
+ hash>/endo.sock`. Linux caps the sockaddr_un path at 108 bytes
(`UNIX_PATH_MAX`); the project base path plus a long worktree slug
plus the test fixture's `~hash` suffix can exceed the cap. The
daemon then logs a `Warning: Length of path for domain socket ...
exceeeds common maximum` and the test fails with
`ENOENT: no such file or directory, access '<...>/endo.sock'`,
which looks like a fs race but is actually that the listen() never
succeeded so the socket file was never created. Pre-PR window:
prefer slug names under ~16 characters
(`feat-rej` over `feat-unhandled-rejection-display`); if the slug
is forced longer, `git worktree move ~/endo-wt/<slug>
~/endo-wt/<short>` before running the daemon suite. The post-PR
`pr-<N>` rename automatically lands inside the budget. Encountered
on the 2026-05-10 PR #187 builder dispatch: the long slug
`feat-unhandled-rejection-display` (32 chars) put 151 of the 261
`packages/daemon` tests over the 108-byte cap; renaming to
`feat-rej` (8 chars) brought the path back under the cap and all
261 tests passed.

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
  `cd ~/garden` first, then `git worktree move`.
- A previously-merged PR's worktree might already have been
  cleaned up by the conductor. The fixer's reuse-if-present
  guard handles this; do not assume the worktree exists.
- **Reused worktrees can hold stale absolute paths to since-pruned
  sibling worktrees in their `node_modules/.bin/*` shims and
  `.pnp.cjs` resolvers.** When the first call to `npx corepack
  yarn format` (or any other yarn-installed CLI) fails with
  `MODULE_NOT_FOUND` pointing at a path like `~/endo-wt/
  <some-other-slug>/node_modules/.store/...`, re-run `npx corepack
  yarn install` in the reused worktree to rewrite the store
  references to the current path. This is one install cycle, not
  a re-checkout, and resolves the cross-worktree leakage that
  yarn 4's portable store creates when sibling worktrees come and
  go. (Session example: PR 101 fixer reused the builder's pr-101
  worktree weeks later; the `.bin/prettier` shim still pointed at
  a deleted sibling `voice-fresh` worktree until the reinstall.)
- **`git stash` to "test the baseline" mid-dispatch is the failure
  mode itself.** When a fixer wants to confirm a CI failure or test
  failure is pre-existing on the parent commit, the temptation is to
  `git stash`, run the test, then `git stash pop`. This loses
  rename-detection on `git mv`-staged files (see the rename pitfall
  above) AND surfaces a flurry of "file modified by user/linter"
  system-reminders for every previously-edited file as the stash
  reverts them, which is misleading mid-fixer when those reminders
  normally indicate real concurrent edits. The cheap alternative is
  `git diff HEAD~1` to inspect what your changes look like, or
  `git show HEAD~1:<path>` to read the parent's version of a single
  file, neither of which mutates the working tree. For a full-tree
  baseline test, `git worktree add --detach <tmp-path> <parent-sha>`
  creates an isolated tree to run the test in; remove it after with
  `git worktree remove <tmp-path>`. Session example: PR 142 fixer
  ran `git stash; cd packages/ocapn; npx ava test/buffer-utils.test.js;
  git stash pop` to confirm 25 pre-existing test failures were not
  caused by the bytes-rename fixup; the stash pop emitted ~10 system
  reminders showing reverted file content as if the user/linter had
  re-edited them, and rename detection on the four `git mv` renames
  was lost (had to `git add -A` again). `git show HEAD:<file>` or a
  detached worktree would have avoided both.

## Session example

The 10-issue parallel implementation pass created
`.worktrees/iss-{3156,3052,3081,2390,2632,2749,2879,1845,2742,2834}`,
each with its own branch off `actual/master`. Ten agents ran in
parallel without conflicts. After standardizing on the
`pr-<N>` naming, the same pattern works for any active PR:
each PR has exactly one worktree, owned by whichever role is
working on it at the moment.
