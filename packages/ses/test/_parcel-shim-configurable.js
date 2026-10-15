// Stands in for a misconfigured `Parcel` shim: its binding is configurable.

export {};

const fixtureGlobal = /** @type {any} */ (globalThis);

const configurableParcel = class Parcel {
  static open() {}

  static locate() {}

  static isParcel() {
    return false;
  }
};

Object.defineProperty(fixtureGlobal, 'Parcel', {
  value: configurableParcel,
  enumerable: false,
  writable: false,
  configurable: true,
});
