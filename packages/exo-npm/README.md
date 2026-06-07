# @endo/exo-npm

The `EndoRegistry` exo capability shape and npm-scoped reference backend
scaffolding.
This is layer 1 of the daemon-worker `importLocation` stack defined in
[`designs/registry-capability.md`](../../designs/registry-capability.md).

The `exo-` prefix indicates that this package imports and exports passable
interfaces over CapTP; the `npm` suffix names the package's scope (npm-style
package resolution against the npm registry's metadata schema). A different
registry backend (a Rust-backed wrapper, a workspace-only resolver) would
carry its own scope-naming.

## What this package provides

- The `EndoRegistryInterface` method guard and the typescript types that
  describe the capability shape (`EndoRegistry`, `RegistryResolution`).
- Structured error classes (`RegistryTamperedError`,
  `RegistryMissingPackageError`, `RegistryNetworkError`,
  `RegistryOfflineError`) tagged via `@endo/errors`'s `errorName` so
  callers can branch on the failure class without inspecting message
  text.
- An npm-scoped reference backend (`makeNpmReferenceRegistry`) that wires
  the capability boundary together. It delegates the actual MVS resolution
  to an injected `resolveHook` so that layer 2 (`designs/mvs-resolver.md`)
  can plug in the algorithm without touching the capability surface.

The CAS-backed store interface (`CasStore` shape, `CasInterface` runtime
guard, `makeMemoryCasStore`, `sha256HexWebCrypto`, `makeRetentionLinkSet`)
lives in [`@endo/mem-cas`](../mem-cas/README.md).
This package depends on `@endo/mem-cas`; consumers wire the two together
via the reference backend's `cas` option.

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

Phase 1, scaffolding only. The npm-scoped reference backend is wired but
the `resolveHook` is a stub. See the design document for the phased plan.
