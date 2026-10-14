// Stands in for a `Parcel` global that carries the shim's `open` and
// `isParcel` statics but is not a constructor: an arrow function, which has
// no own `prototype`.

const { defineProperty } = Object;

const Parcel = () => {};
Parcel.open = () => {};
Parcel.locate = () => '';
Parcel.isParcel = () => false;

defineProperty(globalThis, 'Parcel', {
  value: Parcel,
  enumerable: false,
  writable: false,
  configurable: false,
});
