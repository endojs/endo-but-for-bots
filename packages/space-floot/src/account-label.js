// @ts-check

/**
 * How a backend's account is worded for a person: what its plan is, how full
 * each rate-limit window is and when it resets, credits, banked resets, and
 * how old the figures are. Pure, so a view can render it and a test can read
 * it. The data is `AccountView` from `@endo/floot/src/account-watch.js`.
 *
 * @typedef {{
 *   windowId: string, title: string, usedPercent: number | null,
 *   resetsAt: string, windowSeconds: number | null,
 *   limit: string | null, used: string | null, remaining: string | null,
 * }} AccountWindow
 * @typedef {{
 *   backendId: string, title: string,
 *   key?: string, subscriptionId?: string, label?: string,
 *   plan: { planId: string, title: string, state: string, source: string },
 *   windows: AccountWindow[], limitReached: boolean,
 *   credits: { balance: string | null, hasCredits: boolean, unlimited: boolean } | null,
 *   resetCredits: { availableCount: number, credits: Array<{ id: string, status: string, grantedAt: string, expiresAt: string }> | null } | null,
 *   source: string, observedAt: string,
 * }} Account
 */

/**
 * The accounts a session can be served from: the one it is pinned to, or
 * every account of its backend.
 *
 * @param {Account[] | undefined} accounts
 * @param {{ backendId?: string, subscription?: string } | undefined} session
 * @returns {Account[]}
 */
export const accountsOfSession = (accounts, session) => {
  if (!session) return [];
  const ofBackend = (accounts ?? []).filter(
    account => account.backendId === (session.backendId || 'provider'),
  );
  if (session.subscription && session.subscription !== 'auto') {
    return ofBackend.filter(
      account => account.subscriptionId === session.subscription,
    );
  }
  return ofBackend;
};

/**
 * A span of time in its two largest units: "3d 4h", "2h 10m", "45s".
 *
 * @param {number} ms
 */
export const formatSpan = ms => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const units = [
    ['d', 86_400],
    ['h', 3600],
    ['m', 60],
    ['s', 1],
  ];
  const parts = [];
  let rest = seconds;
  for (const [label, size] of /** @type {Array<[string, number]>} */ (units)) {
    const count = Math.floor(rest / size);
    if (count > 0 || (label === 's' && parts.length === 0)) {
      parts.push(`${count}${label}`);
      rest -= count * size;
    }
    if (parts.length === 2) break;
  }
  return parts.join(' ');
};

/**
 * A window as it stands now. A reading ages: once a window's reset time has
 * passed, the allowance is back, whatever the last reading said.
 *
 * @param {AccountWindow} window
 * @param {number} nowMs
 */
export const windowNow = (window, nowMs) => {
  const resetMs = Date.parse(window.resetsAt);
  const hasReset = Number.isFinite(resetMs);
  const expired = hasReset && resetMs <= nowMs;
  const usedPercent = expired ? 0 : window.usedPercent;
  return {
    usedPercent,
    expired,
    exhausted: usedPercent !== null && usedPercent >= 100,
    resetsInMs: hasReset && !expired ? resetMs - nowMs : null,
  };
};

const shortName = (/** @type {AccountWindow} */ window) => {
  if (window.windowSeconds === 18_000) return '5h';
  if (window.windowSeconds === 604_800) return 'wk';
  if (window.windowSeconds === 86_400) return 'day';
  return window.windowId === 'primary' ? 'short' : 'long';
};

/**
 * The header's chip for the backend of the session on screen: '' when there
 * is nothing known worth a glance.
 *
 * @param {Account | undefined} account
 * @param {number} nowMs
 */
export const accountChip = (account, nowMs) => {
  if (!account) return '';
  const parts = [];
  // The long window first: it is the one that runs out.
  const ordered = [...account.windows].sort(
    (a, b) => (b.windowSeconds ?? 0) - (a.windowSeconds ?? 0),
  );
  for (const window of ordered) {
    const { usedPercent, resetsInMs, exhausted } = windowNow(window, nowMs);
    if (usedPercent !== null) {
      const name = shortName(window);
      if (!exhausted) {
        // Never "100%" for a window that still has room.
        parts.push(`${name} ${Math.min(99, Math.round(usedPercent))}%`);
      } else if (resetsInMs !== null) {
        parts.push(`${name} used up, back in ${formatSpan(resetsInMs)}`);
      } else {
        parts.push(`${name} used up`);
      }
    }
  }
  if (parts.length === 0 && account.credits?.balance) {
    parts.push(`${account.credits.balance} credits`);
  }
  return parts.join(' · ');
};

