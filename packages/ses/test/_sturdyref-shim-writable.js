// Stands in for a misconfigured `SturdyRef` shim: the value matches what
// `lockdown` would install, but the non-configurable global is writable, which
// is not the first-wins shape `@endo/sturdyref` installs.

class SturdyRef {
  static enliven() {}

  static isSturdyRef() {
    return false;
  }
}

Object.defineProperty(globalThis, 'SturdyRef', {
  value: SturdyRef,
  enumerable: false,
  writable: true,
  configurable: false,
});
