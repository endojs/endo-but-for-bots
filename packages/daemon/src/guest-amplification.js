// @ts-check

/** @import { EndoDirectory, NameHub } from './types.js' */

// Rights amplification for guests. A guest exo carries no identifier or
// locator methods, but daemon code that traverses a pet-name path through a
// guest (a host copying into its guest's namespace, introducing names to it,
// settling an invitation it issued) still needs the guest's directory. Guest
// code runs in workers and cannot import this module, so holding a guest exo
// confers nothing beyond its pet-name surface.

/** @type {WeakMap<object, EndoDirectory>} */
const guestDirectories = new WeakMap();

/**
 * @param {object} guest
 * @param {EndoDirectory} directory
 */
export const registerGuestDirectory = (guest, directory) => {
  guestDirectories.set(guest, directory);
};
harden(registerGuestDirectory);

/**
 * @template T
 * @param {T} hub
 * @returns {T | NameHub}
 */
export const amplifyNameHub = hub =>
  guestDirectories.get(/** @type {object} */ (hub)) ?? hub;
harden(amplifyNameHub);
