# Skills

Each file in this directory documents one self-contained technique that
proved load-bearing during a long PR-orchestration session against
`endojs/endo` and the `endojs/endo-but-for-bots` mirror.

The intent is reproducibility: if you came back six months from now,
each file should let you re-acquire the technique without re-deriving
the whole context.

## Index

### Git and worktree workflow

- [worktree-per-pr.md](./worktree-per-pr.md)
- [rebase-before-followup.md](./rebase-before-followup.md)
- [conflict-resolution.md](./conflict-resolution.md)
- [yarn-lock-separate-commit.md](./yarn-lock-separate-commit.md)
- [cherry-pick-followup.md](./cherry-pick-followup.md)
- [ssh-fallback-workflow-scope.md](./ssh-fallback-workflow-scope.md)

### PR review

- [panel-review-12-perspectives.md](./panel-review-12-perspectives.md)
- [pr-mirror-for-offline-review.md](./pr-mirror-for-offline-review.md)
- [review-feedback-followup-commits.md](./review-feedback-followup-commits.md)
- [pr-review-thread-replies.md](./pr-review-thread-replies.md)
- [regression-evidence.md](./regression-evidence.md)

### Subagent orchestration

- [subagent-batching.md](./subagent-batching.md)
- [autonomous-loop-pacing.md](./autonomous-loop-pacing.md)

### CI and quality

- [ci-status-summary.md](./ci-status-summary.md)
- [ci-runtime-comparison.md](./ci-runtime-comparison.md)
- [pre-pr-checklist.md](./pre-pr-checklist.md)
- [fixture-naming-after-diagnostic.md](./fixture-naming-after-diagnostic.md)
- [lerna-ecycle-fix.md](./lerna-ecycle-fix.md)

### Code archaeology

- [todo-link-classification.md](./todo-link-classification.md)
- [rebase-hygiene-audit.md](./rebase-hygiene-audit.md)
- [babel-visitor-exhaustiveness.md](./babel-visitor-exhaustiveness.md)
- [prompt-section-discovery.md](./prompt-section-discovery.md)

### Roadmap grooming

- [velocity-recalibration.md](./velocity-recalibration.md)
- [roadmap-projection.md](./roadmap-projection.md)
- [dependency-graph-maintenance.md](./dependency-graph-maintenance.md)
- [groom-open-questions.md](./groom-open-questions.md)

### Cross-cutting

- [self-improvement.md](./self-improvement.md) — every role's final
  task is to update its own role and skills with what it learned.
- [process-documents.md](./process-documents.md) — what counts as
  a process document, where it lives, and the isolation-commit
  rule that lets process commits drop cleanly when porting work
  upstream.

### Reporting

- [benchmark-comparative-report.md](./benchmark-comparative-report.md)
- [em-dash-style-rule.md](./em-dash-style-rule.md)
- [relative-paths-rule.md](./relative-paths-rule.md) — every link
  and path in a documentation file must be relative, never absolute.
