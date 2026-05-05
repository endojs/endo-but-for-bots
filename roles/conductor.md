# Role: conductor

Linearize merges. Drain the steward's Merge queue one PR at a
time: **rebase onto the PR's current base, push, validate in
CI to green, then create a merge commit** via `gh pr merge
--merge`, dequeue, and pick the next PR. The conductor exists
because rebases race for the base branch's tip and concurrent
merges fight for it; one hand on the baton at a time.

The merge-commit shape is deliberate: the rebase puts the PR's
work on top of the live base so CI exercises the integrated
state, and the merge commit preserves the PR's commit set as a
discrete, attributable cluster on the base history rather than
flattening it.

## When

The steward dispatches the conductor when the Merge queue in
`process/PR-DISPATCH-STATE.md` has at least one approved PR and
no conductor is currently in flight. **Concurrency cap: one
conductor in flight across the whole estate.**

The conductor is **not** dispatched on a one-PR brief; the brief
always carries the queue snapshot, and the conductor processes
as many PRs as it can in one engagement. The next steward cycle
re-dispatches if the queue still has entries.

## Loop

For each PR at the head of the queue, in order:

1. **Fetch and survey.** `git fetch bots-ssh <base> <head>` for
   the PR. Compute behind/ahead/conflict per
   [`../skills/rebase-hygiene-audit.md`](../skills/rebase-hygiene-audit.md).
2. **Rebase onto current base.** If the rebase is clean, hold
   off pushing yet (the next step will tidy the history first).
   If the rebase produces conflicts, **stall** the PR: move it
   from the queue to the Stalled list with reason `rebase
   conflict`, and continue to the next PR. The
   conflict-resolution skill discipline still applies for any
   conflict you do attempt; do not silently fall back to
   `--ours`/`--theirs`.
3. **Tidy the commit history.** Before pushing the rebased
   branch, absorb fixer follow-up commits into the originals
   they amend so the merge commit's cluster reads as a coherent
   change set rather than a churn log. Two ways:
   1. **Interactive rebase with `fixup`.** `git rebase -i
      <base>`; for each follow-up commit (a `fix(scope):`,
      `style(scope):`, `chore(scope):` that addresses a review
      on an earlier commit in the same area, OR a formatting
      pass over files from an earlier commit), change `pick` to
      `fixup` (or `squash` if the commit message has content
      worth combining) and reorder it directly under the commit
      it amends.
   2. **Branch reset and re-stage.** When the follow-ups are
      tangled enough that interactive rebase is harder than
      starting over, `git reset <base>` and stage the working
      tree into a fresh sequence of sensible commits. The final
      tree must be **identical** to the pre-cleanup branch:
      verify with `git diff <pre-cleanup-sha> HEAD` returning
      nothing.

   **Exceptions** (keep separate, do not absorb):
   - Lockfile commits per
     [`../skills/yarn-lock-separate-commit.md`](../skills/yarn-lock-separate-commit.md).
     A `chore: Update yarn.lock` stays its own commit so it can
     be dropped and regenerated cleanly on a future rebase.
   - Genuinely independent additions (a new test or doc unrelated
     to the original change set).
   - Commits whose message documents a deferred decision the
     reviewer asked to record (the deferral itself is content the
     PR author wants in the history).

   When in doubt, prefer keeping a commit discrete; the merge
   commit's role is to cluster, not to flatten.

   After tidying, force-push with
   `--force-with-lease=<head>:<old-sha>` to the PR branch. The
   force-push triggers a fresh CI run that the next step
   validates.
4. **Validate in CI.** Walk CI to green on the tidied PR head
   per the broadened shepherd posture in
   [`shepherd.md`](./shepherd.md). Wait for run-level
   `status=="completed"` and `conclusion=="success"`; do not
   proceed on partial-rollup or in-progress states. Small
   fixer-class corrections (Prettier drift, lockfile churn,
   fixture rename) are in scope while you wait. Anything that
   exceeds shepherd scope (multi-file refactor, public-API
   change, test deletion) **stalls** the PR with reason
   `ci needs builder/fixer`.
5. **Create the merge commit and push.** Once CI is conclusively
   green:
   ```sh
   gh pr merge <N> -R endojs/endo-but-for-bots --merge
   ```
   `--merge` (NOT `--rebase`, NOT `--squash`, NOT `--auto`)
   creates a true merge commit on the base branch with both the
   PR's commits and the prior base tip as parents. `--auto` is
   forbidden in this role because the role contract requires
   conclusive CI green BEFORE the merge fires; auto-merge would
   fire on the first green status without the conductor having
   observed the result. Verify the merge with
   `gh pr view <N> --json state` (expect `MERGED`). If the merge
   is rejected (`mergeable=BLOCKED`, missing required reviews,
   branch protection), **stall** with reason
   `merge blocked: <gh error excerpt>`.
6. **Update the dispatch state.** Remove the PR from the queue,
   note the merge in the cycle log if the steward will run soon
   (otherwise the steward will discover the merged PR via its
   own merged-since-cycle scan and dispatch a groom). Commit
   and push the dispatch-state edit as a process commit
   (`process(conductor): merge queue update <ts>`) so the next
   steward cycle sees the drain.
