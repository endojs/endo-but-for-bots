// @ts-check

import { randomUUID } from 'node:crypto';

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';

import { makeAccountJournal } from './account-oracle.js';
import { makeResetCreditAdmin } from './reset-credit-admin.js';

/**
 * Subscription-admin caplet: the retained `make-unconfined` entrypoint for
 * what an operator may do to one subscription, which today is redeeming a
 * banked rate-limit reset (`reset-credit-admin.js`).
 *
 * Its powers are a namespace of its own, which holds:
 *
 *   - `reset-redeemer`  — the broker's facet for the one provider call
 *     (`reset-redeemer-module.js`). It cannot mint a scope or read the secret.
 *   - `account-source`  — the broker's read-only account source, the same
 *     formula the account oracle holds.
 *   - the redeem intent, written before the provider is called, so that a
 *     daemon that died waiting for the answer revives knowing a redeem is
 *     unconfirmed. Nothing here replays it: revival calls no provider.
 *
 * Both names are resolved per call rather than captured: a deploy re-mints
 * the broker, and setup re-points them; the intent stays with this formula.
 *
 * It is bound into the operator's Floot profile and nowhere else. A delegated
 * runner, a share and a slice are never given it.
 *
 * @param {import('@endo/eventual-send').ERef<any>} powers
 */
export const make = async powers => {
  /** @param {string} name */
  const provide = async name => {
    (await E(powers).has(name)) ||
      Fail`Subscription admin has no ${name} bound`;
    return E(powers).lookup(name);
  };
  return makeResetCreditAdmin({
    provideRedeem: async () => {
      const redeemer = await provide('reset-redeemer');
      return request => E(redeemer).redeem(request);
    },
    observe: async () => E(await provide('account-source')).observe(),
    refreshReading: async () => E(await provide('account-source')).refresh(),
    journal: makeAccountJournal({ powers, prefix: 'reset-intent-v1-' }),
    makeKey: () => randomUUID(),
  });
};
harden(make);
