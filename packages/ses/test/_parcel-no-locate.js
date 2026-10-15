// Stands in for a `Parcel` global with every part of the compatible shape
// except `locate`: a class with a locked `prototype` and `open` and `isParcel`
// statics.

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
