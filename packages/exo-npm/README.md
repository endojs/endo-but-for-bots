# @endo/exo-npm

The `EndoRegistry` exo capability shape and an npm-scoped reference backend.

The `exo-` prefix indicates that this package imports and exports passable
interfaces over CapTP; the `npm` suffix names the package's scope
(npm-style package resolution against the npm registry's metadata schema).
A different registry backend (a Rust-backed wrapper, a workspace-only
resolver) would carry its own scope-naming.

## What this package provides

- The `EndoRegistryInterface` method guard and the typescript types that
  describe the capability shape (`EndoRegistry`, `RegistryResolution`).
- Structured error classes (`RegistryTamperedError`,
  `RegistryMissingPackageError`, `RegistryNetworkError`,
  `RegistryOfflineError`) tagged via `@endo/errors`'s `errorName` so
  callers can branch on the failure class without inspecting message
  text.
- An npm-scoped reference backend (`makeNpmReferenceRegistry`) that wires
  the capability boundary together. It accepts a caller-supplied
  `PackageCacheTable` (sortable by dewey-decimal version) and delegates
  the MVS resolution algorithm to an injected `resolveHook`, so a
  caller can substitute the resolver implementation without touching the
  capability surface.
- A reference MVS resolve hook (`makeMvsResolveHook`) that implements
  Go-like Minimum Version Selection over an npm-shaped dependency graph.
  The hook takes a caller-supplied `fetch` power (so the package itself
  does not bind to a particular HTTP client) and walks `dependencies`,
  `peerDependencies`, and `optionalDependencies` together, observing
  `workspace:` specifiers when the caller supplies a workspace root.
- An in-memory reference `PackageCacheTable`
  (`makeMemoryPackageCacheTable`) suitable for tests and small in-process
  consumers. A SQLite-backed implementation projects the same shape over
  a `(name, major, minor, patch, integrity, treeRef)` relational table
  sorted by the three integer columns; it is tracked separately.

The CAS-backed store interface (`CasStore` shape, `CasInterface` runtime
guard, `makeMemoryCasStore`, `sha256HexWebCrypto`, `makeRetentionLinkSet`)
lives in [`@endo/mem-cas`](../mem-cas/README.md).
This package depends on `@endo/mem-cas`; consumers wire the two together
via the reference backend's `cas` option.

## What this package does not provide

- A Rust-backed `EndoRegistry` wrapping `endor-npm-registry-proxy`.
- A SQLite-backed `PackageCacheTable` implementation. The interface is
  in place; a SQLite projection lands separately.

## Status

The npm-scoped reference backend and the JS MVS resolve hook are wired
together. See [`designs/registry-capability.md`](../../designs/registry-capability.md)
and [`designs/mvs-resolver.md`](../../designs/mvs-resolver.md) for the
design rationale.
</content>
</invoke>