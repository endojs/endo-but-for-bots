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

export { makeMemoryCasStore, makeRetentionLinkSet } from './src/store.js';

export { sha256HexWebCrypto } from './src/store-web-powers.js';

export { makeNpmReferenceRegistry } from './src/reference-backend.js';
