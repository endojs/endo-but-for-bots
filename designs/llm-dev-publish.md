# Continuous `dev` publishing from `llm`

| | |
| --- | --- |
| Created | 2026-07-25 |
| Updated | 2026-08-29 |
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
allow a newer commit to overtake an older commit at the shared development
dist-tag.

A second constraint is decisive and shapes the whole credential story below.
npm offers no authorization scope that restricts a credential to development
releases: any npm token that can publish a package can also tag it `latest` or
publish an ordinary mainline version.
Handing the `llm` workflow a direct npmjs.com publish credential would create
an escalation path from a prompt injection in ordinary repository content to a
supply-chain publication.
This design removes that credential from the workflow entirely.

## Relationship to the attenuation design

This design owns the **chronological build and versioning mechanics** on the
`llm` branch: how the workflow serializes commits, derives versions, stages
manifests, publishes, and recovers.
The **constrained staging boundary and the outbound npmjs.com publication** are
owned by
[capability-attenuated npm development publishing](npm-dev-publisher-attenuation.md)
(PR endojs/endo-but-for-bots#890) and are referenced here rather than
duplicated.
That document specifies what the staging registry accepts and how a separate,
non-agent promoter forwards accepted artifacts to npmjs.com.
Where the two designs touch, the attenuation design is normative and this one
defers to it. Specifically, this document does not redefine any of:

- the `PublishGrant` capability, its issuance, attenuation, and revocation;
- the proxy's publish-validation pipeline (its rules P1 through P8);
- the `dev-*` dist-tag shape, immutability, and tag-monotonicity rules;
- the deterministic promoter that holds the sole npmjs.com credential and
  independently revalidates policy, grant state, integrity, and byte identity
  before forwarding an artifact upstream.

## Goals

- Publish every non-private `@endo/*` workspace from each eligible `llm` tip.
- Give each published package a unique SemVer prerelease version and a `dev-*`
  development dist-tag, satisfying the staging registry's development-release
  shape (attenuation design, section *Semantics of a development release*).
- Process eligible commits in commit order, without cancelling an older run for
  a newer push, so acceptance order at the staging registry is chronological.
- Make a retry safe after a partial staging-registry outage or runner failure.
- Publish only through the capability-attenuated staging registry
  (`npm.minion.town`). The workflow holds no npmjs.com credential and cannot,
  by any request it can make, publish an ordinary or `latest` version anywhere.
- Keep production versions, Git tags, GitHub releases, and Changesets exclusive
  to the existing `master` release path.

## Non-goals

- Promoting an `llm` build to `latest` or creating a GitHub release.
- Replacing the production Changesets release workflow.
- Supporting arbitrary branches or publishing private workspaces.
- Providing a cross-package atomic npm operation, which npm does not offer.
- Specifying the staging registry, its capability model, or the npmjs.com
  promoter. Those belong to the attenuation design; this workflow is one client
  of the staging registry.

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

Because each run publishes into the staging registry before the next run
begins, the staging registry records commits in its durable event log in commit
order, and the promoter forwards them upstream in that same order (attenuation
design, section *Wake mechanism*).
The workflow is where end-to-end chronological order originates.

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
Because the identifier carries a SemVer prerelease component, it also satisfies
the staging registry's prerelease requirement (attenuation design, rule P4) by
construction.

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

Every publish targets the staging registry (`npm.minion.town`), never
npmjs.com, and every publish carries exactly one `dev-*` dist-tag, the shape the
staging registry requires of a development release (attenuation design, section
*Semantics of a development release*).
The workflow first publishes every tarball under a unique per-commit staging
tag:

```
dev-<UTC-commit-time-YYYYMMDDHHMMSS>-<short-sha>
```

It publishes with `npm publish --registry https://npm.minion.town --tag
<staging-tag>` and verifies every `name@version` in `dev-release.json` with
`npm view --registry https://npm.minion.town`.
Only after all packages are present does it move the shared development pointer,
a single reserved `dev-*` tag `dev-latest`, to each package version with
`npm dist-tag add --registry https://npm.minion.town`.
The final summary lists the staging tag, the promoted `dev-latest` versions,
and the commit SHA.

This avoids pointing `dev-latest` at a partly published set when packing or
publishing fails midway.
npm cannot promote a multi-package set atomically, so the pointer move is
observed package by package.
The serialized workflow and manifest-based retry make that window short and
recoverable: rerunning the same SHA verifies already-published versions and
finishes any missing move without producing new versions.
The immutable per-commit staging tag remains a permanent, unambiguous handle
for that exact build; `dev-latest` is the rolling "newest `llm` build" pointer
consumers install with `@endo/<pkg>@dev-latest`.

Both the staging tag and `dev-latest` match the staging registry's `^dev-`
pattern and its monotonic-tag rule; the registry enforces that shape and
rejects any publish that omits a tag, names a non-`dev-` tag, or moves a tag
backward (attenuation design, sections *Semantics of a development release* and
*Publish validation pipeline*).
Because chronological commit-derived versions sort by increasing SemVer
prerelease precedence, each `dev-latest` move is monotonic by construction.

### Credentials and staging-registry authority

The workflow authenticates only to the staging registry, using a `PublishGrant`
bearer token (attenuation design, section *Capability model*) supplied as a
repository or environment secret and written into a job-local `.npmrc`:

```ini
@endo:registry=https://npm.minion.town
//npm.minion.town/:_authToken=${NPM_MINION_TOWN_TOKEN}
```

The grant is attenuated at issuance to the publishable `@endo/*` workspace set
and, by non-negotiable staging-registry policy, to development releases only:
prerelease versions carrying exactly one `dev-*` tag, immutable versions,
monotonic tags.
No request the workflow can make, however a prompt injection in repository
content might craft it, can exceed that authority.
It cannot publish a non-prerelease version, move `latest`, unpublish,
deprecate, change owners, or touch a package outside the grant's allowlist,
because the staging registry refuses each of those by construction rather than
by a policy the workflow could argue past.

The job has `contents: read` and no npmjs.com credential, no `id-token: write`,
no trusted-publishing binding, no `GITHUB_TOKEN` publication authority, and no
tag-creation or Changesets step.
The only publication authority present in the job is the attenuated
staging-registry token.

This is a strictly stronger boundary than binding a direct npmjs.com publisher
to a single workflow file.
A workflow-file binding still holds a credential that npm itself permits to
publish `latest`; its safety rests on nobody being able to alter the protected
workflow.
The attenuated grant holds no such latent authority: the worst outcome of a
fully prompt-injected run is an attributable, immutable `dev-*` prerelease of an
already-allowlisted package in the staging registry, and never anything on
npmjs.com.
Forwarding an accepted artifact to npmjs.com is the separate promoter's job,
gated by the promoter's own independent revalidation (attenuation design,
section *Promotion service*).
No GitHub Actions run ever holds the npmjs.com credential.

