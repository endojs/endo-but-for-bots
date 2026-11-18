// @ts-check
/**
 * What an inference answer's headers say about the account that paid for it
 * (M4 W4.2; `designs/m4-interfaces.md` 5.1, 5.3; R4-25, R4-84). Port of
 * hosted-agent `src/rate-limit-headers.js` (1315bef86)
 * (`rateLimitReadingFromHeaders`, `isSubscriptionExhausted`), answering the
 * adapter's `Reading` (`types.js`: times in ms, windows named
 * `primary` / `secondary`) instead of the reference's ISO text.
 *
 * Both subscription providers report their windows on every answer, served
 * or refused, so a reading costs no request of its own. Every value is parsed
 * into a number, an instant or one of a closed set of words; a header that
 * does not parse is dropped, so no text of the upstream's choosing leaves
 * this module (and none is ever logged).
 *
 * Node only.
 */

/** @typedef {(name: string) => string | null | undefined} HeaderGetter */
/** @typedef {import('./types.js').Reading} Reading */
/** @typedef {import('./types.js').ReadingWindow} ReadingWindow */

const MAX_HEADER_CHARS = 256;
/** A reset before 2020 or after 2100 is not a reset time (seconds). */
const EARLIEST_RESET_S = 1_577_836_800;
const LATEST_RESET_S = 4_102_444_800;

/**
 * @param {HeaderGetter} get
 * @param {string} name
 */
const text = (get, name) => {
  const value = get(name);
  return typeof value === 'string' && value.length <= MAX_HEADER_CHARS
    ? value.trim()
    : '';
};

/**
 * A finite non-negative decimal, or undefined.
 * @param {HeaderGetter} get
 * @param {string} name
 */
const number = (get, name) => {
  const value = text(get, name);
  if (!/^\d{1,15}(\.\d{1,9})?$/.test(value)) return undefined;
  return Number(value);
};

/**
 * Epoch seconds as ms, within a sane range.
 * @param {number | undefined} seconds
 */
const msFromSeconds = seconds => {
  if (seconds === undefined) return undefined;
  if (seconds < EARLIEST_RESET_S || seconds > LATEST_RESET_S) return undefined;
  return Math.trunc(seconds) * 1000;
};

/**
 * @param {HeaderGetter} get
 * @param {string} name
 */
const flag = (get, name) => {
  const value = text(get, name).toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
};

const CODEX_REACHED = harden([
  'rate_limit_reached',
  'workspace_owner_credits_depleted',
  'workspace_member_credits_depleted',
  'workspace_owner_usage_limit_reached',
  'workspace_member_usage_limit_reached',
]);

/**
 * `x-codex-primary-*` and `x-codex-secondary-*` (used percent, window length
 * in minutes, reset time in epoch seconds), `x-codex-credits-*` and
 * `x-codex-rate-limit-reached-type`.
 *
 * `credits` is one short word or a decimal (`Reading.credits` is display
 * text, `MemberAccount.credits`): the balance when the provider gave one,
 * else `unlimited`, `available` or `none`.
 *
 * @param {HeaderGetter} get
 * @param {number} nowMs
 * @returns {Reading | undefined}
 */
const codexReading = (get, nowMs) => {
  /** @type {ReadingWindow[]} */
  const windows = [];
  for (const slot of /** @type {const} */ (['primary', 'secondary'])) {
    const usedPercent = number(get, `x-codex-${slot}-used-percent`);
    if (usedPercent !== undefined) {
      const minutes = number(get, `x-codex-${slot}-window-minutes`);
      const whole =
        minutes !== undefined && Number.isSafeInteger(minutes) && minutes > 0
          ? minutes
          : undefined;
      const resetsAtMs = msFromSeconds(number(get, `x-codex-${slot}-reset-at`));
      windows.push({
        name: slot,
        usedPercent: Math.min(100, usedPercent),
        ...(whole === undefined ? {} : { windowMinutes: whole }),
        ...(resetsAtMs === undefined ? {} : { resetsAtMs }),
      });
    }
  }
  const hasCredits = flag(get, 'x-codex-credits-has-credits');
  const unlimited = flag(get, 'x-codex-credits-unlimited');
  const balanceText = text(get, 'x-codex-credits-balance');
  const balance = /^-?\d{1,24}(\.\d{1,12})?$/.test(balanceText)
    ? balanceText
    : undefined;
  /** @type {string | undefined} */
  let credits;
  if (balance !== undefined) credits = balance;
  else if (unlimited === true) credits = 'unlimited';
  else if (hasCredits !== undefined)
    credits = hasCredits ? 'available' : 'none';
  const reached = CODEX_REACHED.includes(
    text(get, 'x-codex-rate-limit-reached-type'),
  );
  if (windows.length === 0 && credits === undefined && !reached) {
    return undefined;
  }
  return {
    at: nowMs,
    source: 'observed',
    windows,
    limitReached: reached,
    ...(credits === undefined ? {} : { credits }),
  };
};

