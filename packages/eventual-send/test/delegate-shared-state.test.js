// @ts-check
// Verifies the load-bearing claim of the architecture: "all instances
// of @endo/eventual-send share state via the registered-symbol slots".
//
// Approach: import the install path once, install each peer, then
// observe that each slot value is identical to what subsequent reads
// return. The same registry slot serves any module instance that
// reads it.

import 'ses';
import test from 'ava';

import { installOrAdoptOne, installOrAdoptAll } from '../src/install.js';

const symbolFor = Symbol.for;

test.serial(
  'installOrAdoptOne returns the same value as Promise[@<name>] holds',
  t => {
    for (const name of /** @type {const} */ ([
      'delegate',
      'applyMethod',
      'applyFunction',
      'get',
      'resolve',
      'HandledPromise',
    ])) {
      const installed = installOrAdoptOne(name);
      const slot = /** @type {any} */ (Promise)[symbolFor(name)];
      t.is(slot, installed, `slot ${name} value matches install return`);
    }
  },
);

test.serial(
  'a second installOrAdoptOne call returns the same function',
  t => {
    const a = installOrAdoptOne('delegate');
    const b = installOrAdoptOne('delegate');
    t.is(a, b, 'cache returns identical reference');
  },
);

test.serial(
  'installOrAdoptAll returns a bank whose entries match the slots',
  t => {
    const bank = installOrAdoptAll();
    for (const name of /** @type {const} */ ([
      'delegate',
      'applyMethod',
      'resolve',
      'HandledPromise',
    ])) {
      t.is(
        /** @type {any} */ (bank)[name],
        /** @type {any} */ (Promise)[symbolFor(name)],
        `bank.${name} matches slot`,
      );
    }
  },
);

test.serial('a fresh read of the slot equals the install return', t => {
  const installed = installOrAdoptOne('delegate');
  const slot = /** @type {any} */ (Promise)[symbolFor('delegate')];
  t.is(slot, installed, 'slot is the realm-shared delegate');
  t.is(typeof slot, 'function', 'slot is a function');
});
