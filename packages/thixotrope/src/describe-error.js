// @ts-check
import harden from '@endo/harden';

/**
 * A failure as bounded text, for a record a vat keeps or a host index
 * stores: the message of an error, the string of anything else, cut at
 * 512 characters so a verbose failure cannot swell what holds it. In the
 * guest prelude under this name, so a factory shipped by source has it.
 * @param {unknown} reason
 */
export const describeError = reason =>
  String(/** @type {Error} */ (reason)?.message ?? reason).slice(0, 512);
harden(describeError);
