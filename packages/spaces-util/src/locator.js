// @ts-check

import { parseLocator } from '@endo/daemon/locator.js';

export { assertValidLocator } from '@endo/daemon/locator.js';

// The capability-URL grammar (designs/capability-url-locators.md): a
// locator is any capability URL — an `endo://` URL or an `https://` URL
// carrying every locator field in its fragment under the version key `v`.
// UI callers accept either form through `parseCapabilityUrl` and normalize
// with `formatEndoLocator` before handing a locator to daemon methods.
export {
  parseCapabilityUrl,
  isCapabilityUrl,
  formatEndoLocator,
  formatCapabilityUrl,
  canonicalEndoLocator,
} from '@endo/daemon/capability-url.js';

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
