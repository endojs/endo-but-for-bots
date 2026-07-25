# Continuous `dev` publishing from `llm`

| | |
| --- | --- |
| Created | 2026-07-25 |
| Author | Garden |
| Status | Proposed |

## Problem

The `llm` roadmap branch contains useful Endo changes before they are promoted
to `master` and released through the normal Changesets flow.
Consumers who need to exercise those changes currently have no supported npm
installation point, or must install from Git directly.

The normal release workflow is deliberately unsuitable for this purpose.
It runs only for `master`, makes release tags and GitHub releases, and expects
Changesets to determine the production versions.
A development publisher must not create production releases, mutate `llm`, or
allow a newer commit to overtake an older commit at the `dev` dist-tag.

## Goals

- Publish every non-private `@endo/*` workspace from each eligible `llm` tip.
- Give each published package a unique SemVer prerelease version and attach the
  npm `dev` dist-tag.
- Process eligible commits in commit order, without cancelling an older run for
  a newer push.
- Make a retry safe after a partial npm outage or runner failure.
- Keep production versions, Git tags, GitHub releases, and Changesets exclusive
  to the existing `master` release path.

## Non-goals

- Promoting an `llm` build to `latest` or creating a GitHub release.
- Replacing the production Changesets release workflow.
- Supporting arbitrary branches or publishing private workspaces.
- Providing a cross-package atomic npm operation, which npm does not offer.

## Design

### Trigger and ordering

Add `.github/workflows/publish-dev.yml`, triggered only by pushes to `llm`.
It uses a repository-wide FIFO concurrency group:

```yaml
concurrency:
  group: endo-llm-dev-publish
  cancel-in-progress: false
```

The workflow must not use a ref-specific group and must never set
`cancel-in-progress: true`.
Those choices make the queue serialize every `llm` push and retain an earlier
commit when a later commit arrives while it is publishing.
Each run checks out the event's immutable commit SHA, not the moving `llm`
branch name.

Before publishing, the run verifies that the checked-out commit is an ancestor
of the current `llm` tip.
This suppresses a queued run for a commit removed by a force-push while leaving
normal, chronological pushes intact.

### Development versions

The publisher derives one release identifier from the checked-out commit:

```
dev.<UTC-commit-time-YYYYMMDDHHMMSS>.<short-sha>
```

For example, a workspace whose source version is `1.7.0` becomes
`1.7.0-dev.20260725110430.a1b2c3d`.
The timestamp is the commit timestamp in UTC, and the short SHA prevents a
collision for distinct commits sharing a timestamp.
This identifier sorts chronologically among builds of the same source version,
is unambiguous in npm, and makes a rerun of the same commit address exactly
the same package versions.

The workflow records the full SHA, source version, derived version, and package
name in a generated `dist/dev-release.json` manifest.
The manifest is retained as a workflow artifact and included in the run summary.

### Staged workspace manifests

Add a `scripts/prepare-dev-release.mjs` command that receives the commit-derived
identifier and creates a temporary release workspace outside the checkout.
It copies the checked-out source tree, then rewrites only package manifests in
that staging tree:

- Each non-private workspace receives its derived prerelease version.
- `workspace:` dependencies between publishable workspaces resolve to the
  corresponding derived prerelease version.
- Private workspaces retain their source version and are never packed or
  published.

The command writes the manifest described above and does not modify the
checked-out `llm` worktree.
The existing `scripts/pack-all.mjs` and `scripts/release-npm.mjs` run against
the staging tree, so the tarballs are still built by the established
`ts-node-pack` path.
The release command gains an input manifest mode, rather than discovering
workspace versions again after packing.
It rejects a tarball whose package name or version differs from the manifest.

### Two-phase tag promotion

The workflow first publishes every tarball with a unique staging dist-tag:

```
dev-<UTC-commit-time-YYYYMMDDHHMMSS>-<short-sha>
```

It publishes with `npm publish --tag <staging-tag>` and verifies every
`name@version` in `dev-release.json` with `npm view`.
Only after all packages are present does it promote each package version to the
shared `dev` dist-tag with `npm dist-tag add`.
The final summary lists the staging tag, the promoted `dev` versions, and the
commit SHA.

This avoids pointing `dev` at a partly published set when packing or publishing
fails midway.
npm cannot promote a multi-package set atomically, so promotion itself may be
observed package by package.
The serialized workflow and manifest-based retry make that window short and
recoverable: rerunning the same SHA verifies already-published versions and
finishes any missing promotion without producing new versions.

### Credentials and permissions

The job has `contents: read` and the smallest npm publication authority that
the registry permits.
Publication uses npm trusted publishing through GitHub Actions OIDC
(`id-token: write`) for each published `@endo/*` package.
If the registry setup cannot yet use trusted publishing for a given package,
use a repository secret scoped to npm publishing only, treat it as a temporary
higher-risk measure, and remove it once that package's trusted publisher is
configured.
No GitHub write permission, `GITHUB_TOKEN` publication, tag creation, or
Changesets action is part of this workflow.

