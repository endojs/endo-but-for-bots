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
  if (descriptor === undefined) {
    t.fail('Parcel must be an own property');
    return;
  }
  t.false(descriptor.writable);
  t.false(descriptor.configurable);
  t.false(descriptor.enumerable);
});

test('the initial constructor opens and locates its Parcels', async t => {
  await null;
  const parcel = new Installed('test:prelockdown', location => location);
  t.true(Object.isFrozen(parcel));
  t.is(Installed.locate(parcel), 'test:prelockdown');
  t.is(await Installed.open(parcel), 'test:prelockdown');
});

test('the initial constructor supports a powerless shared constructor', async t => {
  await null;
  const SharedParcel = /** @type {typeof Installed} */ (
    /** @type {unknown} */ (
      function Parcel(location, openHook) {
        if (new.target === undefined) {
          throw TypeError('Parcel requires new');
        }
        return Reflect.construct(Installed, [location, openHook], new.target);
      }
    )
  );
  Object.defineProperties(SharedParcel, {
    prototype: { value: Installed.prototype },
    open: { value: Installed.open },
    isParcel: { value: Installed.isParcel },
  });
  Object.defineProperty(Installed.prototype, 'constructor', {
    value: SharedParcel,
  });

  const parcel = new SharedParcel('test:shared', location => location);
  t.is(Object.getPrototypeOf(parcel), Installed.prototype);
  t.is(parcel.constructor, SharedParcel);
  t.true(Installed.isParcel(parcel));
  t.true(SharedParcel.isParcel(parcel));
  t.is(await SharedParcel.open(parcel), 'test:shared');
  t.false(Object.hasOwn(SharedParcel, 'locate'));
  t.is(Installed.locate(parcel), 'test:shared');
});
