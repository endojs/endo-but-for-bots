// Stands in for a `Parcel` global that is an arrow function given the shim's
// statics and a locked own `prototype`. It is callable and has the descriptor
// shape, but has no `[[Construct]]`, so `new Parcel()` would fail.

export {};

const { defineProperty } = Object;
const fixtureGlobal = /** @type {any} */ (globalThis);

const arrowParcel = () => {};
arrowParcel.open = () => {};
arrowParcel.locate = () => '';
arrowParcel.isParcel = () => false;
defineProperty(arrowParcel, 'prototype', {
  value: {},
  writable: false,
  enumerable: false,
  configurable: false,
});

defineProperty(fixtureGlobal, 'Parcel', {
  value: arrowParcel,
  enumerable: false,
  writable: false,
  configurable: false,
});
