// Stands in for a misconfigured `Parcel` shim: the value matches what
// `lockdown` would install, but the non-configurable global is writable, which
// is not the first-wins shape `@endo/parcel` installs.

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
