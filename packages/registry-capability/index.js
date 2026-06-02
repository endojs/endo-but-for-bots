// @ts-check

export {
  RegistryTamperedError,
  RegistryMissingPackageError,
  RegistryNetworkError,
  RegistryOfflineError,
  isRegistryError,
  registryErrorName,
} from './src/errors.js';

export { EndoRegistryInterface, CasStoreInterface } from './src/interfaces.js';

export { makeMemoryCasStore, sha256Hex } from './src/store.js';

export { makeJsReferenceRegistry } from './src/reference-backend.js';
