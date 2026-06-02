# @endo/registry-capability

## 0.1.0

### Initial scaffolding

- Define `EndoRegistry` capability shape and `EndoRegistryInterface`
  method guard.
- Define structured error classes (`RegistryTamperedError`,
  `RegistryMissingPackageError`, `RegistryNetworkError`,
  `RegistryOfflineError`) per `designs/registry-capability.md`'s failure
  surface.
- Add CAS-backed store interface and Map-based reference implementation
  (`makeMemoryCasStore`).
- Add JS reference backend (`makeJsReferenceRegistry`) with an injected
  `resolveHook` for layer 2 (MVS resolver) to plug in.
- Add retention-link hook typedefs for layer 3 (snapshot mapper) to
  pin CAS entries from captured formulas.
