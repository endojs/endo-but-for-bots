// @ts-check
/* global globalThis */

/* This module is the EAGER surface of `@endo/eventual-send`.
 *
 * Importing it has a side effect: `installOrAdoptAll()` runs at module
 * load and writes a fresh peer bank of functions to a set of
 * registered-symbol slots on `Promise`:
 *
 *   Promise[Symbol.for('delegate')]              - delegate(handler)
 *   Promise[Symbol.for('applyMethod')]           - applyMethod
 *   Promise[Symbol.for('applyMethodSendOnly')]   - applyMethodSendOnly
 *   Promise[Symbol.for('applyFunction')]         - applyFunction
 *   Promise[Symbol.for('applyFunctionSendOnly')] - applyFunctionSendOnly
 *   Promise[Symbol.for('get')]                   - get
 *   Promise[Symbol.for('getSendOnly')]           - getSendOnly
 *   Promise[Symbol.for('resolve')]               - HandledPromise.resolve
 *   Promise[Symbol.for('HandledPromise')]        - HandledPromise constructor
 *
 * Each empty slot is filled; each populated slot is adopted as-is.
 *
 * For backward compatibility with the older `@endo/eventual-send/shim.js`
 * convention, this module additionally writes the resulting
 * `HandledPromise` constructor to `globalThis.HandledPromise` when the
 * global is currently undefined. Legacy consumers that read
 * `globalThis.HandledPromise` continue to work.
 *
 * Consumers that want explicit control over WHEN the install happens
 * (typically: before `lockdown()` runs) import this module directly,
 * usually via `@endo/init` or `@endo/lockdown`. Consumers that import
 * the package's main entry instead get a LAZY install on first use of
 * the lexical ponyfill thunks (`delegate`, `applyMethod`, etc.).
 */

import { installOrAdoptAll } from './src/install.js';

const bank = installOrAdoptAll();

if (typeof globalThis.HandledPromise === 'undefined') {
  // Legacy consumers expect `globalThis.HandledPromise` to be the
  // constructor; surface it here.
  /** @type {any} */ (globalThis).HandledPromise = bank.HandledPromise;
}
