// @ts-check

/**
 * @import { PassStyle } from '@endo/pass-style'
 */

import { passStyleOf } from '@endo/pass-style';

// We need to extend the PassStyle type to include OCapN-specific types.
// `'sturdyRef'` is now a first-class `@endo/pass-style` category, so it
// arrives through `passStyleOf` directly; only the two signed-handoff
// discriminators remain OCapN-specific here.
/** @typedef {PassStyle | 'signedHandoffReceive' | 'signedHandoffGive'} OcapnPassStyle */

/**
 * Get the PassStyle of a value, extended to include OCapN-specific types.
 *
 * @param {any} value
 * @returns {OcapnPassStyle}
 */
export const ocapnPassStyleOf = value => {
  if (
    typeof value === 'object' &&
    value !== null &&
    value.type === 'desc:sig-envelope'
  ) {
    if (value.object.type === 'desc:handoff-receive') {
      return 'signedHandoffReceive';
    }
    if (value.object.type === 'desc:handoff-give') {
      return 'signedHandoffGive';
    }
    throw Error(
      `Unexpected object type ${value.object.type} for OcapnPassable`,
    );
  }
  try {
    return passStyleOf(value);
  } catch (error) {
    throw Error(`Unexpected value ${value} for OcapnPassable`, {
      cause: error,
    });
  }
};
