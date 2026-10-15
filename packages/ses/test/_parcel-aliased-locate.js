// Stands in for a `Parcel` global whose `open` is the same function as its
// `locate`, which would give every child compartment location authority.

export {};

const { defineProperty } = Object;
const fixtureGlobal = /** @type {any} */ (globalThis);

const aliasedParcel = class Parcel {
  static locate() {
    return '';
  }

  static isParcel() {
    return false;
  }
};
defineProperty(aliasedParcel, 'open', { value: aliasedParcel.locate });

defineProperty(fixtureGlobal, 'Parcel', {
  value: aliasedParcel,
  enumerable: false,
  writable: false,
  configurable: false,
});
