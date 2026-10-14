// Stands in for a `Parcel` shim that did not lock its global: the value is
// what `lockdown` would install, but the binding is configurable, which is not
// the first-wins shape `@endo/parcel` installs.

class Parcel {
  static open() {}

  static locate() {}

  static isParcel() {
    return false;
  }
}

Object.defineProperty(globalThis, 'Parcel', {
  value: Parcel,
  enumerable: false,
  writable: false,
  configurable: true,
});
