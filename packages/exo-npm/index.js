// @ts-check

export {
  RegistryTamperedError,
  RegistryMissingPackageError,
  RegistryNetworkError,
  RegistryOfflineError,
  isRegistryError,
  registryErrorName,
} from './src/errors.js';

export { EndoRegistryInterface } from './src/interfaces.js';

export {
  makeNpmReferenceRegistry,
  makeMemoryPackageCacheTable,
} from './src/reference-backend.js';
