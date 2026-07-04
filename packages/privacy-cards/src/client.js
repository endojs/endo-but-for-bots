// @ts-check
/* global globalThis */

// Minimal Privacy.com v1 API client.
// The client closes over the API key; nothing it returns or throws ever
// carries the key, so callers can hand client-backed facets across a
// CapTP boundary without risking credential exfiltration.

import { makeError, q, X } from '@endo/errors';

/**
 * The subset of the fetch contract the client relies on. The global
 * `fetch` satisfies it structurally; the unconfined caplet injects a
 * plain node:http implementation instead (see node-fetch.js).
 *
 * @typedef {(url: string, init?: {
 *   method?: string,
 *   headers?: Record<string, string>,
 *   body?: string,
 * }) => Promise<{
 *   ok: boolean,
 *   status: number,
 *   json(): Promise<any>,
 * }>} FetchLike
 */

/**
 * @typedef {object} PrivacyClientOptions
 * @property {string} apiKey Privacy.com API key (secret).
 * @property {string} [baseUrl] API base, default production
 * `https://api.privacy.com/v1`; use `https://sandbox.privacy.com/v1`
 * for the sandbox, or a local mock in tests.
 * @property {FetchLike} [fetchFn] Injectable transport.
 */

/**
 * @typedef {object} PrivacyCard
 * @property {string} token
 * @property {string} [pan]
 * @property {string} [cvv]
 * @property {string} [exp_month]
 * @property {string} [exp_year]
 * @property {string} [last_four]
 * @property {string} [memo]
 * @property {number} spend_limit
 * @property {string} spend_limit_duration
 * @property {string} state
 * @property {string} type
 */

/**
 * @typedef {object} PrivacyTransaction
 * @property {number} amount
 * @property {string} result `APPROVED` or a decline reason.
 * @property {string} status
 */

export const PRODUCTION_BASE_URL = 'https://api.privacy.com/v1';
harden(PRODUCTION_BASE_URL);
export const SANDBOX_BASE_URL = 'https://sandbox.privacy.com/v1';
harden(SANDBOX_BASE_URL);

/**
 * A transport hook: performs one JSON call against the Privacy API.
 * `makePrivacyClient` builds one from an API key and `fetch`; a
 * confined caplet builds one from a mediated fetch *capability* that
 * injects the credential outside the caplet (see confined-caplet.js).
 *
 * @typedef {(method: string, path: string, body?: object) =>
 *   Promise<any>} PrivacyJsonCaller
 */

/**
 * The Privacy.com v1 endpoint surface over an arbitrary transport.
 *
 * @param {PrivacyJsonCaller} call
 */
export const makePrivacyProtocol = call => {
  return harden({
    /** @returns {Promise<boolean>} */
    status: async () => {
      await call('GET', '/status');
      return true;
    },

    /**
     * @param {object} spec Privacy.com card-creation body
     * (`type`, `spend_limit`, `spend_limit_duration`, `memo`, `state`).
     * @returns {Promise<PrivacyCard>}
     */
    createCard: async spec => call('POST', '/cards', spec),

    /**
     * @param {string} cardToken
     * @param {object} patch Properties to update (e.g. `{ state: 'PAUSED' }`).
     * @returns {Promise<PrivacyCard>}
     */
    updateCard: async (cardToken, patch) =>
      call('PATCH', `/cards/${encodeURIComponent(cardToken)}`, patch),

    /** @returns {Promise<PrivacyCard[]>} */
    listCards: async () => {
      const result = await call('GET', '/cards');
      return Array.isArray(result) ? result : result.data || [];
    },

    /** @returns {Promise<unknown[]>} */
    listFundingSources: async () => call('GET', '/funding-sources'),

    /**
     * Lists all transactions for one card, walking pagination.
     *
     * @param {string} cardToken
     * @returns {Promise<PrivacyTransaction[]>}
     */
    listCardTransactions: async cardToken => {
      await null; // eslint aside: first real await is inside the loop
      /** @type {PrivacyTransaction[]} */
      const transactions = [];
      let page = 1;
      let totalPages = 1;
      do {
        // Pages must be fetched in order; the API is the sequencer.
        // eslint-disable-next-line no-await-in-loop
        const result = await call(
          'GET',
          `/transactions?card_token=${encodeURIComponent(
            cardToken,
          )}&page=${page}`,
        );
        transactions.push(...(result.data || []));
        totalPages = Number(result.total_pages) || 1;
        page += 1;
      } while (page <= totalPages);
      return transactions;
    },
  });
};
harden(makePrivacyProtocol);

/**
 * The protocol over the ambient transport: an API key and `fetch`.
 * The key stays inside this closure; errors scrub it defensively.
 *
 * @param {PrivacyClientOptions} options
 */
export const makePrivacyClient = ({
  apiKey,
  baseUrl = PRODUCTION_BASE_URL,
  fetchFn = globalThis.fetch,
}) => {
  if (typeof apiKey !== 'string' || apiKey === '') {
    throw makeError(X`Privacy client requires a non-empty API key`);
  }
  const base = baseUrl.replace(/\/+$/, '');

  /** @type {PrivacyJsonCaller} */
  const call = async (method, path, body) => {
    const response = await fetchFn(`${base}${path}`, {
      method,
      headers: {
        Authorization: `api-key ${apiKey}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      let message = '';
      try {
        const errorBody = await response.json();
        message = /** @type {{ message?: string }} */ (errorBody).message || '';
      } catch {
        // Non-JSON error body; status alone will have to do.
      }
      // Never leak the key, even if a hostile or buggy server echoes
      // it back in its error message.
      message = message.split(apiKey).join('[redacted]');
      throw makeError(
        X`Privacy API ${q(method)} ${q(path)} failed with status ${q(
          response.status,
        )}: ${q(message)}`,
      );
    }
    return response.json();
  };

  return makePrivacyProtocol(call);
};
harden(makePrivacyClient);

/**
 * Conservative approved-spend rollup for a card: every transaction whose
 * `result` is `APPROVED` counts, unless its lifecycle status shows the
 * money provably did not move (`DECLINED`, `VOIDED`).
 * Ambiguity rounds toward "spent" so budget refunds can only ever be
 * too small, never too large.
 *
 * @param {PrivacyTransaction[]} transactions
 * @returns {number} approved spend in cents
 */
export const approvedSpendCents = transactions => {
  let total = 0;
  for (const transaction of transactions) {
    const { result, status, amount } = transaction;
    if (result === 'APPROVED' && status !== 'DECLINED' && status !== 'VOIDED') {
      total += Math.abs(Number(amount) || 0);
    }
  }
  return total;
};
harden(approvedSpendCents);
