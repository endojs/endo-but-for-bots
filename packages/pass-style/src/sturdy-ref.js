import harden from '@endo/harden';
import { passStyleOf } from './passStyleOf.js';

/**
 * @import {SturdyRef} from './types.js';
 */

export { makeSturdyRef } from './sturdyref.js';

/**
 * @param {unknown} value
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
