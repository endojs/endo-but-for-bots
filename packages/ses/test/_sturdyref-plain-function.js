// Stands in for a `SturdyRef` global that carries the shim's `enliven` and
// `isSturdyRef` statics and a `prototype`, but is a plain function rather than
// a class: its `prototype` stays writable, so a Proxy over it could report one
// `prototype` by descriptor and another by `[[Get]]`.

const { defineProperty } = Object;

function SturdyRef() {}
SturdyRef.enliven = () => {};
SturdyRef.isSturdyRef = () => false;

defineProperty(globalThis, 'SturdyRef', {
  value: SturdyRef,
  enumerable: false,
  writable: false,
  configurable: false,
});
