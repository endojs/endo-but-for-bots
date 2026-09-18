// @ts-check

import { Fail } from '@endo/errors';

/** Account selection is formula configuration, not replaceable token metadata.
 *
 * This is what remains of the one-shot operator entry point. `setup-hosted.js`
 * now runs on every daemon start, so `installHostedSubscription` — which
 * refused an existing backend outright — and `withSubscriptionSetupLock` — the
 * filesystem exclusion around a single hand-run installation — are gone. What
 * they protected is kept where it belongs: a credential pinned to a different
 * Secrets record fails closed in `provideManagedRenewableCredentials`, and an
 * existing backend whose account or owner label differs from the requested one
 * is refused before anything is minted. The account check itself is this, and
 * it still runs on every revival, against formula configuration rather than
 * against whatever account a replaced secret happens to name.
 *
 * @param {unknown} accountRef
 * @param {any} state
 * @returns {string}
 */
export const assertSubscriptionAccount = (accountRef, state) => {
  if (
    typeof accountRef !== 'string' ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(accountRef)
  ) {
    throw Fail`Codex subscription requires a pinned account reference`;
  }
  state?.accountId === accountRef || Fail`Codex subscription account changed`;
  return accountRef;
};
harden(assertSubscriptionAccount);
