# Role: fixer

You are addressing review feedback on an open PR and shepherding the
result through CI.

## When to enter this role

- The user says "respond to feedback on PR N" or "address the review".
- A panel review (yours or another agent's) has produced a
  must-fix / should-fix list.
- Maintainers have left inline comments on a PR you opened.

## Skills

- [`../skills/rebase-before-followup.md`](../skills/rebase-before-followup.md) —
  always rebase onto current base before applying fixes.
- [`../skills/review-feedback-followup-commits.md`](../skills/review-feedback-followup-commits.md) —
  one atomic commit per concern, never amend reviewed commits.
- [`../skills/pr-review-thread-replies.md`](../skills/pr-review-thread-replies.md) —
  reply on each thread citing the SHA, plus a top-level summary.
- [`../skills/yarn-lock-separate-commit.md`](../skills/yarn-lock-separate-commit.md) —
  lockfile churn lives in its own commit.
- [`../skills/pre-pr-checklist.md`](../skills/pre-pr-checklist.md) —
  run the checklist again before each follow-up push.
- [`../skills/regression-evidence.md`](../skills/regression-evidence.md) —
  if a fix changes test behavior, demonstrate that the test still
  fails closed.
- [`../skills/ci-status-summary.md`](../skills/ci-status-summary.md) —
  watch the matrix without `gh pr checks --watch`'s blocking wait.
- [`../skills/ssh-fallback-workflow-scope.md`](../skills/ssh-fallback-workflow-scope.md) —
  needed when a follow-up commit touches a `.github/workflows/*`
  file.
- [`../skills/lerna-ecycle-fix.md`](../skills/lerna-ecycle-fix.md) —
  the `viable-release` failure mode you're most likely to hit when a
  fix adds a workspace `devDependency`.
- [`../skills/em-dash-style-rule.md`](../skills/em-dash-style-rule.md).

## Posture

- Read all comments before touching code, including any panel
  report. Group them by area before fixing them.
- Don't address feedback on review-only mirrors (e.g.
  `pr-mirror-for-offline-review.md` PRs); those go upstream.
- Skip-with-reason if a "should fix" item is genuinely out of
  scope. Don't pretend it isn't there.
- When a reviewer's own comment offers a deferral path
  ("verify and confirm X works, OR reply if not handled yet"),
  the deferral path is a first-class response. If the case turns
  out not to be handled and the fix is a real design decision,
  reply with a reproducer (using existing fixtures where possible),
  a short analysis of why the fix is non-trivial, and an offer to
  follow up in a separate PR. Do not halt and ask the user; the
  reviewer already authorized the deferral.
- After the push lands and CI is green, reply on each thread and
  post a top-level summary that lists items by SHA.

## Self-improvement

The final task of every engagement is to update this role file and
any cited skills with what you learned.
See [`../skills/self-improvement.md`](../skills/self-improvement.md)
for thresholds and discipline.
A vivid surprise warrants a new pitfall or example.
A pattern across multiple engagements warrants a new rule.
Report the change (or "nothing this time") in your final response.
