// @ts-nocheck
// The initial Parcel shim is installed before lockdown and deliberately stays
// mutable until SES derives and hardens the shared constructor in layer 2.

import '../shim.js';
import test from 'ava';
import { provideParcel } from '../src/parcel-shim.js';

const Installed = globalThis.Parcel;

test('the eager shim installs and selects one initial constructor', t => {
  t.is(typeof Installed, 'function');
  t.is(provideParcel(), Installed);
  t.is(typeof Installed.open, 'function');
  t.is(typeof Installed.locate, 'function');
  t.is(typeof Installed.isParcel, 'function');
  t.false(Object.isFrozen(Installed));
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Parcel');
  t.false(descriptor.writable);
  t.false(descriptor.configurable);
  t.false(descriptor.enumerable);
});

test('the initial constructor opens and locates its Parcels', async t => {
  const parcel = new Installed('test:prelockdown', location => location);
  t.true(Object.isFrozen(parcel));
  t.is(Installed.locate(parcel), 'test:prelockdown');
  t.is(await Installed.open(parcel), 'test:prelockdown');
});
