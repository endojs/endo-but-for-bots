# Resolve merge or rebase conflicts by reading both sides

## The rule

When git stops the rebase or merge with a conflict, **never use
`--ours` or `--theirs` to resolve it**.
Read both sides of every conflict hunk, understand what each
branch was trying to accomplish, and write the resolution that
honors both.

## Why

`--ours` keeps your side and silently discards the other side's
changes. `--theirs` does the inverse. Either is the right answer
about 5% of the time and the wrong answer the rest, and there is
no way to know which without reading both sides anyway. So you
might as well read.

A real merge conflict is a signal that two intentions touched the
same lines. The resolution that matters is usually a *third*
state (both intentions, woven together), not either input
verbatim.

## Procedure

1. **List every conflicted file:**
   ```sh
   git status --short | grep '^UU\|^AA\|^DD\|^AU\|^UA'
   ```
2. **For each conflicted file, look at three things, in order:**
   - The conflict markers in the working tree (`<<<<<<<`,
     `=======`, `>>>>>>>`).
   - `git log -1 --stat HEAD -- <file>`: what the rebase target
     was doing here.
   - `git log -1 --stat MERGE_HEAD -- <file>` (during a merge) or
     `git log -1 --stat REBASE_HEAD -- <file>` (during a rebase):
     what your branch was doing here.
   For longer histories on either side, expand the `-1` to the full
   range that touches the file.
3. **Open both authors' commits** for the file: `git show
   <sha>:<file>` for context. Often the conflict is mechanical
   (the same constant renamed in two places) but the markers
   make it look semantic.
4. **Write the resolution** as if you were authoring the file
   from scratch, knowing both intents. If the two changes are
   genuinely incompatible, prefer the change that better fits
   the project's current direction and add a note so the other
   author can review.
5. **`git add <file>`** and continue (`git rebase --continue` or
   `git merge --continue`).

## When `--ours` / `--theirs` *might* be correct

Three narrow cases. Even here, read both sides first and confirm:

- **Generated files** (`yarn.lock`, `package-lock.json`,
  `dist/*`). The right resolution is usually to drop both sides
  and regenerate. For yarn.lock specifically, see
  [`yarn-lock-separate-commit.md`](./yarn-lock-separate-commit.md);
  the lockfile commit on the rebased side should be dropped, then
  regenerated and committed fresh.
- **`CHANGELOG.md` files maintained by Changesets.** The release
  bot owns them; conflicts almost always mean both sides had a
  release commit and the right answer is to drop one and let the
  release flow regenerate.
- **Whitespace-only conflicts** introduced by Prettier
  re-running. Rerun Prettier locally; the conflict goes away.

In all three cases, you are not really using `--ours` / `--theirs`;
you are deleting both sides and recomputing. The dishonest
shortcut is to *pretend* this applies elsewhere.

## Pitfalls

- **Resolving by the conflict markers alone.** The markers show
  the lines that disagreed, not the intent. Skim the surrounding
  function and the commit messages from both sides; otherwise
  you'll merge two pieces of code that no longer fit their
  callers.
- **Silent loss.** A conflict resolution that drops one side's
  added function entirely is a real regression even if the file
  compiles. Run the test suite for the affected package after
  every conflicted file.
- **`git rebase --abort` cycles.** If a rebase is so conflict-heavy
  that you've aborted twice, the right answer may be a merge
  commit instead of a rebase. Discuss with the user before
  changing strategy.
- **Conflict in renames.** When git detects a rename, the
  conflict can appear under the new name with no obvious
  signal. `git status` shows `UA` or `AU` markers; treat these
  with extra care, since both sides may have edited the file
  under different paths.
- **`MERGE_HEAD` and `REBASE_HEAD` semantics differ.** During a
  rebase, `HEAD` is the **target** branch's commit (the one being
  replayed onto), and `REBASE_HEAD` is your branch's commit being
  replayed. During a merge, `HEAD` is your branch and
  `MERGE_HEAD` is the incoming branch. Don't confuse them.
- **A clean rebase can still break the PR's invariant.** When the
  branch adds an enforcement check (lint, policy script, schema
  validator), a rebase that finishes without conflict markers may
  still leave the check failing because the new base added a file
  the check covers. Run the PR's own enforcement against the
  rebased tree before pushing. If it complains about a file that
  did not exist when the PR was authored, extend the PR's commit
  to cover that file (the PR's intent already implied it). If the
  fix would change the PR's design, stop and surface the question.
- **The `expr || Fail\`...\`` assertion shape does not narrow types.**
  When a panel asks you to convert `if (!expr) throw Fail\`...\`` to
  `expr || Fail\`...\`` for file-level consistency, watch for a TS
  break at the next use of the narrowed-by-`expr` variable. TypeScript's
  control-flow analyzer narrows through `if (!isFoo(x)) throw ...`
  but does NOT narrow through `isFoo(x) || Fail\`...\`` (the `||`
  is an expression statement; `Fail`'s `: never` return type does
  not propagate to the surrounding scope). The fix is an explicit
  cast at the first use, e.g.
  `for (const v of /** @type {unknown[]} */ (conditions)) { ... }`.
  Worse, the cast is hunk-conflict-bait on the next rebase. If
  the file's other sibling assertions narrow via JSDoc-declared
  `asserts` helpers (e.g. `assertString`'s
  `@returns {asserts value is string}`), prefer extracting the
  narrowing into a named helper rather than inlining the cast at
  every use site. Encountered on PR 114: `assertConditions`
  converted from `throw Fail` to `||` shape; the cast at the
  `enumerate(conditions)` use site was the minimum viable fix.
- **Two sides each add a new parameter to the same parameter list
  / function signature / object literal.** This is the most common
  "trivial-looking" conflict and the most error-prone. Read both
  sides' commit messages to learn the order convention each side
  uses, then keep BOTH parameters in a defensible order (often:
  preserve the base side's slot to avoid breaking pre-existing call
  sites, then append the PR side's new param). Crucially, also
  check the implementations the type or signature is shared with:
  if the JS impl positionally consumes the param after a slot the
  PR knew nothing about, you must add a placeholder for the new
  base-side param to the impl too, or the runtime arg lands in the
  wrong slot and tests fail in subtle ways. Encountered on PR 58:
  llm added `kind?: 'locked' | 'node'` as parameter 8 of
  `DaemonicControlPowers.makeWorker`; PR added `marshalLoadError?`
  as parameter 8 of the same. Resolved by ordering them
  `kind, marshalLoadError` AND adding the matching `kind`
  placeholder to the JS impls.

## Session example

Used in this session whenever a rebase touched a long-divergent
branch (PRs 59, 67, 68, 71, 72, 75 follow-ups all rebased onto
fresh `bots/master` without using `--ours`/`--theirs`). The
discipline kept zero conflict-induced regressions across the
campaign.
