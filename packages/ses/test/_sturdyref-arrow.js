// Stands in for a `SturdyRef` global that carries the shim's `enliven` and
// `isSturdyRef` statics but is not a constructor: an arrow function, which has
// no own `prototype`.

const { defineProperty } = Object;

const SturdyRef = () => {};
SturdyRef.enliven = () => {};
SturdyRef.isSturdyRef = () => false;

defineProperty(globalThis, 'SturdyRef', {
  value: SturdyRef,
  enumerable: false,
  writable: false,
  configurable: false,
});
