// @ts-check

import { Fail, q } from '@endo/errors';
import { boundedJson } from '@endo/hosted-agent/bounded-json.js';

/**
 * The one call that spends a banked Codex rate-limit reset, for the broker's
 * reset redeemer. Host-only: it presents the subscription credential, to the
 * origin the broker already presents it to and to nothing else.
 *
 * Nothing here decides to redeem. It is reached only through the operator's
 * subscription admin (`@endo/hosted-agent` `reset-credit-admin.js`), which
 * stores the idempotency key before this is called.
 *
 * TO CONFIRM ON A LIVE REDEEM: the service does not document this call. The
 * path and the field names (`redeem_request_id`, `credit_id`, `credit_type`
 * with the value `usage_limit`) are read out of the pinned CLI (0.152.0),
 * whose app-server method `account/rateLimitResetCredit/consume` takes
 * `{ idempotencyKey, creditId?, creditType? }` and answers `reset`,
 * `nothingToReset`, `noCredit` or `alreadyRedeemed`. The name of the response
 * field that carries that word is not known, so a few likely names are
 * tried, in both spellings. Until a live redeem confirms the request shape, a
 * wrong guess costs nothing: the service refuses, and that is `refused`.
 */

const CONSUME_URL =
  'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume';
const MAX_BODY_BYTES = 65_536;
const REDEEM_TIMEOUT_MS = 30_000;
const REFUSALS = harden([400, 401, 403, 404, 405, 422]);

// Where the word is looked for. A payload has other strings (a type, a
// window's name), and one of them spelling `reset` must not pass for the
// answer.
const OUTCOME_FIELDS = harden([
  'outcome',
  'result',
  'status',
  'code',
  'state',
  'redeem_status',
]);

const OUTCOMES = harden({
  reset: 'reset',
  nothingToReset: 'nothingToReset',
  nothing_to_reset: 'nothingToReset',
  noCredit: 'noCredit',
  no_credit: 'noCredit',
  alreadyRedeemed: 'alreadyRedeemed',
  already_redeemed: 'alreadyRedeemed',
});

/**
 * The outcome in a consume response, or undefined. Pure and tolerant: the
 * word is looked for in a few likely top-level fields and nowhere deeper,
 * and nothing else of the payload is kept.
 *
 * @param {any} payload
 * @returns {string | undefined}
 */
export const outcomeFromCodexConsume = payload => {
  if (payload === null || typeof payload !== 'object') return undefined;
  const words = OUTCOME_FIELDS.flatMap(field => {
    const value = Object.hasOwn(payload, field) ? payload[field] : undefined;
    return typeof value === 'string' && Object.hasOwn(OUTCOMES, value)
      ? [value]
      : [];
  });
  // Two different words would mean this does not understand the payload.
  const found = new Set(
    words.map(word => OUTCOMES[/** @type {keyof typeof OUTCOMES} */ (word)]),
  );
  return found.size === 1 ? [...found][0] : undefined;
};
harden(outcomeFromCodexConsume);

/**
 * @param {object} powers
 * @param {{ current(): Promise<{ state: { accessToken: string } }> }} powers.credential
 * @param {string} powers.accountRef The pinned ChatGPT account.
 * @param {typeof globalThis.fetch} powers.fetch
 */
export const makeCodexResetRedeem = ({ credential, accountRef, fetch }) => {
  /^[A-Za-z0-9_-]{1,256}$/.test(accountRef) ||
    Fail`Invalid Codex subscription account`;
  /** @param {{ idempotencyKey: string, creditId?: string }} request */
  return async ({ idempotencyKey, creditId }) => {
    /** @type {{ accessToken: string }} */
    let state;
    try {
      ({ state } = await credential.current());
    } catch (_error) {
      // The credential could not be had (a renewal that needs a person), so
      // nothing was sent and nothing is in doubt.
      return harden({ outcome: 'notSent' });
    }
    /** @type {Response} */
    let response;
    try {
      response = await fetch(CONSUME_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${state.accessToken}`,
          'chatgpt-account-id': accountRef,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          redeem_request_id: idempotencyKey,
          ...(creditId === undefined ? {} : { credit_id: creditId }),
          credit_type: 'usage_limit',
        }),
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(REDEEM_TIMEOUT_MS),
      });
    } catch (_error) {
      // No upstream wording, and no cause that could carry a header.
      throw Error('Codex reset redeem got no answer');
    }
    const { status } = response;
    if (REFUSALS.includes(status)) {
      // The service heard the request and would not do it: nothing was spent.
      // Only the statuses that can mean nothing else; a conflict, a timeout
      // or a throttle is not an answer.
      await response.body?.cancel().catch(() => {});
      return harden({ outcome: 'refused', status });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw Fail`Codex reset redeem failed (HTTP ${q(status)})`;
    }
    const outcome = outcomeFromCodexConsume(
      await boundedJson(response, MAX_BODY_BYTES, 'Codex reset redeem'),
    );
    // Accepted, but in words this does not know. Whether a credit was spent
    // is for the usage read to say.
    if (outcome === undefined)
      throw Fail`Codex reset redeem answer was not understood`;
    return harden({ outcome });
  };
};
harden(makeCodexResetRedeem);
