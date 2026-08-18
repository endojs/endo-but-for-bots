// @ts-check

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

export {
  makeMvsResolveHook,
  satisfiesRange,
  parseRangeMajor,
} from './src/mvs-resolver.js';

export {
  mapSnapshot,
  buildCompartmentMap,
  makeMountReadPowers,
} from './src/snapshot-mapper.js';
