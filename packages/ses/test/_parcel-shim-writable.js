// Stands in for a misconfigured `Parcel` shim: the value matches what
// `lockdown` would install, but the non-configurable global is writable, which
// is not the first-wins shape `@endo/parcel` installs.

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
  writable: true,
  configurable: false,
});
