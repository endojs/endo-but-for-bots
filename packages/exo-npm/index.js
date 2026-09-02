// @ts-check

export {
  RegistryTamperedError,
  RegistryMissingPackageError,
  RegistryNetworkError,
  RegistryOfflineError,
  RegistryNotFoundError,
  RegistryPathSyntaxError,
  isPackageRegistryError,
  isRegistryError,
  registryErrorName,
} from './src/errors.js';

export {
  EndoRegistryInterface,
  RegistryDirectoryInterface,
  RegistryHubInterface,
  RegistrySnapshotTreeInterface,
} from './src/type-guards.js';

export {
  makeDeprecatedEndoRegistryAdapter,
  makeEndorNpmRegistryTree,
  makeLookupTreeView,
  makeNpmRegistryTree,
  makePackageRegistryTree,
  lookupPackageVersion,
} from './src/registry-tree.js';

export { resolveRegistryTree } from './src/registry-tree-resolver.js';

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
