// @ts-check
import { E } from '@endo/eventual-send';

/** Subscribe through eventual-send: daemon contexts are remote presences,
 * not local objects with a `cancelled` property. Both settlements mean stop.
 * @param {any} context
 * @param {() => Promise<void>} dispose
 * @returns {Promise<void>}
 */
export const whenHostStops = (context, dispose) =>
  E(context).whenCancelled().then(dispose, dispose);
harden(whenHostStops);
