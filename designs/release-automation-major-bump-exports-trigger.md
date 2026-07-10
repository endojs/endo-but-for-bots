# Release Automation: `.js` Exports-Key Cleanup Notice on Major Bumps

| | |
|---|---|
| **Created** | 2026-07-10 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Not Started |

## What is the Problem Being Solved?

Pass 1 of [exports-extensionless-migration](exports-extensionless-migration.md)
leaves every migrated package with dual `exports` keys: the `.js`-suffixed key
(`./foo.js`) retained for compatibility beside the new extensionless sibling
(`./foo`), with a standing changeset note reserving the right to remove the
`.js` keys **in the next major version**. That reserved window is easy to
miss: majors are rare, the note scrolls away into the changelog, and nothing
at release time connects "this PR declares a major bump for `@endo/pkg`" with
"`@endo/pkg` still carries removable `.js` keys."

This design adds a deterministic, **non-blocking** notice to release
automation: when a pull request carries a planned major bump for a package
whose `exports` still holds `.js`-suffixed keys with extensionless siblings,
CI surfaces the removable keys as an informational annotation, framed as
"major bump: opportunity to complete the extensionless-exports cleanup." No
LLM, no persistent state, no gate.

## Design

### The removable set

For a package, an exports key `./K.js` is **removable-on-major** iff:

1. it is an explicit (non-pattern) subpath key ending in `.js` — the same
   population pass 1 migrated, so `.`, `./package.json`, other extensions
   (`.css`), and `*` pattern keys are excluded; and
2. the sibling key `./K` exists in the same map; and
3. the two values are deep-equal.

The deep-equality clause makes the check self-limiting: a pair someone later
diverges on purpose is no longer a compatibility alias and is not flagged,
and once a major actually removes the `.js` keys the removable set is empty
and the notice self-quiets. Zero findings means zero output; there is no
state to disarm.

This predicate is the complement of the migration's **gate A** (which fails
when an explicit `.js` key *lacks* a deep-equal extensionless sibling). Both
walk the same structure, so the pair enumeration lives in one shared,
dependency-free helper, `scripts/lib/extensionless-exports.mjs` (exporting
`dualExportPairs(exportsMap)`), consumed by the pass-1 codemod's `--check`
mode and by this check. If the codemod lands first without the helper, this
work factors it out of `scripts/codemod-exports-extensionless.mjs`.

### Detecting a planned major bump: two surfaces, one core

**Surface 1 — the contributor PR that declares the major (the early
reminder).** On `pull_request`, diff against the merge base and collect the
`.changeset/*.md` files the PR **adds or modifies** (never `README.md`).
Parse each changeset's YAML frontmatter for `"<pkg>": major` entries.
Scoping to the PR's own changesets — rather than everything pending on the
branch, which is what `changeset status` reports — keeps one long-lived
pending major changeset from spamming every unrelated PR on the branch.

**Surface 2 — the changesets release PR (the reminder of record).** The
`changesets/action` "Version Packages" PR (head branch `changeset-release/*`,
per `.github/workflows/release.yml`) *consumes* the changeset files, so
surface 1 is blind there — and that PR is the last deterministic gate before
tags are pushed. On that branch shape the check instead diffs each changed
workspace `package.json` `version` against the merge base and treats a bump
as breaking iff the major component increased, or the major is `0` and the
minor increased (the 0.x breaking convention).

Both surfaces feed the same reporting core. If the notice is ignored on the
contributor PR it reappears on the release PR; if it is ignored there too,
the maintainer has made an informed choice, which is all a non-blocking
notice can and should achieve.

### Surfacing: annotations and a step summary, not a comment

On findings the check emits:

- one **check annotation** per affected package, via the workflow command
  `::notice file=packages/<dir>/package.json,line=<line of the first
  removable key>,title=Major bump: removable .js exports keys::<key list>`,
  visible in the PR's Checks tab and Files-changed view; and
- a **`$GITHUB_STEP_SUMMARY`** markdown table (package, removable `.js`
  keys, and a pointer to
  [exports-extensionless-migration](exports-extensionless-migration.md) and
  its standing changeset note) so the full list survives even when the
  annotation message is truncated.

Considered and rejected: a sticky PR comment. Reason: it requires
`pull-requests: write` on a `pull_request`-triggered workflow (the repo's CI
workflows grant no write permissions), and bot-comment churn is noisier than
annotations for a purely informational signal. Annotations and the step
summary need no permissions at all.

The job **exits 0 whenever it runs to completion, findings or not**:
non-blocking is a property of the design, not a `continue-on-error` flag. A
genuine script crash still turns the (dedicated, clearly named) job red — an
informational check whose breakage is invisible would silently rot.

### The script and its wiring

`scripts/check-major-bump-exports-notice.mjs` — plain Node, no dependencies,
no install step:

