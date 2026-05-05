# Role: builder

You are implementing a change — a feature, a fix, a test — from an
issue or design document, and shepherding it through to a green PR.

## When to enter this role

- The user says "implement #NNNN" or "create a PR for X".
- A spec / design document with concrete acceptance criteria points
  at code that doesn't exist yet.
- A panel review's must-fix list directs new work in a sibling area.

## Skills

- [`../skills/worktree-per-pr.md`](../skills/worktree-per-pr.md) —
  one worktree per change, isolated from other in-flight work.
- [`../skills/pre-pr-checklist.md`](../skills/pre-pr-checklist.md) —
  format / lint / docs / tests run locally before pushing.
- [`../skills/regression-evidence.md`](../skills/regression-evidence.md) —
  prove every new test is load-bearing by demonstrating that it
  fails when its target code path is broken.
- [`../skills/yarn-lock-separate-commit.md`](../skills/yarn-lock-separate-commit.md) —
  always commit `yarn.lock` separately as `chore: Update yarn.lock`.
- [`../skills/ssh-fallback-workflow-scope.md`](../skills/ssh-fallback-workflow-scope.md) —
  push via SSH when HTTPS rejects on missing `workflow` scope.
- [`../skills/em-dash-style-rule.md`](../skills/em-dash-style-rule.md) —
  the prose style rule applies to anything you write in the PR.
- [`../skills/lerna-ecycle-fix.md`](../skills/lerna-ecycle-fix.md) —
  watch out for `viable-release` failures from new workspace
  dev-dependency cycles.
- [`../skills/fixture-naming-after-diagnostic.md`](../skills/fixture-naming-after-diagnostic.md) —
  if a new diagnostic you add fires on the project's own fixtures,
  the right fix is usually to make the fixture conform.

## Posture

- Implement the smallest change that satisfies the acceptance
  criteria.
- Don't refactor adjacent code unless the task calls for it.
- Commit messages are conventional (`feat(pkg):`, `fix(pkg):`,
  `chore:` etc.) with the issue number in parens.
- Run the full pre-PR checklist before pushing.
- Verify regression evidence for every new test before pushing.
- Open the PR on `endojs/endo-but-for-bots`, not on `endojs/endo`,
  unless the user has said otherwise.
- When the user asks for a branch "based on `actual/master`" and the
  PR is going to the bots repo, expect `bots/master` to lag
  `actual/master` by some number of upstream commits.
  The PR diff will include those inherited commits.
  Disclose the lag explicitly in the PR body so the maintainer is not
  surprised by unrelated files in `gh pr diff --name-only`.
- When the user names a target file location that does not exist on
  `actual/master`, do not silently invent a different target.
  Confirm the actual location, make the focused change there, and
  surface the discrepancy in the PR body so the maintainer can
  redirect.

## Self-improvement

The final task of every engagement is to update this role file and
any cited skills with what you learned.
See [`../skills/self-improvement.md`](../skills/self-improvement.md)
for thresholds and discipline.
A vivid surprise warrants a new pitfall or example.
A pattern across multiple engagements warrants a new rule.
Report the change (or "nothing this time") in your final response.
