// @ts-nocheck
/* global globalThis */
// First-wins guards against a malformed pre-existing global: a value at
// globalThis.SturdyRef that is not a { fromLocation, toLocation } namespace is
// rejected loudly rather than silently adopted. Own file (own process) so the
// pre-seeded global is isolated.

import '@endo/init';
import test from 'ava';
import harden from '@endo/harden';
import { selectSturdyRef } from '../src/sturdyref-pony.js';

test('first-wins: a malformed pre-existing SturdyRef is rejected', t => {
  Object.defineProperty(globalThis, 'SturdyRef', {
    value: harden({ notANamespace: true }),
    enumerable: false,
    writable: false,
    configurable: true,
  });
  t.throws(() => selectSturdyRef(), {
    message: /fromLocation, toLocation/,
  });
});
