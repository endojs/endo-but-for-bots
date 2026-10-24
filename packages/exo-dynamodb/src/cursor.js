// @ts-check

import { Fail } from '@endo/errors';

/**
 * Make an incarnation-local cursor sealer. Tokens carry no backend keys and
 * are unforgeable by holders that cannot access this closure. Restarting the
 * broker naturally invalidates every token.
 *
 * @param {{ random: () => string }} options a host-injected cryptographically
 * secure random token source
 */
export const makeMemoryCursorSealer = options => {
  const { random } = options;
  typeof random === 'function' ||
    Fail`A secure random token source is required`;
  /** @type {Map<string, unknown>} */
  const records = new Map();
  return harden({
    /** @param {unknown} record */
    seal(record) {
      let token;
      do token = random();
      while (records.has(token));
      records.set(token, harden(record));
      return token;
    },
    /** @param {string} token */
    unseal(token) {
      return records.get(token);
    },
  });
};
harden(makeMemoryCursorSealer);
