// @ts-check
// Simulates the "lost race" scenario: between the ponyfill's read of
// `Promise[Symbol.for('delegate')]` (sees empty) and its
// `Object.defineProperty` write, a competing writer takes the slot.
// `defineProperty` throws because the slot is now non-configurable;
// the ponyfill's catch path re-reads and adopts the winner.
//
// We simulate the race by intercepting `Object.defineProperty` so the
// first call from the ponyfill triggers the competing write before
// the original `defineProperty` proceeds. The original then throws,
// the ponyfill catches, re-reads, and returns the winner's value.

import 'ses';
import test from 'ava';

const symbolForDelegate = Symbol.for('delegate');

const winner = function WinningHandledPromise() {};
/** @type {any} */ (winner).brand = 'winner';

const originalDefineProperty = Object.defineProperty;
let intercepted = false;
/** @type {typeof Object.defineProperty} */
const patchedDefineProperty = (target, key, descriptor) => {
  if (
    !intercepted &&
    /** @type {any} */ (target) === Promise &&
    key === symbolForDelegate
  ) {
    intercepted = true;
    // The competing writer takes the slot first.
    originalDefineProperty(target, key, {
      value: winner,
      configurable: false,
      writable: false,
      enumerable: false,
    });
    // Now the ponyfill's own defineProperty call (the one we're
    // intercepting) goes ahead. It will throw because the slot is
    // already non-configurable.
  }
  return originalDefineProperty(target, key, descriptor);
};
Object.defineProperty = patchedDefineProperty;

const { getHandledPromise } = await import('../handled-promise.js');

test.serial('ponyfill recovers from a lost race', t => {
  const hp = getHandledPromise();
  t.is(/** @type {any} */ (hp), winner, 'adopted the racing winner');
  t.is(/** @type {any} */ (hp).brand, 'winner');
  t.true(intercepted, 'race interception fired');
});

test.serial('subsequent calls return the cached adopted value', t => {
  const a = getHandledPromise();
  const b = getHandledPromise();
  t.is(a, b);
  t.is(/** @type {any} */ (a), winner);
});

// Restore the original after the race-test work is done. AVA runs
// each test file in its own worker, so this is precautionary rather
// than load-bearing.
test.after.always(() => {
  Object.defineProperty = originalDefineProperty;
});
