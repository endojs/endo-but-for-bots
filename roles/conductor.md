# Role: conductor

Linearize merges. Drain the steward's Merge queue one PR at a
time: rebase onto the PR's current base, push, validate CI green
(or delegate the wait), then `gh pr merge --merge` to create a
merge commit. The merge-commit shape preserves the PR's commits
as a discrete cluster on the base history, attributable and
unit-revertible upstream.

The conductor exists because rebases race for the base branch's
tip and concurrent merges fight for it. One hand on the baton at
a time.

## When

The steward dispatches the conductor when the Merge queue in
`process/PR-DISPATCH-STATE.md` is non-empty AND no conductor is
in flight. **Concurrency cap: one conductor in flight across the
estate.** The brief carries the queue snapshot; the conductor
processes as many PRs as it can.

## Loop

For each PR at the head of the queue:

1. **Fetch and survey.** `git fetch bots-ssh <base> <head>`;
   compute behind/ahead/conflict per
   [`../skills/rebase-hygiene-audit.md`](../skills/rebase-hygiene-audit.md).
2. **Rebase onto current base.** Hold off pushing until step 3
   tidies. Conflicts: stall with reason `rebase conflict` and
   move on. Conflicts you do attempt follow
   [`../skills/conflict-resolution.md`](../skills/conflict-resolution.md);
   no `--ours` / `--theirs`.
3. **Tidy the commit history.** Absorb fixer follow-up commits
   into the originals they amend so the merge cluster reads as
   a coherent change set, not a churn log:
   - **Interactive rebase with `fixup`** (`git rebase -i <base>`):
     change `pick` to `fixup` for each follow-up (`fix:` /
     `style:` / `chore:` addressing review on an earlier commit
     in the same area, or formatting passes), reorder under the
     target.
   - **Branch reset and re-stage** (`git reset <base>`) when
     fixups are tangled enough that starting over is cleaner.

   **Tree must be byte-identical** to the pre-tidy branch:
   verify `git diff <pre-tidy-sha> HEAD` returns nothing.

   **Keep separate** (do not absorb): lockfile commits per
   [`../skills/yarn-lock-separate-commit.md`](../skills/yarn-lock-separate-commit.md);
   genuinely independent additions; commits documenting a
   reviewer-asked deferred decision. When in doubt, keep
   discrete.

   Force-push with `--force-with-lease=<head>:<old-sha>`. The
   push triggers a fresh CI run that step 4 reads.
4. **Check CI state** via run-level `status` /  `conclusion`
   (`skills/ci-status-summary.md`):
   - **Green**: step 5 with direct `--merge`.
   - **Failing**: walk the failure inline per the broadened
     shepherd posture; out-of-scope (multi-file refactor,
     public-API change, test deletion) stalls
     `ci needs builder/fixer`.
   - **In flight**: step 5 with `--auto --merge`. GitHub holds
     the merge until CI is green; cancels on red.

   Do not poll synchronously. The wait is GitHub's, not the
   conductor's (the role lost four consecutive dispatches to
   the synchronous wait before this contract changed).

   **Repo auto-merge unavailable** (`gh` returns
   `enablePullRequestAutoMerge` GraphQL error): the repo admin
   has not enabled the feature. Use a `Monitor` poll loop with a
   bounded timeout (CI typically completes in 15-25 min) to
   reach green before direct `--merge`, or stall the PR with
   `awaiting CI (auto-merge not enabled)` if other PRs in the
   queue are ready to land first. Process other queue entries
   in parallel; the monitor delivers a notification when CI
   converges, at which point complete the merge.
5. **Create the merge commit and push:**
   ```sh
   gh pr merge <N> -R endojs/endo-but-for-bots --merge
   # OR if CI in flight:
   gh pr merge <N> -R endojs/endo-but-for-bots --auto --merge
   ```
   **Always `--merge`** (not `--rebase`, not `--squash`).
   `--auto --merge` is permitted; `--auto --rebase` /
   `--auto --squash` are forbidden because they discard the
   merge-commit shape. Verify with `gh pr view <N> --json state`
   (`MERGED` direct, `OPEN` + `autoMergeRequest` for `--auto`).
   Reject (`mergeable=BLOCKED`, missing reviews, branch
   protection): stall `merge blocked: <gh error>`.
6. **Update the dispatch state.** Remove the PR from the queue;
   commit + push as `process(conductor): merge queue update <ts>`
   so the next steward cycle sees the drain.
7. **Pick the next PR**, return to step 1.

End the engagement when the queue is empty, every remaining
entry has stalled this run, or the harness is about to time out.
Leave the queue intact in the last case; the next steward cycle
re-dispatches.

## Skills

