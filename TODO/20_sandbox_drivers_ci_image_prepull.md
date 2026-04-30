# Endo POSIX Sandbox — Pre-pull Alpine OCI Image in CI

Follow-up split out from `TADA/17_endo_posix_sandbox_test_fix.md` § "CI plan",
bullet 2.
Builds on `TODO/19_sandbox_drivers_ci_job.md` (the new `sandbox-drivers` job
this step lives inside).

## Goal

Cut podman-test runtime variance and registry-flake risk by pre-pulling
`docker.io/library/alpine:3.19` once at job-setup time, before
`yarn workspace @endo/sandbox run test:drivers` runs.

## Background

The podman test suite uses `docker.io/library/alpine:3.19` as the rootfs for
every slice (`packages/sandbox/test/podman.test.js:32`).
On a cold runner, the first `podman run …` pulls the image before the test
makes progress.
That adds seconds to the suite and exposes it to docker.io rate-limits and
registry outages.

Pre-pulling once at the top of the CI job amortises the cost across all
podman cases, makes the per-test timing predictable, and turns "registry
unreachable" into a single visible early-job failure instead of an obscure
mid-test timeout.

The podman test file already tracks an `imagePresent` flag in
`PodmanAvailability` — pre-pulling means `imagePresent === true` is the
common case in CI, so any test that gates on it (e.g. the `apk update`
case) actually runs rather than being SKIP-passed.

## Tasks

- [ ] Add a `podman pull docker.io/library/alpine:3.19` step in the
  `sandbox-drivers` GHA job, sequenced **after** the `apt-get install -y
  bubblewrap` step and the `yarn install` / `yarn build` steps but
  **before** the `yarn …test:drivers` step.
- [ ] Decide on tag-source-of-truth.
  The image ref is currently duplicated:
  - `packages/sandbox/test/podman.test.js:32` (`ALPINE_REF`)
  - `packages/sandbox/README.md:146`, `:311`
  - The new GHA workflow step.

  Either (a) accept the small triplication and add a comment in the
  workflow pointing at `podman.test.js`, or (b) extract the tag into a
  small JS constant the test imports (and keep README + workflow
  manually in sync).
  Option (a) is fine for now; option (b) is only worth it if the tag
  starts changing often.
- [ ] Optionally, cache `~/.local/share/containers/storage` between runs
  via `actions/cache` keyed on `alpine:3.19`.
  Only worth doing if the pull cost turns out to be material (cold pull
  of alpine is ~5 MiB; probably not worth the cache-management
  complexity on first cut — skip unless metrics justify it).
- [ ] Confirm the test still passes when the image is pre-pulled —
  specifically that `imagePresent === true` does not change any
  assertions, just unlocks the `apk update` case.

## Dependencies

- Lands together with or after `TODO/19_sandbox_drivers_ci_job.md`.
  The pre-pull step has nowhere to live until the new `sandbox-drivers`
  job exists.

## References

- `TADA/17_endo_posix_sandbox_test_fix.md` — original recommendation.
- `packages/sandbox/test/podman.test.js` — `ALPINE_REF`,
  `PodmanAvailability.imagePresent`, `apk update` case.
- `packages/sandbox/README.md` — operator-facing image reference.
