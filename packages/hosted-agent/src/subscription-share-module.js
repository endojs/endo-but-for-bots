// @ts-check

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import { makeAccountJournal } from './account-oracle.js';
import { makeSubscriptionShare } from './subscription-share.js';

/**
 * Share caplet: the retained `make-unconfined` entrypoint of one share of a
 * subscription (`subscription-share.js`).
 *
 * Its powers are a namespace of its own, which holds:
 *
 *   - `subscription` — what the share is made over: the operator's broker as
 *     a `Subscription` (`subscription-module.js`), or a share somebody else
 *     handed over, which is how a holder narrows a share further.
 *   - `share-limits` — a stored value, the grantor's limits. Read for every
 *     endpoint and request, so rewriting it changes the share with no restart.
 *   - the share's state, written ahead of what depends on it: whether it was
 *     revoked, and the meter's ceiling. A revoked share revives revoked, and
 *     a restart does not refill a budget.
 *
 * The value is the **grantor's** facet: `revoke()`, `getStatus()`, and
 * `share()`, which answers the share itself. Setup binds that in a formula of
 * its own (`subscription-share-facet-module.js`), and that is what is handed
 * out: a holder of the share has no path to this.
 *
 * @param {import('@endo/eventual-send').ERef<any>} powers
 * @param {unknown} _context
 * @param {{ env?: Record<string, string> }} [options]
 */
export const make = async (powers, _context, { env } = {}) => {
  const shareId = env?.SHARE_ID ?? Fail`Share has no SHARE_ID`;
  /** @param {string} name */
  const provide = async name => {
    (await E(powers).has(name)) || Fail`Share has no ${name} bound`;
    return E(powers).lookup(name);
  };
  const { share, admin } = makeSubscriptionShare({
    shareId,
    provideUnderlying: () => provide('subscription'),
    provideLimits: () => provide('share-limits'),
    journal: makeAccountJournal({ powers, prefix: 'share-state-v1-' }),
  });
  return makeExo(
    'ShareKit',
    M.interface('ShareKit', {
      share: M.call().returns(M.remotable()),
      revoke: M.callWhen().returns(M.undefined()),
      getStatus: M.callWhen().returns(M.record()),
      help: M.call().optional(M.string()).returns(M.string()),
    }),
    {
      share: () => share,
      revoke: () => admin.revoke(),
      getStatus: () => admin.getStatus(),
      /** @param {string} [methodName] */
      help(methodName) {
        if (methodName === 'share') {
          return 'share() — The share itself, a Subscription: what is handed to a holder. Setup binds it as a formula of its own.';
        }
        return methodName === undefined
          ? `Share kit for "${shareId}": share(), revoke(), getStatus(). The grantor’s; a holder of the share cannot reach it.`
          : admin.help(methodName);
      },
    },
  );
};
harden(make);
