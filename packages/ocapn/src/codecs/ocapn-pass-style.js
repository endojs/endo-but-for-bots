// @ts-check

/**
 * @import { PassStyle } from '@endo/pass-style'
 */

import { passStyleOf } from '@endo/pass-style';
import { isParcel } from '../client/parcels.js';

// We need to extend the PassStyle type to include OCapN-specific types.
/** @typedef {PassStyle | 'parcel' | 'signedHandoffReceive' | 'signedHandoffGive'} OcapnPassStyle */

/**
 * Get the PassStyle of a value, extended to include OCapN-specific types.
 *
 * @param {any} value
 * @returns {OcapnPassStyle}
 */
export const ocapnPassStyleOf = value => {
  if (isParcel(value)) {
    return 'parcel';
  }
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
    const passStyle = passStyleOf(value);
    // Every realm Parcel takes the OCapN parcel codec, which writes
    // the ones OCapN minted and refuses the rest.
    return passStyle === 'parcel' ? 'parcel' : passStyle;
  } catch (error) {
    throw Error(`Unexpected value ${value} for OcapnPassable`, {
      cause: error,
    });
  }
};
