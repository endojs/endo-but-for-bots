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
`.js` keys **in the next major version**. (Pass 1 of the migration adds the
extensionless siblings and retains the `.js` keys. Removing those `.js` keys
later is a separate, unscheduled major bump (the event this notice exists to
prompt), not a further migration step.) That reserved window is easy to miss:
majors are rare, the note
scrolls away into the changelog, and nothing
at release time connects "this PR declares a major bump for `@endo/pkg`" with
"`@endo/pkg` still carries removable `.js` keys."

This design adds a deterministic, **non-blocking** notice to release
automation: when a pull request carries a planned major bump for a package
whose `exports` still holds `.js`-suffixed keys with extensionless siblings,
CI surfaces the removable keys as an informational annotation, framed as
"major bump: opportunity to complete the extensionless-exports cleanup." No
LLM and no gate; the check keeps no state of its own, reading pass 1's
committed manifest for provenance.

## Design

### The removable set

For a **publishable** package (see the `private` carve-out below), an exports
key `./K.js` is **removable-on-major** iff:

1. it is an explicit (non-pattern) subpath key ending in `.js`, the same
   population pass 1 migrated, so `.`, `./package.json`, other extensions
   (`.css`), and `*` pattern keys are excluded; and
2. the sibling key `./K` exists in the same map; and
3. the two values are deep-equal; and
4. **provenance:** the pair was created by the migration's pass 1, as recorded
   in pass 1's committed manifest of the keys it added (the concrete artifact
   is specified below), not merely structurally deep-equal today.

The fourth clause is not optional narrowing. It is load-bearing.
Structural deep-equality alone has a **live false positive on `llm` today**,
before pass 1 has landed anything: `packages/platform/package.json` already
carries three deep-equal dual pairs (`./fs/lite/types.js`,
`./fs/search.types.js`, `./fs/extended/backend-types.js`) that are
`node16`-resolution **type-entry aliases** a consumer plausibly imports by the
`.js` specifier, not compatibility shims the next major should drop. The
deep-equality clause cannot tell "pass-1 compat alias" from "intentional
dual key that is deep-equal by design", so structural deep-equality alone does
not stay inert until pass 1 lands packages: without a
provenance filter the check would fire on `platform` on day one. Pass 1's manifest is the discriminator;
this check enumerates the intersection of that manifest with the still-present
dual pairs.

**The manifest is a concrete, committed artifact, and emitting it is a required
addition to pass 1's design (PR #663).** As currently written, #663 inserts the
extensionless siblings directly into each `package.json` and defines a `--check`
"gate A" that fails on a *missing* sibling; it does **not** yet emit or persist
any record of which `.js` keys it retained. This design cannot read run state
from a codemod that ran (potentially months) earlier in an unrelated CI job, so
the provenance signal must be a durable file that pass 1 checks in. This design
therefore specifies it and adds it to #663's scope: a repo-root
`.exports-migration-manifest.json`, written by pass 1's codemod in the same
commit that inserts the siblings, mapping each touched package name to the
`.js` subpath keys pass 1 retained for compatibility **paired with the exact
`exports` value each key carried at creation time** (keys sorted):

```json
{
  "@endo/codec": { "./codec.js": "./src/codec.js" },
  "@endo/pkg": { "./bar.js": "./src/bar.js", "./foo.js": "./src/foo.js" }
}
```

A colocated per-package alternative was weighed (a `package.json` field
recording the same fact) and rejected: it travels with a rename (a live
concern, `daemon-rename-to-manager` is a pending row) and avoids a second
repo-root dotfile, but it puts pass-1 provenance inside the very file a later
major edits to *remove* the `.js` keys, so the record and the thing it vouches
for share one mutable place and a careless removal drops the provenance with
the key. A central manifest keeps provenance in a file no later cleanup
touches. The concurrent-PR-conflict cost of one aggregate file that every pass-1
commit rewrites is real but bounded (pass 1 is a single migration wave, not
continuous) and is the price of that separation.

Recording the creation-time value, not just the key name, binds provenance to
the fact that made it true. `exports` is mutable place-data: a key can be
deleted and, much later, re-added under the identical string for an unrelated
reason. Keying provenance on the name alone would let the never-edited manifest
assert pass-1 provenance for that unrelated re-creation: the very false
positive the guard exists to prevent. A key is therefore flagged only when it
is in the manifest **and** its current value still deep-equals the recorded
creation-time value, so a delete-then-recreate under a new value is not
mistaken for a pass-1 artifact.

