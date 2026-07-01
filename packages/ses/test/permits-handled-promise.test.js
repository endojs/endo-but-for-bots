// @ts-check

/* global globalThis */

import test from 'ava';
import '../index.js';

// HandledPromise is supplied by `@endo/eventual-send`'s shim and is not a
// SES intrinsic on its own. The permits in `packages/ses/src/permits.js`
// list `subscribe` and `settle` (alongside the prior `applyMethod`,
// `applyFunction`, `get`, `resolve`, ...) so that lockdown does not
// remove them when the shim has installed `HandledPromise` on the
// global before lockdown runs. This test simulates that flow: install a
// minimal HandledPromise shim with the new methods, then run lockdown,
// and verify lockdown left the methods in place.

/** @type {any} */
const minimalShim = function HandledPromise(_executor) {
  // Constructor body is irrelevant for the permits test; we only need
  // the function value to exist so lockdown's intrinsic-walking finds
  // it under globalThis.HandledPromise.
};
// Per the SES permits, HandledPromise's [[Prototype]] is %Promise%.
Object.setPrototypeOf(minimalShim, Promise);
// Per HandledPromise convention, prototype must be Promise.prototype.
minimalShim.prototype = Promise.prototype;
// Static methods that the permits file enumerates. We only attach the
// two new ones plus one prior method (resolve) as a control.
minimalShim.applyFunction = () => {};
minimalShim.applyFunctionSendOnly = () => {};
minimalShim.applyMethod = () => {};
minimalShim.applyMethodSendOnly = () => {};
minimalShim.get = () => {};
minimalShim.getSendOnly = () => {};
minimalShim.resolve = () => {};
minimalShim.subscribe = () => {};
minimalShim.settle = () => {};

/** @type {any} */ (globalThis).HandledPromise = minimalShim;

lockdown();

test('lockdown does not remove HandledPromise.subscribe', t => {
  /** @type {any} */
  const HP = /** @type {any} */ (globalThis).HandledPromise;
  t.is(typeof HP.subscribe, 'function');
});

test('lockdown does not remove HandledPromise.settle', t => {
  /** @type {any} */
  const HP = /** @type {any} */ (globalThis).HandledPromise;
  t.is(typeof HP.settle, 'function');
});

test('lockdown preserves HandledPromise.resolve (control)', t => {
  /** @type {any} */
  const HP = /** @type {any} */ (globalThis).HandledPromise;
  t.is(typeof HP.resolve, 'function');
});
