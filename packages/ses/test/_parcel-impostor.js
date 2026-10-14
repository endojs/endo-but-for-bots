// Stands in for an unrelated application `Parcel` global that is not the
// `@endo/parcel` constructor: a function without the shim's `open` and
// `isParcel` statics.

/** @type {any} */ (globalThis).Parcel = function Parcel() {};
