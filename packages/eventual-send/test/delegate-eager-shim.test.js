// @ts-check
/* global globalThis */
// Verifies the EAGER surface: importing
// `@endo/eventual-send/shim.js` writes a function to each peer slot
// `Promise[Symbol.for(<name>)]` BEFORE any other code in the test
// runs. Also verifies the legacy back-compat write to
// `globalThis.HandledPromise`.

import 'ses';
import test from 'ava';

import '../shim.js';

const peerNames = /** @type {const} */ ([
  'delegate',
  'applyFunction',
  'applyFunctionSendOnly',
  'applyMethod',
  'applyMethodSendOnly',
  'get',
  'getSendOnly',
  'resolve',
  'HandledPromise',
]);

test.serial('shim eagerly populates every Promise[@<peer>] slot', t => {
  for (const name of peerNames) {
    const slot = /** @type {any} */ (Promise)[Symbol.for(name)];
    t.is(typeof slot, 'function', `slot ${name} holds a function`);
  }
});

test.serial('shim sets each peer slot non-configurable and non-writable', t => {
  for (const name of peerNames) {
    const desc = Object.getOwnPropertyDescriptor(Promise, Symbol.for(name));
    t.truthy(desc, `descriptor present for ${name}`);
    t.false(
      /** @type {PropertyDescriptor} */ (desc).configurable,
      `${name} not configurable`,
    );
    t.false(
      /** @type {PropertyDescriptor} */ (desc).writable,
      `${name} not writable`,
    );
  }
});

test.serial('shim writes globalThis.HandledPromise for back-compat', t => {
  const hp = /** @type {any} */ (globalThis).HandledPromise;
  t.is(typeof hp, 'function', 'globalThis.HandledPromise is set');
  t.is(typeof hp.applyMethod, 'function', 'has applyMethod static');
  t.is(typeof hp.applyFunction, 'function', 'has applyFunction static');
  t.is(typeof hp.resolve, 'function', 'has resolve static');
});

test.serial('the shim-installed delegate is callable', t => {
  const slot = /** @type {any} */ (Promise)[Symbol.for('delegate')];
  // The delegate is a callable function: delegate(handler) returns a
  // settler bag.
  const settler = slot();
  t.is(typeof settler.promise.then, 'function', 'returned a thenable');
  t.is(typeof settler.resolve, 'function', 'has resolve');
  t.is(typeof settler.reject, 'function', 'has reject');
  t.is(
    typeof settler.resolveWithPresence,
    'function',
    'has resolveWithPresence',
  );
});

test.serial('peers are NOT properties of the delegate function', t => {
  // Restructure invariant: applyMethod, applyFunction, etc. are PEERS
  // on Promise, not properties on `delegate`. Verify the absence on
  // delegate so a regression that re-attaches them is caught.
  const slot = /** @type {any} */ (Promise)[Symbol.for('delegate')];
  for (const name of [
    'applyFunction',
    'applyFunctionSendOnly',
    'applyMethod',
    'applyMethodSendOnly',
    'get',
    'getSendOnly',
    'resolve',
    'HandledPromise',
  ]) {
    t.is(
      slot[name],
      undefined,
      `delegate.${name} should be undefined; peer lives on Promise`,
    );
  }
});
