// prefer-endo-primitives-exempt: this low-level pass-style test cannot depend on @endo/exo, which depends on pass-style.
import assert from 'node:assert/strict';

const { create, defineProperty, freeze, getPrototypeOf } = Object;
const scenario = process.argv[2];

assert.equal(Object.hasOwn(globalThis, 'Parcel'), false);

const importParcelCheck = async () => {
  const { isParcelObject } = await import('../src/parcel.js');
  return isParcelObject;
};

/**
 * A constructor whose `isParcel` is a brand check over its own instances.
 */
const makeBranded = () => {
  const brand = new WeakSet();
  const Branded = function Parcel() {
    const instance = freeze(create(Branded.prototype));
    brand.add(instance);
    return instance;
  };
  Branded.isParcel = value => brand.has(value);
  return freeze(Branded);
};

await null;

if (scenario === 'absent') {
  const isParcelObject = await importParcelCheck();
  assert.equal(isParcelObject(freeze({})), false);
} else if (scenario === 'accessor-global') {
  let reads = 0;
  defineProperty(globalThis, 'Parcel', {
    configurable: true,
    get() {
      reads += 1;
      throw Error('boom');
    },
  });
  const isParcelObject = await importParcelCheck();
  assert.equal(isParcelObject(freeze({})), false);
  assert.equal(reads, 0);
} else if (scenario === 'shim') {
  await import('@endo/parcel/shim.js');
  const isParcelObject = await importParcelCheck();
  const { Parcel } = /** @type {any} */ (globalThis);
  const parcel = new Parcel('test:parcel', () => 'opened');
  assert.equal(isParcelObject(parcel), true);
  // Same prototype, frozen, and empty, but not made by the constructor.
  const impostor = freeze(create(getPrototypeOf(parcel)));
  assert.equal(isParcelObject(impostor), false);
} else if (scenario === 'captured') {
  const first = makeBranded();
  const second = makeBranded();
  defineProperty(globalThis, 'Parcel', {
    configurable: true,
    writable: true,
    value: first,
  });
  const isParcelObject = await importParcelCheck();
  const fromFirst = first();
  assert.equal(isParcelObject(fromFirst), true);
  defineProperty(globalThis, 'Parcel', { value: second });
  assert.equal(isParcelObject(second()), false);
  assert.equal(isParcelObject(fromFirst), true);
} else {
  assert.fail(`unknown scenario ${scenario}`);
}
