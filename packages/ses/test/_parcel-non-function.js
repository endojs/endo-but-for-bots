// Stands in for an unrelated application `Parcel` global that is not a
// function at all.

export {};

const fixtureGlobal = /** @type {any} */ (globalThis);
fixtureGlobal.Parcel = 42;
