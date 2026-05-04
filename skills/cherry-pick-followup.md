# Cherry-pick into the working branch

## When to use

When a doc/style/policy change lands on a working branch that's not
the same branch your local working tree is on, and you want it
applied locally without reauthoring it.

## How

```sh
git -C <repo> cherry-pick <sha>      # the original commit
# … resolve conflicts manually if any …
git -C <repo> log --oneline -2       # confirm the new commit landed
```

If you also want the change reflected on a worktree's branch, do the
cherry-pick from inside that worktree instead.

## Pitfalls

- A cherry-picked commit gets a new SHA. If you cherry-pick the same
  commit onto multiple branches, each branch has a different SHA;
  this is fine but can confuse `git log --oneline` comparisons across
  branches. Compare commit messages or trees, not SHAs.
- The user-provided `CLAUDE.md` and the repo's `AGENTS.md` track
  different style rules in the same project. Cherry-picking a
  CLAUDE.md change to a branch that has only AGENTS.md leaves the
  rule undocumented. Detect this case and target the right file
  instead of doing a no-op cherry-pick.

## Session example

After landing the PR-review-best-practices addition to `CLAUDE.md`
on the `design/best-practices-from-review` branch (PR 51), the same
commit was cherry-picked onto the `triage` branch so the local
working tree's instructions reflected the new style guidance. Later
amendments (yarn.lock-separate, em-dash ban, formula-specific
rules) were applied on both branches in lockstep.
