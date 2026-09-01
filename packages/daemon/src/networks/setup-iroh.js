// @ts-check
// endo run --UNCONFINED packages/daemon/src/networks/setup-iroh.js --powers @agent

import { E } from '@endo/eventual-send';

/** @import { ERef } from '@endo/eventual-send' */

// Keep the persisted formula independent of any particular installation path.
// The worker resolves this export from the active @endo/daemon package when it
// revives the network service.
const irohSpecifier = '@endo/daemon/iroh.js';
const irohWorker = 'iroh-worker';

/**
 * Install the iroh network module into the daemon and register it under
 * `@nets/iroh` so the daemon discovers it as an active transport.
 *
 * Idempotent: if `@nets/iroh` already exists this is a no-op, so it is safe to
 * run on every daemon start (e.g. via ENDO_EXTRA). The transport formula
 * persists in the formula graph and is re-provided by `reviveNetworks()` on
 * each restart; this script only needs to (re)install it the first time.
 *
 * @param {ERef<any>} powers
 */
export const main = async powers => {
  const alreadyInstalled = await E(powers).has('@nets', 'iroh');
  if (alreadyInstalled) {
    return 'iroh network already installed at @nets/iroh';
  }
  await E(powers).provideWorker(irohWorker);
  await E(powers).makeUnconfined(irohWorker, irohSpecifier, {
    powersName: '@agent',
    resultName: 'network-service-iroh',
  });

  await E(powers).move(['network-service-iroh'], ['@nets', 'iroh']);

  return 'iroh network installed at @nets/iroh';
};
harden(main);