The manifest is **immutable provenance**: it is an append-only historical record
of what pass 1 did, written once per package by pass 1 and never edited
afterward. In particular it is **not** the opt-out knob (that is a separate
suppression list, below); conflating the two would make the file stop truthfully
answering "what did pass 1 create?" for its other consumer, the codemod's own
`--check` gate A, which reads the same manifest.
The check **fails closed on missing provenance**: a `.js` key with no entry in
the manifest is never flagged, even when it is structurally deep-equal to an
extensionless sibling today. There is deliberately **no** parse-the-changeset-note
fallback. A free-form changelog note has no machine-parseable key-list grammar
(the repo's actual `.changeset/*.md` bodies are prose paragraphs), and a prose
parser reliable enough to assert "pass 1 created this exact key" without
reintroducing the `platform` `.types.js` false positive is a harder problem
than the manifest it would stand in for, so specifying such a parser to the
same rigor as the frontmatter grammar is not worth its risk. Until #663 both
lands and is amended to emit the manifest, the notice simply finds nothing,
which is its correct inert behavior before any pass-1 package exists.
Confirming #663 emits the manifest in the shape specified here is a named
prerequisite in the test plan.

**Opting out is a separate suppression list, never a manifest edit.** A package
that deliberately keeps a compatibility `.js` key past a major (a reserved
right, not an obligation) would otherwise see the notice fire at every future
major. Silencing it must not corrupt the immutable manifest, so the opt-out is
a distinct, mutable `.exports-migration-suppressions.json`, mapping each package
name to the list of `.js` keys to silence, consumed **only** by this notice's
provenance filter, never by gate A. It deliberately shares the
`.exports-migration-` prefix with the manifest so a maintainer scanning
repo-root dotfiles reads the paired provenance/override files as one subsystem
from the filenames alone: the immutable `-manifest` and the hand-editable
`-suppressions`. A key present in the manifest but listed in suppressions is
skipped by the notice while the manifest still records, truly, that pass 1
created it.

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
questions: gate A wants the orphaned keys, this check wants the matched,
in-manifest pairs. A single list named "dual pairs" would not distinguish the
two, so the helper returns a classification instead:
`classifyExportSubpaths(exportsMap, manifest) -> { matched, orphaned }`, whose
two sibling fields name the same category (in-manifest `.js` keys, partitioned
by whether their extensionless sibling is present) at the same level. `matched`
is the deep-equal in-manifest pairs **before** the caller applies
private-package exclusion and the `.exports-migration-suppressions.json` filter,
so it is not itself the final removable set; the caller narrows it. It is
consumed by the pass-1 codemod's `--check` mode and by this check. If the
codemod lands first without the helper, this work will factor it out of
`scripts/codemod-exports-extensionless.mjs`.

### Detecting a planned major bump: two surfaces, one core

Changesets accumulates one intent file per change under `.changeset/`, each
naming the packages it bumps and at what level (`major`/`minor`/`patch`); the
`changesets/action` bot batches the pending files into a "Version Packages"
PR that applies the bumps and, once merged, cuts the release tags. The two
surfaces below hook the two ends of that pipeline, and both classify a bump
as breaking through one shared breaking-bump core so their criteria cannot
drift. It is exposed as **two named entry points over that core**,
`isBreakingBump(bumpLevel, currentVersion)` for surface 1 and
`isBreakingVersionChange(oldVersion, newVersion)` for surface 2, so neither
call site is a `(string, string)` pair whose meaning switches on which surface
it sits in (see Design Decision 4).

**Surface 1: the contributor PR that declares the major (the early
reminder).** On `pull_request`, diff against the merge base and collect the
`.changeset/*.md` files the PR **adds or modifies** (never
`.changeset/README.md`). Parse each changeset's leading `---`-fenced YAML
frontmatter block for `<pkg>: <bump>` entries, accepting the package key in
three spellings: single-quoted
(`'@endo/cbor': major`, what `changeset add` emits) and **double-quoted**
(`"@endo/captp": minor`, five hand-written entries across
`.changeset/graceful-captp-shutdown.md`, `http-confine-core.md`,
`http-web-seed-content.md`, `tar-writer-web-seed-provide.md`, and
`http-client-initial.md`), both attested in the repo today, plus bare/unquoted,
handled defensively: it is valid YAML and cheap to accept, though a survey of
every `.changeset/*.md` frontmatter block on `HEAD` turns up no bare/unquoted
entry in the repo today. A
grammar fixed to any one spelling would silently drop the others, and because
zero findings exits 0 (below), that miss is invisible; a survey of every
`.changeset/*.md` frontmatter block on the branch, not one exemplar, is what
fixes the grammar. Only entries inside the fenced block count: a body line that
merely looks like an entry (a double-quoted phrase followed by a colon, e.g.
`add-endo-ocapn-iroh.md`'s `"Dial keys, not IPs": ...` prose) must not register
as a package, and a file whose first line is an entry with no opening `---`
fence (`.changeset/lucky-planes-resolve.md`) is malformed frontmatter, not a
bare-key changeset. Treat an entry as breaking through
`isBreakingBump(bumpLevel, currentVersion)`, which is true for `major`, and for
`minor` when the package's current `package.json` `version` has a `0` major
(the 0.x breaking convention). Sharing the core is deliberate: without the 0.x
clause the early reminder would silently miss exactly the pre-1.0 breaking
bumps the late gate catches. The workspace has 19 publishable packages at
`0.x`. (Counting the `private` packages too, which carry `version` bumps
under `privatePackages.version` but this check excludes, 68 of the 123 total
workspace packages are at `0.x`; the notice acts on the 19 publishable ones.)
Scoping to the PR's own changesets, rather than everything pending on the
branch (which is what `changeset status` reports), keeps one long-lived
pending major changeset from spamming every unrelated PR on the branch.

**Surface 2: the Changesets release PR (the reminder of record).** The
`changesets/action` "Version Packages" PR (head branch `changeset-release/*`,
per `.github/workflows/release.yml`) *consumes* the changeset files, so
surface 1 is blind there, and that PR is the last deterministic gate before
tags are pushed. On that branch shape the check instead diffs each changed
workspace `package.json` `version` against the merge base and feeds the
`(oldVersion, newVersion)` pair to `isBreakingVersionChange`: breaking iff the
major component increased, or the major is `0` and the minor increased (the
0.x breaking convention). Acting on this surface's notice means holding the
Version Packages PR and landing the key removal on the base branch, then
regenerating the PR: `changeset version` has already consumed the changesets
and written `CHANGELOG.md`, so a removal committed straight into the PR would
ship undocumented, and `changesets/action` force-pushes `changeset-release/*`
on each run, so a commit added there is not durable. The base-branch removal is
documented the ordinary way (it carries its own `major` changeset for the
package, which the next Version Packages run folds into the changelog), so
"land it on the base branch" is not itself the undocumented path it replaces.
This is folded into the "Which branch actually cuts releases" prerequisite below.

**Which branch actually cuts releases.** Surface 2 must be pinned to the
branch this fork's own tag-cutting really runs from before it is relied on as
the closing gate. `.github/workflows/release.yml` triggers only on `push` to
`master` and `.changeset/config.json` sets `baseBranch: master`, yet this
fork develops on `llm`, and observed releases have arrived by merging
upstream `endojs/endo` history into `llm` rather than through this fork's own
`master` pipeline. The confirmation question is not merely "does the release
pipeline run" but the sharper "do *this fork's own* changesets (authored on
`llm` for packages like `@endo/cbor`) ever reach a `changeset-release/*`
Version Packages PR against `master`". A `master` pipeline that is live but
only ever sees upstream-merged changesets would still never fire surface 2 for
the packages this design cares about. If that path does not exist here, surface
2 must key off whichever branch shape actually precedes this fork's own tags;
failing that, the design is surface-1-only and must say so. What it must not do
is attach to a `changeset-release/*` PR that never appears and so never fires.
Confirming this is a prerequisite of the implementation PR and a named item in
the test plan below.

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
summary need no permissions at all. The trade-off is honest about its residual
gap: for a contributor who does not habitually open the Checks tab, a
Checks-tab annotation is exactly as missable as the changeset note it
supplements. This surfacing narrows the visibility gap for the Checks-tab
audience without closing it for everyone. If that proves too weak in practice,
the lower-frequency release-PR gate (surface 2) could later request
`pull-requests: write` for a sticky comment on that surface alone, without
granting write to the high-frequency contributor-PR path.

The job **exits 0 whenever it runs to completion, findings or not**:
non-blocking is a property of the design, not a `continue-on-error` flag. A
genuine script crash still turns the (dedicated, clearly named) job red; an
informational check whose breakage is invisible would silently rot.

### The script and its wiring

`scripts/check-major-bump-exports-notice.mjs`, plain Node, no dependencies,
no install step:

1. Run `git diff --name-status <merge-base>...HEAD` to find candidate files.
2. Select the surface from an explicit `--mode` flag whose values name the
   user-facing surface, not the parsing technique: `--mode pr` runs surface 1
   (parse the added/modified changesets), `--mode release` runs surface 2 (diff
   workspace `package.json` versions), and the default `--mode auto` sniffs the
   head branch (`changeset-release/*` resolves to `release`, otherwise `pr`).
   The flag ships one canonical spelling per value, no parse-technique aliases;
   if a mode ever needs invoking by a parsing-technique name in practice, an
   alias can be added then, with a stated reason.
   Because the mode is a passed value and not read only from the branch name,
   surface 1 is forceable on any branch. A companion `--base <ref>` flag names
   the ref to diff against for the selected surface; in CI it is the
   checked-out merge-base commit, and it defaults to that when omitted.
   Empty input is a legitimate zero-finding outcome under **every** mode: the
   exit code depends on the state of the world, not on whether the mode was
   typed or inferred. A surface with no candidate inputs (a contributor PR that
   edits a `package.json` but adds no changeset, or a maintainer running
   `--mode release` on a branch with no version diffs) logs the liveness line
   to the step summary and exits 0, never a red check, so the invariant above
   holds with no "how was the mode chosen" special case. A caller that genuinely
   wants "you asked me to look and there was nothing to look at" as a hard error
   opts into it explicitly with `--require-findings`, which is off by default and
   never set in CI. The frontmatter grammar is the leading
   `---`-fenced block, and within it each `<pkg>: <bump>` line whose package key
   is single-quoted, double-quoted, or bare (the three spellings described in
   "Surface 1"); a small line parser covers all three, only lines between the
   opening and closing `---` are considered, and malformed lines are reported in
   the step summary and skipped rather than trusted.
3. Map breaking-bumped package names to workspace directories, run
   `classifyExportSubpaths` on each package's `exports`, and anchor the
   annotation on the line where the removable key is **defined as a key**. Plain
   `JSON.parse` discards source positions, so this does take one pass over the
   source text, but a targeted one, not the naive "first `.js` substring"
   scan that mis-anchors (a `.js` key can also appear as a *value* line, and
   after pass 1 the extensionless sibling's value line can precede its `.js`
   key). The pass is a small, dependency-free key-position scan: it matches the
   exact key token at the start of an `exports` entry (the JSON string
   `"./K.js"` immediately followed by `:`), which distinguishes a key
   occurrence from a value occurrence without pulling in a position-tracking
   JSON parser. This is a handful of lines and is folded into the "1-2 days"
   estimate.
4. Emit the annotations and the summary; exit 0. On zero findings still emit
   one liveness line to the step summary naming the surface that ran ("surface
   1 (`pr`): N breaking bumps considered, M publishable packages with removable
   keys") so "found nothing" is distinguishable from "did not run" and from
   "`auto` picked the other surface". Because the check **fails closed on a
   missing manifest** (a permanent state until #663 lands and is amended), that
   same liveness line reports **manifest presence and entry count** ("provenance
   manifest: present, 12 packages" / "provenance manifest: absent (inert until
   `exports-extensionless-migration` pass 1 lands)"): a fail-closed zero caused by
   an absent provenance input must not read identically to a healthy zero, or
   the design's own "silently rots" hazard reappears in the one output meant to
   prevent it.

Wiring: a dedicated job (`major-bump-exports-notice`) in a small separate
workflow on `pull_request` with a path filter (`.changeset/**`,
`packages/**/package.json`), a checkout deep enough to reach the merge base,
actions pinned by SHA, and workflow-level `permissions: {}` per repo
convention (see `release.yml` and the posture in
[ci-no-npm-lifecycle](ci-no-npm-lifecycle.md)).
Runtime is seconds: checkout, Node, one script, no `yarn install`.

Local reproduction, surface 1 (a contributor PR against `llm`):
`node scripts/check-major-bump-exports-notice.mjs --mode pr --base
origin/llm` prints the same report as plain text. Surface 2, the higher-stakes
release-PR gate: `node scripts/check-major-bump-exports-notice.mjs --mode
release --base <release-branch-parent>` exercises the `package.json`
version-diff path against the same base the release PR would diff from. Omitting
`--mode` (that is, `auto`) sniffs the branch shape, matching CI.

### Test plan

- Unit tests (ava) live at `scripts/test/check-major-bump-exports-notice.test.mjs`
  and are **wired into CI** the way the repo actually runs script tests: a
  `test:major-bump-exports-notice` root-`package.json` script (`ava
  scripts/test/check-major-bump-exports-notice.test.mjs`) invoked from
  `.github/workflows/ci.yml` beside the existing
  `yarn test:package-uniformity` (ci.yml line 92), the repo's *wired*
  script-test precedent (`scripts/test/check-package-uniformity.test.mjs`), not
  the unreferenced `scripts/generate-composite-tsconfigs.test.mjs`, which no
  script or workflow invokes and would leave these tests never running in CI.
  Fixtures cover: changeset-frontmatter parsing across all three parsed key
  spellings (single-quoted `'@endo/cbor': major`, double-quoted
  `"@endo/captp": minor`, and defensively-handled bare/unquoted), each with the
  entry inside a
  proper `---` fence; and the two malformed shapes that must **not** register a
  package: a body line that looks like an entry (`"Dial keys, not IPs": ...`), and
  a file whose first line is an entry with no opening `---` fence (the
  `lucky-planes-resolve.md` shape); plus ordinary malformed lines.
  `classifyExportSubpaths` (dual
  in-manifest pairs, diverged values, out-of-manifest deep-equal pairs such as
  `platform`'s `.types.js` aliases, `private`-package exclusion, pattern keys,
  string versus conditional-object values), and the 0.x breaking rule proven
  identical on both entry points (`isBreakingBump` over a `<bump>` plus the
  package's current version (`0.x` or not), and `isBreakingVersionChange` over an
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
- Confirm the provenance source before relying on it: verify PR #663 emits the
  committed `.exports-migration-manifest.json` in the shape specified here (each
  key paired with its creation-time value), and amend #663's design if it does
  not. There is no changeset-note fallback: on a missing manifest entry the
  check fails closed (flags nothing), never falling back to bare structural
  deep-equality, which would reintroduce the `platform` `.types.js` false
  positive. Fixture both fail-closed paths: a deep-equal pair with no manifest
  entry (not flagged), and an in-manifest key whose current value has diverged
  from the recorded creation-time value (not flagged).

## Dependencies

| Design | Relationship |
|--------|--------------|
| `exports-extensionless-migration` (forthcoming, PR #663; not yet on `llm`) | Prerequisite in effect: its pass 1 creates the dual keys this check enumerates, and its gate A shares the `classifyExportSubpaths` helper and pass-1 manifest. **Required amendment to #663:** #663 as written does not emit a manifest of the keys pass 1 retained; this design adds emitting the committed `.exports-migration-manifest.json` (format in "The removable set") to #663's scope. If #663 lands before that amendment, this check flags nothing: it fails closed on a missing manifest, with no changeset-note fallback. Authoring and landing this check is not blocked, but the notice is inert until pass-1 packages (and their manifest) exist, because the provenance clause fires only on keys the manifest records. |

## Design Decisions

1. **Annotations plus step summary, not a PR comment.** Zero permissions,
   zero comment churn; the signal is informational.
2. **Diff-scoped changeset detection.** Only changesets the PR itself adds
   or modifies trigger surface 1; pending majors elsewhere on the branch do
   not spam unrelated PRs.
3. **Two surfaces.** The contributor PR is the early reminder; the Version
   Packages PR is the reminder of record. Whether this fork actually cuts
   releases through a `changeset-release/*` Version Packages PR is unconfirmed;
   the mechanics of acting on surface 2 (hold the PR, land the removal on the
   base branch) and the surface-1-only fallback are stated in "Surface 2" and
   "Which branch actually cuts releases" above, and confirming which holds is a
   prerequisite of the implementation PR.
4. **One shared breaking-bump core, two named entry points.** Both surfaces
   classify through one core, exposed as `isBreakingBump(bumpLevel,
   currentVersion)` and `isBreakingVersionChange(oldVersion, newVersion)` so
   neither call site is a `(string, string)` pair whose meaning switches on
   context; the 0.x breaking convention holds identically at the early reminder
   and the late gate rather than the two paths converging only because surface
   2 backstops surface 1.
5. **Deep-equality plus provenance guard.** A pair is flagged only when it is
   deep-equal *and* recorded in pass 1's manifest, so intentionally diverged
   pairs and pre-existing type-entry aliases (for example, `platform`'s
   `.types.js` keys) are never flagged, and the notice self-quiets once the
   cleanup ships.
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
  it need an explicit per-key opt-out? (Assumed acceptable, and the opt-out
  already exists if wanted: the `.exports-migration-suppressions.json` list
  described in "The removable set" silences a key without diverging its values
  and without touching pass 1's immutable manifest. The suppression list, not
  the manifest, is the opt-out knob; the manifest stays a truthful record of
  what pass 1 created.)

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
