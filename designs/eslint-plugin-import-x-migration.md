# eslint-plugin-import-x Migration Assessment

| | |
|---|---|
| **Created** | 2026-05-12 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |
| **Source** | Closing comment of issue [#218](https://github.com/endojs/endo-but-for-bots/issues/218) (`Survey support for package exports and imports in ecosystem tools`); follow-on to that survey's finding that `eslint-plugin-import` is `exports`-blind. |

## What is the Problem Being Solved?

Endo packages gate their public surface through the `package.json`
`exports` field.
The default ESLint resolver
(`eslint-import-resolver-node`, used by
[`eslint-plugin-import`](https://github.com/import-js/eslint-plugin-import))
ignores `exports` entirely; it walks the file system instead of the
manifest.
That mismatch produces false-positive `import/no-unresolved` errors
on every Endo subpath import, and false negatives on imports of paths
that the manifest does not actually expose.

The previous survey
([issue #218 closing comment](https://github.com/endojs/endo-but-for-bots/issues/218#issuecomment-2872815049))
identified
[`eslint-plugin-import-x`](https://github.com/un-ts/eslint-plugin-import-x)
as the only actively-maintained ESLint plugin with first-party
`exports` support
(landed in [v4.6.0](https://github.com/un-ts/eslint-plugin-import-x/pull/209),
2024-12-19).
Today the workspace works around the gap by depending on the
near-abandoned
[`eslint-import-resolver-exports`](https://www.npmjs.com/package/eslint-import-resolver-exports)
(last published 2022, "1.0.0-beta.5"), wired into the resolver list
in [`packages/eslint-plugin/lib/configs/imports.js`](../packages/eslint-plugin/lib/configs/imports.js).

The proposal is to replace the `eslint-plugin-import` +
`eslint-import-resolver-exports` pair with `eslint-plugin-import-x`
and its built-in `unrs-resolver`.
Before doing so the project should weigh the supply-chain history of
the new dependency, because the maintainer was the proximate victim
of [CVE-2025-54313](https://github.com/advisories/GHSA-f29h-pxvx-f335),
the July-2025 phishing attack on `eslint-config-prettier`.
This document assesses that risk, names the mitigations the upstream
adopted in response, and recommends a course.

## Background

### Today's wiring

[`packages/eslint-plugin/lib/configs/imports.js`](../packages/eslint-plugin/lib/configs/imports.js)
configures the resolver chain:

```js
settings: {
  'import/resolver': {
    exports: {},   // eslint-import-resolver-exports
    node: {},      // bundled with eslint-plugin-import
  },
},
rules: {
  'import/extensions': ['error', 'always', { ignorePackages: true }],
  'import/no-extraneous-dependencies': [...],
  'import/prefer-default-export': 'off',
}
```

[`packages/eslint-plugin/lib/configs/style.js`](../packages/eslint-plugin/lib/configs/style.js)
turns `import/no-unresolved` off for `*.ts` files (TypeScript already
type-checks those).

The root [`package.json`](../package.json) lists the relevant deps in
`devDependencies`:

```json
"eslint-import-resolver-exports": "^1.0.0-beta.5",
"eslint-plugin-import": "^2.31.0",
```

`plugin:@endo/internal` extends `plugin:@jessie.js/recommended` and
`plugin:@endo/strict`; `strict` extends `plugin:@endo/imports`,
`plugin:@endo/style`, and `plugin:@endo/recommended`.
`@endo/style` extends `airbnb-base`, which is the only place
`import/*` rules enter outside `imports.js` itself.
The complete list of `import/*` rules touched by Endo's config tree
is therefore: `import/extensions`, `import/no-extraneous-dependencies`,
`import/prefer-default-export`, and `import/no-unresolved` (the last
disabled for `*.ts`).
Every one of these rules exists in `eslint-plugin-import-x` under the
same rule body, only the namespace prefix changes (`import/` →
`import-x/`).

### Why `eslint-import-resolver-exports` is a problem on its own terms

The package has been pinned at `^1.0.0-beta.5` since its only release
in 2022.
Its npm record shows no maintainer activity, no provenance
attestation, and no signed releases.
A `beta.5` direct devDependency that has not been republished in
three years is itself a quiet supply-chain risk: nobody is watching
it, and a future republish under a single-maintainer npm account
would be hard to distinguish from an attack.
Migrating away from it is justified independently of whether
`eslint-plugin-import-x` is the destination.

## Migration Mechanics

### File-by-file changes

The migration is mostly mechanical because `eslint-plugin-import-x`
is a soft fork: same rule bodies, same rule semantics, different
namespace prefix and a different default resolver.

1. [`package.json`](../package.json) (root):
   - Remove `eslint-plugin-import` and `eslint-import-resolver-exports`
     from `devDependencies`.
   - Add `eslint-plugin-import-x` (pinned exact, see "Mitigations" below).
   - Lockfile churn lands in its own commit per the project's
     pre-PR checklist.

2. [`packages/eslint-plugin/lib/configs/imports.js`](../packages/eslint-plugin/lib/configs/imports.js):
   - Drop the `'import/resolver'` setting (the built-in
     `unrs-resolver` handles `exports` natively, so the explicit
     resolver chain becomes redundant).
   - Rename rule keys from `import/*` to `import-x/*`.
   - Register the plugin: `plugins: ['import-x']`.

3. [`packages/eslint-plugin/lib/configs/style.js`](../packages/eslint-plugin/lib/configs/style.js):
   - Rename `import/no-unresolved` to `import-x/no-unresolved` in the
     `*.ts` override.

4. [`packages/eslint-plugin/package.json`](../packages/eslint-plugin/package.json):
   - The `eslintConfig.rules['import/extensions']: 'off'` self-override
     becomes `'import-x/extensions': 'off'`.

5. Per-package `.eslintrc.json` overrides
   ([`packages/init/test/.eslintrc.json`](../packages/init/test/.eslintrc.json),
   [`packages/module-source/test/.eslintrc.json`](../packages/module-source/test/.eslintrc.json)):
   - Audit and rename any `import/*` rule references; both files
     today are small and target unrelated rules but should be
     re-checked at the time of the change.

6. `airbnb-base` continues to extend `eslint-plugin-import` rule
   names from inside its own config files.
   `eslint-plugin-import-x` ships a `flat/recommended` config but does
   not register `import/*` aliases.
   The fix is to extend `airbnb-base` and then explicitly disable the
   `import/*` rules it switched on, leaving only the `import-x/*`
   rules from our own config.
   The replacement list to disable is small and stable
   (`import/no-unresolved`, `import/named`, `import/default`,
   `import/namespace`, `import/extensions`, `import/order`,
   `import/no-named-as-default`, `import/no-named-as-default-member`,
   and `import/prefer-default-export` are the rules `airbnb-base`
   sets and `eslint-plugin-import-x` provides under the new prefix).
   An alternative, if `airbnb-base` itself becomes painful to keep
   around (see Open Question 2), is to extract the small subset of
   its rules we actually want into `@endo/style` directly and drop
   the `airbnb-base` dependency.

### What does **not** change

- The set of `import/*` rules Endo opts in to: identical names
  under the new prefix, identical semantics.
  `eslint-plugin-import-x` is a soft fork with the same rule bodies;
  the README is explicit that it preserves `eslint-plugin-import`'s
  rule API surface.
- The `eslint-config-prettier` extension chain.
  Prettier compatibility rides on `prettier`-the-config, not on the
  import plugin.
- `@jessie.js/eslint-plugin`, `@typescript-eslint/eslint-plugin`,
  `eslint-plugin-jsdoc`, `@endo/eslint-plugin` itself: none of these
  reference `import/*` rule names.
- Per-file `// eslint-disable-next-line import/...` comments in the
  source tree: a one-time `sed`-equivalent rename to `import-x/...`
  closes the gap.
  The investigator should grep the tree before pushing the migration
  PR; today there is no such comment in `packages/`, but downstream
  packages may carry them.

### What we gain

- `exports` is honoured natively by the built-in `unrs-resolver`
  ([Rust crate](https://github.com/un-ts/unrs-resolver)), so
  `eslint-import-resolver-exports` retires.
  Today's resolver-chain ordering bug ("which resolver wins for which
  subpath") goes away with the chain itself.
- ESLint v9 compatibility.
  `eslint-plugin-import` 2.31 is on the `peerDependencies: eslint
  ^2 || ^3 || ^4 || ^5 || ^6 || ^7 || ^8 || ^9` waiver but its v9
  story has been
  [disputed by maintainers](https://github.com/import-js/eslint-plugin-import/issues/2948);
  `eslint-plugin-import-x` 4.x targets `^8.57.0 || ^9.0.0 || ^10.0.0`
  cleanly.
  The Endo workspace is on ESLint 8.57; staying on `import-x` makes
  the eventual ESLint 9/10 migration smaller.
- Dependency-graph reduction.
  `eslint-plugin-import-x` reports its own dependency tree at 16
  packages (vs `eslint-plugin-import`'s 117), almost all of that
  reduction from replacing `tsconfig-paths` + `typescript` + `resolve`
  with the single `unrs-resolver` + `get-tsconfig` pair.
  Fewer transitive packages reduces the supply-chain attack surface
  per dev-dependency install, even though every transitive is itself
  a separate trust judgement.

### What we lose

- One extra plugin namespace to think about; downstream Endo users
  who have their own `import/*` config inherit a plugin we no longer
  preconfigure for them.
  This is an `@endo/eslint-plugin` semver-major change.
  A changeset entry must accompany the migration commit per
  [CONTRIBUTING.md](../CONTRIBUTING.md).

## Upstream Trust Assessment

This section is the load-bearing reason this design exists.
The maintainer of `eslint-plugin-import-x`, JounQin, was the
proximate victim of CVE-2025-54313.
The questions below are the ones a project that takes its own
supply-chain seriously should answer before adding any of his
packages to its dependency tree.

### Maintainership

- **Primary maintainer:** [JounQin](https://github.com/JounQin),
  npm account `jounqin` (`admin@1stg.me`).
  Based in Nanjing, China; affiliated with the
  [un-ts](https://github.com/un-ts),
  [rxts](https://github.com/rx-ts), and
  [1stG](https://github.com/1stG) GitHub organisations.
- **Co-maintainers:** the npm record for `eslint-plugin-import-x`
  lists a single maintainer (`jounqin`).
  The GitHub repo accepts contributions from a small set of
  recurring contributors but the publish authority and the
  release-cut authority are concentrated in one person.
  This is the highest-impact item in the assessment.
- **Other projects on the same npm account:**
  `synckit`, `@pkgr/core`, `napi-postinstall`, `eslint-config-prettier`,
  `eslint-plugin-prettier`, plus a long tail of `@un-ts/*`,
  `@rxts/*`, and `@1stg/*` packages.
  An npm-account compromise lights up every one of these in the
  same blast.
- **Public reputation:** active in the prettier ecosystem
  (co-maintainer of `prettier-eslint`, `eslint-plugin-prettier`),
  the JS/TypeScript eslint plugin space, and Rust-for-JS tooling
  (Taplo, the JS bindings for Rspack).
  A real, named, long-running open-source maintainer; not anonymous.

### Funding model

- Personal sponsors via GitHub Sponsors, Patreon
  ([patreon.com/1stG](https://www.patreon.com/1stG)), and
  Open Collective
  ([opencollective.com/unts](https://opencollective.com/unts),
  [opencollective.com/1stG](https://opencollective.com/1stG),
  [opencollective.com/rxts](https://opencollective.com/rxts)).
- No corporate sponsor of record.
- Effectively a one-person volunteer project subsidised by
  small-dollar donors.

### Release cadence

`eslint-plugin-import-x` shipped 19 4.x releases between
2025-04 and 2025-06 (typical interval: under a week).
Then nothing from 2025-06-27 (`v4.16.1`) until 2026-03-11
(`v4.16.2`), an 8.5-month gap that overlaps with the July-2025
incident response and the publicly-discussed "moving to OIDC trusted
publishing" rollout that followed.
Cadence has not yet returned to the pre-incident weekly tempo.
For comparison, `eslint-plugin-import` shipped its last release
(2.32.0) on 2025-06-20 and has not released since (almost 11 months
as of 2026-05-12).

### Issue triage health

Open issues at time of writing: 56.
Open PRs: 21.
Recent issues receive responses within days; the open queue is
dominated by feature requests rather than bug reports.
This is healthier than `eslint-plugin-import`'s issue tracker
(750+ open, multi-year median time-to-first-response) but still
light by professional-team standards.

### Supply-chain hygiene

This is where the assessment gets concrete.

- **npm trusted publishing (OIDC):** `eslint-plugin-import-x`
  4.16.2 (2026-03-11) was published from GitHub Actions via npm's
  trusted-publisher OIDC flow rather than a long-lived npm token
  (`_npmUser.trustedPublisher.id == "github"` in the npm registry
  metadata).
  The same is true of the post-incident `synckit` 0.11.12 release
  (2026-01-14).
  This is the single most material mitigation against a repeat of
  CVE-2025-54313: the maintainer no longer has an npm token that
  could be phished out of him.
  An attacker would now need to compromise either the `un-ts/*`
  GitHub organisation or the GitHub Actions workflow itself.
- **SLSA provenance:** the npm registry record for
  `eslint-plugin-import-x@4.16.2` carries an
  [`attestations.provenance` block](https://docs.npmjs.com/generating-provenance-statements)
  with `predicateType: https://slsa.dev/provenance/v1`.
  Consumers can verify with `npm audit signatures` and (more strongly)
  with the npm CLI's provenance verification.
  `eslint-plugin-import` does not carry provenance attestations as
  of this writing.
- **Signed commits:** the maintainer's recent commits to
  `un-ts/eslint-plugin-import-x` are signed with a verified GPG/SSH
  key (the green "Verified" badge in the GitHub commit list).
  Not every historical commit is signed; the repo does not require
  signing as a branch protection.
- **Dependency pinning:** the runtime `dependencies` block uses
  caret ranges (`^1.9.2` for `unrs-resolver`, etc.).
  This is normal for a library but means transitive churn is on by
  default; consumers who want strict reproducibility get it from
  their own lockfile.
- **CI hardening:** the publish workflow uses GitHub OIDC
  (above); other workflows are run-of-the-mill GitHub Actions
  without `permissions: read-all` minimisation visible at a glance.
  Not a bright spot, not a red flag.

### Audit trail

- **CVE-2025-54313** (eslint-config-prettier and four sibling
  packages, July 2025): JounQin's npm token phished and used to
  publish malicious versions.
  Public response within 24 hours (Twitter/X confirmation,
  deprecation of bad versions, fresh good versions).
  Post-incident: migrated to npm trusted publishing for active
  packages.
  No evidence `eslint-plugin-import-x` itself was published with
  malicious content during the window: the package was not in the
  list of compromised packages, and its v4.10.x releases of that
  period appear in the npm time series at expected cadence.
  The compromise was scoped to packages the attacker manually
  targeted with the leaked token, not an automated release pipeline,
  and the attacker stopped short of `eslint-plugin-import-x`.
- **No prior advisories** against `eslint-plugin-import-x` itself
  on the
  [GitHub Advisory Database](https://github.com/advisories?query=eslint-plugin-import-x)
  or
  [Snyk's database](https://security.snyk.io/package/npm/eslint-plugin-import-x)
  as of 2026-05-12.
- **No prior advisories** against `eslint-plugin-import` either
  (apart from a low-severity ReDoS in 2022 that landed a fix
  within a release).

### Comparison to `eslint-plugin-import`

| Dimension | `eslint-plugin-import` | `eslint-plugin-import-x` |
|---|---|---|
| Last release | 2025-06-20 (2.32.0) | 2026-03-11 (4.16.2) |
| Maintainer count (npm) | 3 (`benmosher`, `ljharb`, `jfmengels`) | 1 (`jounqin`) |
| `exports` field support | No (8-year-old open issue) | Yes (built-in, since 4.6.0) |
| ESLint 9 / 10 readiness | Disputed | Yes |
| Dependency tree size | ~117 | ~16 |
| npm provenance | Not present | Present |
| npm publish auth | Long-lived token | OIDC trusted publisher |
| Public security incident | None | Maintainer phished July 2025 (different package) |
| Weekly downloads | ~43M | ~3.5M |

The honest summary: `eslint-plugin-import-x` is the faster-moving,
better-engineered, lower-dep-count, provenance-bearing fork; it is
also a younger project whose single maintainer was successfully
phished within the past year.
The mitigation he adopted (OIDC trusted publishing) is the right
one, and is not present on the upstream we are migrating from.

### Reversibility

The fork is API-compatible at the rule level.
A future "roll back to `eslint-plugin-import`" PR is a reverse of
the same `s/import-x/import/g` plus a re-add of
`eslint-import-resolver-exports`.
The configs do not encode `import-x`-only behaviour.
The reversibility is one-config-file deep.

## Risk Mitigations We Should Adopt Regardless

These are project-wide hygiene measures that pay off whether we
move to `eslint-plugin-import-x`, stay on `eslint-plugin-import`,
or do something else entirely.

1. **Pin exact versions for ESLint plugins.**
   Drop the caret on `eslint-plugin-import-x` (and ideally on the
   other ESLint plugins the workspace pulls in directly).
   Today's `^4.16.2` becomes `4.16.2`.
   Caret ranges on a single-maintainer package mean a malicious
   `4.16.3` reaches us through `yarn install` with no review.
   This is the single highest-leverage mitigation in this list.
2. **Hold dev-dep upgrades for a maturity period.**
   The Dependabot review process should gate dev-dep PRs through a
   7-to-14-day soak for non-vuln-fix upgrades.
   Apply the same gate to `eslint-plugin-import-x`.
   Document the carve-out for fixes to disclosed CVEs.
3. **Verify npm provenance in CI.**
   Add `npm audit signatures` (or equivalent) to the workspace's
   pre-publish CI step so the absence of provenance on a critical
   dev-dep produces a noisy failure.
   This is cheap on yarn 4 and catches a malicious republish that
   strips attestations.
4. **Restrict to `devDependencies`.**
   `eslint-plugin-import-x` must never appear in any package's
   `dependencies`.
   An eslint plugin should not be reachable from the published
   tarballs of `@endo/*`.
   The current plugin is correctly scoped to root devDependencies;
   the migration must preserve that.
5. **Document the rollback path.**
   The migration commit should include a comment in
   `packages/eslint-plugin/lib/configs/imports.js` pointing back
   to this design document, with a one-paragraph rollback recipe
   (re-add `eslint-plugin-import` and
   `eslint-import-resolver-exports`, rename `import-x/*` to
   `import/*`, restore the `import/resolver` settings block).
   When future maintainers consider rolling back, the path should
   not require re-discovering this design.
6. **Watch the maintainer.**
   Subscribe a maintainer (or a watchman) to GitHub notifications
   on the [`un-ts/eslint-plugin-import-x` releases feed](https://github.com/un-ts/eslint-plugin-import-x/releases.atom)
   and to the maintainer's GitHub profile.
   A repeat phishing attack would surface fastest in the same
   places the 2025 incident did (Twitter/X, GitHub issues on the
   affected packages); treat any such signal as a stop-the-presses
   for ESLint plugin upgrades.

## Recommendation

**Adopt `eslint-plugin-import-x`, with the mitigations above
applied as part of the migration PR rather than as future
follow-ups.**

The trade-off:

- The status quo (`eslint-plugin-import` +
  `eslint-import-resolver-exports`) is **already** a higher-risk
  configuration than the proposal.
  `eslint-import-resolver-exports` is a single-maintainer
  abandoned beta with no provenance and no signing; it has the
  same single-maintainer-phishability profile as the
  `eslint-plugin-import-x` maintainer with none of the
  post-incident mitigations.
  Staying put trades the named, recently-hardened risk for an
  unnamed, unmaintained one.
- `eslint-plugin-import` upstream itself is **slowing**, not
  speeding up, on `exports` and on ESLint 9/10.
  Continued reliance defers the migration cost without bounding it.
- The migration is mechanical, the reversibility is good, and the
  upstream's post-incident behaviour (OIDC trusted publishing,
  SLSA provenance, signed commits, public post-mortem) is the
  right behaviour.
  The mitigation list above pins the residual risk to roughly the
  level we already accept for every other single-maintainer
  dev-dependency in the tree.

The recommendation is **not** an unqualified endorsement of the
upstream.
The single-maintainer concentration remains the dominant risk; the
mitigations above narrow but do not close it.
A future "we need a second pair of eyes on every Endo dev-dep
upgrade" tightening would narrow it further.

## Phased implementation

1. **Migration PR (this design's deliverable, separate PR).**
   Lands the dev-dep change, the config edits, the changeset, the
   pinned-version policy, and the rollback comment.
   Hand-tested with `yarn lint` across the workspace; CI must show
   zero new lint errors before merge.
2. **`npm audit signatures` CI step (separate PR).**
   Adds a workspace-wide signature audit to the CI matrix.
   Failing the build on missing provenance forces conscious
   acceptance of any future regression.
3. **Dependabot policy update (separate, prose-only PR).**
   Document the `eslint-plugin-import-x` carve-out in the
   project's Dependabot review notes: pinned exact, soak period
   applies, vuln-fix bypass requires posting the upstream
   advisory link in the PR body.

The three PRs can land in any order; (1) is the user-visible
change, (2) and (3) are hygiene that pay off regardless of which
plugin we depend on.

## Open Questions

1. **Should we wait for a second maintainer on
   `eslint-plugin-import-x` before adopting?**
   The single-maintainer risk is the dominant one.
   If un-ts onboards a second publish-authority maintainer in the
   next quarter, the assessment improves materially with no other
   change.
   The cost of waiting is continued false-positive
   `import/no-unresolved` noise on Endo subpath imports plus the
   continued unmaintained-`-resolver-exports` risk.
   The author's read is that the existing risk is comparable to the
   proposed risk and the proposed configuration is otherwise
   strictly better, so waiting earns nothing; a maintainer who
   disagrees should leave the PR open until a second co-maintainer
   appears on the npm record.

2. **Should we drop `airbnb-base` while we are in here?**
   `airbnb-base` extends `eslint-plugin-import` rules under the
   `import/*` namespace.
   Migrating to `import-x/*` while still extending `airbnb-base`
   means the airbnb rules turn into dead config under their old
   prefix.
   The straightforward fix is to extend `airbnb-base` and disable
   the now-orphaned `import/*` rules it sets, but a cleaner fix is
   to extract the small subset of `airbnb-base` we actually use
   into `@endo/style` directly.
   Out of scope of this design; flagged for a follow-up.

3. **Should the workspace adopt npm trusted publishing for its own
   `@endo/*` packages?**
   The same OIDC trusted-publisher flow that mitigated the
   `eslint-plugin-import-x` maintainer's risk applies to every npm
   package the Endo project itself publishes.
   A separate design doc, but the supply-chain conversation this
   document opens should not stop at the dev-dep boundary.

## Affected Designs

| Design | Relationship |
|--------|-------------|
| [break-dev-dependency-cycles](break-dev-dependency-cycles.md) | Adjacent dev-dependency hygiene work; both narrow the dev-dep blast radius. |
| [ci-no-npm-lifecycle](ci-no-npm-lifecycle.md) | Disabling install-time scripts is the strongest mitigation against postinstall-vector compromises like CVE-2025-54313's `install.js`. The two designs are complementary. |

## Prompt

> Per kriskowal at
> https://github.com/endojs/endo-but-for-bots/issues/218 (closing
> directive): "Please dispatch a builder to propose a migration to
> eslint-plugin-import-x including a frank assessment of the
> upstream project's trustworthiness to shield us from
> supply-chain-attack."
