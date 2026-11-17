// @ts-check

import { E } from '@endo/eventual-send';

/**
 * The account source of one provider broker, as a formula of its own.
 *
 * An account oracle needs what the broker's transport read of the account
 * (`account-source.js`) and nothing else the broker service can do. The
 * service also mints session scopes, so the oracle's namespace does not hold
 * the service: it holds this, whose powers are the broker service and whose
 * value is only the service's read-only `accountSource()` facet.
 *
 * Setup mints it again over the broker that exists now on every run, since a
 * deploy can re-mint the broker, and re-points the oracle's `account-source`
 * name at it.
 *
 * A broker over several subscriptions has a source per subscription; which one
 * this formula is comes in its environment.
 *
 * @param {import('@endo/eventual-send').ERef<{ accountSource(id?: string): unknown }>} broker
 * @param {unknown} _context
 * @param {{ env?: Record<string, string> }} [options]
 */
export const make = (broker, _context, { env } = {}) =>
  env?.ACCOUNT_SUBSCRIPTION_ID
    ? E(broker).accountSource(env.ACCOUNT_SUBSCRIPTION_ID)
    : E(broker).accountSource();
harden(make);
