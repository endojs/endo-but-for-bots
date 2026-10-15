// Stands in for an unrelated application `Parcel` global.

export {};

const fixtureGlobal = /** @type {any} */ (globalThis);
fixtureGlobal.Parcel = 42;
