// @ts-check

import { Fail, b, q } from '@endo/errors';

/**
 * The id of an account authority: what serves a hosted session's inference,
 * a single account or a pool of them, as the operator declares it in the
 * host configuration. The broker's profile records it, the account catalog
 * carries it, every session plan records it as `accountRef`, and the grant
 * reports it, so a session bound to one authority is refused a reopen under
 * another unless the request authorizes rebinding `account`. It is never a
 * provider's name and never a Secret's.
 */
export const ACCOUNT_AUTHORITY_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
harden(ACCOUNT_AUTHORITY_PATTERN);

/**
 * @param {unknown} value
 * @param {string} [label] The adapter's name for messages.
 * @returns {string}
 */
export const assertAccountAuthority = (value, label = 'Hosted') => {
  if (typeof value !== 'string' || !ACCOUNT_AUTHORITY_PATTERN.test(value)) {
    throw Fail`${b(label)} account authority must be an id of 1 to 256 letters, digits, dashes or underscores, got ${q(value)}`;
  }
  return value;
};
harden(assertAccountAuthority);
