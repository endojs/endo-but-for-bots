// @ts-check

import harden from '@endo/harden';

// A short age label for the runs rail.
//
// Deliberately not `@endo/spaces-util`'s `relativeTime`: that one returns the
// empty string past a week, because its callers fall back to an absolute
// timestamp. The rail has no room for a fallback, and a run list is exactly
// where "1mo ago" is the useful part — so this keeps going all the way up.

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
// Averaged, because "1mo ago" is a rough label and calendar months are not a
// unit. Precision here would be false precision.
const MONTH = 2_629_800; // 30.4375 days
const YEAR = 12 * MONTH;

/**
 * @param {string | number | Date | undefined} when
 * @param {number} [now] - epoch ms; defaults to the clock
 * @returns {string} e.g. `just now`, `2m ago`, `3d ago`, `1mo ago`, `2y ago`,
 *   or `''` when there is no usable timestamp
 */
export const relativeAge = (when, now = Date.now()) => {
  if (when === undefined || when === null || when === '') return '';
  const then =
    when instanceof Date
      ? when.getTime()
      : typeof when === 'number'
        ? when
        : Date.parse(String(when));
  if (!Number.isFinite(then)) return '';

  const seconds = Math.floor((now - then) / 1000);
  // A clock skew between the daemon and the browser can put a run marginally in
  // the future; "just now" beats "-1m ago".
  if (seconds < 45) return 'just now';
  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)}m ago`;
  if (seconds < DAY) return `${Math.floor(seconds / HOUR)}h ago`;
  if (seconds < WEEK) return `${Math.floor(seconds / DAY)}d ago`;
  if (seconds < MONTH) return `${Math.floor(seconds / WEEK)}w ago`;
  if (seconds < YEAR) return `${Math.floor(seconds / MONTH)}mo ago`;
  return `${Math.floor(seconds / YEAR)}y ago`;
};
harden(relativeAge);

/**
 * Newest first. Runs are compared on `updatedAt`, falling back to the journal
 * sequence — which is monotonic per run but not comparable ACROSS runs, so it
 * is only a tie-breaker for entries that carry no timestamp at all.
 *
 * @param {any[]} summaries
 * @returns {any[]} a new array; the input is left alone
 */
export const newestFirst = summaries => {
  const at = summary => {
    const parsed = Date.parse(String(summary && summary.updatedAt));
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  return [...(summaries || [])].sort((a, b) => {
    const aAt = at(a);
    const bAt = at(b);
    if (aAt !== undefined && bAt !== undefined) return bAt - aAt;
    // A timestamped run sorts above one without a timestamp rather than
    // interleaving unpredictably.
    if (aAt !== undefined) return -1;
    if (bAt !== undefined) return 1;
    return Number(b?.seq ?? 0) - Number(a?.seq ?? 0);
  });
};
harden(newestFirst);
