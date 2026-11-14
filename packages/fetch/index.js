// @ts-check
// reexport-policy-exempt: this is the package's own entry point, not a
// compatibility shim; each name has no older home to deprecate.

/**
 * @import {
 *   Fetch as FetchType,
 *   FetchRequestOptions as FetchRequestOptionsType,
 *   FetchResponse as FetchResponseType,
 *   Timer as TimerType,
 *   Transport as TransportType,
 * } from './src/types.js';
 */

/**
 * @typedef {FetchType} Fetch
 * @typedef {FetchRequestOptionsType} FetchRequestOptions
 * @typedef {FetchResponseType} FetchResponse
 * @typedef {TimerType} Timer
 * @typedef {TransportType} Transport
 */

export {
  make,
  makeFetch,
  FetchInterface,
  FetchRequestOptionsShape,
  FetchResponseShape,
} from './src/index.js';
