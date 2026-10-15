// Stands in for a `Parcel` global that lacks only `locate`.

export {};

const { defineProperty } = Object;
const fixtureGlobal = /** @type {any} */ (globalThis);

const noLocateParcel = class Parcel {
  static open() {}

  static isParcel() {
    return false;
  }
};

defineProperty(fixtureGlobal, 'Parcel', {
  value: noLocateParcel,
  enumerable: false,
  writable: false,
  configurable: false,
});
