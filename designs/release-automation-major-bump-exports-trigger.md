# Release Automation: `.js` Exports-Key Cleanup Notice on Major Bumps

| | |
|---|---|
| **Created** | 2026-07-10 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Not Started |

## What is the Problem Being Solved?

Pass 1 of `exports-extensionless-migration` (in flight as PR #663; not yet on
`llm`, so its design file is cited by name here, not linked, until it lands)
leaves every migrated package with dual `exports` keys: the `.js`-suffixed key
(`./foo.js`) retained for compatibility beside the new extensionless sibling
(`./foo`), with a standing changeset note reserving the right to remove the
`.js` keys **in the next major version**. (The migration is two passes: pass 1
adds the extensionless siblings and retains the `.js` keys; removing the `.js`
keys is a later, unscheduled major, which this notice exists to prompt, not
pass 2.) That reserved window is easy to miss: majors are rare, the note
scrolls away into the changelog, and nothing
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

For a **publishable** package (see the `private` carve-out below), an exports
key `./K.js` is **removable-on-major** iff:

1. it is an explicit (non-pattern) subpath key ending in `.js`, the same
   population pass 1 migrated, so `.`, `./package.json`, other extensions
   (`.css`), and `*` pattern keys are excluded; and
2. the sibling key `./K` exists in the same map; and
3. the two values are deep-equal; and
4. **provenance:** the pair was created by the migration's pass 1, recorded in
   the migration's own manifest of the keys it added, not merely structurally
   deep-equal today.

The fourth clause is not optional narrowing. It is load-bearing.
Structural deep-equality alone has a **live false positive on `llm` today**,
before pass 1 has landed anything: `packages/platform/package.json` already
carries three deep-equal dual pairs (`./fs/lite/types.js`,
`./fs/search.types.js`, `./fs/extended/backend-types.js`) that are
`node16`-resolution **type-entry aliases** a consumer plausibly imports by the
`.js` specifier, not compatibility shims the next major should drop. The
deep-equality clause cannot tell "pass-1 compat alias" from "intentional
dual key that is deep-equal by design", so the earlier claim that the notice
is "inert until pass-1 packages exist" was false: without a provenance filter
it would fire on `platform` on day one. Pass 1's manifest (the record of which
`.js` keys it retained for compatibility) is the discriminator; this check
enumerates the intersection of that manifest with the still-present dual pairs.

**Private packages are out of scope.** `.changeset/config.json` sets
`privatePackages: {version: true, tag: true}`, so private packages carry
changeset entries and version bumps, and roughly half the `0.x` workspace is
`private`. An unpublished package has no compatibility window at all (its
`.js` keys can go at any time, not only at a major), so "wait for the major"
is the wrong advice there and the notice would be noise across half the tree.
The removable set is computed only for packages whose `package.json` is not
`private`.

A worked example. Given

```jsonc
"exports": {
  "./codec": "./src/codec.js",       // extensionless sibling (pass-1 output)
  "./codec.js": "./src/codec.js",     // retained .js key, deep-equal -> removable
  "./types.js": "./types.d.ts",       // no "./types" sibling -> NOT removable
  "./legacy": "./src/legacy-v2.js"    // "./legacy.js" absent -> NOT removable
}
```

only `./codec.js` is removable-on-major (and only if pass 1's manifest lists
it): `./types.js` has no extensionless sibling, and `./legacy` is
extensionless already. Once a major deletes `./codec.js` the set is empty and
the notice self-quiets. Zero findings means zero output; there is no state to
disarm.

