# Rebase before follow-up push

## When to use

When responding to review feedback on a PR whose base branch has
moved since the PR was opened. Always rebase the PR branch onto the
current base before pushing the fix-up commit, or the PR will
appear "behind master" and CI may run against stale dependency
versions.

## How

```sh
git fetch bots master            # or whichever remote/branch is the PR base
git switch -c kr-followup        # working branch from current PR head
git rebase bots/master           # resolves linearly if no conflicts
# … apply review fixes …
git commit -m "fix(pkg): address review on … (#NNNN)"
git push --force-with-lease bots HEAD:<original-branch-name>
```

`--force-with-lease` (not `--force`) protects against overwriting
work pushed by anyone else since the agent's last fetch. If the
lease is rejected, fetch again and re-rebase.

## Pitfalls

- Never resolve rebase conflicts with `--ours` / `--theirs`. The
  daemon `CLAUDE.md` is explicit on this.
- If the PR branch contains accidentally-included commits that have
  since been merged to master independently (e.g., a vendored copy
  of a fix that landed via a different PR), the rebase silently
  drops them. Verify the rebased diff still represents your intent.
- The OAuth token used by the bots agent may lack the `workflow`
  scope, so a rebase that reaches a commit modifying
  `.github/workflows/*` will be rejected at push time. Push via SSH
  instead. See `ssh-fallback-workflow-scope.md`.
- **Switching base branches (e.g., `llm` → `master`) can drop or
  conflict with bots-repo-only infrastructure files.** A PR opened
  against `llm` may contain a "docs(designs): index ..." commit that
  modifies `designs/README.md`, but `designs/README.md` does not
  exist on `master`. The rebase will surface this as a `modify/delete`
  conflict; the right resolution is `git rebase --skip` for the
  bots-repo-only commit, leaving only the upstream-bound design
  commits on the rebased branch. Verify post-rebase with `git diff
  --name-only bots-ssh/master..HEAD`; the remaining files should
  all belong on master.
- After a base-branch switch, also re-check `git merge-base HEAD
  bots-ssh/master` against the current `bots-ssh/master` SHA. If
  master moved during the session (a common occurrence in busy
  repos), the rebase target you initially passed may now be stale,
  and `git diff bots-ssh/master..HEAD` will list spurious files
  belonging to interim commits. A second `git rebase bots-ssh/master`
  resolves it cleanly.
- **"Byte-identical duplicate commits will auto-skip" is true only
  for the cumulative tree, not for each commit in isolation.** When
  the new base contains a sequence `A; A'` (e.g., a draft and its
  revision) and the rebased branch carries patch-id-equivalent
  copies `B; B'` of those, `git rebase` replays them one at a time.
  `B` (the draft) does not match the new base's *final* version
  (which is `A'`), so it surfaces as a content conflict (often
  `AA add/add` on a fresh file). Two clean options:
  1. `git rebase -i` and `drop` the duplicate commits explicitly
     before starting, after confirming the cumulative tree matches
     `git diff bots/<base>:<file> bots/<head>:<file>` is empty.
  2. Resolve by accepting the new base's content for each conflict
     and let the second commit become empty (skipped automatically).
  Option 1 is faster and gives a cleaner shortlog.

## Session example

PRs 71, 72, 75, and 59 all received follow-up commits where the
agent first ran `git rebase bots/master` (synced earlier in the
session with `actual/master`) before applying review fixes. PR 59's
"line 101 regression" turned out to have already been resolved by
the rebase itself.