1. `git diff --name-status <merge-base>...HEAD` to find candidate files.
2. Pick the surface: a `changeset-release/*` head branch (or `--mode
   versions`) diffs workspace `package.json` versions; otherwise parse the
   added/modified changesets. The frontmatter grammar is the constrained
   `"<pkg>": <bump>` block that `changeset add` writes; a small line parser
   covers it, and malformed lines are reported in the step summary and
   skipped rather than trusted.
3. Map major-bumped package names to workspace directories, run
   `dualExportPairs` on each package's `exports`, and locate the first
   removable key's line in the raw `package.json` text as the annotation
   anchor.
4. Emit the annotations and the summary; exit 0.

Wiring: a dedicated job (`major-bump-exports-notice`) in a small separate
workflow on `pull_request` with a path filter (`.changeset/**`,
`packages/**/package.json`), a checkout deep enough to reach the merge base,
actions pinned by SHA and workflow-level `permissions: {}` per repo
convention (see `release.yml` and designs/ci-no-npm-lifecycle.md posture).
Runtime is seconds: checkout, Node, one script, no `yarn install`.

Local reproduction:
`node scripts/check-major-bump-exports-notice.mjs --base origin/master`
prints the same report as plain text.

### Test plan

- Unit tests (ava, colocated under `scripts/` per the
  `generate-composite-tsconfigs.test.mjs` precedent) over fixtures:
  changeset-frontmatter parsing (major/minor/patch, quoted and unquoted
  names, malformed lines), `dualExportPairs` (dual pairs, diverged values,
  pattern keys, string versus conditional-object values), and the 0.x
  breaking rule.
- One live probe after pass 1 lands: a scratch PR adding a `major` changeset
  for a migrated package must produce the annotation and summary; a sibling
  `minor`-only scratch PR must produce neither.

## Dependencies

| Design | Relationship |
|--------|--------------|
| [exports-extensionless-migration](exports-extensionless-migration.md) (PR #663, in flight) | Prerequisite in effect: its pass 1 creates the dual keys this check enumerates, and its gate A shares the `dualExportPairs` helper. Authoring and landing this check is not blocked, but the notice is inert until pass-1 packages exist |

## Design Decisions

1. **Annotations plus step summary, not a PR comment.** Zero permissions,
   zero comment churn; the signal is informational.
2. **Diff-scoped changeset detection.** Only changesets the PR itself adds
   or modifies trigger surface 1; pending majors elsewhere on the branch do
   not spam unrelated PRs.
3. **Two surfaces.** The contributor PR is the early reminder; the Version
   Packages PR is the reminder of record, the last deterministic point
   before tags where the cleanup can still join the major.
4. **Deep-equality guard**, so intentionally diverged key pairs are never
   flagged and the notice self-quiets once the cleanup ships.
5. **Exit 0 on findings by construction**, not via `continue-on-error`, so
   real crashes stay visible.
6. **Install-free, dependency-free script.** The constrained changeset
   frontmatter does not need a YAML library; the job costs seconds.

## Open Questions

- Should the removable-keys list also be injected into the major's
  `CHANGELOG.md` entry (a `@changesets/changelog-github` wrapper), so the
  reminder outlives the PRs? (Assumed no for now: the two PR surfaces reach
  the people who can act, at the moments they can act.)
- When the cleanup is actually taken up, should this notice invert into a
  blocking gate on major-bump PRs until the `.js` keys are removed? (Assumed
  no: the changeset note reserves a right; it does not create an
  obligation.)

## Prompt

> **Repo:** endojs/endo-but-for-bots, base `llm`. The additive
> extensionless-`exports` migration (`design-exports-extensionless-migration`)
> leaves each package with BOTH `.js` and extensionless subpath keys,
> retained for compatibility, with a changeset note reserving the right to
> remove the `.js` keys **in the next major version**. This plan gives us a
> machine reminder so that window is not missed: when a PR carries a
> **planned major bump** for such a package, release automation should
> surface that the `.js`-suffixed `exports` keys are now removable.
>
> Requirements: **Detect a planned major bump** — read the PR's pending
> changesets (`.changeset/*.md`) and identify packages declared for a
> `major` bump. **Cross-reference retained `.js` keys** — for each such
> package, check whether its `package.json` `exports` still carries
> `.js`-suffixed subpath keys that have extensionless siblings (legacy-compat
> keys left by the migration). **Surface on the PR** — if any exist, emit an
> informational, non-blocking notice on the PR (a comment or a check
> annotation) listing the removable `.js` keys per package, framed as "major
> bump → opportunity to complete the extensionless-exports cleanup."
> **Deterministic, no LLM** — runs in plain release-automation/CI code.
>
> Dependency: meaningful only after the migration's pass 1 lands the dual
> keys. Not a hard blocker to authoring, but its notice is inert until such
> packages exist.
