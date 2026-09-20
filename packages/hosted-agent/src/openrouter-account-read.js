// @ts-check

import { Fail } from '@endo/errors';

import { boundedJson } from './bounded-json.js';

/**
 * One read of OpenRouter's key and credit endpoints, for an account oracle's
 * `refresh()`. OpenRouter reports nothing about the account on inference
 * responses, so unlike the subscription providers an active read is the only
 * source — and it still runs only when somebody asks.
 *
 * Host-only: it presents the API key, to `openrouter.ai` and nothing else.
 *
 * `GET /api/v1/key` gives the key's spend and cap and the free-model request
 * count for the day (which resets at midnight UTC); `GET /api/v1/credits`
 * gives the account's purchased and used credits. Every field is optional
 * here and anything that does not parse is dropped.
 */

const KEY_URL = 'https://openrouter.ai/api/v1/key';
const CREDITS_URL = 'https://openrouter.ai/api/v1/credits';
const MAX_BODY_BYTES = 65_536;
const READ_TIMEOUT_MS = 20_000;

/** @param {unknown} value */
const finite = value =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * Money as decimal text, to the cent of a cent; undefined for a figure past
 * what plain decimal notation holds, which `toFixed` would write with an
 * exponent.
 *
 * @param {number} value
 */
const money = value => (Math.abs(value) < 1e15 ? value.toFixed(4) : undefined);

/**
 * The next midnight UTC after an instant. @param {number} nowMs
 * @param nowMs
 */
const nextUtcMidnight = nowMs => {
  const date = new Date(nowMs);
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1),
  ).toISOString();
};

/**
 * The two payloads as a raw account reading. Pure and tolerant.
 *
 * @param {any} keyPayload `GET /api/v1/key`
 * @param {any} creditsPayload `GET /api/v1/credits`, or undefined
 * @param {number} nowMs
 */
export const readingFromOpenRouter = (keyPayload, creditsPayload, nowMs) => {
  const key = keyPayload?.data;
  if (key === null || typeof key !== 'object') return harden({});
  /** @type {Record<string, any>} */
  const reading = {
    plan: {
      planId: key.is_free_tier === true ? 'free-tier' : 'pay-as-you-go',
      title:
        key.is_free_tier === true
          ? 'OpenRouter (no credits purchased)'
          : 'OpenRouter',
      state: 'active',
    },
  };
  const windows = [];
  const daily = key.free_model_daily_requests;
  const used = finite(daily?.used);
  const limit = finite(daily?.limit);
  if (
    used !== undefined &&
    limit !== undefined &&
    Number.isSafeInteger(used) &&
    Number.isSafeInteger(limit) &&
    used >= 0 &&
    limit > 0
  ) {
    windows.push({
      // The only window OpenRouter has, so it is the one a pool ranks on.
      windowId: 'secondary',
      title: 'Free-model requests today',
      limit: BigInt(limit),
      used: BigInt(used),
      windowSeconds: 86_400,
      resetsAt: nextUtcMidnight(nowMs),
    });
  }
  // The account's balance when the credits endpoint answered; otherwise what
  // is left under this key's own cap, when it has one.
  const purchased = finite(creditsPayload?.data?.total_credits);
  const spent = finite(creditsPayload?.data?.total_usage);
  const keyRemaining = finite(key.limit_remaining);
  let balance;
  if (purchased !== undefined && spent !== undefined) {
    balance = purchased - spent;
  } else if (keyRemaining !== undefined) {
    balance = keyRemaining;
  }
  const balanceText = balance === undefined ? undefined : money(balance);
  reading.rateLimits = {
    windows,
    limitReached: balance !== undefined && balance <= 0 && windows.length === 0,
    ...(balance === undefined || balanceText === undefined
      ? {}
      : {
          credits: {
            balance: balanceText,
            hasCredits: balance > 0,
            unlimited: false,
          },
        }),
  };
  return harden(reading);
};
harden(readingFromOpenRouter);

/**
 * @param {object} powers
 * @param {() => Promise<string>} powers.readKey The API key, read per call.
 * @param {typeof globalThis.fetch} powers.fetch
 * @param {() => number} [powers.now]
 */
export const makeOpenRouterAccountRead = ({
  readKey,
  fetch,
  now = Date.now,
}) => {
  /**
   * @param {string} url
   * @param {string} apiKey
   */
  const get = async (url, apiKey) => {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
      },
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    // A status, never a body: no upstream wording leaves here.
    response.ok ||
      Fail`OpenRouter account read refused (HTTP ${response.status})`;
    return boundedJson(response, MAX_BODY_BYTES, 'OpenRouter account read');
  };
  return async () => {
    const apiKey = await readKey();
    (/^[\x21-\x7e]+$/.test(apiKey) && apiKey.length <= 512) ||
      Fail`Invalid OpenRouter credential`;
    const keyPayload = await get(KEY_URL, apiKey);
    // Not every key may read the account's credits; the key's own figures
    // stand without them.
    const creditsPayload = await get(CREDITS_URL, apiKey).catch(
      () => undefined,
    );
    return readingFromOpenRouter(keyPayload, creditsPayload, now());
  };
};
harden(makeOpenRouterAccountRead);