The workflow retains the existing defense-in-depth install settings:
`YARN_ENABLE_SCRIPTS=false` and `npm_config_ignore_scripts=true`.
It runs `corepack enable`, `yarn install --immutable`, and the existing
publish smoke test against a local registry before authenticating to the
staging registry.

### Staging-registry credential setup

Provisioning the grant is operator work within a maintainer-approved policy, not
a per-run secret handed to an agent (attenuation design, section *Availability
to unattended jobs*).

1. The operator issues a `PublishGrant` for this publishing job class, scoped to
   the publishable `@endo/*` workspace set and, by fixed registry policy,
   development-releases-only, and mints an HTTP token from it.
2. Store the token as the repository or environment secret
   `NPM_MINION_TOWN_TOKEN`. Grants carry a mandatory expiry, so rotation is a
   fresh issuance of a successor token before the current grant expires, not an
   extension.
3. Configure no per-package trusted publisher and no long-lived automation token
   on npmjs.com for this workflow. The only npmjs.com credential in the whole
   system is the promoter's, held outside GitHub Actions entirely (attenuation
   design, section *Upstream token*).
4. Keep any account or organization policy that blocks mainline publication from
   automation in place as defense in depth, consistent with the goal that
   automation in this repository cannot publish mainline or `latest` versions.

### Failure handling and observability

The workflow fails before moving `dev-latest` when the source is not an ancestor
of current `llm`, the generated manifest is incomplete, packing omits a package,
or the staging registry rejects or returns a version whose manifest does not
match the expected version.

For a failed run, the next workflow run must not skip it merely because a newer
commit is queued.
The maintainer reruns the failed workflow for that SHA after correcting the
external condition.
The unique version and staging tag make that rerun idempotent: the staging
registry treats a byte-identical republish of an existing `(name, version)` as
an idempotent accept (attenuation design, section *Replay and idempotency*), so
a rerun never produces a new version and only finishes missing work.
The workflow summary and retained manifest provide the exact recovery input.

Recovery of the npmjs.com side, including duplicate-publish confirmation,
byte-identity checks, quarantine, and backoff, is the promoter's responsibility
and is specified in the attenuation design (section *Crash-safe state machine*).
It is deliberately not duplicated here: once the staging registry has accepted a
release, this workflow's obligation is discharged.

## Implementation plan

1. Add `scripts/prepare-dev-release.mjs` and tests that cover prerelease
   derivation, workspace dependency rewriting, private workspace exclusion, and
   manifest/tarball mismatch rejection.
2. Extend `scripts/release-npm.mjs` with manifest-driven staging publication and
   a separate promotion command that verifies all packages before moving
   `dev-latest`.
