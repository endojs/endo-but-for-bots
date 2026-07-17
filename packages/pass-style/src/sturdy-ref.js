import harden from '@endo/harden';
import { passStyleOf } from './passStyleOf.js';

/**
 * @import {SturdyRef} from './types.js';
 */

export { makeSturdyRef } from './sturdyref.js';

/**
 * True when `value` is a SturdyRef: a first-class `@endo/pass-style` value
 * whose `passStyleOf` is `'sturdyRef'`. Recognition is structural — a value the
 * caller did not construct but that satisfies the opaque SturdyRef shape is
 * still a SturdyRef. It reveals nothing about where it points; the locator
 * mapping is held off-band by the realm-global `SturdyRef` shim
 * (`./sturdy-ref-shim.js`).
 *
 * @param {any} value
 * @returns {value is SturdyRef}
 */
export const isSturdyRef = value => {
  try {
    return passStyleOf(value) === 'sturdyRef';
  } catch {
    return false;
  }
};
harden(isSturdyRef);