/** How long a "limit reached" with no window to say when it lifts is believed. */
const UNDATED_BLOCK_MS = 3_600_000;

/**
 * Whether the account cannot spend right now, as far as is known.
 *
 * A full window blocks until it resets. The provider's own word that the
 * limit is reached, with no window full (depleted credits, a spend control),
 * stands until every window the reading named has reset: one of them
 * resetting does not refill credits. A reading that named no window cannot
 * say when it lifts, so it is believed for an hour and then no longer.
 *
 * @param {Account | undefined} account
 * @param {number} nowMs
 */
export const accountBlocked = (account, nowMs) => {
  if (!account) return false;
  const windows = account.windows.map(window => windowNow(window, nowMs));
  if (windows.some(window => window.exhausted)) return true;
  if (!account.limitReached) return false;
  if (windows.length > 0) return !windows.every(window => window.expired);
  const at = Date.parse(account.observedAt);
  return Number.isFinite(at) && nowMs - at < UNDATED_BLOCK_MS;
};

/**
 * @param {string} observedAt
 * @param {string} source
 * @param {number} nowMs
 */
const provenance = (observedAt, source, nowMs) => {
  if (source === 'unavailable') return 'nothing known yet';
  const at = Date.parse(observedAt);
  const age = Number.isFinite(at) ? `${formatSpan(nowMs - at)} ago` : '';
  if (source === 'observed') return age ? `as of ${age}` : 'observed';
  if (source === 'remembered') {
    return age ? `remembered from ${age}` : 'remembered';
  }
  return 'declared by the operator';
};

/**
 * The settings panel's account of every backend's subscription.
 *
 * @param {Account[] | undefined} accounts
 * @param {number} nowMs
 * @returns {Array<{ id: string, title: string, rows: Array<[string, string]> }>}
 */
export const accountSections = (accounts, nowMs) =>
  (accounts ?? []).map(account => {
    /** @type {Array<[string, string]>} */
    const rows = [];
    if (account.plan.title || account.plan.planId) {
      rows.push(['Plan', account.plan.title || account.plan.planId]);
    }
    for (const window of account.windows) {
      const { usedPercent, expired, resetsInMs } = windowNow(window, nowMs);
      const used =
        usedPercent === null ? 'usage not published' : `${usedPercent}% used`;
      const counts =
        window.remaining !== null && window.limit !== null
          ? `, ${window.remaining} of ${window.limit} left`
          : '';
      let reset = '';
      if (expired) reset = ' — has reset since this reading';
      else if (resetsInMs !== null)
        reset = ` — resets in ${formatSpan(resetsInMs)}`;
      rows.push([window.title || window.windowId, `${used}${counts}${reset}`]);
    }
    if (accountBlocked(account, nowMs)) {
      rows.push(['Status', 'limit reached']);
    }
    if (account.credits) {
      let credits = 'none';
      if (account.credits.unlimited) credits = 'unlimited';
      else if (account.credits.balance !== null)
        credits = account.credits.balance;
      else if (account.credits.hasCredits) credits = 'some';
      rows.push(['Credits', credits]);
    }
    if (account.resetCredits && account.resetCredits.availableCount > 0) {
      const expiries = (account.resetCredits.credits ?? [])
        .map(credit => Date.parse(credit.expiresAt))
        .filter(ms => Number.isFinite(ms) && ms > nowMs)
        .sort((a, b) => a - b);
      rows.push([
        'Banked resets',
        `${account.resetCredits.availableCount}${
          expiries.length
            ? `, the first expires in ${formatSpan(expiries[0] - nowMs)}`
            : ''
        }`,
      ]);
    }
    rows.push([
      'Figures',
      provenance(account.observedAt, account.source, nowMs),
    ]);
    return {
      id: account.key || account.backendId,
      // A backend with several subscriptions is told apart by their labels.
      title: account.label
        ? `${account.title || account.backendId} — ${account.label}`
        : account.title || account.backendId,
      rows,
    };
  });
