# Defer stacking when the foundation PR is in flight

## When to use

A maintainer directs you to reframe PR `<N>` to layer on top of PR
`<F>` ("most of the implementation belongs in `<F>`'s package").
Before reconstructing PR `<N>` on top of PR `<F>`'s head, check
whether PR `<F>` is itself mid-reshape.
If it is, defer the reconstruction and post the plan instead.

## Why

Reconstructing PR `<N>` on a PR `<F>` head that is about to be
force-pushed wastes the reconstruction work and creates a race:
the foundation rebases under you, your stacked branch loses its
parent commits, and either you re-rebase (costly) or worse you
push a branch that no longer reflects the maintainer's intent.

The correct order is:

1. PR `<F>` reshapes to its final shape and lands or stabilises.
2. PR `<N>` reconstructs on the now-stable foundation.

## How to detect "in flight"

Check three signals on PR `<F>`:

```sh
gh pr view <F> -R <repo> --json reviewDecision,mergeStateStatus
gh api "repos/<repo>/pulls/<F>/reviews" \
  --jq '.[] | select(.submitted_at > "<recent-cutoff>") | {state, user: .user.login, submitted_at}'
gh api "repos/<repo>/pulls/<F>/comments" \
  --jq '[.[] | select(.created_at > "<recent-cutoff>")] | length'
```

**In flight** if any of:

- `reviewDecision: CHANGES_REQUESTED` from a maintainer in the last
  few hours.
- A burst of inline review comments on the surface PR `<N>` will
  layer on (e.g., the very interfaces you would import).
- The maintainer's recent comments propose renames or interface
  changes (these will rebase under you).

## What to do when deferred

Post a top-level reconstruction plan comment on PR `<N>` covering:

1. **Strategy paragraph**: explicitly name which strategy
   (defer-then-reconstruct vs reconstruct-on-current-tip) and why.
2. **What moves**: a per-file table mapping the current PR `<N>`
   diff to "moves to `<F>`'s package" vs "stays in originating
   package". Include line counts so the maintainer sees the
   magnitude.
3. **Namer-consult renames**: a `current → proposed` table with the
   rationale citing namer's three laws / system laws. Cross-check
   against renames the maintainer has already applied to PR `<F>`
   (e.g., if PR `<F>` spelled `temporaryDirectory`, PR `<N>` should
   not introduce `tmpDir`).
4. **Reconstruction shape**: a numbered commit sequence for the
   eventual reconstruction dispatch. Include the base-branch change
   if applicable.
5. **Saboteur-must-fix mapping**: how each must-fix from the
   pre-existing panel review on PR `<N>` either survives, evaporates,
   or moves with the file relocations.

## Pitfalls

- **Do not push the reconstruction**. The whole point of deferring
  is to avoid the race. The plan comment is the deliverable; the
  next dispatch (after PR `<F>` lands) executes.
- **Do not change the PR base yet**. Changing the base while PR
  `<F>` is still mutating means GitHub re-computes the diff against
  a moving target. Defer base change until PR `<F>` stabilises.
- **Do read the maintainer's in-flight feedback on PR `<F>`** before
  drafting the plan. The feedback typically reveals the final shape
  (rename targets, surface collapses) that PR `<N>` should anticipate.
  Skipping this leads to a plan that reconstructs against PR `<F>`'s
  current state, not its destination.
- **Reply path is a top-level PR comment** when the maintainer's
  directive was itself a top-level conversation comment. Do not
  attempt to reply via the inline-review API (the path differs).

## Session example

PR 135 (`feat/mount-core`) received directive
`comment-4402324272` at 2026-05-08T01:00Z to layer on top of PR 122
(`feat/platform-fs`). PR 122 was simultaneously
`CHANGES_REQUESTED` (kriskowal review at 00:56Z) with four reshape
directives:

- Rename `EndoMount` to `EndoMountDirectory`.
- Add cap-std style symlink confinement on the platform `Directory`.
- Split `remove`/`removeTree` rather than carry a recursive option.
- Collapse `asDirectory` because mount points and platform
  directories should implement the same interface.

All four directives change the surface PR 135 was meant to layer
on. The dispatch deferred reconstruction and posted the plan as
`comment-4402359192`, mapping each PR 135 file to "moves to
`@endo/platform`" vs "stays in daemon" and proposing renames
matching PR 122's already-applied conventions
(`tmpDir → temporaryDirectory`, `opts → options`, `Fn → Function`,
`Dir → Directory`).

PR 127 (`feat/mount-extensions`) received the same directive
five minutes later (`pullrequestreview-4248713053` at 01:05Z).
PR 127 layers features (revocation, deny patterns, glob, grep,
stat, JSON helpers) on top of the same Mount surface PR 135
covers, so the dispatch posted plan `comment-4402419055` that
defers to **both** PR 122 and PR 135.
The reconstruction order becomes a chain:
PR 122 lands or stabilises, then PR 135 reconstructs on PR 122,
then PR 127 reconstructs on PR 135.
The PR 127 plan added a "Coordination with PR 135" section that
explicitly numbered the chain so the maintainer could see the
dependency.
**When two stacked PRs receive the same defer directive, each
plan should reference the other** so the eventual reconstruction
dispatch knows the full dependency order rather than treating
each PR in isolation.
Without this cross-reference, the post-PR-122 dispatch could
reconstruct PR 127 directly on PR 122 and re-introduce the
capability-VFS adapter that PR 135 was supposed to host, causing
a duplicate that PR 135's own reconstruction would then fight.

## Skills

- [`worktree-per-pr.md`](./worktree-per-pr.md) — the in-flight PR's
  worktree may exist; use `git worktree list` to check before
  creating a new one.
- [`rebase-before-followup.md`](./rebase-before-followup.md) — the
  follow-up dispatch (after PR `<F>` lands) follows this pattern,
  with the additional base-branch-change step.
- [`pr-review-thread-replies.md`](./pr-review-thread-replies.md) —
  for distinguishing top-level vs inline-review reply paths.
