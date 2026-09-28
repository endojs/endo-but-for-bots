// @ts-check

// Surface module: re-exports the capability-URL API from the source tree.
// A locator is any capability URL — an `endo://` URL, or an `https://` URL
// whose fragment carries the locator fields under a recognized version key
// `v` (designs/capability-url-locators.md). This module is dependency-light
// and browser-safe so UI callers (Chat via `@endo/spaces-util`, web shells)
// can share the daemon's one grammar.

export {
  parseCapabilityUrl,
  isCapabilityUrl,
  formatEndoLocator,
  formatCapabilityFragment,
  formatCapabilityUrl,
  canonicalEndoLocator,
} from './src/capability-url.js';
