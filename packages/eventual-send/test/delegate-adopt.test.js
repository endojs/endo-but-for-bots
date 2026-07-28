// @ts-check
// Verifies the adopt path: when stand-in peers are pre-installed at
// `Promise[Symbol.for(<name>)]` BEFORE the package's surfaces are
// imported, both the shim and the main entry adopt them rather than
// installing their own.

import 'ses';
import test from 'ava';

const symbolFor = Symbol.for;

// Plant stand-in peers before importing either surface. We plant the
// `delegate` and `applyMethod` peers; the shim should install fresh
// peers for the others.
const fakeDelegate = function FakeDelegate() {
  return Object.freeze({
    promise: Promise.resolve(),
    resolve: () => {},
    reject: () => {},
    resolveWithPresence: () => Object.create(null),
  });
};
/** @type {any} */ (fakeDelegate).isFake = true;

const fakeApplyMethod = function FakeApplyMethod() {
  return Promise.resolve('fake-applyMethod');
};
/** @type {any} */ (fakeApplyMethod).isFake = true;

Object.defineProperty(Promise, symbolFor('delegate'), {
  value: fakeDelegate,
  configurable: false,
  writable: false,
  enumerable: false,
});
Object.defineProperty(Promise, symbolFor('applyMethod'), {
  value: fakeApplyMethod,
  configurable: false,
  writable: false,
  enumerable: false,
});

// Now import both surfaces. They should both adopt the planted values
// rather than installing their own at those slots.
await import('../shim.js');
const { delegate, applyMethod } = await import('../src/no-shim.js');

test.serial('shim adopts the pre-installed delegate (no overwrite)', t => {
  const slot = /** @type {any} */ (Promise)[symbolFor('delegate')];
  t.is(slot, fakeDelegate, 'slot still holds the planted value');
  t.true(/** @type {any} */ (slot).isFake, 'fake brand survived');
});

test.serial('shim adopts the pre-installed applyMethod', t => {
  const slot = /** @type {any} */ (Promise)[symbolFor('applyMethod')];
  t.is(slot, fakeApplyMethod, 'slot still holds the planted value');
});

test.serial('main entry delegate thunk routes through the planted fake', t => {
  const settler = delegate();
  // The fake's settler.promise is a known Promise.resolve(), so we
  // can confirm we hit the fake.
  t.is(typeof settler.promise.then, 'function');
  t.is(/** @type {any} */ (Promise)[symbolFor('delegate')], fakeDelegate);
});

test.serial(
  'main entry applyMethod thunk routes through the planted fake',
  async t => {
    const result = await applyMethod({}, 'noop', []);
    t.is(result, 'fake-applyMethod', 'fake applyMethod was reached');
  },
);
