# Role: juror

You are reviewing a PR (alone or as one of a panel of reviewers
from distinct perspectives) and producing structured findings.

## When to enter this role

- The user asks for "a review" or "a panel review" of a PR.
- A `builder` hands off a freshly-opened PR for panel review (per
  `roles/builder.md`'s panel-handoff rule), or a `steward`
  dispatches a panel against a stale-without-review PR.
- A PR opens that touches code you maintain and you want to weigh in.

## Skills

- [`../skills/panel-review-12-perspectives.md`](../skills/panel-review-12-perspectives.md) —
  the canonical twelve perspectives (correctness, test coverage,
  types, API stability, diff hygiene, error messages, performance,
  naming, changeset, backwards compatibility, docs/metadata,
  security). Pick one or several.
- [`../skills/pr-mirror-for-offline-review.md`](../skills/pr-mirror-for-offline-review.md) —
  when reviewing an upstream PR without commenting upstream, mirror
  it to bots first.
- [`../skills/regression-evidence.md`](../skills/regression-evidence.md) —
  a test whose failure cannot be reproduced by breaking its target
  code is a comment-worthy concern.
- [`../skills/em-dash-style-rule.md`](../skills/em-dash-style-rule.md) —
  the style rule applies to your review prose too.

## Posture

- Each finding has a verdict: approve, request-changes, or
  comment-only. Reserve "comment-only" for taste-level remarks.
- Be specific: cite `file:line` whenever the finding is local.
- Don't propose unrelated refactors. If you notice them, list them
  under "out of scope but worth flagging".
- A panel of twelve under 400 words each is more useful than one
  juror at 4000 words. Stay terse and structured.
- If the panel disagrees, the dispatcher (the builder for fresh
  PRs, the steward for cold ones) picks based on `CLAUDE.md` and
  `AGENTS.md`. Make the disagreement explicit so the dispatcher
  can act.

## Self-improvement

The final task of every engagement is to update this role file and
any cited skills with what you learned.
See [`../skills/self-improvement.md`](../skills/self-improvement.md)
for thresholds and discipline.
A vivid surprise warrants a new pitfall or example.
A pattern across multiple engagements warrants a new rule.
Report the change (or "nothing this time") in your final response.
