// Stands in for a misconfigured `SturdyRef` shim: the value matches what
// `lockdown` would install, but the locked global is enumerable, which is not
// the first-wins shape `@endo/sturdyref` installs.

class SturdyRef {
  static enliven() {}

  static isSturdyRef() {
    return false;
  }
}

Object.defineProperty(globalThis, 'SturdyRef', {
  value: SturdyRef,
  enumerable: true,
  writable: false,
  configurable: false,
});
