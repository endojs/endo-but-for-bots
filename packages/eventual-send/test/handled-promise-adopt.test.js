// @ts-check
// Simulates "another library installed first": pre-populates
// `Promise[Symbol.for('delegate')]` before the ponyfill is imported,
// then verifies the ponyfill adopts the pre-installed value rather
// than installing its own.

import 'ses';
import test from 'ava';

const symbolForDelegate = Symbol.for('delegate');

// Plant a stand-in `HandledPromise` BEFORE importing the ponyfill.
// The ponyfill's module-local cache is initialized lazily on first
// `getHandledPromise()` call, so even after the import the slot
// observation happens on first use.
const fakeHandledPromise = function FakeHandledPromise() {};
fakeHandledPromise.isFake = true;
Object.defineProperty(Promise, symbolForDelegate, {
  value: fakeHandledPromise,
  configurable: false,
  writable: false,
  enumerable: false,
});

const { getHandledPromise } = await import('../handled-promise.js');

test.serial('ponyfill adopts the pre-installed delegate', t => {
  const hp = getHandledPromise();
  t.is(
    /** @type {any} */ (hp),
    fakeHandledPromise,
    'returned reference equals pre-installed',
  );
  t.true(/** @type {any} */ (hp).isFake, 'fake brand survived');
});

test.serial('subsequent calls return the same adopted reference', t => {
  const first = getHandledPromise();
  const second = getHandledPromise();
  t.is(first, second, 'adopted value is cached');
  t.is(
    /** @type {any} */ (first),
    fakeHandledPromise,
    'cached value is the adopted one',
  );
});

test.serial(
  'slot is unchanged after adoption (no second defineProperty)',
  t => {
    getHandledPromise();
    t.is(
      /** @type {any} */ (Promise)[symbolForDelegate],
      fakeHandledPromise,
      'slot still holds the pre-installed value',
    );
  },
);
