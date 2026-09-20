// @ts-check

import { Fail, q } from '@endo/errors';
import { boundedJson } from '@endo/hosted-agent/bounded-json.js';

/**
 * One read of the ChatGPT backend's Codex usage endpoint, for the account
 * oracle's `refresh()`. Host-only: it presents the subscription credential,
 * to the origin the broker already presents it to and to nothing else. It is
 * never run on its own — inference responses carry the windows in their
 * headers, and that is the mechanism. This exists for what headers do not
 * carry (the plan, the banked rate-limit resets) and for an account that has
 * served nothing since the daemon started.
 *
 * The response is the backend's own snake_case payload. Its field names are
 * taken from the pinned CLI (0.152.0); the service does not document it, so
 * every field is optional and anything that does not parse is dropped.
 */

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const MAX_BODY_BYTES = 262_144;
const READ_TIMEOUT_MS = 20_000;

// The plan types the pinned CLI's schema enumerates.
const PLAN_TITLES = harden({
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro',
  team: 'Team',
  self_serve_business_prolite: 'Business',
  self_serve_business_usage_based: 'Business',
  business: 'Business',
  ent26: 'Enterprise',
  enterprise_cbp_automation: 'Enterprise',
  enterprise_cbp_usage_based: 'Enterprise',
  enterprise: 'Enterprise',
  edu: 'Edu',
  edu_plus: 'Edu',
  edu_pro: 'Edu',
});

/** @param {unknown} value */
const finite = value =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

/** @param {unknown} seconds epoch seconds */
const instant = seconds => {
  const value = finite(seconds);
  if (value === undefined || value < 1_577_836_800 || value > 4_102_444_800) {
    return '';
  }
  return new Date(Math.trunc(value) * 1000).toISOString();
};

const titleOfSeconds = seconds => {
  if (seconds === 18_000) return '5-hour window';
  if (seconds === 604_800) return 'Weekly window';
  if (seconds % 86_400 === 0) return `${seconds / 86_400}-day window`;
  if (seconds % 3600 === 0) return `${seconds / 3600}-hour window`;
  return `${seconds}-second window`;
};

/**
 * @param {string} windowId
 * @param {any} snapshot
 */
const windowFrom = (windowId, snapshot) => {
  if (snapshot === null || typeof snapshot !== 'object') return [];
  const usedPercent = finite(snapshot.used_percent);
  if (usedPercent === undefined) return [];
  const seconds = finite(snapshot.limit_window_seconds);
  const whole =
    seconds !== undefined && Number.isSafeInteger(seconds) && seconds > 0
      ? seconds
      : undefined;
  return [
    {
      windowId,
      title: whole === undefined ? `${windowId} window` : titleOfSeconds(whole),
      usedPercent: Math.min(100, usedPercent),
      ...(whole === undefined ? {} : { windowSeconds: whole }),
      resetsAt: instant(snapshot.reset_at),
    },
  ];
};

const CREDIT_STATES = harden(['available', 'redeeming', 'redeemed']);

/**
 * The usage payload as a raw account reading. Pure, and tolerant: a payload
 * of an unexpected shape yields what of it could be read, down to `{}`.
 *
 * @param {any} payload
 * @returns {Record<string, any>}
 */
export const readingFromCodexUsage = payload => {
  if (payload === null || typeof payload !== 'object') return harden({});
  /** @type {Record<string, any>} */
  const reading = {};
  // A plan this does not know is reported as unknown, not by the word the
  // backend used: a reading is shown to views and to models.
  const planType = payload.plan_type;
  if (typeof planType === 'string') {
    const known = Object.hasOwn(PLAN_TITLES, planType);
    reading.plan = {
      planId: known ? planType : 'unknown',
      title: known
        ? PLAN_TITLES[/** @type {keyof typeof PLAN_TITLES} */ (planType)]
        : 'Unknown plan',
      state: known ? 'active' : 'unknown',
    };
  }
  const limit = payload.rate_limit;
  const windows =
    limit !== null && typeof limit === 'object'
      ? [
          ...windowFrom('primary', limit.primary_window),
          ...windowFrom('secondary', limit.secondary_window),
        ]
      : [];
  const credits = payload.credits;
  const resets = payload.rate_limit_reset_credits;
  const balance =
    typeof credits?.balance === 'string' &&
    /^-?\d{1,24}(\.\d{1,12})?$/.test(credits.balance)
      ? credits.balance
      : null;
  const availableCount = finite(resets?.available_count);
  const rows = Array.isArray(resets?.credits) ? resets.credits : undefined;
  if (
    windows.length > 0 ||
    (credits !== null && typeof credits === 'object') ||
    availableCount !== undefined ||
    limit?.limit_reached === true
  ) {
    reading.rateLimits = {
      windows,
      limitReached:
        limit?.limit_reached === true ||
        typeof payload.rate_limit_reached_type === 'string',
      ...(credits !== null && typeof credits === 'object'
        ? {
            credits: {
              balance,
              hasCredits: credits.has_credits === true,
              unlimited: credits.unlimited === true,
            },
          }
        : {}),
      ...(availableCount !== undefined && Number.isSafeInteger(availableCount)
        ? {
            resetCredits: {
              availableCount,
              credits:
                rows === undefined
                  ? null
                  : rows
                      .filter(
                        row =>
                          typeof row?.id === 'string' &&
                          /^[A-Za-z0-9_.:-]{1,128}$/.test(row.id),
                      )
                      .slice(0, 64)
                      .map(row => ({
                        id: row.id,
                        status: CREDIT_STATES.includes(row.status)
                          ? row.status
                          : 'unknown',
                        // Display text of the backend's choosing is not kept:
                        // an account reading is shown to models.
                        description: '',
                        grantedAt: instant(row.granted_at),
                        expiresAt: instant(row.expires_at),
                      })),
            },
          }
        : {}),
    };
  }
  return harden(reading);
};
harden(readingFromCodexUsage);

/**
 * @param {object} powers
 * @param {{ current(): Promise<{ state: { accessToken: string } }> }} powers.credential
 *   The broker's renewing credential; a spent token is refreshed as it would
 *   be for inference.
 * @param {string} powers.accountRef The pinned ChatGPT account.
 * @param {typeof globalThis.fetch} powers.fetch
 */
export const makeCodexAccountRead = ({ credential, accountRef, fetch }) => {
  /^[A-Za-z0-9_-]{1,256}$/.test(accountRef) ||
    Fail`Invalid Codex subscription account`;
  return async () => {
    const { state } = await credential.current();
    const response = await fetch(USAGE_URL, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${state.accessToken}`,
        'chatgpt-account-id': accountRef,
        accept: 'application/json',
      },
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    // No upstream wording leaves here: a status, never a body.
    response.ok || Fail`Codex usage read refused (HTTP ${q(response.status)})`;
    return readingFromCodexUsage(
      await boundedJson(response, MAX_BODY_BYTES, 'Codex usage read'),
    );
  };
};
harden(makeCodexAccountRead);
