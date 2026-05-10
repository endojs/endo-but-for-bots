// @ts-check
// Verifies the ponyfill installs at `Promise[Symbol.for('delegate')]`
// when the slot is empty, caches the result, and that subsequent calls
// from the same module instance hit the cache.

import 'ses';
import test from 'ava';

import { getHandledPromise } from '../handled-promise.js';

const symbolForDelegate = Symbol.for('delegate');

test.serial('first call installs at Promise[@delegate]', t => {
  const before = /** @type {any} */ (Promise)[symbolForDelegate];
  // The slot may already be installed by a prior import in this worker,
  // but if not, this call is the first. Either way, the post-condition
  // is that the slot holds a function.
  const hp = getHandledPromise();
  const after = /** @type {any} */ (Promise)[symbolForDelegate];
  t.is(typeof hp, 'function');
  t.is(after, hp, 'slot value matches returned constructor');
  if (before !== undefined) {
    t.is(after, before, 'pre-existing slot value preserved');
  }
});

test.serial('slot is installed non-configurable and non-writable', t => {
  // After `getHandledPromise()` has run at least once in this worker,
  // the slot must be locked down per the race-to-install discipline.
  getHandledPromise();
  const desc = Object.getOwnPropertyDescriptor(Promise, symbolForDelegate);
  t.truthy(desc, 'descriptor present');
  t.false(
    /** @type {PropertyDescriptor} */ (desc).configurable,
    'not configurable',
  );
  t.false(/** @type {PropertyDescriptor} */ (desc).writable, 'not writable');
  t.false(
    /** @type {PropertyDescriptor} */ (desc).enumerable,
    'not enumerable',
  );
});

test.serial('second call returns the cached constructor', t => {
  const first = getHandledPromise();
  const second = getHandledPromise();
  t.is(first, second, 'cache hit returns identical reference');
});

test.serial('returned constructor exposes HandledPromise static methods', t => {
  const hp = getHandledPromise();
  t.is(typeof hp.applyMethod, 'function');
  t.is(typeof hp.applyFunction, 'function');
  t.is(typeof hp.get, 'function');
  t.is(typeof hp.resolve, 'function');
});
