// Stands in for a `Parcel` global installed as an accessor: the getter
// returns a shim-shaped constructor on its first read and a bare function on
// every later read, so a check that reads the global by `[[Get]]` would
// validate one value and let `lockdown` sample another.

class Parcel {
  static open() {}

  static locate() {}

  static isParcel() {
    return false;
  }
}

let reads = 0;
Object.defineProperty(globalThis, 'Parcel', {
  get() {
    reads += 1;
    return reads === 1 ? Parcel : function Impostor() {};
  },
  enumerable: false,
  configurable: true,
});
