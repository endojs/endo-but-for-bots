// Stands in for a misconfigured `Parcel` shim whose binding is not the
// first-wins shape `@endo/parcel` installs: here, it is writable.

export {};

const fixtureGlobal = /** @type {any} */ (globalThis);

const writableParcel = class Parcel {
  static open() {}

  static locate() {}

  static isParcel() {
    return false;
  }
};

Object.defineProperty(fixtureGlobal, 'Parcel', {
  value: writableParcel,
  enumerable: false,
  writable: true,
  configurable: false,
});
