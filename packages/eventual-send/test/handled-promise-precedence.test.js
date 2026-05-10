// @ts-check
// Verifies that the standard `Promise.delegate` (forward-compat hook
// for the eventual TC39 proposal) takes precedence over the
// registered-symbol slot.

import 'ses';
import test from 'ava';

const symbolForDelegate = Symbol.for('delegate');

// Plant both a `Promise.delegate` (the standard slot) AND a
// `Promise[Symbol.for('delegate')]` (the registry slot) before
// importing the ponyfill. The ponyfill should pick the standard one.
const standardDelegate = function StandardDelegate() {};
/** @type {any} */ (standardDelegate).source = 'standard';
const registrySlot = function RegistryDelegate() {};
/** @type {any} */ (registrySlot).source = 'registry';

Object.defineProperty(Promise, 'delegate', {
  value: standardDelegate,
  configurable: true,
  writable: true,
  enumerable: false,
});
Object.defineProperty(Promise, symbolForDelegate, {
  value: registrySlot,
  configurable: false,
  writable: false,
  enumerable: false,
});

const { getHandledPromise } = await import('../handled-promise.js');

test.serial('standard Promise.delegate wins over registry slot', t => {
  const hp = getHandledPromise();
  t.is(
    /** @type {any} */ (hp),
    standardDelegate,
    'returned the standard delegate',
  );
  t.is(/** @type {any} */ (hp).source, 'standard');
});

test.serial('cache survives across calls', t => {
  const a = getHandledPromise();
  const b = getHandledPromise();
  t.is(a, b);
  t.is(/** @type {any} */ (a), standardDelegate);
});