const ANTHROPIC_WINDOWS = harden([
  { slot: '5h', name: 'primary', minutes: 300 },
  { slot: '7d', name: 'secondary', minutes: 10_080 },
]);

/**
 * `anthropic-ratelimit-unified-{5h,7d}-utilization` (a fraction 0..1) and
 * `-reset` (epoch seconds), and `anthropic-ratelimit-unified-status`
 * (`allowed`, `allowed_warning`, `rejected`).
 *
 * @param {HeaderGetter} get
 * @param {number} nowMs
 * @returns {Reading | undefined}
 */
const anthropicReading = (get, nowMs) => {
  /** @type {ReadingWindow[]} */
  const windows = [];
  for (const { slot, name, minutes } of ANTHROPIC_WINDOWS) {
    const utilization = number(
      get,
      `anthropic-ratelimit-unified-${slot}-utilization`,
    );
    if (utilization !== undefined) {
      const resetsAtMs = msFromSeconds(
        number(get, `anthropic-ratelimit-unified-${slot}-reset`),
      );
      windows.push({
        name: /** @type {'primary' | 'secondary'} */ (name),
        usedPercent: Math.min(100, utilization * 100),
        windowMinutes: minutes,
        ...(resetsAtMs === undefined ? {} : { resetsAtMs }),
      });
    }
  }
  const status = text(get, 'anthropic-ratelimit-unified-status').toLowerCase();
  const known = ['allowed', 'allowed_warning', 'rejected'].includes(status);
  if (windows.length === 0 && !known) return undefined;
  return {
    at: nowMs,
    source: 'observed',
    windows,
    limitReached: status === 'rejected',
  };
};

/**
 * The account reading in an answer's headers, or undefined when they carry
 * none. The provider is told from the headers themselves. A getter that
 * throws, or a header that cannot be digested, costs the reading, never the
 * request.
 *
 * @param {HeaderGetter} get case-insensitive, as `Headers.prototype.get`
 * @param {number} [nowMs] when the answer arrived (the reading's `at`)
 * @returns {Reading | undefined}
 */
export const readingFromHeaders = (get, nowMs = Date.now()) => {
  try {
    const reading = codexReading(get, nowMs) ?? anthropicReading(get, nowMs);
    return reading === undefined ? undefined : harden(reading);
  } catch (_error) {
    return undefined;
  }
};
harden(readingFromHeaders);

/**
 * The latest reset time among `windows`, when every one of them names one.
 * @param {ReadingWindow[]} windows
 */
const latestNamedReset = windows => {
  if (windows.length === 0) return null;
  const times = windows.map(window => window.resetsAtMs);
  if (!times.every(time => typeof time === 'number')) return null;
  return Math.max(.../** @type {number[]} */ (times));
};

/**
 * Whether a refused answer says the subscription is used up (as opposed to
 * throttled for a moment or refused for another cause), told by header; the
 * answer's body is never parsed. `untilMs` is the reset time the reading
 * names for what is used up (the full windows, else every window when the
 * provider says the limit is reached with none full), or `null` when it
 * names none: the pool then marks the member on its backoff (5.1).
 *
 * @param {number} status
 * @param {HeaderGetter} get
 * @returns {{ untilMs: number | null } | undefined}
 */
export const isExhausted = (status, get) => {
  if (status !== 429) return undefined;
  const reading = readingFromHeaders(get, 0);
  if (reading === undefined) return undefined;
  const full = reading.windows.filter(window => window.usedPercent >= 100);
  if (full.length > 0) return harden({ untilMs: latestNamedReset(full) });
  if (reading.limitReached) {
    return harden({ untilMs: latestNamedReset(reading.windows) });
  }
  return undefined;
};
harden(isExhausted);
