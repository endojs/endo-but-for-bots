// @ts-check

import { E } from '@endo/eventual-send';

import { makeAccountJournal, makeAccountOracle } from './account-oracle.js';

/**
 * Account-oracle caplet: the retained `make-unconfined` entrypoint.
 *
 * A durable formula that answers "what plan is this credential on, how much of
 * its allowance is left and when does that reset, and what do these tokens
 * cost?" without holding — or being able to hand out — the credential.
 * `revivePins()` brings it back with the same identity, so a reference stored
 * under a pet name keeps working across a daemon restart.
 *
 * Its powers are a namespace of its own, which holds:
 *
 *   - `account-profile` — optional; a stored value carrying the operator's
 *     declared plan, quota, and price list. Data, not a capability.
 *   - `account-source`  — optional; a capability with `observe()`, and
 *     optionally `watch()` and `refresh()`, in the raw reading shape. For a
 *     hosted adapter it is the broker's account source
 *     (`account-source-module.js`): what the broker's transport read from the
 *     rate-limit headers of the responses it served, pushed here as it
 *     arrives and answered from memory, never by calling the provider. It is
 *     only that read-only facet; the namespace never holds the broker.
 *   - the journal of observations, written when a reading changes materially.
 *
 * Every name is resolved per call rather than captured: a broker is re-minted
 * by a deploy, and setup re-points `account-source` at the new one's.
 *
 * After a restart it answers immediately from the journal, marked
 * `remembered`. It calls no provider then, or ever on its own: only an
 * explicit `refresh()` asks the source for an active read.
 *
 * @param {import('@endo/eventual-send').ERef<object>} powers
 * @param {Promise<object> | object | undefined} _context
 * @param {{ env?: Record<string, string> }} [options]
 */
export const make = async (powers, _context, { env } = {}) => {
  const providerId = env?.ACCOUNT_PROVIDER_ID || 'anthropic';

  const provideDeclared = async () => {
    await null;
    if (!(await E(powers).has('account-profile'))) return undefined;
    return E(powers).lookup('account-profile');
  };

  /**
   * The source bound now, or undefined. A name that does not resolve — a
   * broker from before it had an account source, a source whose broker is
   * gone — is "no source", not a failure: the oracle still answers from its
   * profile and its journal.
   *
   * @returns {Promise<any>}
   */
  const provideSource = async () => {
    await null;
    try {
      if (await E(powers).has('account-source')) {
        return await E(powers).lookup('account-source');
      }
    } catch (_error) {
      // fall through
    }
    return undefined;
  };

  /**
   * Whether the source answers a method. A source from before `watch()` and
   * `refresh()` has only `observe()`, and is asked for nothing more.
   *
   * @param {any} source
   * @param {string} method
   */
  const offers = async (source, method) => {
    try {
      // eslint-disable-next-line no-underscore-dangle
      const names = await E(source).__getMethodNames__();
      return Array.isArray(names) && names.includes(method);
    } catch (_error) {
      return false;
    }
  };

  return makeAccountOracle({
    providerId,
    provideDeclared,
    provideObserved: async () => {
      const source = await provideSource();
      return source === undefined ? undefined : E(source).observe();
    },
    watchObserved: async () => {
      const source = await provideSource();
      if (source === undefined || !(await offers(source, 'watch'))) {
        return undefined;
      }
      return E(source).watch();
    },
    refreshObserved: async () => {
      const source = await provideSource();
      if (source !== undefined && (await offers(source, 'refresh'))) {
        await E(source).refresh();
      }
    },
    journal: makeAccountJournal({ powers }),
  });
};
harden(make);
