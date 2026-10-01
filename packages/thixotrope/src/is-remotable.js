// @ts-check
import harden from '@endo/harden';
import { passStyleOf } from '@endo/pass-style';

/**
 * Whether a value is a remotable, without throwing: `passStyleOf` throws
 * on a value that is not even passable, which a check at a boundary wants
 * to report as "not a remotable" rather than as the marshaller's error. In
 * the guest prelude under this name, so a factory shipped by source has it.
 * @param {unknown} value
 */
export const isRemotable = value => {
  try {
    return passStyleOf(value) === 'remotable';
  } catch (_error) {
    return false;
  }
};
harden(isRemotable);
