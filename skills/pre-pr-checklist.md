# Pre-PR checklist

## Trigger

Read this skill before every push to a PR branch (initial create
or follow-up), and again before any `gh pr edit --body` rewrite.
The checklist below is the minimum; the PR-body template section
applies whenever `gh pr create` or `gh pr edit --body` runs.

## The minimum

Run before every push to a PR branch:

- `npx corepack yarn format` from the repo root.
  Prettier drift is the single most common review nit.
- `npx corepack yarn lint` (or `cd packages/<name> && yarn lint`)
  for the packages you changed.
  Catches ESLint-only rules: `harden-exports`, `no-underscore-dangle`,
  the project's `@endo/internal` config.
- `npx corepack yarn docs` from the repo root, or `tsc --build`.
  Catches missing members on exported interfaces, type drift, broken
  `@import` specifiers. This is the load-bearing check for type-only
  changes; CI will surface them but local catches them faster.
- `cd packages/<name> && npx ava`: at least the tests nearest the
  change. For broader changes, run the full package suite.
- Decide whether to add a `.changeset/<name>.md` per
  [`./changeset-discipline.md`](./changeset-discipline.md).
  Most internal-hygiene PRs (devDep cleanup, test moves, refactors
  that don't change exported surfaces) skip the changeset.

## PR body template

When `gh pr create` opens a new PR, populate the body from
`.github/PULL_REQUEST_TEMPLATE.md` (in the repo you are
opening against). Read the template at the head of the base
branch and fill the section headings rather than inventing your
own structure. Delete the guidance lines (the prompted prose
under each heading) before submitting. Default to the template
unless the PR is a one-line trivial change AND the maintainer
has previously waved the template for that change class.

```sh
gh api "repos/<owner>/<repo>/contents/.github/PULL_REQUEST_TEMPLATE.md?ref=<base>" \
  --jq '.content' | base64 -d > /tmp/pr-body.md
# edit /tmp/pr-body.md to fill in the sections
gh pr create --base <base> --head <head> --body-file /tmp/pr-body.md --title '...'
```

If the template file is missing on the base branch, fall back
to the conventions in the repo's `CONTRIBUTING.md` and surface
the missing-template observation in the PR body so the
maintainer can decide whether to add one.

The same template applies to **after-the-fact body rewrites**
(`gh pr edit <N> --body-file ...`), not just initial creation.
A PR that grew in scope after open should be reset to the
template structure rather than appended to; reviewers expect
the section headings in the same order on every PR in the repo.

**Do not line-wrap paragraphs in the PR body.** GitHub renders
PR descriptions in a flavor of Markdown where line breaks are
interpreted literally (single newlines render as `<br>`-style
breaks, not paragraph continuations). Wrapping a paragraph at
80 to 100 columns the way the rest of the repo's markdown does
produces visible ragged-edge breaks in the rendered description.
Each paragraph in the PR body is a single physical line; let
the browser wrap it. Lists and headings still get their own
lines (that's what they need); only the prose under them stays
unwrapped. This is a deliberate exception to the project's
markdown line-wrap convention; it applies to PR descriptions
only.

**The PR body describes the change, not the methodology.** Do
not mention this checklist, the template-fill workflow, the
process discipline, the steward, the conductor, or any internal
agent role in the body or title. A reviewer should read the PR
and learn what changed and why; how an agent assembled the PR
is irrelevant to that reader. Strip self-narrating phrases
("ran the pre-PR checklist", "filled per template", "addressed
in cycle N", "the juror panel found", and similar) before
submitting. If a section heading from the template would
otherwise be empty, write `No impact.` rather than narrating
that you considered it.

The most pernicious form of methodology leak is a literal
`skills/<file>.md` or `roles/<file>.md` path citation in the
body. These expose the agent's internal directory layout to
every reader of the public PR. Cite the *substance* of the
discipline (e.g., "Reverting the fix causes the new assertions
to fail closed, confirming they are load-bearing.") instead of
the file that documents the discipline.

## Lockfile rule

If the change adds or updates a dependency, commit `yarn.lock`
**in its own commit**, separately from the `package.json` change,
with the message `chore: Update yarn.lock`.
See `yarn-lock-separate-commit.md`.

## Workspace gotchas

- Yarn 4 via corepack: `npx corepack yarn install`. Plain `yarn`
  may not be on PATH inside a fresh worktree.
- For workspace-scoped commands: `npx corepack yarn workspace <name>
  exec ava` or `npx corepack yarn workspaces foreach -A run lint`.
- Daemon integration tests need `--timeout=120s` and must be
  `test.serial` if they fork a real daemon.

## Lint-rule gotchas

- Don't rename "intentionally unused" identifiers with a leading
  underscore. This conflicts with `no-underscore-dangle`. Use
  `// eslint-disable-next-line no-unused-vars` instead, or delete
  the unused declaration.
- `/** @type {T} */` binds to the **next declaration**, not the
  enclosing block. When refactoring, keep the tag adjacent.

## Why

Ten of the ten implementation PRs in this session passed CI on
their first push because the agent ran the full checklist locally
first. The few failures that did surface were not Prettier or lint
errors but real semantic issues (missing fixture name, lerna
ECYCLE). Those required follow-up, but the lint/format/typedoc
class of nit was eliminated.

See also: `regression-evidence.md` (verify a new test is load-bearing
before pushing).
