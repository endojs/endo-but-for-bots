// @ts-check

/**
 * Admission over a fixed list, for tests of the grant and the issuer, where
 * a list is the whole story. No adapter admits models this way: production
 * admission is an account's catalog owner (`../src/model-catalog.js`).
 *
 * @param {readonly string[]} models
 */
export const admitsModels = models => {
  const ids = new Set(models);
  return harden(/** @param {string} model */ async model => ids.has(model));
};
harden(admitsModels);
