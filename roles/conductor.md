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
   - **Green**: step 5 with direct `--merge`. (Documented
     pre-existing infra failures like `build-wasm` drift on
     a sibling-PR commit do not count as red for this gate;
     see the shepherd's recurring-patterns notes for the
     known list.)
   - **Failing**: do NOT merge.
     Per the canonical flow in [`./README.md`](./README.md),
     an approved-but-red PR's correct next dispatch is a
     **shepherd**, not a conductor merge.
     Stall with reason `ci red: needs shepherd` and surface
     to the steward so the next cycle can dispatch a
     shepherd; in-scope chain-fixes the conductor itself can
     do per the broadened shepherd posture are still
     acceptable, but the merge waits until CI is green.
     Out-of-scope (multi-file refactor, public-API change,
     test deletion) stalls `ci needs builder/fixer`.
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
6. **Clean up the PR's worktree and branches.** Per
   [`../skills/worktree-per-pr.md`](../skills/worktree-per-pr.md),
   the builder/fixer have been working in
   `~/endo-wt/pr-<N>` and on branch `<head-ref-name>`.
   After the merge lands, both are dead weight. Cleanup is the
   conductor's responsibility:
   ```sh
   cd ~/garden  # leave any conductor worktree first
   N=<PR-number>
   BRANCH=<head-ref-name>
   WT=~/endo-wt/pr-${N}
   [ -d "$WT" ] && git worktree remove "$WT"
   git branch -D "$BRANCH" 2>/dev/null || true
   gh api -X DELETE \
     "repos/endojs/endo-but-for-bots/git/refs/heads/$BRANCH" 2>/dev/null \
     || true
   ```
   `gh pr merge --merge --delete-branch` deletes the remote
   branch automatically; the local worktree and local branch
   need explicit cleanup either way.
7. **Update the dispatch state.** Remove the PR from the queue;
   commit + push as `process(conductor): merge queue update <ts>`
   so the next steward cycle sees the drain.
   If the merge unblocks downstream PRs (e.g., a fix that other
   PRs were waiting to rebase onto), record the unblocked PR
   numbers in the dispatch-state entry so the **steward** can
   fan out the weaver / shepherd follow-ups in the next cycle.
   The conductor does NOT dispatch those follow-ups itself: the
   conductor's tool surface may not include `Agent`, and the
   one-conductor-at-a-time concurrency cap means follow-up
   dispatches naturally belong to the steward's per-cycle
   coordinator role.
   Encountered on PR #167 (2026-05-10): the brief asked the
   conductor to dispatch two weavers in parallel after the merge;
   the conductor reported back that `Agent` was not in its
   exposed deferred-tool set and recorded the briefs in
   dispatch-state instead, which the steward then dispatched
   from the parent loop.

   **Conductor briefs MUST verify CI is green BEFORE dispatch;
   "wait for CI" reduces to armed-and-flee.** The conductor's
   session-bounded Monitor task dies when the conductor exits.
   A brief that says "wait for CI to converge then merge" sees
   the conductor poll once, see PENDING, end the engagement, and
   the merge never happens. The steward must verify
   `gh pr view <N> --json statusCheckRollup` returns all-green
   BEFORE dispatching the conductor; if CI isn't green, arm a
   parent-context Monitor first and dispatch the conductor only
   from the Monitor's convergence event.
   Encountered on PR #140 (2026-05-10): consolidation push
   restarted CI; conductor brief said "wait for CI to converge
   then merge"; the conductor armed a Monitor and ended within
   ~50 seconds. The steward had to arm a parent Monitor and
   re-dispatch the conductor on convergence. Pre-conductor CI
   verification is the steward's job, not the conductor's.
8. **Pick the next PR**, return to step 1.

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
- [`../skills/worktree-per-pr.md`](../skills/worktree-per-pr.md): step-6 cleanup of the merged PR's worktree and branches.
- [`../skills/em-dash-style-rule.md`](../skills/em-dash-style-rule.md).

## Posture

