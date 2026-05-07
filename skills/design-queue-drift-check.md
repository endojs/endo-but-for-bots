# Design-queue drift check

Re-classify the `Spec'd-but-not-started` section of
`process/DESIGNS-WITHOUT-PR.md` so the marshal's eligibility filter
stops sending builders into walls.

## When to use

- The marshal returned a `needs-groom-first` outcome for the second
  cycle running.
- A builder dispatch surfaced a pre-flight impasse and the steward
  asks "is the rest of the queue similarly rotted?"
- A periodic mini-pass (cheaper than a full grooming pass) is due
  and the user has not asked for the velocity / roadmap rerun.

This is **a triage pass, not a full grooming pass**. It updates only
`process/DESIGNS-WITHOUT-PR.md`. The full velocity, roadmap, and
dependency-graph procedures from [`../roles/groom.md`](../roles/groom.md)
are explicitly skipped; those are a separate engagement.

## The two drift patterns

### Drift pattern A: design vs. later code refactor

The design's `Status: In Progress` (or "Done" sub-items) may have been
invalidated by a later commit that undid the design's premise.

Per [`../roles/builder.md`](../roles/builder.md)'s pre-flight rule:
walk the design's referenced packages and `git log --oneline -- <key
file>` from the design's `Updated` date forward. If a later refactor
reversed any "Done" sub-item or invalidated assumptions, the design
needs designer revision before a builder can act.

Reference example: `daemon-agent-network-identity.md` claims items 1
and 2 `*(Done)*` but commit `d0ce26b327 refactor(daemon): migrate to
SQLite, remove LOCAL_NODE and synced pet stores` (~3 weeks after the
design's last update) explicitly removed the `LOCAL_NODE` sentinel
those items introduced. The PR-99-builder dispatch surfaced this at
impasse cost.

### Drift pattern B: compose-A+B+C with unsatisfied deps

For designs that compose multiple capabilities, check the dependency
chain at the *phase* level, not just the `Status` field. A dependency
may be `In Progress` with an open PR but only ship Phase 1 of what the
dependent needs.

Reference example: `endoclaw-proactive-messages.md` depends on
`endoclaw-timer`. PR #40 ships only the Phase 1 host-side `onTick`
callback; the proactive design needs Phase 2 mail-delivered ticks
(explicitly deferred in the timer design's "Not yet implemented"
list). Surface-level Status check missed it.

## Procedure

1. **Stand on garden in a dedicated worktree.** Per
   [`./worktree-per-pr.md`](./worktree-per-pr.md):

   ```sh
   mkdir -p ~/endo-wt
   git worktree add --detach ~/endo-wt/groom-drift-check garden
   cd ~/endo-wt/groom-drift-check
   git fetch bots-ssh garden
   git checkout -B groom-drift-check bots-ssh/garden
   ```

   `--detach` first because the `garden` branch is held by the
   steward's seat (`~/garden` or a sibling).
   Then `checkout -B <local-name> bots-ssh/garden` gives a tracking
   branch that pushes back to garden. Use `git push bots-ssh
   HEAD:garden` to push into the remote `garden` ref without needing
   the local branch name to match.

2. **Read `process/DESIGNS-WITHOUT-PR.md`'s Spec'd-but-not-started
   section.** Note the snapshot timestamp; designs that acquired PRs
   since the snapshot must be removed first.

3. **Filter out designs that already have a PR.** For each entry,
   check the design's metadata (`Status: PR #N`) and grep for any
   open or merged PR matching the design slug:

   ```sh
   git ls-remote bots-ssh | grep -E "<slug-keywords>"
   gh pr list -R endojs/endo-but-for-bots --state all \
     --search "<slug-keywords>" --json number,state,title
   ```

   Move merged or in-flight entries to a "removed since snapshot"
   note in the file's intro paragraph; do not re-classify them.

4. **For each remaining design**, perform both drift checks. Keep
   the per-design analysis tight (1-3 sentences each); this is a
   triage pass, not a full design review.

   For drift pattern A:
   - Read the design's `## Status` section (if present) for sub-items
     marked "Done".
   - Identify the design's primary touched file(s) by scanning the
     design body for explicit file references plus any `Status: PR #N`
     cross-references.
   - `git log --oneline --since=<design-Updated-date> bots-ssh/llm --
     <file>` to spot post-design refactors that touch the same
     concept.
   - Sample a handful of files per design; do not exhaustively grep.

   For drift pattern B:
   - Read the design's `## Dependencies` / `## Depends On` section.
   - For each dependency, check its design file's Status and any
     in-flight PR's commit messages or PR body for which phase
     shipped.
   - If a dependency is `In Progress` with an open PR, the dependent
     design's pseudo-code may be calling an API the PR's actual
     implementation does not expose.

   Also flag **structural** misclassifications: a document framed as
   "ideas and directions" or as a parent index is not a single-PR
   target regardless of its `Status` field. Move it to
   `blocked-on-design-revision` (needs a focused sub-design extracted)
   or recommend moving it to the Aspirational/Reference group.