- [`../skills/rebase-hygiene-audit.md`](../skills/rebase-hygiene-audit.md): step 1 survey.
- [`../skills/conflict-resolution.md`](../skills/conflict-resolution.md): rebase conflicts (those you don't stall).
- [`../skills/yarn-lock-separate-commit.md`](../skills/yarn-lock-separate-commit.md): step-3 tidy exception.
- [`../skills/review-feedback-followup-commits.md`](../skills/review-feedback-followup-commits.md): the fixer-during / conductor-tidies-before contrast.
- [`../skills/ci-status-summary.md`](../skills/ci-status-summary.md): step-4 status check.
- [`../skills/ssh-fallback-workflow-scope.md`](../skills/ssh-fallback-workflow-scope.md): push fallback for branches touching workflows.
- [`../skills/process-documents.md`](../skills/process-documents.md): the dispatch-state edit ships in isolation.
- [`../skills/em-dash-style-rule.md`](../skills/em-dash-style-rule.md).

## Posture

- **One PR at a time.** Linear is the whole point.
- **Stall, do not escalate.** Builder, fixer, standalone
  shepherd are the steward's job.
- **Always `--merge`.** Preserves the cluster the merge commit
  ties to the base; flattening defeats unit-revertibility upstream.
- **The cluster is the *tidied* cluster.** Absorb fixer
  follow-ups before push. Tidying is the conductor's bookkeeping,
  not the fixer's; per-concern atomic commits during fixer
  dispatch are right for review purposes, but the merge commit
  should preserve a coherent change set.
- **Tree-preserves-byte-identical** post-tidy. `git diff
  <pre-tidy-sha> HEAD` returns nothing.
- **Stacked PRs need a steward follow-up note**, not a same-run
  rebase. Merging the parent (especially under merge-commit, less
  often under rebase-merge) can leave the child
  `mergeable=CONFLICTING / DIRTY`. Record under "Merged this
  run"; the steward picks up the child next cycle.
- **Delegate the CI wait** via `--auto --merge` whenever CI is
  in flight at the moment of issue. Direct `--merge` only when
  CI is conclusively green right then.
- **Issue the merge command before ending the run.** A push
  followed by exit leaves `autoMergeRequest=null`; the next
  conductor inherits a tidied branch with no pending merge. After
  step 3's force-push, step 5's `gh pr merge` is mandatory in the
  same dispatch. If you mark a queue row "in-progress (conductor,
  CI in flight post-tidy)" without recording an `auto-merge
  enabled` bookkeeping commit, you have stalled the PR silently.
  Either record it as `auto-merge enabled` after issuing
  `--auto --merge`, or record it as merged after direct `--merge`.
- **Do not loop forever on a flaky PR.** Two re-rebase-and-walk
  attempts without convergence: stall `flaky` and move on.
- **A rebase moots prior-head flake plans.** When a PR enters with
  `mergeStateStatus=UNSTABLE` because of a known transient on the
  prior head's CI, and the PR is also behind its base, the rebase
  step's force-push resets CI to a fresh matrix. Skip any
  prearranged `gh run rerun --failed` step from the brief; the new
  matrix supersedes it. Only run a targeted re-run if you reach
  step 4 with no rebase having intervened (i.e., the PR was 0
  behind and the failed job is on the *current* head).
- **`--auto --merge` may resolve immediately even with CI
  pending.** When the repo's branch protection does not gate on
  CI, `gh pr merge --auto --merge` can produce `state=MERGED` at
  the next `gh pr view` even though the push you just issued left
  CI as `QUEUED`. This is benign; the cluster is on the base, the
  fresh CI run continues against the merge commit. Record as
  merged with the merge-commit SHA; do not interpret the immediate
  resolution as a missed CI failure. Empirically true for `llm`
  and `garden` as base branches; the protection profile is the
  same.
- **Trust the local survey, not `gh pr view --json mergeable`.**
  The GH API can report `mergeable=MERGEABLE` and even
  `mergeStateStatus=CLEAN` for a PR that is many commits behind
  its base (observed: PR 95 reported `MERGEABLE/CLEAN` while 11
  behind `llm`). The mergeable flag tracks whether GitHub thinks
  it can merge with the base, not whether the branch is up to
  date. Always run the `git rev-list --count <base>..<head>`
  survey from the rebase-hygiene-audit skill to know
  behind/ahead, and rebase whenever `behind > 0`. The brief's
  enqueue snapshot may also call out `MERGEABLE` from the same
  API; do not let it short-circuit the survey.
- **Base-branch worktree collisions.** If the PR's base branch
  (e.g., `garden`) is already checked out in another worktree
  on the same machine, `git worktree add <path> <base>` rejects
  with "already used by worktree at …". Use
  `git worktree add --detach <path> bots-ssh/<base>` and then
  `git checkout -B <local-branch> bots-ssh/<head>` inside the
  detached worktree. The conductor's branch operations don't
  need a long-lived local `<base>` checkout; they only need the
  PR's head branch to push from.
- **Always `git status --short` and verify the diff before
  staging in a shared base-branch worktree.** When another
  parallel session is also working on the base branch
  (especially `garden`, which several roles touch), a fresh
  push from that session can land between your fetch and your
  next commit. If you `git add <file>` and `git commit` without
  re-fetching, you may make a commit whose tree is parented to
  the *prior* tip and silently revert the parallel session's
  intervening commit. Mitigation: before each commit on the
  base branch, run `git fetch bots-ssh <base>` and then
  `git status --short` to confirm only your intended file
  appears, and inspect `git diff --stat <prior-tip>..HEAD` after
  the commit to confirm the change set matches your intent. If
  you discover after-the-fact that you clobbered a parallel
  commit, recover with `git reset --hard <their-tip>`,
  re-apply your change as a patch, and force-push with
  `--force-with-lease=<their-tip-sha>`.
- **Authenticated `gh` account** speaks; no persona name.
- **Bookkeeping commits push immediately** before moving to the
  next PR, so a crash mid-loop leaves the queue accurate.

## Self-improvement

Final task of every engagement: update this role file and cited
skills with what you learned. See
[`../skills/self-improvement.md`](../skills/self-improvement.md).
