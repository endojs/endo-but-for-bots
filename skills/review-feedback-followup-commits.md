# Review-feedback follow-up commits

## Triggers

Read this skill when responding to inline review comments,
top-level review feedback, or maintainer "please address X"
asks on an open PR.

## Core rules

- **Add a follow-up commit on top; do not amend.** Amending
  forces the reviewer to recompute the diff between the prior
  PR state and the current one. The follow-up makes that diff
  trivial. Amend only the just-rebased tip when no one else
  has pushed since.
- **One concern per commit, conventional-commit message,
  parenthesized PR number.** A reviewer who agrees with three
  points and disagrees with the fourth can request the fourth
  be dropped without unwinding the others. Examples:
  `fix(ci): restore line accidentally regressed in rebase (#NNN)`,
  `refactor(pkg): clarify mock transport's pair-of-pipes (#NNN)`.
- **Rebase before applying fix-ups.** See
  [`rebase-before-followup.md`](./rebase-before-followup.md);
  even an apparently no-op rebase matters.
- **Lockfile changes ship in their own commit** per
  [`yarn-lock-separate-commit.md`](./yarn-lock-separate-commit.md).
- **Reply on each thread after the push lands** citing SHA(s)
  per
  [`pr-review-thread-replies.md`](./pr-review-thread-replies.md).

## Patterns that trigger a deeper read

Each line below is a trigger. If the pattern matches, follow
the cited reference for the full handling.

- **Reviewer asks to pin an external dependency to a specific
  version.** Verify upstream state before committing the pin;
  capture the actual sha256 from a fresh download. See
  [`verify-upstream-state-before-pinning.md`](./verify-upstream-state-before-pinning.md).
  (Session example: PR 82's Guix-binary pin.)

- **A review item demands a major rewrite of an existing
  commit.** Land the rewrite as commit A; treat any subsequent
  follow-ups as additive sharpenings (clarifying paragraph,
  new design-decision bullet, hedging adjective) that a
  reviewer could request be dropped without unwinding A. Do
  not split the rewrite itself into "phase 1, phase 2"; that
  is theater.

- **The dispatching prompt summarizes review threads with
  line numbers and suggested actions.** Treat the line number
  as authoritative and the action summary as a hint. Read the
  file at that line yourself before applying the edit; the
  dispatcher can mismatch a line to the wrong file or
  identifier in the surrounding paragraph.

- **The fix is a package rename.** Sweep the cascade per
  [`package-rename-cascade.md`](./package-rename-cascade.md):
  package directory, `package.json` fields, AVA test file,
  `.changeset/*.md`, error-message strings, design doc,
  `yarn.lock`. After the sweep, `grep -rn '<old-name>'` should
  return only intentional historical references.

- **The reviewer flags a naming issue on one line of a design
  document.** The same name almost always appears in several
  contexts, each wanting a different treatment. Walk every
  occurrence with `grep -n`, classify, then edit; mechanical
  sed-substitution swaps consumer-facing names for
  machinery-facing names and breaks coherence. SES-intrinsic
  renames are the canonical case; full handling at
  [`ses-intrinsic-naming.md`](./ses-intrinsic-naming.md).
