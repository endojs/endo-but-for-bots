# Review-feedback follow-up commits

## Principle

When addressing review feedback on an open PR, **add a follow-up
commit on top** rather than amending the original commit. The
follow-up makes the diff between the previous PR state and the
current one trivially reviewable. Amend only the just-rebased tip
when no one but you has pushed since.

## Per-concern commits, not one-big-fixup

Group review responses into atomic commits where each commit
addresses one concern. A reviewer who agrees with three points and
disagrees with the fourth can request the fourth commit be dropped
without unwinding the others.

Use conventional-commit messages with the parenthesized PR number,
e.g.:

- `fix(ci): restore line accidentally regressed in rebase (#NNN)`
- `refactor(pkg): clarify mock transport's pair-of-pipes (#NNN)`
- `feat(pkg): subpath exports for transports (#NNN)`
- `docs(pkg): rename old → new in codec docs (#NNN)`
- `chore: Update yarn.lock`

## How

```sh
# from the worktree at the PR head
git fetch bots master
git switch -c kr-followup
git rebase bots/master
# … apply each fix as its own commit …
git push --force-with-lease bots HEAD:<original-branch-name>
```

## Reply on each thread

Once the push lands and CI is green, post one reply per inline
comment thread citing the commit SHA(s). See
`pr-review-thread-replies.md`.

## Pitfalls

- Don't squash everything into one big commit; reviewers lose the
  ability to ask for partial reverts.
- Don't skip the rebase before the follow-up commits, even if it
  looks like a no-op. See `rebase-before-followup.md`.
- If the lockfile changes, that goes in its own commit per
  `yarn-lock-separate-commit.md`.
- When a reviewer asks you to pin an external dependency to a
  specific version, verify the current state of the upstream
  release before committing the pin. The dispatching prompt's
  guessed version or release date may be stale; fetch the
  download page or directory listing yourself, capture the
  sha256, and embed both as workflow-level env vars so a future
  bump is a two-line change. Key any download cache by both
  fields so a stale blob can't shadow a version bump.
- When one review item demands a major rewrite (e.g. a scope
  reduction that re-frames an entire design document), don't try
  to fake atomic commits for the rest. Land the rewrite as commit
  A. Then commits B, C, ... should be **additive sharpenings** of
  the new content (a clarifying paragraph, a new design-decision
  bullet, a hedging adjective) that a reviewer could request be
  dropped without unwinding the rewrite. Keep the rewrite commit
  honest about its scope; the reviewer expected the rewrite, and
  splitting it into "phase 1 of the rewrite, phase 2 of the
  rewrite" is theater.
- When a dispatching prompt summarises each review thread with a
  line number and a suggested action, treat the line number as
  authoritative and the action summary as a hint. Read the file
  at that line yourself before applying the edit. The dispatcher
  can mismatch a line to the wrong file/identifier in the
  surrounding paragraph (e.g. "rename `bench-X.js`" when line N
  is actually about `webextension-X.js`); the reviewer's comment
  is anchored to the line, not to the dispatcher's gloss.
- A package rename touches more than `package.json:name` and the
  source identifiers. Sweep:
  - The package directory under `packages/` (`git mv`).
  - `package.json` `name`, `homepage`, `repository.directory`.
  - The AVA test file under `test/<old>.test.js`; rename to
    `test/<new>.test.js` so the file name still matches the package.
  - The `.changeset/<old>-*.md` file (rename and update the package
    name on the YAML front-matter line).
  - Any error-message text that names the package (e.g.
    `Invalid <pkg> length prefix`); these are between identifier and
    prose and are easy to miss with an `*Reader`/`*Writer` grep.
  - The companion design document under `designs/`, if the rename
    flows from a name decision recorded there.
  - `yarn.lock` (separate commit; see this file).
  After all renames, `grep -rn '<old-name>' packages/ designs/
  .changeset/ yarn.lock` should return only intentional historical
  references (e.g. an "originally named X" line in a design's
  candidates table or the verbatim `## Prompt` block).
- When a reviewer flags a naming issue on one line of a design
  document, the same name almost always appears in several different
  contexts in the surrounding prose, each wanting a different
  treatment. SES-intrinsic renames are the canonical case: the
  reviewer says "use `%SharedURL%` not `SharedURL`", and the right
  answer depends on the local context:
  - Permits-table cells, intrinsic identifiers, and "binding lives
    on `sharedGlobalPropertyNames`" prose want `%SharedURL%`.
  - Code that runs inside a compartment wants the binding name
    (`globalThis.URL` or just `URL`).
  - TC39-style discussion of the abstract intrinsic in pure prose
    can use the bare `SharedURL` form, but only when the surrounding
    text makes the abstraction clear.
  Walk every occurrence of the flagged name with `grep -n` before
  editing; classify each into one of the contexts above; then edit.
  Mechanical sed-style substitution will silently replace
  consumer-facing surface names with permits-machinery names and
  break the design's coherence.

## Session example

PR 59 received seven follow-up commits (mock simplification, subpath
exports, ws-browser, util de-dup, doc renames, lint fix, README) plus
a separate `chore: Update yarn.lock`. Each commit cited the PR
number and was individually reviewable.

PR 82 received one follow-up commit promoting a pinned Guix release
to the primary install path. The dispatching prompt guessed the
version had shipped in 2025-04; the upstream directory listing
showed 2026-01-22, and the prompt-claimed sha256 placeholder had
to be replaced with the value computed by downloading and hashing
the tarball locally. Pinning without verification would have
shipped wrong metadata in the workflow's documentation comments.
