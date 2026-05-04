# Review-feedback follow-up commits

## Principle

When addressing review feedback on an open PR, **add a follow-up
commit on top** rather than amending the original commit. The
follow-up makes the diff between the previous PR state and the
current one trivially reviewable. Amend only the just-rebased tip
when no one but you has pushed since.

## Per-concern commits, not one-big-fixup

Group review responses into atomic commits where each commit
addresses one concern. A reviewer who agrees with three points and
disagrees with the fourth can request the fourth commit be dropped
without unwinding the others.

Use conventional-commit messages with the parenthesized PR number,
e.g.:

- `fix(ci): restore line accidentally regressed in rebase (#NNN)`
- `refactor(pkg): clarify mock transport's pair-of-pipes (#NNN)`
- `feat(pkg): subpath exports for transports (#NNN)`
- `docs(pkg): rename old → new in codec docs (#NNN)`
- `chore: Update yarn.lock`

## How

```sh
# from the worktree at the PR head
git fetch bots master
git switch -c kr-followup
git rebase bots/master
# … apply each fix as its own commit …
git push --force-with-lease bots HEAD:<original-branch-name>
```

## Reply on each thread

Once the push lands and CI is green, post one reply per inline
comment thread citing the commit SHA(s). See
`pr-review-thread-replies.md`.

## Pitfalls

- Don't squash everything into one big commit; reviewers lose the
  ability to ask for partial reverts.
- Don't skip the rebase before the follow-up commits, even if it
  looks like a no-op. See `rebase-before-followup.md`.
- If the lockfile changes, that goes in its own commit per
  `yarn-lock-separate-commit.md`.

## Session example

PR 59 received seven follow-up commits (mock simplification, subpath
exports, ws-browser, util de-dup, doc renames, lint fix, README) plus
a separate `chore: Update yarn.lock`. Each commit cited the PR
number and was individually reviewable.