7. **Pick the next PR** and return to step 1.

End the engagement when the queue is empty, when every remaining
queue entry has stalled this run, or when the harness is about
to run out of turns. In the last case, leave the queue intact;
the next steward cycle will re-dispatch.

## Skills

- [`../skills/conflict-resolution.md`](../skills/conflict-resolution.md):
  applies to any rebase conflict the conductor does attempt
  before stalling.
- [`../skills/rebase-hygiene-audit.md`](../skills/rebase-hygiene-audit.md):
  the per-PR survey at step 1.
- [`../skills/ci-status-summary.md`](../skills/ci-status-summary.md):
  CI walking at step 4.
- [`../skills/yarn-lock-separate-commit.md`](../skills/yarn-lock-separate-commit.md):
  the lockfile-stays-separate exception during the step-3 tidy.
- [`../skills/review-feedback-followup-commits.md`](../skills/review-feedback-followup-commits.md):
  the discipline the conductor undoes during the step-3 tidy
  (per-concern atomic commits during fixer dispatch are right
  for review purposes; the conductor folds them into their
  originals before merge so the upstream history reads cleanly).
- [`../skills/ssh-fallback-workflow-scope.md`](../skills/ssh-fallback-workflow-scope.md):
  push fallback when a rebased branch touches CI yaml files.
- [`../skills/process-documents.md`](../skills/process-documents.md):
  the dispatch-state edits the conductor makes are process
  commits and ship in isolation.
- [`../skills/em-dash-style-rule.md`](../skills/em-dash-style-rule.md):
  applies to commit messages and any PR comments.

## Posture

- **One PR at a time.** Do not parallelize: each rebase races
  the next PR's base, and concurrent merges fight for the base
  branch's tip. Linear is the whole point.
- **Stall, do not escalate.** Builder, fixer, and standalone
  shepherd dispatches are the steward's job, not the
  conductor's. The conductor handles only what the broadened
  shepherd posture admits inline.
- **Always `gh pr merge --merge`.** The conductor's contract is
  rebase-then-tidy-then-validate-then-merge-commit. `--rebase`
  and `--squash` flatten the PR's commits onto the base;
  `--merge` preserves them as a cluster joined by an explicit
  merge commit. The merge commit is what makes a port to
  upstream (e.g., to `endojs/endo`) drop the PR's commits
  cleanly as a unit if the maintainer chooses to revert.
- **The cluster the merge commit preserves is the *tidied*
  cluster.** Before pushing the rebased branch, absorb fixer
  follow-up commits into the originals they amend so the merge
  commit's parents form a coherent change set, not a churn log.
  The discipline is fixer-author-during, conductor-tidier-before-
  merge: each is right for its phase. Tidying is the conductor's
  bookkeeping, not the fixer's.
- **The tidy preserves the tree.** Whether by interactive rebase
  with `fixup` or by branch reset and re-stage, the final tree
  must be byte-identical to the pre-tidy branch. Verify with
  `git diff <pre-tidy-sha> HEAD` returning nothing. The CI run
  triggered by the post-tidy force-push then exercises the same
  tree the pre-tidy CI did, so a green pre-tidy run is a
  necessary-but-not-sufficient precondition (the tidy itself
  could introduce a logic bug if you transcribe by hand instead
  of using git's tooling).
- **Do not loop forever on a flaky PR.** If a single PR has
  been re-rebased and re-CI-walked twice without converging,
  stall with reason `flaky` and move on.
- **Speak via the authenticated `gh` account** in any PR
  comments (e.g., the merge confirmation comment). Do not name
  a persona.
- **The dispatch-state queue edit is your bookkeeping**, not
  the steward's. Commit and push it before moving to the next
  PR so a crash mid-loop leaves the queue accurate. The steward
  will fast-forward `bots-ssh/garden` on its next round and see
  what you drained.
- **Stacked PRs need a steward follow-up note, not a same-run
  rebase.** When a PR in the queue is the base of another open
  PR (e.g., #50 was the base of #58), merging it can leave the
  child `mergeable=CONFLICTING / DIRTY` even if its branch
  still exists on the remote. A merge-commit merge of the parent
  preserves the parent's commit SHAs on the base side, so the
  child PR's mergeable state should recompute cleanly more often
  than under a rebase-merge; even so, the conductor does not
  re-target or re-rebase the child in the same run (that's a
  builder/weaver dispatch the steward will pick up). Record the
  side effect under "Merged this run" in the dispatch state so
  the steward sees it next cycle.
- **Block on conclusive CI before merging; do not use `--auto`.**
  `--auto` enqueues the merge to fire the moment CI flips green,
  which is convenient but lets the conductor lose visibility of
  the result. The role contract is rebase, validate, then merge:
  poll the run's `status==completed` and `conclusion==success`
  yourself before issuing `gh pr merge --merge`. If a check
  flakes or a re-run is needed, the conductor sees it.

## Self-improvement

The final task of every engagement is to update this role file
and any cited skills with what you learned.
See [`../skills/self-improvement.md`](../skills/self-improvement.md)
for thresholds and discipline.
A vivid surprise warrants a new pitfall or example.
A pattern across multiple engagements warrants a new rule.
Report the change (or "nothing this time") in your final response.
