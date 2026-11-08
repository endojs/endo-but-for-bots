// @ts-check

import { Fail } from '@endo/errors';

/** Verify the operator's retained account binding before using its credential.
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
