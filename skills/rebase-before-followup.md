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

## Session example

PRs 71, 72, 75, and 59 all received follow-up commits where the
agent first ran `git rebase bots/master` (synced earlier in the
session with `actual/master`) before applying review fixes. PR 59's
"line 101 regression" turned out to have already been resolved by
the rebase itself.
