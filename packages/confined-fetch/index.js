// @ts-check

/**
 * @typedef {import('./src/types.js').ConfinedFetchService} ConfinedFetchService
 * @typedef {import('./src/types.js').ConfinedFetchServiceExo} ConfinedFetchServiceExo
 * @typedef {import('./src/types.js').ConfinedFetchServicePowers} ConfinedFetchServicePowers
 * @typedef {import('./src/types.js').FetchStore} FetchStore
 * @typedef {import('./src/types.js').FetchStoreDirectory} FetchStoreDirectory
 * @typedef {import('./src/types.js').PersistedSnapshot} PersistedSnapshot
 */

export { make } from './src/index.js';
export {
  makeConfinedFetchService,
  ConfinedFetchServiceInterface,
} from './src/service.js';
export { makeFetchStore } from './src/store.js';
export { makeTransportFromBase } from './src/transport.js';