- **One PR at a time.** Linear is the whole point.
- **Only merge CI-green PRs.** Per the canonical flow in
  [`./README.md`](./README.md) and per maintainer directive on
  PR #157: the conductor only merges PRs whose `gh pr checks` is
  green at merge time (excluding documented pre-existing infra
  failures the shepherd's notes call out, e.g. `build-wasm`
  drift on a sibling-PR commit).
  An APPROVED PR with red CI is not a merge candidate; it is a
  shepherd dispatch.
  Stall such PRs with `ci red: needs shepherd` and let the
  steward dispatch a shepherd next cycle.
  The conductor never short-circuits the shepherd by merging
  red.
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
- **Arming a Monitor is not the same as issuing the merge.** A
  Monitor watches; it does not merge. If you find yourself ending
  a dispatch with "let the monitor wait" and no `gh pr merge`
  command issued, you have stalled silently. The PR sits at
  `state=OPEN`, `autoMergeRequest=null`, and the steward has to
  notice and issue the merge as a fallback (this happened on
  PR 94 → conductor stalled after rebasing). Verify before
  reporting: `gh pr view <N> --json state,autoMergeRequest`
  must show either `state=MERGED` or `autoMergeRequest != null`.
  If neither: you have not done the merge.
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
- **A rebase also moots a brief's "direct `--merge`" claim.** When
  the brief reports `27/27 CI SUCCESS` and instructs a direct
  `--merge` (no `--auto`), but the survey shows the PR is behind
  its base, the rebase + force-push invalidates the prior matrix.
  The fresh CI is in flight at the moment of merge issue, so step
  4's "in flight → `--auto --merge`" branch applies. Use
  `--auto --merge`; do not re-read the brief's "CI green, no need
  for `--auto`" guidance literally once you've performed the rebase
  step. (The `--auto --merge` path is a strict superset of `--merge`:
  if branch protection does not gate on CI, GitHub resolves it
  immediately as a direct merge anyway. See the immediately-resolves
  bullet below.)
- **A tidy can require rewording the absorbed-into commit, not just
  fixing it up.** When a `fix(...)` follow-up's body contradicts a
  caveat in the original commit's message ("transitively-referenced
  blobs ... out of scope for this cut and tracked as a follow-up"
  vs. an absorbed-in commit that implements the transitive sweep),
  a plain `fixup` carries the stale caveat into the merge cluster
  unchanged. Use `reword` (or a follow-up `git commit --amend` while
  HEAD is on the absorbed-target) to bring the message in line with
  the absorbed code. The byte-identical-tree check still applies;
  only the message changes. Pre-tidy SHA recorded before the reword,
  not just before the initial fixup, so the diff comparison spans
  both edits.
- **`--auto --merge` may resolve immediately even with CI
  pending.** When the repo's branch protection does not gate on
  CI, `gh pr merge --auto --merge` can produce `state=MERGED` at
  the next `gh pr view` even though the push you just issued left
  CI as `QUEUED`. This is benign; the cluster is on the base, the
  fresh CI run continues against the merge commit. Record as
  merged with the merge-commit SHA; do not interpret the immediate
  resolution as a missed CI failure.
- **Authenticated `gh` account** speaks; no persona name.
- **Bookkeeping commits push immediately** before moving to the
  next PR, so a crash mid-loop leaves the queue accurate.
- **The conductor's own scratch worktree may need detached HEAD.**
  When the brief says "create a conductor worktree from `garden`",
  but `garden` is already checked out at another worktree (the
  steward's, or a checkin-pr* worktree), `git worktree add … garden`
  fails with "already used by worktree at …". Use
  `git worktree add --detach <path> bots-ssh/garden` instead; the
  conductor's worktree is for issuing `gh pr merge` and survey
  commands, not for authoring on `garden`. The bookkeeping commit
  goes in whichever worktree currently holds the `garden` branch.

## Self-improvement

Final task of every engagement: update this role file and cited
skills with what you learned. See
[`../skills/self-improvement.md`](../skills/self-improvement.md).
