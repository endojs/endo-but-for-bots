// Stands in for a `SturdyRef` shim that did not lock its global: the value is
// what `lockdown` would install, but the binding is configurable, which is not
// the first-wins shape `@endo/sturdyref` installs.

class SturdyRef {
  static enliven() {}

  static isSturdyRef() {
    return false;
  }
}

Object.defineProperty(globalThis, 'SturdyRef', {
  value: SturdyRef,
  enumerable: false,
  writable: false,
  configurable: true,
});
