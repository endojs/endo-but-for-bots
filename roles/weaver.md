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
- **Rename-vs-content conflicts radiate beyond the conflict
  markers.** When the PR's intent is "rename file X to Y" and the
  new base independently added file Z whose links point at X, the
  README conflict is the visible part; Z's link to X is the
  silent part. Grep the post-rebase tree for the old name across
  all files the new base added (sibling designs, deprecation
  stubs, dependency tables, READMEs in adjacent packages) and
  fix those references in a follow-up commit on the same branch.
  Encountered on PR 29: PR 86 added `designs/syrups.md` (a
  supersession stub) and `designs/cbors.md` (a sibling design),
  both linking to the pre-rename `ocapn-tcp-syrup-framing.md`.
  Only the README surfaced as a conflict; the other two would
  have shipped with broken links. Updating the supersession stub
  was in scope; the sibling design's many cross-references were
  out of scope for the weaver and were noted for a follow-up
  fixer.
- **Cross-repo merges (`actual/master` into `bots-ssh/llm`) can
  land conflict-free even when both sides carry "the same fix".**
  Git's merge looks at tree content, not commit identity. When the
  bot side mirrored an upstream fix (e.g., the guix-CI-resilience
  change shipped as PR #82 on the bot estate and PR #3242 upstream
  with byte-identical workflow content), `git merge` sees identical
  blobs at the same path on both sides and produces no conflict
  marker at all. The dispatch may warn you to expect a textual
  conflict; verify post-merge with `git diff actual/master HEAD --
  <files>` that the touched paths really are byte-identical, and
  cite both SHAs in the merge commit body so a future reviewer
  can trace the duplicate landing. If the diff is non-empty, the
  bot mirror diverged from upstream and you must read both sides.
- **Pre-merge survey distinguishes "merge me" from "I have nothing
  new".** Before invoking `git merge`, run both
  `git log --oneline <target>..<source>` and the inverse. If the
  first list is empty the target is already current; if the second
  list is short it tells you what bot-side commits will need to
  rebase later. Capture the second list in your report so the
  steward knows which in-flight PRs will need attention next cycle.
- **Rebasing a multi-commit PR after upstream squash-landed its
  substance: skip per-commit, do not merge or take-theirs.** When
  an upstream maintainer squashes a PR's N commits into one
  upstream commit, then the bot mirror later rebases the original
  N-commit chain onto the new upstream tip, every PR commit will
  conflict against the squash commit (HEAD already contains a
  superset of what the PR commit is trying to introduce). The
  weaver instinct to "read both sides and synthesize" is wrong
  here: HEAD already **is** the synthesis. The right move per
  conflicting commit is `git rebase --skip`. Empty commits (typically
  the test-and-changeset commits whose blobs upstream took
  byte-identically) drop automatically with `--empty=drop`. What
  remains is exactly the substance the upstream squash did NOT take
  — usually a small late-fixup that arrived after the squash. Pre-flight
  check: `git diff HEAD actual/<base> -- <PR-files>` per file.
  Files that report "IDENTICAL" against the upstream tip are
  already-landed; the surviving substance is whatever differs. If
  every PR file is identical, the PR is fully superseded and
  should close as "superseded by upstream <SHA>" rather than
  rebase. If only a small subset differs, run the rebase with
  `--empty=drop` and `--skip` each conflicting commit; amend the
  surviving commit's message to describe what actually survives
  (the original "fixup!" subject is misleading after the rebase
  collapses everything else away). Encountered on PR
  endojs/endo-but-for-bots#55 (kriskowal-base64): four PR commits
  rebased to one 3-line commit after upstream `7325bbe15f` squashed
  three of the four plus most of the fixup; the surviving substance
  was the `Object.defineProperty(adaptDecoder(...), 'name', { value:
  'xsDecodeBase64' })` rename that the upstream squash had not picked
  up.

Continuous queue-draining merge work has its own role: see
[`conductor.md`](./conductor.md). The steward dispatches the
conductor (not the weaver) when approved PRs accumulate.

## Self-improvement

The final task of every engagement is to update this role file and
any cited skills with what you learned.
See [`../skills/self-improvement.md`](../skills/self-improvement.md)
for thresholds and discipline.
A vivid surprise warrants a new pitfall or example.
A pattern across multiple engagements warrants a new rule.
Report the change (or "nothing this time") in your final response.