5. **Re-classify** each design into one of:

   - **eligible-for-builder**: both checks pass; marshal can dispatch
     a builder.
   - **blocked-on-design-revision**: drift A failed, OR the document
     is structurally an idea-bag / parent index. Needs designer (not
     builder) to reconcile design with current code or extract a
     focused sub-design.
   - **blocked-on-dependency**: drift B failed; needs the named
     dependency's actual phase to ship before the design is actionable.
   - **blocked-on-maintainer-decision**: the design has explicit open
     questions for the maintainer that the builder cannot guess.

6. **Restructure the section** with a sub-heading per classification,
   one-sentence "why" per design citing the offending commit SHA (drift
   A) or the unsatisfied phase (drift B). Bump the snapshot timestamp.

7. **Restate the eligibility ranking** at the bottom of the section,
   filtered to `eligible-for-builder` entries only and ranked by the
   prior groom's roadmap-priority signal (smaller surface area as a
   tiebreaker between equal-priority entries). The marshal previously
   had to skip past blocked designs; the new ranking is filtered.

8. **Append "Suggested follow-ups"** for each
   `blocked-on-design-revision` entry that needs a designer dispatch
   (so the steward sees them as candidates for the next cycle).

9. **Commit and push** per the groom's direct-push pattern (see
   [`../roles/groom.md`](../roles/groom.md)):

   ```sh
   GIT_AUTHOR_NAME="Kris Kowal" GIT_AUTHOR_EMAIL="kris@agoric.com" \
   GIT_COMMITTER_NAME="Kris Kowal" GIT_COMMITTER_EMAIL="kris@agoric.com" \
     git commit -m "process(groom): re-classify Spec'd-but-not-started with drift checks" \
     process/DESIGNS-WITHOUT-PR.md
   until git push bots-ssh HEAD:garden --force-with-lease; do
     git fetch bots-ssh garden && git rebase bots-ssh/garden
   done
   ```

10. **Cleanup** the worktree.

## Scope discipline

- Do not redesign or revise the design files themselves; this pass
  updates only `process/DESIGNS-WITHOUT-PR.md`.
- Do not dispatch builders or designers; the marshal will pick from
  your re-classified eligible list on the next cycle.
- Skip the velocity-recalibration / roadmap-projection /
  dependency-graph procedures from
  [`../roles/groom.md`](../roles/groom.md). Those are a separate
  full-grooming pass.
- Cap at ~30 minutes of work; if a design is genuinely ambiguous (could
  be drift B or could be eligible depending on how the dep's API
  actually shipped), classify as `blocked-on-maintainer-decision` and
  move on.

## Pitfalls

- **The `garden` branch is usually held by another worktree.** Use
  `git worktree add --detach <path> garden`, then immediately
  `git checkout -B <local-name> bots-ssh/garden` and push via
  `git push bots-ssh HEAD:garden`. A plain
  `git worktree add <path> garden` fails because two worktrees cannot
  share the same checked-out branch.
- **PR-acquired entries hide in the queue.** A snapshot dated days
  before the pass may list designs that acquired PRs since. Filter
  these out before classifying so the eligibility count is
  honest.
- **"Ideas and directions" documents are not the marshal's
  responsibility.** A document that says "pick one facet and write a
  focused design for it" is not implementable as one PR. Classify it
  `blocked-on-design-revision` and recommend it move to
  Aspirational/Reference.
- **The design's `Status: In Progress` lies in two directions.** It
  can lie low (work shipped, no one updated the field) and it can lie
  high (work undone by a refactor, no one updated the field). Drift A
  catches the second case; the cross-peer-gc resync follow-up in the
  prior groom's note catches the first.

## Session origin

Introduced 2026-05-06 after two consecutive builder dispatches
(`daemon-agent-network-identity` PR-99 follow-up and
`endoclaw-proactive-messages`) hit pre-flight impasses on drift A and
drift B respectively. The full grooming-pass procedure
([`../roles/groom.md`](../roles/groom.md)) does not include a
classification dimension for these failures; the marshal's eligibility
filter therefore kept dispatching against rotted entries. The
drift-check pass replaces the surface-level "Status is not In Progress
and Dependencies are Complete" check with the two-pattern check above.
