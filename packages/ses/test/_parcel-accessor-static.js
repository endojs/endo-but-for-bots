// Stands in for a `Parcel` global whose `open` static is an accessor with a
// getter that throws, so a check that reads statics by `[[Get]]` would run it.

export {};

const { defineProperty } = Object;
const fixtureGlobal = /** @type {any} */ (globalThis);

export const getterCalls = { count: 0 };

const accessorStaticParcel = class Parcel {
  static locate() {
    return '';
  }

  static isParcel() {
    return false;
  }
};
defineProperty(accessorStaticParcel, 'open', {
  get() {
    getterCalls.count += 1;
    throw Error('Parcel.open getter must not run');
  },
  configurable: true,
});

defineProperty(fixtureGlobal, 'Parcel', {
  value: accessorStaticParcel,
  enumerable: false,
  writable: false,
  configurable: false,
});
