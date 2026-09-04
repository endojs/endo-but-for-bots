// @ts-check
// endo run --UNCONFINED packages/daemon/src/networks/setup-ocapn.js --powers @agent

import { E } from '@endo/eventual-send';

/** @import { ERef } from '@endo/eventual-send' */

const ocapnSpecifier = new URL('ocapn.js', import.meta.url).href;

/**
 * Install the OCapN-Noise peer transport into the daemon and register
 * it under `@nets/ocapn` so the daemon discovers it as an active
 * transport for daemon-to-daemon connections.
 *
 * @param {ERef<object>} powers
 */
export const main = async powers => {
  await E(powers).makeUnconfined(undefined, ocapnSpecifier, {
    powersName: '@agent',
    resultName: 'network-service-ocapn',
  });

  await E(powers).move(['network-service-ocapn'], ['@nets', 'ocapn']);

  return 'OCapN-Noise network installed at @nets/ocapn';
};
harden(main);
