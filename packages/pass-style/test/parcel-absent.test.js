import test from '@endo/ses-ava/test.js';

const mutableTest =
  Object.getOwnPropertyDescriptor(globalThis, 'Parcel')?.configurable !== false
    ? test
    : test.skip;

mutableTest('without the shim, no Parcel global appears', t => {
  t.is(/** @type {any} */ (globalThis).Parcel, undefined);
});