3. Add the `llm`-only workflow with FIFO concurrency, immutable-SHA checkout,
   ancestor check, install hardening, staging-registry authentication with the
   injected `PublishGrant` token, smoke test, artifact, and run summary. The
   workflow requests no npmjs.com credential and no `id-token: write`.
4. Arrange the `PublishGrant` issuance and the `NPM_MINION_TOWN_TOKEN` secret
   with the operator (attenuation design, section *Availability to unattended
   jobs*), then exercise the workflow from a disposable commit and confirm that
   `npm view <package>@dev-latest version --registry https://npm.minion.town`
   matches the recorded manifest.

## Verification

- Unit-test the version and manifest helpers with fixed commit times and SHAs.
- Run the publish smoke test against a local instance of the staging registry
  (the attenuation design's proxy) using a staging tag, then verify every
  manifest entry and its internal dependency versions.
- Confirm the workflow carries no npmjs.com credential and no `id-token: write`,
  and that its only publish target is `https://npm.minion.town`.
- Use two queued test commits to confirm that the first run completes before the
  second begins, and that the final `dev-latest` tag points to the later commit.
- Interrupt a staged publish, rerun the same SHA, and confirm that no duplicate
  versions are attempted and that all packages are promoted only after the
  manifest is complete.
- Force-push away a queued commit and confirm that its run exits before
  staging-registry authentication or publication.

## Dependencies

| Design | Relationship |
| --- | --- |
| [capability-attenuated npm development publishing](npm-dev-publisher-attenuation.md) (PR endojs/endo-but-for-bots#890) | Normative for everything downstream of the workflow's publish call: the `PublishGrant` capability, the proxy publish-validation pipeline, the `dev-*` tag shape and monotonicity, and the deterministic npmjs.com promoter. This design produces the constrained prerelease artifacts that design's staging registry accepts. |

## Resolved decisions

These questions were resolved in review of this design.

- Publication goes through the capability-attenuated staging registry
  (`npm.minion.town`), not directly to npmjs.com. The `llm` workflow holds no
  npmjs.com credential at all; its only publish authority is an attenuated
  `PublishGrant` token bounded to the publishable `@endo/*` set and to
  development releases. A separate non-agent promoter is the sole npmjs.com
  credential holder and independently revalidates every release before
  forwarding it (attenuation design, PR endojs/endo-but-for-bots#890). This
  supersedes the earlier plan to give the workflow a direct npmjs.com credential
  scope-limited only by a trusted-publishing workflow-file binding; the earlier
  plan still held a credential npm permits to publish `latest`, whereas the
  attenuated grant cannot express that authority at all.
- Development builds are addressed by a `dev`-prefixed tag, never an `llm-dev`
  channel. Each `llm` commit publishes under an immutable per-commit staging tag
  `dev-<UTC-commit-time>-<short-sha>`, and a single shared moving pointer
  `dev-latest` follows the newest build. The bare tag `dev` is deliberately not
  used, because the staging registry structurally forbids any dist-tag that does
  not match `^dev-` (attenuation design, section *Semantics of a development
  release*), so a bare `dev` could not pass the attenuation boundary. Renaming
  the `llm` branch to `dev` remains desirable and is tracked separately from this
  design.
- Every non-private workspace that is published generally is published as a
  `dev-*`-tagged prerelease. The rollout does not use a maintained allowlist of
  its own; the publishable set is the same set of non-private `@endo/*`
  workspaces that the production release path publishes, and the grant's package
  allowlist is issued to cover exactly that set.
- The shared moving development pointer is spelled `dev-latest`, named
  identically across both designs. The attenuation design (PR
  endojs/endo-but-for-bots#890), which owns the reserved shared-moving `dev-*`
  tag-shape and monotonicity policy, aligned its channel tag to `dev-latest` to
  match this design, so the two documents agree on the exact literal. The
  planned `llm`-to-`dev` branch rename is tracked separately and does not change
  this tag spelling.

## Open questions

None. The one open question — the exact spelling of the shared moving pointer,
shared surface with the attenuation design's tag policy — is resolved above: both
designs name it `dev-latest`.

## Prompt

> Revise the continuous `llm` development-publishing design so that it publishes
> constrained prerelease artifacts to the capability-attenuated
> `npm.minion.town` staging registry instead of directly to npmjs.com. Remove
> the direct agent-to-npmjs.com credential path; a separate non-agent promoter
> holds the sole npmjs.com credential and independently revalidates policy,
> grant state, integrity, and byte identity. Preserve and sharpen the FIFO
> ordering, commit-derived versions, manifest-backed retry and recovery, and
> development-tag semantics, and state clearly which details are delegated to the
> attenuation design (PR endojs/endo-but-for-bots#890) rather than duplicating
> them.
