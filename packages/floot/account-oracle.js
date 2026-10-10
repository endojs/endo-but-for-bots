// @ts-check

import { E } from '@endo/eventual-send';
import {
  makeAccountJournal,
  makeAccountOracle,
} from '@endo/hosted-agent/account-oracle.js';

/**
 * Account-oracle caplet.
 *
 * A durable formula that answers "what plan is this credential on, how much of
 * the rate limit is left, and what do these tokens cost?" without holding — or
 * being able to hand out — the credential itself. `revivePins()` brings it back
 * with the same identity, so a reference stored under a pet name keeps working
 * across a daemon restart; that is why this is a formula rather than an object
 * minted inside the Floot factory.
 *
 * Its own namespace holds:
 *
 *   - `account-profile`  – optional; a stored value carrying the operator's
 *     declared plan, quota, and price list. Data, not a capability: rewriting
 *     it and calling `refresh()` is how an operator corrects the answer.
 *   - `account-source`   – optional; a capability with `observe()` returning a
 *     live `{ plan?, rateLimits?, rateCard? }` reading. A provider that
 *     publishes none of this simply has no source, and every answer is then
 *     marked `declared` or `unavailable` rather than invented.
 *
 * Observations are journalled into this caplet's own pet store, so a restart
 * answers immediately from the last real reading, marked `remembered` with the
 * instant it was taken.
 *
 * @param {import('@endo/eventual-send').ERef<object>} powers
 * @param {Promise<object> | object | undefined} _context
 * @param {{ env?: Record<string, string> }} [options]
 */
export const make = async (powers, _context, { env } = {}) => {
  const providerId = env?.ACCOUNT_PROVIDER_ID || 'anthropic';

  // Resolved per call rather than captured: the profile is meant to be edited
  // in place, and a `refresh()` after an edit must see the new value.
  const provideDeclared = async () => {
    await null;
    if (!(await E(powers).has('account-profile'))) return undefined;
    return E(powers).lookup('account-profile');
  };

  const provideObserved = async () => {
    await null;
    if (!(await E(powers).has('account-source'))) return undefined;
    const source = await E(powers).lookup('account-source');
    return E(source).observe();
  };

  return makeAccountOracle({
    providerId,
    provideDeclared,
    provideObserved,
    journal: makeAccountJournal({ powers }),
  });
};
harden(make);
