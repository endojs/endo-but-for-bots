// @ts-nocheck
// The shim installed BEFORE lockdown, as a `HandledPromise` shim would be.
// Installing must not use `@endo/harden`, which would make lockdown throw
// "Cannot lockdown (repairIntrinsics) if a prior harden implementation has
// been used and installed". Lockdown then hardens the constructor. Isolated in
// its own file (its own process) because it runs lockdown itself.

import '../shim.js';
import 'ses';
import test from 'ava';
import { provideSturdyRef } from '../src/sturdyref-shim.js';
import { enliven, isSturdyRef } from '../src/sturdyref-pony.js';

const { isFrozen, getPrototypeOf, getOwnPropertyDescriptor } = Object;
const { ownKeys } = Reflect;

const Installed = globalThis.SturdyRef;

// Captured before lockdown, which would otherwise install the harden we are
// checking is absent.
const hardenBeforeLockdown = Object[Symbol.for('harden')];

// Before lockdown the shim only freezes what it owns; the shared intrinsics
// above it (here `Function.prototype`) are still mutable.
const functionPrototypeFrozenBeforeLockdown = Object.isFrozen(
  Function.prototype,
);

let lockdownError;
try {
  lockdown();
} catch (error) {
  lockdownError = error;
}

test('importing the shim before lockdown installs without @endo/harden', t => {
  t.is(typeof Installed, 'function', 'the shim installed at import time');
  t.is(hardenBeforeLockdown, undefined, 'no prior harden was installed');
});

test('lockdown succeeds after the shim was imported', t => {
  t.is(lockdownError, undefined);
  t.is(typeof harden, 'function');
});

test('the pre-lockdown install is the realm constructor, locked in place', t => {
  t.is(globalThis.SturdyRef, Installed);
  t.is(provideSturdyRef(), Installed);
  const descriptor = getOwnPropertyDescriptor(globalThis, 'SturdyRef');
  t.false(descriptor.writable);
  t.false(descriptor.configurable);
  t.false(descriptor.enumerable);
});

test('the constructor, prototype, and statics are frozen', t => {
  t.true(isFrozen(Installed));
  t.true(isFrozen(Installed.prototype));
  t.true(isFrozen(Installed.enliven));
  t.true(isFrozen(Installed.isSturdyRef));
});

// SES does not yet permit `SturdyRef` as an intrinsic, so lockdown does not
// itself harden the constructor; the shim froze it, lockdown hardened the
// shared intrinsics beneath it, and `harden` then accepts it.
test('after lockdown, harden accepts the pre-lockdown constructor', t => {
  t.false(functionPrototypeFrozenBeforeLockdown, 'shim did not harden');
  t.true(isFrozen(getPrototypeOf(Installed)), 'lockdown hardened the rest');
  t.is(harden(Installed), Installed, 'harden accepts it as already hardened');
});

test('the constructor matches the shape SES permits for SturdyRef', t => {
  // Pins the shape that the intended layer-2 `SturdyRef` and
  // `%SturdyRefPrototype%` SES permits will expect; no such permit exists in
  // SES yet, but any extra own property would be removed (or would break
  // lockdown) once one is added.
  t.is(getPrototypeOf(Installed), Function.prototype);
  t.deepEqual(ownKeys(Installed).sort(), [
    'enliven',
    'isSturdyRef',
    'length',
    'name',
    'prototype',
  ]);
  t.deepEqual(ownKeys(Installed.prototype), [
    'constructor',
    Symbol.toStringTag,
  ]);
  t.is(Installed.prototype.constructor, Installed);
});

test('refs made after lockdown work and are frozen', async t => {
  const ref = new Installed({ enliven: () => 'live' });
  t.true(isFrozen(ref));
  t.true(isSturdyRef(ref));
  t.is(await enliven(ref), 'live');
});

test('a child compartment sees the same constructor if SES shares it', t => {
  // Without SES's `SturdyRef` permit, a child compartment has no SturdyRef;
  // with it, the child receives this very constructor.
  const { SturdyRef: childSturdyRef } = new Compartment().globalThis;
  t.true(childSturdyRef === undefined || childSturdyRef === Installed);
});
