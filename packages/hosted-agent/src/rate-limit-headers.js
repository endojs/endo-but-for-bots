// @ts-check

/**
 * What an inference response's headers say about the account that paid for
 * it, as a raw account reading (`{ plan?, rateLimits }`, the shape
 * `account-oracle.js` normalizes). Both subscription providers report their
 * windows on every response, served or refused, so status costs no request of
 * its own.
 *
 * This runs host-side, in the transport, and what it returns is the only part
 * of an upstream's headers that goes anywhere. Every value is parsed into a
 * number, an instant or one of a closed set of words, and a header that does
 * not parse is dropped: no text of the upstream's choosing leaves here.
 *
 * Header names are from the pinned CLIs (Codex 0.152.0, Claude Code 2.1.263);
 * see designs/hosted-agent-subscriptions.md, "What the providers publish".
 *
 * @module
 */

/** @typedef {(name: string) => string | null | undefined} HeaderGetter */

const MAX_HEADER_CHARS = 256;

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
 *
 * @param {HeaderGetter} get
 * @param {string} name
 */
const number = (get, name) => {
  const value = text(get, name);
  if (!/^\d{1,15}(\.\d{1,9})?$/.test(value)) return undefined;
  return Number(value);
};

/**
 * Seconds since the epoch, as an ISO instant, within a sane range: a header
 * that would place a reset before 2020 or past 2100 is not a reset time.
 *
 * @param {number | undefined} seconds
 */
const instantFromSeconds = seconds => {
  if (seconds === undefined) return '';
  if (seconds < 1_577_836_800 || seconds > 4_102_444_800) return '';
  return new Date(Math.trunc(seconds) * 1000).toISOString();
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

const titleOfMinutes = minutes => {
  if (minutes === 300) return '5-hour window';
  if (minutes === 10_080) return 'Weekly window';
  if (minutes % 1440 === 0) return `${minutes / 1440}-day window`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return `${minutes}-minute window`;
};

const CODEX_REACHED = harden([
  'rate_limit_reached',
  'workspace_owner_credits_depleted',
  'workspace_member_credits_depleted',
  'workspace_owner_usage_limit_reached',
  'workspace_member_usage_limit_reached',
]);

/**
 * `x-codex-primary-*` and `x-codex-secondary-*`: used percent, window length
 * in minutes, reset time in epoch seconds; `x-codex-credits-*`; and
 * `x-codex-rate-limit-reached-type`.
 *
 * @param {HeaderGetter} get
 */
const codexReading = get => {
  const windows = [];
  for (const slot of ['primary', 'secondary']) {
    const usedPercent = number(get, `x-codex-${slot}-used-percent`);
    if (usedPercent !== undefined) {
      const minutes = number(get, `x-codex-${slot}-window-minutes`);
      const whole =
        minutes !== undefined && Number.isSafeInteger(minutes) && minutes > 0
          ? minutes
          : undefined;
      windows.push({
        windowId: slot,
        title: whole === undefined ? `${slot} window` : titleOfMinutes(whole),
        usedPercent: Math.min(100, usedPercent),
        ...(whole === undefined ? {} : { windowSeconds: whole * 60 }),
        resetsAt: instantFromSeconds(number(get, `x-codex-${slot}-reset-at`)),
      });
    }
  }
  const hasCredits = flag(get, 'x-codex-credits-has-credits');
  const unlimited = flag(get, 'x-codex-credits-unlimited');
  const balanceText = text(get, 'x-codex-credits-balance');
  const balance = /^-?\d{1,24}(\.\d{1,12})?$/.test(balanceText)
    ? balanceText
    : null;
  const credits =
    hasCredits === undefined && unlimited === undefined && balance === null
      ? undefined
      : {
          balance,
          hasCredits: hasCredits === true,
          unlimited: unlimited === true,
        };
  const reached = CODEX_REACHED.includes(
    text(get, 'x-codex-rate-limit-reached-type'),
  );
  if (windows.length === 0 && credits === undefined && !reached) {
    return undefined;
  }
  return {
    rateLimits: {
      windows,
      limitReached: reached,
      ...(credits === undefined ? {} : { credits }),
    },
  };
};

const ANTHROPIC_WINDOWS = harden([
  { slot: '5h', windowId: 'primary', title: '5-hour window', seconds: 18_000 },
  {
    slot: '7d',
    windowId: 'secondary',
    title: 'Weekly window',
    seconds: 604_800,
  },
]);

/**
 * `anthropic-ratelimit-unified-{5h,7d}-utilization` (a fraction from 0 to 1)
 * and `-reset` (epoch seconds), and `anthropic-ratelimit-unified-status`
 * (`allowed`, `allowed_warning`, `rejected`).
 *
 * @param {HeaderGetter} get
 */
const anthropicReading = get => {
  const windows = [];
  for (const { slot, windowId, title, seconds } of ANTHROPIC_WINDOWS) {
    const utilization = number(
      get,
      `anthropic-ratelimit-unified-${slot}-utilization`,
    );
    if (utilization !== undefined) {
      windows.push({
        windowId,
        title,
        usedPercent: Math.min(100, utilization * 100),
        windowSeconds: seconds,
        resetsAt: instantFromSeconds(
          number(get, `anthropic-ratelimit-unified-${slot}-reset`),
        ),
      });
    }
  }
  const status = text(get, 'anthropic-ratelimit-unified-status').toLowerCase();
  const known = ['allowed', 'allowed_warning', 'rejected'].includes(status);
  if (windows.length === 0 && !known) return undefined;
  return {
    rateLimits: { windows, limitReached: status === 'rejected' },
  };
};

/**
 * The account reading in a response's headers, or undefined when they carry
 * none. The provider is told from the headers themselves, so the transport
 * needs no configuration to know whose they are.
 *
 * `windowId` is `primary` for the short window and `secondary` for the long
 * one under both providers, which is what a pool ranks on.
 *
 * @param {HeaderGetter} get case-insensitive, as `Headers.prototype.get` is
 * @returns {{ rateLimits: { windows: any[], limitReached: boolean, credits?: any } } | undefined}
 */
export const rateLimitReadingFromHeaders = get => {
  try {
    const reading = codexReading(get) ?? anthropicReading(get);
    return reading === undefined ? undefined : harden(reading);
  } catch (_error) {
    // A reading is an observation: a header this cannot digest must never
    // change how the request it arrived on settles.
    return undefined;
  }
};
harden(rateLimitReadingFromHeaders);

/**
 * Whether a refused response says the subscription is used up, as opposed to
 * throttled for a moment or refused for another cause. Told by header, since
 * the transport does not parse a refused body.
 *
 * @param {number} status
 * @param {HeaderGetter} get
 */
export const isSubscriptionExhausted = (status, get) => {
  if (status !== 429) return false;
  const reading = rateLimitReadingFromHeaders(get);
  if (reading === undefined) return false;
  if (reading.rateLimits.limitReached) return true;
  return reading.rateLimits.windows.some(
    window => Number(window.usedPercent) >= 100,
  );
};
harden(isSubscriptionExhausted);
