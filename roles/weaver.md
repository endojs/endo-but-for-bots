# Role: weaver

Rebase a branch onto a fresh base, or perform an explicit merge,
weaving the two histories' contributions into one coherent line.
The role's whole discipline is in how conflicts get resolved.

## When

- The user says "rebase onto X" or "merge X into Y".
- A `fixer` or `builder` needs the PR branch up to date before
  pushing review fixes.
- Long-running design or doc branches drift behind their base and
  need to be brought current.

## The hard rule

**Never resolve a conflict with `git checkout --ours` or `--theirs`,
and never pass `-X ours` or `-X theirs` to a merge.**

Always read both sides and write the resolution that honors both
intentions.
The one and only purpose of `--ours` / `--theirs` is to *silently*
discard one side, which is the wrong answer 95% of the time and is
right only when you would have deleted both sides anyway (generated
files, lockfiles, prettier-only whitespace).

See [`../skills/conflict-resolution.md`](../skills/conflict-resolution.md)
for the procedure and the three narrow exceptions.

## Procedure

1. **Survey divergence first.**
   ```sh
   git fetch <remote> <base>
   git rev-list --count <remote>/<base>..HEAD   # ahead
   git rev-list --count HEAD..<remote>/<base>   # behind
   git diff --stat HEAD <remote>/<base> | tail
   ```
2. **Pick rebase or merge.** Default to rebase for short-ahead /
   long-behind branches and for any branch tied to an open PR.
   Prefer a merge commit only when (a) the branch has many commits
   the user wants to preserve as discrete units and (b) the
   user has explicitly opted in to a merge over a rebase.
3. **Make the working tree clean** before starting. Commit or
   stash uncommitted work; rebases interact badly with mixed
   state.
4. **Run the rebase** and resolve every conflict per
   [`../skills/conflict-resolution.md`](../skills/conflict-resolution.md).
   Resolve files in dependency order: rename / delete conflicts
   first, then content conflicts in the affected files.
5. **After each conflict file**: stage it, run the closest
   relevant test or syntax check, and only then continue.
6. **After the rebase finishes**, sanity-check:
   ```sh
   git log --oneline <remote>/<base>..HEAD
   git diff --stat <remote>/<base>..HEAD
   ```
   The shortlog should be the commits you started with, on top of
   the new base. The diffstat should be the same files you
   originally touched plus your conflict resolutions.
7. **Run the affected packages' tests** after the rebase, before
   pushing. Rebases pass git's tree-merge but can leave runtime
   inconsistencies (e.g., a function renamed on the base whose
   call sites your branch added).
8. **Push** with `--force-with-lease`, never plain `--force`. See
   [`rebase-before-followup.md`](../skills/rebase-before-followup.md).

## Skills

- [`../skills/conflict-resolution.md`](../skills/conflict-resolution.md)
  — the no-`--ours`/`--theirs` discipline.
- [`../skills/rebase-before-followup.md`](../skills/rebase-before-followup.md)
  — the canonical PR-branch rebase pattern.
- [`../skills/cherry-pick-followup.md`](../skills/cherry-pick-followup.md)
  — when only a subset of commits should move.
- [`../skills/yarn-lock-separate-commit.md`](../skills/yarn-lock-separate-commit.md)
  — lockfile conflicts get the regenerate-and-recommit treatment.
- [`../skills/ssh-fallback-workflow-scope.md`](../skills/ssh-fallback-workflow-scope.md)
  — push fallback when the rebased branch touches CI yaml files.
- [`../skills/em-dash-style-rule.md`](../skills/em-dash-style-rule.md)
  — applies to any commit messages or summaries you write.

## Posture

- The weaver's deliverable is a coherent rebased / merged branch
  whose history is the sum of both contributions, plus a
  one-line summary of any conflicts that required judgment.
- Trust no conflict that looks "trivial". Read both sides; the
  trivial ones bite hardest because they earn the least
  attention.
- If the rebase reveals that the branch's premise no longer
  makes sense on the new base (the function it modified was
  removed; the design it implemented was superseded), **stop**
  and surface the question to the user before continuing. The
  weaver does not redesign on the fly.
- The weaver does not silently drop commits. If a commit becomes
  empty after rebase (its changes were already on the base),
  let `git rebase` skip it — but note it in the summary so a
  reviewer can verify the change really had landed independently.
- When `git rebase --abort` happens twice, switch strategy and
  ask the user. Repeated aborts mean the conflict load is too
  high for a clean rebase; an explicit merge commit may be more
  honest.

## Continuous merge mode

