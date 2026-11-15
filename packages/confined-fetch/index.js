// @ts-check
// reexport-policy-exempt: this is the package's own entry point, not a
// compatibility shim; each name has no older home to deprecate.

/**
 * @import {
 *   ConfinedFetchService as ConfinedFetchServiceType,
 *   ConfinedFetchServiceExo as ConfinedFetchServiceExoType,
 *   ConfinedFetchServicePowers as ConfinedFetchServicePowersType,
 *   FetchStore as FetchStoreType,
 *   FetchStoreDirectory as FetchStoreDirectoryType,
 *   PersistedSnapshot as PersistedSnapshotType,
 * } from './src/types.js';
 */

/**
 * @typedef {ConfinedFetchServiceType} ConfinedFetchService
 * @typedef {ConfinedFetchServiceExoType} ConfinedFetchServiceExo
 * @typedef {ConfinedFetchServicePowersType} ConfinedFetchServicePowers
 * @typedef {FetchStoreType} FetchStore
 * @typedef {FetchStoreDirectoryType} FetchStoreDirectory
 * @typedef {PersistedSnapshotType} PersistedSnapshot
 */

export { make } from './src/index.js';
export {
  makeConfinedFetchService,
  ConfinedFetchServiceInterface,
} from './src/service.js';
export { makeFetchStore } from './src/store.js';
export { makeTransportFromBase } from './src/transport.js';
