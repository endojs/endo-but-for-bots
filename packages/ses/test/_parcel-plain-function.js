// Stands in for a `Parcel` global that carries the shim's `open` and
// `isParcel` statics and a `prototype`, but is a plain function rather than
// a class: its `prototype` stays writable, so a Proxy over it could report one
// `prototype` by descriptor and another by `[[Get]]`.

export {};

const { defineProperty } = Object;
const fixtureGlobal = /** @type {any} */ (globalThis);

const plainParcel = function Parcel() {};
plainParcel.open = () => {};
plainParcel.locate = () => '';
plainParcel.isParcel = () => false;

defineProperty(fixtureGlobal, 'Parcel', {
  value: plainParcel,
  enumerable: false,
  writable: false,
  configurable: false,
});
