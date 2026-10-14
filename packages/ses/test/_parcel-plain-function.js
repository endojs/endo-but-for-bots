// Stands in for a `Parcel` global that carries the shim's `open` and
// `isParcel` statics and a `prototype`, but is a plain function rather than
// a class: its `prototype` stays writable, so a Proxy over it could report one
// `prototype` by descriptor and another by `[[Get]]`.

const { defineProperty } = Object;

function Parcel() {}
Parcel.open = () => {};
Parcel.locate = () => '';
Parcel.isParcel = () => false;

defineProperty(globalThis, 'Parcel', {
  value: Parcel,
  enumerable: false,
  writable: false,
  configurable: false,
});