This predicate is the complement of the migration's **gate A** (which fails
when a *pass-1-migrated* `.js` key lacks a deep-equal extensionless sibling).
Both walk the same structure and read the same manifest, so the enumeration
lives in one shared, dependency-free helper,
`scripts/lib/extensionless-exports.mjs`. The two consumers ask opposite
questions (gate A wants the orphaned keys, this check wants the matched,
in-manifest pairs), so rather than a single list whose name promises only "dual
pairs", the helper returns a classification, `classifyExportSubpaths(exportsMap,
manifest) -> { dual, orphaned }`. It is consumed by the pass-1 codemod's
`--check` mode and by
this check. If the codemod lands first without the helper, this work factors it
out of `scripts/codemod-exports-extensionless.mjs`.

### Detecting a planned major bump: two surfaces, one core

Changesets accumulates one intent file per change under `.changeset/`, each
naming the packages it bumps and at what level (`major`/`minor`/`patch`); the
`changesets/action` bot batches the pending files into a "Version Packages"
PR that applies the bumps and, once merged, cuts the release tags. The two
surfaces below hook the two ends of that pipeline, and both classify a bump
as breaking through one shared breaking-bump core so their criteria cannot
drift. It is exposed as **two named entry points over that core**,
`isBreakingChangeset(bump, currentVersion)` for surface 1 and
`isBreakingVersionBump(oldVersion, newVersion)` for surface 2, so neither
call site is a `(string, string)` pair whose meaning switches on which surface
it sits in (see Design Decision 4).

**Surface 1: the contributor PR that declares the major (the early
reminder).** On `pull_request`, diff against the merge base and collect the
`.changeset/*.md` files the PR **adds or modifies** (never
`.changeset/README.md`). Parse each changeset's YAML frontmatter for
`'<pkg>': <bump>` entries. That single-quoted spelling is what `changeset add`
actually emits (`.changeset/add-endo-cbor.md`: `'@endo/cbor': major`); a
parser written to a double-quoted grammar would match zero real changesets and
surface 1 would silently never fire. Treat an entry as breaking through
`isBreakingChangeset(bump, currentVersion)`, which is true for `major`, and for
`minor` when the package's current `package.json` `version` has a `0` major
(the 0.x breaking convention). Sharing the core is deliberate: without the 0.x
clause the early reminder would silently miss exactly the pre-1.0 breaking
bumps the late gate catches, and the workspace has 19 publishable packages at
`0.x` (68 of 123 counting the `private` packages `privatePackages.version`
bumps but this check excludes).
Scoping to the PR's own changesets, rather than everything pending on the
branch (which is what `changeset status` reports), keeps one long-lived
pending major changeset from spamming every unrelated PR on the branch.

**Surface 2: the Changesets release PR (the reminder of record).** The
`changesets/action` "Version Packages" PR (head branch `changeset-release/*`,
per `.github/workflows/release.yml`) *consumes* the changeset files, so
surface 1 is blind there, and that PR is the last deterministic gate before
tags are pushed. On that branch shape the check instead diffs each changed
workspace `package.json` `version` against the merge base and feeds the
`(oldVersion, newVersion)` pair to `isBreakingVersionBump`: breaking iff the
major component increased, or the major is `0` and the minor increased (the
0.x breaking convention). Acting on this surface's notice means holding the
Version Packages PR and landing the key removal on the base branch, then
regenerating the PR: `changeset version` has already consumed the changesets
and written `CHANGELOG.md`, so a removal committed straight into the PR would
ship undocumented, and `changesets/action` force-pushes `changeset-release/*`
on each run, so a commit added there is not durable. This is folded into the
"Which branch actually cuts releases" prerequisite below.

**Which branch actually cuts releases.** Surface 2 must be pinned to the
branch this fork's own tag-cutting really runs from before it is relied on as
the closing gate. `.github/workflows/release.yml` triggers only on `push` to
`master` and `.changeset/config.json` sets `baseBranch: master`, yet this
fork develops on `llm`, and observed releases have arrived by merging
upstream `endojs/endo` history into `llm` rather than through this fork's own
`master` pipeline. If `master`/`release.yml` is not a live publish path here,
surface 2 must key off whichever branch shape actually precedes this fork's
tags. Failing that, the design is surface-1-only and must say so. What it must
not do is attach to a `changeset-release/*` PR that never appears and so never
fires. Confirming this is a prerequisite of the implementation PR and a named
item in the test plan below.

Both surfaces feed the same reporting core. If the notice is ignored on the
contributor PR it reappears on the release PR; if it is ignored there too,
the maintainer has made an informed choice, which is all a non-blocking
notice can and should achieve.

### Surfacing: annotations and a step summary, not a comment

On findings the check emits:

- one **check annotation** per affected package, via the workflow command
  `::notice file=packages/<dir>/package.json,line=<line of the first
  removable key>,title=Major bump: removable .js exports keys::<key list>`,
  always visible in the PR's Checks tab, and inlined on the Files-changed
  view only when the annotated `package.json` is itself part of the PR's diff
  (surface 2, which diffs `package.json`; not surface 1, whose PR touches
  only `.changeset/*.md`, leaving the annotation in the Checks tab alone); and
- a **`$GITHUB_STEP_SUMMARY`** markdown table (package, removable `.js`
  keys, and a pointer to `exports-extensionless-migration` (forthcoming,
  PR #663) and its standing changeset note) so the full list survives even
  when the
  annotation message is truncated.

Considered and rejected: a sticky PR comment. Reason: it requires
`pull-requests: write` on a `pull_request`-triggered workflow (the repo's CI
workflows grant no write permissions), and bot-comment churn is noisier than
annotations for a purely informational signal. Annotations and the step
summary need no permissions at all.

The job **exits 0 whenever it runs to completion, findings or not**:
non-blocking is a property of the design, not a `continue-on-error` flag. A
genuine script crash still turns the (dedicated, clearly named) job red; an
informational check whose breakage is invisible would silently rot.

### The script and its wiring

`scripts/check-major-bump-exports-notice.mjs`, plain Node, no dependencies,
no install step:

1. Run `git diff --name-status <merge-base>...HEAD` to find candidate files.
2. Select the surface from an explicit `--mode auto|changesets|versions` flag
   (default `auto`): `versions` diffs workspace `package.json` versions,
   `changesets` parses the added/modified changesets, and `auto` sniffs the
   head branch (`changeset-release/*` means `versions`, otherwise
   `changesets`). The mode is passed as a value, not read only from the branch
   name, so surface 1 is forceable on any branch and a mode with no candidate
   inputs is an **error, not a quiet pass** (a `versions` run on a branch with
   no version diffs, or a `changesets` run with no changesets, exits non-zero
   with a diagnostic rather than reporting zero findings). The frontmatter
   grammar is the constrained single-quoted `'<pkg>': <bump>` block that
   `changeset add` writes; a small line parser covers it, and malformed lines
   are reported in the step summary and skipped rather than trusted.
3. Map breaking-bumped package names to workspace directories, run
   `classifyExportSubpaths` on each package's `exports`, and anchor the
   annotation by the **parsed key's position inside the `exports` map** (not a
   raw-text scan for the first `.js` substring, which mis-anchors: a `.js` key
   can also appear as a *value* line, and after pass 1 the extensionless
   sibling's value line can precede its `.js` key).
4. Emit the annotations and the summary; exit 0. On zero findings still emit
   one liveness line to the step summary ("N breaking bumps considered, M
   publishable packages with removable keys") so "found nothing" is
   distinguishable from "did not run".

Wiring: a dedicated job (`major-bump-exports-notice`) in a small separate
workflow on `pull_request` with a path filter (`.changeset/**`,
`packages/**/package.json`), a checkout deep enough to reach the merge base,
actions pinned by SHA, and workflow-level `permissions: {}` per repo
convention (see `release.yml` and the posture in
[ci-no-npm-lifecycle](ci-no-npm-lifecycle.md)).
Runtime is seconds: checkout, Node, one script, no `yarn install`.

Local reproduction, surface 1 (a contributor PR against `llm`):
`node scripts/check-major-bump-exports-notice.mjs --mode changesets --base
origin/llm` prints the same report as plain text. Surface 2, the higher-stakes
release-PR gate: `node scripts/check-major-bump-exports-notice.mjs --mode
versions --base <release-branch-parent>` exercises the `package.json`
version-diff path against the same base the release PR would diff from. Omitting
`--mode` (i.e. `auto`) sniffs the branch shape, matching CI.

### Test plan

- Unit tests (ava, colocated under `scripts/` per the
  `generate-composite-tsconfigs.test.mjs` precedent) over fixtures:
  changeset-frontmatter parsing (major/minor/patch, single-quoted names, with
  one fixture copied verbatim from an existing `.changeset/*.md` such as
  `'@endo/cbor': major`, and malformed lines), `classifyExportSubpaths` (dual
  in-manifest pairs, diverged values, out-of-manifest deep-equal pairs such as
  `platform`'s `.types.js` aliases, `private`-package exclusion, pattern keys,
  string versus conditional-object values), and the 0.x breaking rule proven
  identical on both entry points (`isBreakingChangeset` over a `<bump>` plus the
  package's current `0.x`-or-not version, and `isBreakingVersionBump` over an
  `(oldVersion, newVersion)` pair).
- The two steps most likely to fail silently get their own fixtures: the
  breaking-bumped-package-name to workspace-directory mapping, and the
  annotation anchor (the parsed-key position inside `exports`, verified on a
  `package.json` where a `.js` key also appears as a value line).
- One live probe after pass 1 lands: a scratch PR adding a `major` changeset
  for a migrated package must produce the annotation and summary; a sibling
  `minor`-only scratch PR must produce neither, except for a `0.x` package,
  where the `minor` changeset must also produce the notice.
- Confirm which branch this fork's tag-cutting workflow actually triggers
  from (per "Which branch actually cuts releases" above) and, if it is a
  `changeset-release/*` PR, add a fixture exercising surface 2's branch-shape
  detection and version-diff path; otherwise repoint surface 2 to the real
  release branch shape or record the design as surface-1-only.

## Dependencies

| Design | Relationship |
|--------|--------------|
| `exports-extensionless-migration` (forthcoming, PR #663; not yet on `llm`) | Prerequisite in effect: its pass 1 creates the dual keys this check enumerates, and its gate A shares the `classifyExportSubpaths` helper and pass-1 manifest. Authoring and landing this check is not blocked, but the notice is inert until pass-1 packages exist, because the provenance clause fires only on keys pass 1's manifest records. |

## Design Decisions

1. **Annotations plus step summary, not a PR comment.** Zero permissions,
   zero comment churn; the signal is informational.
2. **Diff-scoped changeset detection.** Only changesets the PR itself adds
   or modifies trigger surface 1; pending majors elsewhere on the branch do
   not spam unrelated PRs.
3. **Two surfaces.** The contributor PR is the early reminder; the Version
   Packages PR is the reminder of record. It is the last deterministic point
   before tags where the cleanup can still join the major, but acting on it
   means holding the Version Packages PR and landing the removal on the base
   branch, because the PR's own commits are not durable (`changesets/action`
   force-pushes the branch) and land after `CHANGELOG.md` is written.
4. **One shared breaking-bump core, two named entry points.** Both surfaces
   classify through one core, exposed as `isBreakingChangeset(bump,
   currentVersion)` and `isBreakingVersionBump(oldVersion, newVersion)` so
   neither call site is a `(string, string)` pair whose meaning switches on
   context; the 0.x breaking convention holds identically at the early reminder
   and the late gate rather than the two paths converging only because surface
   2 backstops surface 1.
5. **Deep-equality plus provenance guard.** A pair is flagged only when it is
   deep-equal *and* recorded in pass 1's manifest, so intentionally diverged
   pairs and pre-existing type-entry aliases (e.g. `platform`'s `.types.js`
   keys) are never flagged, and the notice self-quiets once the cleanup ships.
6. **Exit 0 on findings by construction.** Non-blocking is a property of the
   design, not a `continue-on-error` flag, so real crashes stay visible.
7. **Install-free, dependency-free script.** The constrained changeset
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
- A package that deliberately keeps a compatibility `.js` key past a major
  (a reserved right, not an obligation) will see the notice fire at *every*
  future major. Is that acceptable as a standing, ignorable reminder, or does
  it need an explicit per-key opt-out (e.g. dropping the key from pass 1's
  manifest, which the provenance clause already honors)? (Assumed acceptable:
  the manifest is the opt-out (removing a key from it silences the notice
  without diverging the values), so perpetual reminders are opt-out-able
  without a new mechanism.)

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
> Requirements: **Detect a planned major bump**: read the PR's pending
> changesets (`.changeset/*.md`) and identify packages declared for a
> `major` bump. **Cross-reference retained `.js` keys**: for each such
> package, check whether its `package.json` `exports` still carries
> `.js`-suffixed subpath keys that have extensionless siblings (legacy-compat
> keys left by the migration). **Surface on the PR**: if any exist, emit an
> informational, non-blocking notice on the PR (a comment or a check
> annotation) listing the removable `.js` keys per package, framed as "major
> bump -> opportunity to complete the extensionless-exports cleanup."
> **Deterministic, no LLM**: runs in plain release-automation/CI code.
>
> Dependency: meaningful only after the migration's pass 1 lands the dual
> keys. Not a hard blocker to authoring, but its notice is inert until such
> packages exist.
