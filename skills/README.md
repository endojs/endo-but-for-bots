# Skills

Each file in this directory documents one self-contained technique that
proved load-bearing during a long PR-orchestration session against
`endojs/endo` and the `endojs/endo-but-for-bots` mirror.

The intent is reproducibility: if you came back six months from now,
each file should let you re-acquire the technique without re-deriving
the whole context.

## Trigger-and-filter convention

The role / skill hierarchy is **trigger-broad at the parent,
filter-narrow at the child**:

- The role index in `CLAUDE.md` lists each role with one
  succinct trigger line. The line should be **slightly
  overbroad on purpose**: it casts a wide enough net that an
  agent skimming the index will follow the link in any
  plausibly-relevant case.
- Each role file then narrows: it states what *would not*
  warrant entering the role, and lists its skills with their
  own one-line triggers. Same overbroad-at-parent rule applies
  to the skill list.
- Each skill file is the deepest layer; it can be **specific
  and a little verbose** to filter out the false positives the
  parent's overbroad trigger let through.

Practical effect: a skill is allowed to lead with "Read this
when X" and "Skip this when Y" before any technique. A role's
skill list is allowed to read "[skill](./skill.md): when X
matches even loosely". The cost of an unnecessary read is small
compared to the cost of a missed match.

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
- [pr-cycle-state.md](./pr-cycle-state.md) — the two-file
  `process/` state pattern for a periodic queue-managing role
  whose context clears between cycles.

### CI and quality

- [ci-status-summary.md](./ci-status-summary.md)
- [ci-runtime-comparison.md](./ci-runtime-comparison.md)
- [pre-pr-checklist.md](./pre-pr-checklist.md)
- [fixture-naming-after-diagnostic.md](./fixture-naming-after-diagnostic.md)
- [lerna-ecycle-fix.md](./lerna-ecycle-fix.md)
- [coverage-driven-testing.md](./coverage-driven-testing.md) — run
  c8, write tests for reachable code, delete unreachable code.
- [adversarial-tests.md](./adversarial-tests.md) — the
  brainstorming list for invariant-attacking gotcha tests.

### Package-specific conventions

- [ses-intrinsic-naming.md](./ses-intrinsic-naming.md) — the
  `%Foo%` / `globalThis.Foo` / bare-`Foo` three-context rule
  for shared SES intrinsics. Read when working in
  `packages/ses/` (the package has a scoped `CLAUDE.md`
  pointing here).
- [surface-module-pattern.md](./surface-module-pattern.md) — a
  package's public API lives in physical surface modules at the
  package root (`packages/<pkg>/<name>.js`), not under `src/`.
  Each surface module re-exports the public subset and masks
  test-only helpers. Read when adding to a package's `exports`
  map, or when a maintainer review asks for a "physical
  `./<name>.js`".

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
- [design-queue-drift-check.md](./design-queue-drift-check.md) — the
  triage-pass procedure that re-classifies
  `process/DESIGNS-WITHOUT-PR.md`'s Spec'd-but-not-started entries by
  drift-pattern A (design vs. later code refactor) and drift-pattern B
  (compose-pattern with unsatisfied phase dependency) so the marshal's
  eligibility filter stops sending builders into walls.

### Cross-cutting

- [self-improvement.md](./self-improvement.md) — every role's final
  task is to update its own role and skills with what it learned.
- [process-documents.md](./process-documents.md) — what counts as
  a process document, where it lives, and the isolation-commit
  rule that lets process commits drop cleanly when porting work
  upstream.
- [no-backward-compat-stage.md](./no-backward-compat-stage.md) —
  daemon / familiar / chat do not preserve backward compatibility
  at this stage of the project. Rename / remove freely, update
  in-tree call sites in the same PR, do not add deprecation
  shims. Other `@endo/*` packages remain semver-stable.

### Reporting

- [benchmark-comparative-report.md](./benchmark-comparative-report.md)
- [em-dash-style-rule.md](./em-dash-style-rule.md)
- [relative-paths-rule.md](./relative-paths-rule.md) — every link
  and path in a documentation file must be relative, never absolute.
