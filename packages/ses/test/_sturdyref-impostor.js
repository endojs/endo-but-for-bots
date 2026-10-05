// Stands in for an unrelated application `SturdyRef` global that is not the
// `@endo/sturdyref` constructor: a function without the shim's `enliven` and
// `isSturdyRef` statics.

/** @type {any} */ (globalThis).SturdyRef = function SturdyRef() {};
