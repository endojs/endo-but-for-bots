# Rebase before follow-up push

## When to use

When responding to review feedback on a PR whose base branch has
moved since the PR was opened. Always rebase the PR branch onto the
current base before pushing the fix-up commit, or the PR will
appear "behind master" and CI may run against stale dependency
versions.

## How

```sh
git fetch bots master            # or whichever remote/branch is the PR base
git switch -c kr-followup        # working branch from current PR head
git rebase bots/master           # resolves linearly if no conflicts
# … apply review fixes …
git commit -m "fix(pkg): address review on … (#NNNN)"
git push --force-with-lease bots HEAD:<original-branch-name>
```

`--force-with-lease` (not `--force`) protects against overwriting
work pushed by anyone else since the agent's last fetch. If the
lease is rejected, fetch again and re-rebase.

## Pitfalls

- Never resolve rebase conflicts with `--ours` / `--theirs`. The
  daemon `CLAUDE.md` is explicit on this.
- If the PR branch contains accidentally-included commits that have
  since been merged to master independently (e.g., a vendored copy
  of a fix that landed via a different PR), the rebase silently
  drops them. Verify the rebased diff still represents your intent.
- The OAuth token used by the bots agent may lack the `workflow`
  scope, so a rebase that reaches a commit modifying
  `.github/workflows/*` will be rejected at push time. Push via SSH
  instead. See `ssh-fallback-workflow-scope.md`.
- **Switching base branches (e.g., `llm` → `master`) can drop or
  conflict with bots-repo-only infrastructure files.** A PR opened
  against `llm` may contain a "docs(designs): index ..." commit that
  modifies `designs/README.md`, but `designs/README.md` does not
  exist on `master`. The rebase will surface this as a `modify/delete`
  conflict; the right resolution is `git rebase --skip` for the
  bots-repo-only commit, leaving only the upstream-bound design
  commits on the rebased branch. Verify post-rebase with `git diff
  --name-only bots-ssh/master..HEAD`; the remaining files should
  all belong on master.
- After a base-branch switch, also re-check `git merge-base HEAD
  bots-ssh/master` against the current `bots-ssh/master` SHA. If
  master moved during the session (a common occurrence in busy
  repos), the rebase target you initially passed may now be stale,
  and `git diff bots-ssh/master..HEAD` will list spurious files
  belonging to interim commits. A second `git rebase bots-ssh/master`
  resolves it cleanly.
- **"Byte-identical duplicate commits will auto-skip" is true only
  for the cumulative tree, not for each commit in isolation.** When
  the new base contains a sequence `A; A'` (e.g., a draft and its
  revision) and the rebased branch carries patch-id-equivalent
  copies `B; B'` of those, `git rebase` replays them one at a time.
  `B` (the draft) does not match the new base's *final* version
  (which is `A'`), so it surfaces as a content conflict (often
  `AA add/add` on a fresh file). Two clean options:
  1. `git rebase -i` and `drop` the duplicate commits explicitly
     before starting, after confirming the cumulative tree matches
     `git diff bots/<base>:<file> bots/<head>:<file>` is empty.
  2. Resolve by accepting the new base's content for each conflict
     and let the second commit become empty (skipped automatically).
  Option 1 is faster and gives a cleaner shortlog.
- **Master may have landed a strict-superset of the PR's intent via
  a different route.** Before resolving conflicts, diff master's
  version of each conflicted file against the PR's version. If
  master's content already does what the PR was trying to do (and
  more), the PR is superseded and the right outcome is to STOP and
  report rather than fabricate a resolution. Telltales:
  - `git show <base>:<conflicted-file>` is structurally what the PR
    was building toward.
  - The reviewer's pointer to a "do this like sibling X" comment
    may itself link to the upstream PR that already landed the
    equivalent work; check the linked PR's `mergedAt` against the
    PR-under-review's last push date.
  - Resolving by accepting master's content would leave the PR's
    feature commits empty, with only ancillary content (a design
    doc, a changeset) surviving the rebase.
  Encountered on bots-PR #27: upstream `endojs/endo#3216` landed
  the same `@endo/base64` native-dispatch refactor (in a stricter
  form: `Reflect.apply` capture, options pin, polyfill-fallback
  diagnostic) before the bots-repo PR's reviewer asked to align
  with the hex pattern. The reviewer's link was to the same PR
  that had already landed the equivalent work. Closing the
  bots-PR was the right outcome; no commits were pushed.

- **Cross-base rebase requires `--onto`, not bare `git rebase
  <new-base>`.** When the PR's old base (e.g., `bots-ssh/llm`) and
  the new base (`actual/master`) share only a deep ancestor, plain
  `git rebase actual/master` will replay every commit between
  `actual/master` and the PR head — typically hundreds of commits
  from the old base's own history that have nothing to do with the
  PR. The first conflict (often `yarn.lock`) is a strong signal that
  this is what happened; abort and use the explicit form:
  ```sh
  git rebase --onto <new-base> <old-base> HEAD
  ```
  This replays only the PR's own commits (`<old-base>..HEAD`) onto
  the new base. Encountered on PR 155 (master-sync): bare
  `git rebase actual/master` started replaying 696 commits from
  llm's history; `git rebase --onto actual/master ada6d43c7d HEAD`
  replayed only the 9 PR commits cleanly.

- **Working-mirror PRs require a master-sync sub-stage before the
  rebase.** When the PR is a working mirror (per
  [`pr-mirror-for-offline-review.md`](./pr-mirror-for-offline-review.md))
  of an upstream branch and the bots-repo's `master` lags upstream,
  rebasing the mirror PR onto stale `bots-ssh/master` would still
  leave it missing the upstream peer-fixes the panel flagged. The
  fix is a two-step: first sync `bots-ssh/master` with
  `actual/master`, then rebase the mirror PR onto the new master.
  Concrete sequence (in a separate worktree, NOT the PR's worktree):
  ```sh
  ORIG=$(git rev-parse bots-ssh/master)  # save for force-with-lease
  git worktree add --detach <path> bots-ssh/master
  cd <path>
  git checkout -B master-sync HEAD
  git rebase --onto actual/master \
    $(git merge-base actual/master bots-ssh/master) master-sync
  # Verify the rebased tip carries ONLY bot-fork-only commits
  # (typically design-doc-only) by diffing against actual/master:
  git diff --stat actual/master..HEAD
  # If anything outside the expected paths shows up, STOP.
  git push --force-with-lease=master:$ORIG bots-ssh master-sync:master
  ```
  Empty merge commits drop themselves during the rebase. After the
  push, `git fetch bots-ssh master` from the PR's worktree before
  the standard `git rebase bots-ssh/master`. Encountered on PR 114:
  the bot fork's master was 3 design-doc commits ahead of, and 5
  commits behind, `actual/master`; the sync replayed the 2
  non-merge bot-only commits onto upstream and the merge commit
  emptied out. The PR then rebased onto the new tip with one
  package.json conflict (both sides added dependencies — merge
  both alphabetically).

## Session example

PRs 71, 72, 75, and 59 all received follow-up commits where the
agent first ran `git rebase bots/master` (synced earlier in the
session with `actual/master`) before applying review fixes. PR 59's
"line 101 regression" turned out to have already been resolved by
the rebase itself.
