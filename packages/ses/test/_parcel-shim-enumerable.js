// Stands in for a misconfigured `Parcel` shim: the value matches what
// `lockdown` would install, but the locked global is enumerable, which is not
// the first-wins shape `@endo/parcel` installs.

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
