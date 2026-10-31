// @ts-check
import { E } from '@endo/eventual-send';
import { assertCopyData } from '@endo/hosted-agent/copy-data.js';
import { discoverAccounts } from './account-discovery.js';

/**
 * Current configured accounts are not evidence of which account paid for earlier
 * turns. In particular, an automatic subscription pool can change each turn.
 * Return only data, never oracle or reset capabilities.
 * @param {any} profile
 * @param {{backendId: string, subscription?: string}} session
 * @param {boolean} [refresh]
 */
export const readSessionAccounts = async (
  profile,
  session,
  refresh = false,
) => {
  const { entries, unknown } = await discoverAccounts(profile);
  const pinned = !!session.subscription && session.subscription !== 'auto';
  const selected = entries.filter(entry =>
    entry.uses.some(
      use =>
        use.backendId === session.backendId &&
        (!pinned || use.subscriptionId === session.subscription),
    ),
  );
  const accounts = await Promise.all(
    selected.map(
      async ({ accountId, providerId, title, label, oracle, uses }) => {
        if (refresh) await E(oracle).refresh();
        const [plan, rateLimits, rateCard] = await Promise.all([
          E(oracle).getPlan(),
          E(oracle).getRateLimits(),
          E(oracle).getRateCard(),
        ]);
        const snapshot = harden({
          accountId,
          providerId,
          title,
          ...(label === undefined ? {} : { label }),
          uses,
          plan,
          rateLimits,
          rateCard,
        });
        assertCopyData(snapshot);
        return snapshot;
      },
    ),
  );
  return harden({
    available: accounts.length > 0,
    complete: unknown.length === 0,
    selection: pinned ? 'subscription-pin' : 'configured-accounts',
    accounts,
    unknownSources: unknown,
    attribution: 'not-recorded',
    costUnavailable:
      'Session usage is not attributed to individual accounts. Published mappings do not establish runtime eligibility, the current route, or the payer of previous turns.',
  });
};
harden(readSessionAccounts);
