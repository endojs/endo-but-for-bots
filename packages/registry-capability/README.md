# @endo/registry-capability

The `EndoRegistry` capability shape and JS reference backend scaffolding.
This is layer 1 of the daemon-worker `importLocation` stack defined in
[`designs/registry-capability.md`](../../designs/registry-capability.md).

## What this package provides

- The `EndoRegistryInterface` method guard and the typescript types that
  describe the capability shape (`EndoRegistry`, `RegistryResolution`).
- Structured error classes (`RegistryTamperedError`,
  `RegistryMissingPackageError`, `RegistryNetworkError`,
  `RegistryOfflineError`) tagged via `@endo/errors`'s `errorName` so
  callers can branch on the failure class without inspecting message
  text.
- A CAS-backed store interface (`makeMemoryCasStore`) with a Map-based
  reference implementation suitable for tests; persistent storage is
  deferred to a follow-up.
- A JS reference backend (`makeJsReferenceRegistry`) that wires the
  capability boundary together. It delegates the actual MVS resolution
  to an injected `resolveHook` so that layer 2 (`designs/mvs-resolver.md`)
  can plug in the algorithm without touching the capability surface.
- A retention-link hook (`retentionLinks`) so the formula graph (layer 3,
  `designs/snapshot-mapper.md`) can pin entries.

## What this package does **not** provide

- The MVS resolution algorithm itself (layer 2).
- The snapshot mapper that consumes a `RegistryResolution` (layer 3).
- The daemon-worker entry point that calls `makeFromPackage` (layer 4).
- A Rust-backed `EndoRegistry` wrapping `endor-npm-registry-proxy`
  (Phase 5 of the design).
- Wiring of `@registry` into `HostFormula` as a required field. The
  design's migration policy is named but the wiring is a daemon-side
  change deferred to a follow-up (see the PR body for the open
  question).

## Status

Phase 1, scaffolding only. The JS reference backend is wired but the
`resolveHook` is a stub. See the design document for the phased plan.
