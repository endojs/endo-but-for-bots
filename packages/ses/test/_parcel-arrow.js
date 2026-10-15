// Stands in for a `Parcel` global that carries the shim's `open` and
// `isParcel` statics but is not a constructor: an arrow function, which has
// no own `prototype`.

export {};

const { defineProperty } = Object;
const fixtureGlobal = /** @type {any} */ (globalThis);

const arrowParcel = () => {};
arrowParcel.open = () => {};
arrowParcel.locate = () => '';
arrowParcel.isParcel = () => false;

defineProperty(fixtureGlobal, 'Parcel', {
  value: arrowParcel,
  enumerable: false,
  writable: false,
  configurable: false,
});