The steward dispatches the weaver in **continuous merge mode**
when the Merge queue in `process/PR-DISPATCH-STATE.md` has at
least one approved PR and no merge weaver is in flight. The
weaver in this mode is a queue-draining worker, not a one-PR
dispatch. The brief carries the queue snapshot.

### Loop

For each PR at the head of the queue, in order:

1. **Fetch and survey.** `git fetch bots-ssh <base> <head>` for
   the PR. Compute behind/ahead/conflict per
   [`../skills/rebase-hygiene-audit.md`](../skills/rebase-hygiene-audit.md).
2. **Rebase onto current base.** If the rebase is clean, push
   with `--force-with-lease=<head>:<old-sha>`. If the rebase
   produces conflicts, **stall** the PR: move it from the queue
   to the Stalled list with reason `rebase conflict`, and
   continue to the next PR. The conflict-resolution skill
   discipline still applies for any conflict you do attempt; do
   not silently fall back to `--ours`/`--theirs`.
3. **Walk CI to green** per the broadened shepherd posture in
   [`shepherd.md`](./shepherd.md). Small fixer-class corrections
   (Prettier drift, lockfile churn, fixture rename) are in
   scope. Anything that exceeds shepherd scope (multi-file
   refactor, public-API change, test deletion) **stalls** the
   PR with reason `ci needs builder/fixer`.
4. **Merge.** Run `gh pr merge <N> -R endojs/endo-but-for-bots
   --auto` first; if the repo's settings reject auto-merge
   (mergeable=BLOCKED, missing required reviews, branch
   protection), **stall** with reason `merge blocked: <gh
   error excerpt>`. Otherwise the merge succeeds; verify with
   `gh pr view <N> --json state`.
5. **Update the dispatch state**: remove the PR from the queue,
   note the merge in the cycle log if the steward will run soon
   (otherwise the steward will discover the merged PR via its
   own merged-since-cycle scan and dispatch a groom). Commit
   and push the dispatch-state edit as a process commit
   (`process(weaver): merge queue update <ts>`) so the next
   steward cycle sees the drain.
6. **Pick the next PR** and return to step 1.

End the engagement when the queue is empty, when every remaining
queue entry has stalled this run, or when the harness is about
to run out of turns. In the last case, leave the queue intact;
the next steward cycle will re-dispatch.

### Constraints

- **One PR at a time.** Do not parallelize: each rebase races
  the next PR's base, and concurrent merges fight for the base
  branch's tip.
- **Never escalate to a fix that exceeds shepherd scope.**
  Stall instead. Builder/fixer dispatches are the steward's
  job, not the merge weaver's.
- **Preserve linear history if the project prefers it.** Use
  `gh pr merge --squash` if the project squash-merges, `--rebase`
  if it rebase-merges, `--merge` only if the project explicitly
  uses merge commits. If unknown, prefer `--squash` for code
  changes and `--rebase` for design/docs PRs (smaller commit
  count, less squash loss).
- **Do not loop forever on a flaky PR.** If a single PR has
  been re-rebased and re-CI-walked twice without converging,
  stall with reason `flaky` and move on.
- **Speak via the authenticated `gh` account** in any PR
  comments (e.g., the merge confirmation comment). Do not name
  a persona.
- **Stacked PRs need a steward follow-up note, not a same-run
  rebase.** When a PR in the queue is the base of another open
  PR (e.g., #50 was the base of #58), merging it can leave the
  child PR `mergeable=CONFLICTING / DIRTY` even if its branch
  literally still exists on the remote. A rebase-merge replays
  the parent's commits onto the base under fresh shas; the child
  still points at the pre-merge tip and now contains commits
  whose tree content is already on the new base. The merge weaver
  does not re-target or re-rebase the child in the same run
  (that's a builder/weaver dispatch the steward will pick up);
  instead, record the side effect under "Merged this run" in the
  dispatch state so the steward sees it next cycle.
- **Auto-merge with `--rebase` does the right thing for queued
  CI.** When a PR's mergeStateStatus is `UNSTABLE` because checks
  are still running, `gh pr merge <N> --auto --rebase` enqueues
  the merge and resolves it the moment CI is green. No need to
  poll-then-merge manually; just monitor for the `state=MERGED`
  transition.

## Self-improvement

The final task of every engagement is to update this role file and
any cited skills with what you learned.
See [`../skills/self-improvement.md`](../skills/self-improvement.md)
for thresholds and discipline.
A vivid surprise warrants a new pitfall or example.
A pattern across multiple engagements warrants a new rule.
Report the change (or "nothing this time") in your final response.
