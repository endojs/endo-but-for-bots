// @ts-check
// Verifies the LAZY surface: importing the main entry
// (`@endo/eventual-send`) does NOT trigger the install. Each peer slot
// is observed empty after import. The first call to a lexical ponyfill
// thunk (or any `HandledPromise.*` static) triggers the install on
// demand FOR THAT PEER.

import 'ses';
import test from 'ava';

import { delegate, applyMethod, HandledPromise } from '../src/no-shim.js';

const symbolFor = Symbol.for;

test.serial('the main entry does NOT install at import (slots empty)', t => {
  // We must observe this BEFORE any other test in this file runs, since
  // the first invocation of any export triggers the install. AVA serial
  // ordering plus the fact that this is the first test ensures it.
  for (const name of [
    'delegate',
    'applyMethod',
    'applyFunction',
    'get',
    'resolve',
    'HandledPromise',
  ]) {
    const slot = /** @type {any} */ (Promise)[symbolFor(name)];
    t.is(slot, undefined, `slot ${name} is empty after import-only`);
  }
});

test.serial('the first call to delegate(...) installs at the slot', t => {
  const before = /** @type {any} */ (Promise)[symbolFor('delegate')];
  t.is(before, undefined, 'precondition: delegate slot empty');
  const settler = delegate();
  const after = /** @type {any} */ (Promise)[symbolFor('delegate')];
  t.is(typeof after, 'function', 'delegate slot populated after delegate call');
  t.is(typeof settler.promise.then, 'function', 'usable settler returned');
});

test.serial('subsequent calls to delegate(...) reuse the same delegate', t => {
  delegate();
  const slotA = /** @type {any} */ (Promise)[symbolFor('delegate')];
  delegate();
  const slotB = /** @type {any} */ (Promise)[symbolFor('delegate')];
  t.is(slotA, slotB, 'identical delegate across calls');
});

test.serial(
  'calling applyMethod thunk installs the applyMethod peer on demand',
  t => {
    // Each thunk installs its own peer slot lazily. The applyMethod
    // peer is NOT installed by calling delegate(); it is installed by
    // calling applyMethod() (or HandledPromise.applyMethod).
    const target = Object.freeze({
      noop() {
        return 'noop-result';
      },
    });
    // The lexical thunk dispatches to the peer.
    t.is(typeof applyMethod, 'function', 'lexical thunk callable');
    const promiseFromThunk = applyMethod(target, 'noop', []);
    t.is(typeof promiseFromThunk.then, 'function', 'thunk returns a promise');
    const peer = /** @type {any} */ (Promise)[symbolFor('applyMethod')];
    t.is(typeof peer, 'function', 'applyMethod peer installed after first call');
  },
);

test.serial('HandledPromise.* methods route through the same peers', t => {
  // Reading HandledPromise.resolve via the getter triggers the install
  // for the resolve peer.
  const adapterResolve = HandledPromise.resolve;
  const peerResolve = /** @type {any} */ (Promise)[symbolFor('resolve')];
  t.is(typeof HandledPromise.applyMethod, 'function');
  t.is(typeof HandledPromise.resolve, 'function');
  t.is(adapterResolve, peerResolve, 'identity with the peer slot');
  // Behavioral check: HandledPromise.resolve(x).then(v => x) works.
  return HandledPromise.resolve(42).then(v => {
    t.is(v, 42, 'resolve returns the value');
  });
});
