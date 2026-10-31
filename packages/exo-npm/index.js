// @ts-check
// reexport-policy-exempt: this is the package's own entry point, not a
// compatibility shim; each name has no older home to deprecate.

export {
  RegistryTamperedError,
  RegistryMissingPackageError,
  RegistryNetworkError,
  RegistryOfflineError,
  isRegistryError,
  registryErrorName,
} from './src/errors.js';

export { EndoRegistryInterface } from './src/type-guards.js';

export {
  makeNpmReferenceRegistry,
  makeMemoryPackageCacheTable,
} from './src/reference-backend.js';

export { makeMvsResolveHook, satisfiesRange } from './src/mvs-resolver.js';

export {
  mapSnapshot,
  buildCompartmentMap,
  makeMountReadPowers,
} from './src/snapshot-mapper.js';
