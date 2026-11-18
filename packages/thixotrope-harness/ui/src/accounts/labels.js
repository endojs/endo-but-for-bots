// @ts-check
/**
 * How a subscription account is worded for a person (R4-84, R4-86, R6-52,
 * R6-54; W4.7), after the reference `space-floot/src/account-label.js`,
 * adapted to M4's `MemberAccount` (`guest/lib/interfaces-m4.js`): plan,
 * windows (used percent, reset time), limit reached, credits and banked
 * resets (read-only, decision 8), each labelled with its provenance
 * (`observed`, `remembered`, `declared`, `unavailable`). Pure functions of
 * the record and the browser's clock.
 */
/* eslint-disable import/no-relative-packages */
import { m4Texts } from '../../../guest/lib/texts-m4.js';

/**
 * A span of time in its two largest units: "3d 4h", "2h 10m", "45s".
 *
 * @param {number} ms
 */
export const formatSpan = ms => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  /** @type {Array<[string, number]>} */
  const units = [
    ['d', 86_400],
    ['h', 3600],
    ['m', 60],
    ['s', 1],
  ];
  const parts = [];
  let rest = seconds;
  for (const [label, size] of units) {
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
 * A window as it stands now: once its reset time has passed, the
 * allowance is back, whatever the reading said.
 *
 * @param {{ usedPercent: number, resetsAt?: string }} window
 * @param {number} nowMs
 */
export const windowNow = (window, nowMs) => {
  const resetMs =
    window.resetsAt === undefined ? NaN : Date.parse(window.resetsAt);
  const hasReset = Number.isFinite(resetMs);
  const expired = hasReset && resetMs <= nowMs;
  const usedPercent = expired ? 0 : window.usedPercent;
  return {
    usedPercent,
    expired,
    exhausted: usedPercent >= 100,
    resetsInMs: hasReset && !expired ? resetMs - nowMs : undefined,
  };
};

/**
 * The short name of a window: its length when it is a known one.
 *
 * @param {{ name: string, windowMinutes?: number }} window
 */
export const windowName = window => {
  if (window.windowMinutes === 300) return '5h';
  if (window.windowMinutes === 1440) return 'day';
  if (window.windowMinutes === 10_080) return 'wk';
  if (window.name === 'primary') return 'short';
  if (window.name === 'secondary') return 'long';
  return 'other';
};

/** How long a "limit reached" with no window to say when it lifts is believed. */
const UNDATED_BLOCK_MS = 3_600_000;

/**
 * Whether the account cannot serve now, as far as is known: marked,
 * unusable or retired; a full window; or the provider's word that the
 * limit is reached, until every window it named has reset (an undated
 * one for an hour from the reading).
 *
 * @param {Record<string, any>} account `MemberAccount`
 * @param {number} nowMs
 */
export const accountBlocked = (account, nowMs) => {
  if (account.state !== 'ok') return true;
  /** @type {Array<ReturnType<typeof windowNow>>} */
  const windows = account.windows.map((/** @type {any} */ window) =>
    windowNow(window, nowMs),
  );
  if (windows.some(window => window.exhausted)) return true;
  if (!account.limitReached) return false;
  if (windows.length !== 0) return !windows.every(window => window.expired);
  const at = account.at === undefined ? NaN : Date.parse(account.at);
  return Number.isFinite(at) && Number(nowMs - at) < UNDATED_BLOCK_MS;
};

/**
 * The provenance label (R4-84, word for word) with the reading's age.
 *
 * @param {Record<string, any>} account
 * @param {number} nowMs
 */
export const provenanceText = (account, nowMs) => {
  /** @type {Record<string, string>} */
  const words = {
    observed: m4Texts.provenanceObserved,
    remembered: m4Texts.provenanceRemembered,
    declared: m4Texts.provenanceDeclared,
    unavailable: m4Texts.provenanceUnavailable,
  };
  const word = words[account.provenance] ?? m4Texts.provenanceUnavailable;
  const at = account.at === undefined ? NaN : Date.parse(account.at);
  if (
    (account.provenance === 'observed' ||
      account.provenance === 'remembered') &&
    Number.isFinite(at)
  ) {
    return `${word}, ${formatSpan(nowMs - at)} ago`;
  }
  return word;
};

/**
 * The status-bar chip of one member account (R6-52): its label, then each
 * window, the long one first ("wk 40%", "5h used up, back in 2h 10m"),
 * else its credits, else its plan; "limit reached" when the provider said
 * so; the provenance when nothing was observed.
 *
 * @param {Record<string, any>} account
 * @param {number} nowMs
 */
export const chipText = (account, nowMs) => {
  const parts = [];
  const ordered = [...account.windows].sort(
    (a, b) => (b.windowMinutes ?? 0) - (a.windowMinutes ?? 0),
  );
  for (const window of ordered) {
    const { usedPercent, resetsInMs, exhausted } = windowNow(window, nowMs);
    const name = windowName(window);
    if (!exhausted) {
      // Never "100%" for a window that still has room.
      parts.push(`${name} ${Math.min(99, Math.round(usedPercent))}%`);
    } else if (resetsInMs !== undefined) {
      parts.push(`${name} used up, back in ${formatSpan(resetsInMs)}`);
    } else {
      parts.push(`${name} used up`);
    }
  }
  if (parts.length === 0 && account.credits) {
    parts.push(`${account.credits} credits`);
  }
  if (parts.length === 0 && account.plan) parts.push(account.plan);
  if (account.limitReached && !parts.some(part => part.includes('used up'))) {
    parts.push('limit reached');
  }
  if (account.state === 'unusable' || account.state === 'marked') {
    parts.push(account.state);
  }
  if (account.provenance !== 'observed') {
    parts.push(provenanceText(account, nowMs));
  }
  return `${account.label}: ${parts.join(' · ')}`;
};

/**
 * The Subscriptions panel's rows of one member account (R6-54): plan,
 * windows with percent used and reset, status, credits, banked resets
 * (read-only: no redeem, decision 8) and the source.
 *
 * @param {Record<string, any>} account
 * @param {number} nowMs
 * @returns {Array<[string, string]>}
 */
export const accountRows = (account, nowMs) => {
  /** @type {Array<[string, string]>} */
  const rows = [];
  if (account.plan) rows.push(['Plan', account.plan]);
  for (const window of account.windows) {
    const { expired, resetsInMs } = windowNow(window, nowMs);
    let reset = '';
    if (expired) reset = ' (has reset since this reading)';
    else if (resetsInMs !== undefined) {
      reset = ` · resets in ${formatSpan(resetsInMs)} (${window.resetsAt})`;
    }
    rows.push([
      windowName(window),
      `${window.usedPercent}% used, ${Math.max(0, 100 - window.usedPercent)}% left${reset}`,
    ]);
  }
  /** @type {string[]} */
  const status = [account.state];
  if (account.code !== undefined) status.push(account.code);
  if (account.markedUntil !== undefined) {
    status.push(`until ${account.markedUntil}`);
  }
  if (accountBlocked(account, nowMs) && account.state === 'ok') {
    status.push('limit reached');
  }
  rows.push(['Status', status.join(' · ')]);
  if (account.credits) rows.push(['Credits', account.credits]);
  for (const credit of account.banked ?? []) {
    rows.push([
      'Banked reset',
      [
        credit.label ?? 'reset',
        ...(credit.expiresAt === undefined
          ? []
          : [`expires ${credit.expiresAt}`]),
      ].join(' · '),
    ]);
  }
  rows.push(['Source', provenanceText(account, nowMs)]);
  return rows;
};
