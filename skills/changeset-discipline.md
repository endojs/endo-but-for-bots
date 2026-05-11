# Changeset discipline: only when end-users care

The Endo project uses `@changesets/cli` to manage release notes.
Per-PR changesets live at `.changeset/<adjective-noun-thing>.md`
(e.g., `.changeset/lucky-views-train.md`) with the format:

```md
---
'@endo/<package>': minor
---

<one-paragraph user-visible description>
```

There is NO `packages/<pkg>/NEWS.md` convention; that file
shouldn't exist anywhere.

## When to write a changeset

A change needs a changeset if and only if it is **user-observable**.
Concretely:

- A new exported API.
- A change in observable behavior of an existing exported API.
- A bug fix that the user could have noticed.
- A breaking change (removed export, changed signature, stricter
  validation).
- A migration step the user must perform on upgrade.

## When NOT to write a changeset

Most internal-hygiene PRs do **not** need a changeset.
Skip the changeset entirely (don't write a "no-op" entry) if all of
the following are true:

- The change does not enable the user to do anything new.
- The change does not obligate the user to perform any migration
  step.
- The user could not detect the change by reading the package's
  documentation, signatures, or behavior.

Examples that **do not** need a changeset:

- Removing an unused devDependency from a `package.json`.
- Moving tests into a sibling synthetic test package
  (`@endo/<subsystem>-test`) when no exported surface changes.
- Renaming an internal-only file under `src/`.
- Adding a private internal subpath under `exports` gated by the
  `test` condition.
- Refactoring a test fixture.
- Updating a comment, JSDoc, or README that describes already-existing
  behavior.
- CI workflow tweaks.
- Build-only or lint-only changes.

The rationale: a changeset entry surfaces in the project's published
release notes.
A noisy changelog full of "removed unused devDep" or "moved tests"
entries trains downstream consumers to ignore the changelog,
which makes the genuinely user-facing entries harder to notice.

## When in doubt, ask

A changeset is easier to add than to remove (after publish, the entry
ships forever).
If you are unsure whether a change is user-observable, ask the
maintainer in the PR description rather than defaulting to writing
one.

## Origin

This rule was made explicit by kriskowal on PR #209
([discussion](https://github.com/endojs/endo-but-for-bots/pull/209#discussion_r3216462659)):

> This is beneath the notice of end users and does not need a
> changeset mention because it does not enable the user to do
> anything new nor obligates the user to perform migration steps
> when upgrading. Please adjust the changeset skill accordingly.

And on PR #210
([discussion](https://github.com/endojs/endo-but-for-bots/pull/210#discussion_r3216465132)):

> This is beneath the threshold of needing user attention and does
> not need a changeset.

## How to apply on the next PR

1. Before adding `.changeset/<name>.md`, ask: would a downstream
   consumer reading the published release notes recognize this as
   relevant to them?
2. If no: skip the changeset.
3. If yes: write the changeset; lead with the user-visible
   change in plain language; cite the PR number.
4. The PR description's `[Documentation]` consideration line should
   say "no changeset (internal hygiene)" when the changeset is
   intentionally omitted, so reviewers know it was a deliberate
   choice rather than an oversight.
