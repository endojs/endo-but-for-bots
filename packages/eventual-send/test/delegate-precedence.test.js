// @ts-check
// Verifies the forward-compat hook for the `delegate` peer: when
// `Promise.delegate` (the expected eventual TC39 standard slot) is
// present and is a function, the install path returns it without
// consulting the registered-symbol slot.
//
// The other peers do not have a forward-compat hook (only the
// `delegate` peer maps to the proposed standard `Promise.delegate`).

import 'ses';
import test from 'ava';

const symbolFor = Symbol.for;

// Plant BOTH a `Promise.delegate` (the standard slot) AND a
// `Promise[Symbol.for('delegate')]` (the registry slot) before
// importing the install path. The install path should pick the
// standard one.
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
Object.defineProperty(Promise, symbolFor('delegate'), {
  value: registrySlot,
  configurable: false,
  writable: false,
  enumerable: false,
});

const { installOrAdoptOne } = await import('../src/install.js');

test.serial('Promise.delegate wins over the registry slot', t => {
  const adopted = installOrAdoptOne('delegate');
  t.is(
    /** @type {any} */ (adopted),
    standardDelegate,
    'returned the standard delegate',
  );
  t.is(/** @type {any} */ (adopted).source, 'standard');
});

test.serial('cache survives across calls', t => {
  const a = installOrAdoptOne('delegate');
  const b = installOrAdoptOne('delegate');
  t.is(a, b, 'cache returns identical reference');
});

test.serial(
  'no Promise.applyMethod precedence — only delegate has the hook',
  t => {
    // Plant an applyMethod registry slot WITHOUT a Promise.applyMethod.
    // The peer should adopt the registry slot regardless.
    const planted = function PlantedApplyMethod() {};
    /** @type {any} */ (planted).source = 'registry-applyMethod';
    Object.defineProperty(Promise, symbolFor('applyMethod'), {
      value: planted,
      configurable: false,
      writable: false,
      enumerable: false,
    });
    const adopted = installOrAdoptOne('applyMethod');
    t.is(
      /** @type {any} */ (adopted),
      planted,
      'applyMethod adopts the registry slot, no precedence hook',
    );
  },
);
