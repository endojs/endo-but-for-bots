// @ts-check

import { E } from '@endo/eventual-send';

/**
 * The reset redeemer of one provider broker, as a formula of its own, for the
 * same reason the account source is one (`account-source-module.js`): the
 * subscription admin needs the one call that spends a banked reset, and
 * nothing else the broker service can do, so its namespace holds this and not
 * the service.
 *
 * Setup mints it again over the broker that exists now on every run and
 * re-points the admin's `reset-redeemer` name at it.
 *
 * @param {import('@endo/eventual-send').ERef<{ resetRedeemer(id?: string): unknown }>} broker
 * @param {unknown} _context
 * @param {{ env?: Record<string, string> }} [options]
 */
export const make = (broker, _context, { env } = {}) =>
  env?.ACCOUNT_SUBSCRIPTION_ID
    ? E(broker).resetRedeemer(env.ACCOUNT_SUBSCRIPTION_ID)
    : E(broker).resetRedeemer();
harden(make);