npm does not offer an authorization scope that restricts a credential to a
single dist-tag or version prefix.
Both granular access tokens and trusted publishing grant write access at
package granularity, and write access permits publishing any version and
moving any dist-tag, including `latest`.
A fallback publish token therefore cannot be constrained to the `dev` tag
alone, which is why it is only a temporary bridge to trusted publishing.
The durable scope limit comes instead from trusted publishing binding publish
authority to one specific workflow file rather than to a reusable secret:
only `publish-dev.yml` can publish these packages, and that workflow by
construction publishes SemVer prerelease versions and touches only the `dev`
dist-tag.
Because every published version is a prerelease and every `npm publish` passes
an explicit `--tag`, npm never moves `latest`.
Abusing this authority to publish a mainline or `latest` version would require
modifying the workflow file itself on the protected `llm` branch, which keeps a
prompt injection in ordinary repository content from escalating into a supply
chain attack.

The workflow retains the existing defense-in-depth install settings:
`YARN_ENABLE_SCRIPTS=false` and `npm_config_ignore_scripts=true`.
It runs `corepack enable`, `yarn install --immutable`, and the existing
publish smoke test against a local registry before authenticating to npm.

### Trusted publishing setup

Configuring trusted publishers requires npm account authority that only the
maintainers hold; a workflow cannot grant itself this access.
For each public `@endo/*` package the maintainers:

1. Open the package's Settings on npmjs.com and add a trusted publisher for
   this GitHub repository, naming the workflow file `publish-dev.yml` and, if
   used, the deployment environment the job runs in.
2. Remove any long-lived automation token that still carries publish access to
   the package once its trusted publisher works, so the workflow binding is the
   only automated publication path.
3. Keep any account or organization publishing-access policy that blocks
   mainline publication from automation in place, consistent with the goal that
   automation in this repository cannot publish mainline or `latest` versions.

Until a package has a working trusted publisher, its dev publication either
skips that package or uses the temporary publish-only token described above,
which is removed as soon as trusted publishing is in place.

### Failure handling and observability

The workflow fails before promotion when the source is not an ancestor of
current `llm`, the generated manifest is incomplete, packing omits a package,
or npm returns a version whose manifest does not match the expected version.

For a failed run, the next workflow run must not skip it merely because a newer
commit is queued.
The maintainer reruns the failed workflow for that SHA after correcting the
external condition.
The unique version and staging tag make that rerun idempotent.
The workflow summary and retained manifest provide the exact recovery input.

## Implementation plan

1. Add `scripts/prepare-dev-release.mjs` and tests that cover prerelease
   derivation, workspace dependency rewriting, private workspace exclusion, and
   manifest/tarball mismatch rejection.
2. Extend `scripts/release-npm.mjs` with manifest-driven staging publication and
   a separate promotion command that verifies all packages before moving `dev`.
3. Add the `llm`-only workflow, FIFO concurrency, immutable-SHA checkout,
   ancestor check, install hardening, npm authentication, smoke test, artifact,
   and run summary.
4. Configure npm trusted publishers for the public `@endo/*` packages, then
   exercise the workflow from a disposable commit and confirm that `npm view
   <package>@dev version` matches the recorded manifest.

## Verification

- Unit-test the version and manifest helpers with fixed commit times and SHAs.
- Run the publish smoke test against Verdaccio using a staging tag, then verify
  every manifest entry and its internal dependency versions.
- Use two queued test commits to confirm that the first run completes before
  the second begins, and that the final `dev` tag points to the later commit.
- Interrupt a staged publish, rerun the same SHA, and confirm that no duplicate
  versions are attempted and that all packages are promoted only after the
  manifest is complete.
- Force-push away a queued commit and confirm that its run exits before npm
  authentication or publication.

## Resolved decisions

These questions were resolved in review of this design.

- The public dist-tag is exactly `dev`. Consumers install `@endo/<pkg>@dev`;
  there is no separate named channel such as `llm-dev`. Renaming the `llm`
  branch to `dev` is desirable but is tracked separately from this design.
- Every non-private workspace that is published generally is published as a
  `dev`-tagged prerelease. The rollout does not use a maintained allowlist; the
  publishable set is the same set of non-private `@endo/*` workspaces that the
  production release path publishes.
- npm trusted publishing is the intended credential path, arranged by the
  maintainers, and deliberately scope-limited so that automation in this
  repository cannot publish mainline or `latest` versions. The mechanism and
  its limits are described under Credentials and permissions and Trusted
  publishing setup above, including the fact that npm has no dist-tag-scoped
  credential, so the workflow-file binding of trusted publishing is what
  prevents an escalation from prompt injection to a supply chain attack.
