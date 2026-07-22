/* The `@endo/sturdyref` ponyfill.
 *
 * A ponyfill exposes a feature as importable functions instead of installing a
 * global. This ponyfill's functions delegate to the realm's single shared
 * `SturdyRef` namespace, which the first-wins shim installs at
 * `globalThis.SturdyRef` (see `./sturdyref-shim.js`). Because the ponyfill
 * imports the shim and defers to the shared global, an eval twin of ocapn or
 * captp that imports this ponyfill converges on the SAME sturdyref-to-locator
 * mapping as every other twin in the realm — that is what lets sturdyrefs
 * transport between twins.
 *
 * Importing this module is safe before `lockdown`: it installs nothing until a
 * function is first called, and installation/hardening therefore happens after
 * `lockdown` in normal use.
 */

import { provideSturdyRef } from './sturdyref-shim.js';

/** @import { Locator } from './sturdyref-shim.js' */
/** @import { SturdyRef } from '@endo/pass-style' */

export {
  provideSturdyRef,
  selectSturdyRef,
  makeSturdyRefNamespace,
} from './sturdyref-shim.js';

/**
 * Mint a fresh opaque sturdyref for a locator record, retaining the mapping in
 * the realm's shared, globally-retained WeakMap.
 *
 * @param {Locator} locator
 * @returns {SturdyRef}
 */
export const fromLocation = locator => provideSturdyRef().fromLocation(locator);

/**
 * Recover the locator record a sturdyref was minted for, from the realm's
 * shared mapping. Throws if the sturdyref is unknown to this realm.
 *
 * @param {SturdyRef} sturdyRef
 * @returns {Locator}
 */
export const toLocation = sturdyRef => provideSturdyRef().toLocation(sturdyRef);
