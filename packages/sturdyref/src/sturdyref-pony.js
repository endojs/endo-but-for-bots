/* The `@endo/sturdyref` ponyfill.
 *
 * A ponyfill exposes a feature as importable functions instead of installing a
 * global. This ponyfill's functions delegate to the realm's single shared
 * `SturdyRef` constructor, which the first-wins shim installs at
 * `globalThis.SturdyRef` (see `./sturdyref-shim.js`). Because the ponyfill
 * defers to the shared global, an eval twin of ocapn or captp that imports
 * this ponyfill recognizes and enlivens the refs minted by every other twin.
 *
 * Importing this module is safe before `lockdown`: it installs nothing until a
 * function is first called. Calling it before `lockdown` is safe too; see
 * `./sturdyref-shim.js` for how hardening is deferred to `lockdown`.
 */

import { provideSturdyRef } from './sturdyref-shim.js';

/** @import { SturdyRef, SturdyRefHandler } from './sturdyref-shim.js' */

const { freeze } = Object;

/**
 * Construct a SturdyRef with the realm's shared constructor. Equivalent to
 * `new SturdyRef(handler)`.
 *
 * @param {SturdyRefHandler} handler
 * @returns {SturdyRef}
 */
export const makeSturdyRef = handler => {
  const SturdyRef = provideSturdyRef();
  return new SturdyRef(handler);
};

/**
 * Send `enliven` to a SturdyRef: in a later turn, invoke its handler's hook
 * and settle with the result.
 *
 * @param {SturdyRef} ref
 * @returns {Promise<unknown>}
 */
export const enliven = ref => provideSturdyRef().enliven(ref);

/**
 * Brand check: whether `value` was constructed by the realm's shared
 * `SturdyRef` constructor. Reveals nothing about what the ref captures.
 *
 * @param {unknown} value
 * @returns {value is SturdyRef}
 */
export const isSturdyRef = value => provideSturdyRef().isSturdyRef(value);

freeze(makeSturdyRef);
freeze(enliven);
freeze(isSturdyRef);
