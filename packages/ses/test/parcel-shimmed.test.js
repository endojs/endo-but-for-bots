import './_parcel-shim-first.js';
import '../index.js';
import test from 'ava';
import { fc as fastCheck } from '@fast-check/ava';

const InitialParcel = /** @type {any} */ (globalThis).Parcel;
lockdown();

const { getOwnPropertyDescriptor, isFrozen } = Object;
const SharedParcel = new Compartment().globalThis.Parcel;

test('lockdown preserves initial authority and derives a shared constructor', t => {
  t.is(/** @type {any} */ (globalThis).Parcel, InitialParcel);
  t.not(SharedParcel, InitialParcel);
  t.is(typeof InitialParcel.locate, 'function');
  t.false(Object.hasOwn(SharedParcel, 'locate'));
  t.is(SharedParcel.open, InitialParcel.open);
  t.is(SharedParcel.isParcel, InitialParcel.isParcel);
  t.is(SharedParcel.prototype, InitialParcel.prototype);
  t.is(SharedParcel.prototype.constructor, SharedParcel);
});

test('the locked start binding and ordinary child binding are distinct', t => {
  const initialDescriptor = getOwnPropertyDescriptor(globalThis, 'Parcel');
  t.is(initialDescriptor?.value, InitialParcel);
  t.false(initialDescriptor?.writable);
  t.false(initialDescriptor?.configurable);

  const childDescriptor = getOwnPropertyDescriptor(
    new Compartment().globalThis,
    'Parcel',
  );
  t.is(childDescriptor?.value, SharedParcel);
  t.true(childDescriptor?.writable);
  t.true(childDescriptor?.configurable);
});

test('lockdown hardens both constructors, their statics, and prototype', t => {
  for (const specimen of [
    InitialParcel,
    InitialParcel.open,
    InitialParcel.locate,
    InitialParcel.isParcel,
    SharedParcel,
    SharedParcel.open,
    SharedParcel.isParcel,
    SharedParcel.prototype,
  ]) {
    t.true(isFrozen(specimen));
  }
});

test('child construction shares the initial brand and opening table', async t => {
  const compartment = new Compartment({
    __options__: true,
    globals: { harden },
  });
  const parcel = compartment.evaluate(
    `new Parcel('test:child', (location, specimen) => harden({ location, specimen }))`,
  );
  t.true(InitialParcel.isParcel(parcel));
  t.is(InitialParcel.locate(parcel), 'test:child');
  t.is(parcel instanceof InitialParcel, true);
  t.is(parcel instanceof SharedParcel, true);
  const opened = await SharedParcel.open(parcel);
  t.is(opened.location, 'test:child');
  t.is(opened.specimen, parcel);
});

test('child code cannot recover the initial constructor', t => {
  const compartment = new Compartment();
  t.is(compartment.evaluate('Parcel'), SharedParcel);
  t.is(compartment.evaluate('Parcel.prototype.constructor'), SharedParcel);
  t.is(compartment.evaluate('typeof Parcel.locate'), 'undefined');
  const grandchild = compartment.evaluate('new Compartment()');
  t.is(grandchild.globalThis.Parcel, SharedParcel);
});

test('the shared constructor delegates construction with its new target', t => {
  t.is(SharedParcel.name, 'Parcel');
  t.is(SharedParcel.length, 2);
  t.throws(() => SharedParcel('test:call', () => {}), {
    message: /Parcel requires new/,
  });
  const compartment = new Compartment();
  t.throws(
    () =>
      compartment.evaluate(
        `new (class extends Parcel {})('test:sub', () => {})`,
      ),
    { message: /Parcel construction requires the shared Parcel prototype/ },
  );
});

test('shared construction keeps each location and parcel distinct', async t => {
  await fastCheck.assert(
    fastCheck.asyncProperty(
      fastCheck.uniqueArray(fastCheck.string(), {
        minLength: 1,
        maxLength: 20,
      }),
      async locations => {
        const openHook = harden((location, specimen) =>
          harden({ location, specimen }),
        );
        const parcels = locations.map(
          location => new SharedParcel(location, openHook),
        );
        const opened = await Promise.all(
          parcels.map(parcel => SharedParcel.open(parcel)),
        );
        return parcels.every(
          (parcel, index) =>
            SharedParcel.isParcel(parcel) &&
            InitialParcel.locate(parcel) === locations[index] &&
            opened[index].location === locations[index] &&
            opened[index].specimen === parcel,
        );
      },
    ),
  );
  t.pass();
});
