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
Prefer npm trusted publishing through GitHub Actions OIDC (`id-token: write`)
for each published `@endo/*` package.
If the registry setup cannot yet use trusted publishing, use a repository
secret scoped to npm publishing only, and remove it after trusted publishers
are configured.
No GitHub write permission, `GITHUB_TOKEN` publication, tag creation, or
Changesets action is part of this workflow.

The workflow retains the existing defense-in-depth install settings:
`YARN_ENABLE_SCRIPTS=false` and `npm_config_ignore_scripts=true`.
It runs `corepack enable`, `yarn install --immutable`, and the existing
publish smoke test against a local registry before authenticating to npm.

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

## Open questions

- Should the public dist-tag be exactly `dev`, or should consumers select a
  named channel such as `llm-dev`?
- Does every currently public workspace belong in this channel, or should the
  first rollout use a maintained allowlist of packages?
- Can all public `@endo/*` packages be configured for npm trusted publishing,
  or is a temporary automation token required for a subset?
