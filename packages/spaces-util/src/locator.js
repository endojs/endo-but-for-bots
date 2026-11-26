// @ts-check

import { parseLocator } from '@endo/daemon/locator.js';

/**
 * @deprecated Import `assertValidLocator` from `@endo/daemon/locator.js`
 * directly. `@endo/spaces-util` plain-re-exports it
 * (endojs/endo-but-for-bots#543): importing it through `@endo/spaces-util`
 * rather than from the package that originally exports it is discouraged, and
 * this re-export is slated for removal in a future major version.
 */
export { assertValidLocator } from '@endo/daemon/locator.js';

/**
 * Derive a bare formula identifier (`number:node`) from an `endo://` locator.
 * The daemon's identifier-side helpers are intentionally daemon-internal, so
 * this rebuilds the id from the public `parseLocator` output for UI callers
 * that need a formula id (e.g. `reverseIdentify` for pet-name display).
 *
 * @param {string} locator - An `endo://` locator.
 * @returns {string} The bare formula identifier.
 */
export const idFromLocator = locator => {
  const { number, node } = parseLocator(locator);
  return `${number}:${node}`;
};
