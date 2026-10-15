// Stands in for a misconfigured `Parcel` shim: its binding is enumerable.

export {};

const fixtureGlobal = /** @type {any} */ (globalThis);

const enumerableParcel = class Parcel {
  static open() {}

  static locate() {}

  static isParcel() {
    return false;
  }
};

Object.defineProperty(fixtureGlobal, 'Parcel', {
  value: enumerableParcel,
  enumerable: true,
  writable: false,
  configurable: false,
});
