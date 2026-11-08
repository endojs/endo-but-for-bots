// @ts-check
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

/**
 * The controller may read the account catalogs behind a subscription.
 * @param {any} broker
 */
export const make = broker =>
  Far('Subscription model catalog', {
    /** @param {string} [subscriptionId] */
    modelCatalog: subscriptionId =>
      subscriptionId === undefined
        ? E(broker).modelCatalog()
        : E(broker).modelCatalog(subscriptionId),
  });
harden(make);
