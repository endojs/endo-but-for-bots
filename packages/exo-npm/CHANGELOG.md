# @endo/exo-npm

## 0.1.0

### Initial scaffolding

- Define `EndoRegistry` capability shape and `EndoRegistryInterface`
  method guard.
- Define structured error classes (`RegistryTamperedError`,
  `RegistryMissingPackageError`, `RegistryNetworkError`,
  `RegistryOfflineError`) per `designs/registry-capability.md`'s failure
  surface.
- Add npm-scoped reference backend (`makeNpmReferenceRegistry`) with an
  injected `resolveHook` for layer 2 (MVS resolver) to plug in.
- CAS-backed store moved to a separate package, `@endo/mem-cas`, so the
  common CAS interface can grow into a family of backends
  (`@endo/mem-cas`, a future `@endo/git-cas`, the daemon's persistent
  `store-sha256` tree).
