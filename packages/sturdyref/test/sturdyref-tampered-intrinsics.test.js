// @ts-nocheck
/* eslint-disable no-extend-native -- the test tampers with intrinsics on purpose */
// Without lockdown, the `WeakMap` and `Promise` globals and their prototypes
// are mutable. The shim captures them at module load, so replacing them after
// import (but before the first ref is made) cannot capture the ref-to-handler
// map or the result of enlivening. Isolated in its own file (its own process)
// because it never locks down and tampers with globals.

import test from 'ava';
import { makeSturdyRef, enliven, isSturdyRef } from '../src/sturdyref-pony.js';

test('replacing WeakMap and Promise.prototype.then after import reaches nothing', async t => {
  const leaked = [];
  // Tamper through untyped aliases: a direct `Promise.prototype.then = ...`
  // or `globalThis.WeakMap = ...` in a JS file redeclares the global type for
  // every file in the repository-wide type check.
  const global = /** @type {any} */ (globalThis);
  const promisePrototype = /** @type {any} */ (Promise.prototype);
  const OriginalWeakMap = WeakMap;
  const { then } = promisePrototype;
  global.WeakMap = function LeakyWeakMap(...args) {
    const map = new OriginalWeakMap(...args);
    leaked.push(map);
    return map;
  };
  promisePrototype.then = function tamperedThen(onFulfilled, onRejected) {
    leaked.push(onFulfilled);
    return Reflect.apply(then, this, [onFulfilled, onRejected]);
  };
  let ref;
  let pending;
  try {
    // The first call installs the constructor, building its private map.
    ref = makeSturdyRef({ enliven: () => 'live' });
    pending = enliven(ref);
  } finally {
    global.WeakMap = OriginalWeakMap;
    promisePrototype.then = then;
  }
  t.is(await pending, 'live');
  t.true(isSturdyRef(ref));
  t.is(leaked.length, 0, 'neither the map nor the continuation leaked');
});
