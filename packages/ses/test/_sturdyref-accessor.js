// Stands in for a `SturdyRef` global installed as an accessor: the getter
// returns a shim-shaped constructor on its first read and a bare function on
// every later read, so a check that reads the global by `[[Get]]` would
// validate one value and let `lockdown` sample another.

class SturdyRef {
  static enliven() {}

  static isSturdyRef() {
    return false;
  }
}

let reads = 0;
Object.defineProperty(globalThis, 'SturdyRef', {
  get() {
    reads += 1;
    return reads === 1 ? SturdyRef : function Impostor() {};
  },
  enumerable: false,
  configurable: true,
});
