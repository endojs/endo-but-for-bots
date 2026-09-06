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
 * Epoch milliseconds for a summary's timestamp, or `undefined` when there is
 * nothing usable there.
 *
 * `updatedAt` arrives untyped from the daemon, so the label and the sort read
 * it through this one parser rather than each inventing its own: `Date.parse`
 * of a stringified epoch is `NaN`, so a sort that only knew how to parse
 * strings would drop an epoch-valued run to the bottom of a rail whose label
 * rendered its age perfectly well.
 *
 * @param {unknown} when
 * @returns {number | undefined}
 */
const epochMs = when => {
  if (when instanceof Date) {
    const at = when.getTime();
    return Number.isFinite(at) ? at : undefined;
  }
  if (typeof when === 'number') {
    return Number.isFinite(when) ? when : undefined;
  }
  if (typeof when !== 'string' || when === '') {
    return undefined;
  }
  const parsed = Date.parse(when);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * @param {string | number | Date | null | undefined} when
 * @param {number} [now] - epoch ms; defaults to the clock
 * @returns {string} e.g. `just now`, `2m ago`, `3d ago`, `1mo ago`, `2y ago`,
 *   or `''` when there is no usable timestamp
 */
export const relativeAge = (when, now = Date.now()) => {
  const then = epochMs(when);
  if (then === undefined) return '';

  const seconds = Math.floor((now - then) / 1000);
  // Under a minute there is no whole unit to show, so the label stays
  // qualitative rather than flooring to "0m ago". This also absorbs the clock
  // skew between the daemon and the browser, which can put a run marginally in
  // the future: "just now" beats "-1m ago".
  if (seconds < MINUTE) return 'just now';
  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)}m ago`;
  if (seconds < DAY) return `${Math.floor(seconds / HOUR)}h ago`;
  if (seconds < WEEK) return `${Math.floor(seconds / DAY)}d ago`;
  if (seconds < MONTH) return `${Math.floor(seconds / WEEK)}w ago`;
  if (seconds < YEAR) return `${Math.floor(seconds / MONTH)}mo ago`;
  return `${Math.floor(seconds / YEAR)}y ago`;
};
harden(relativeAge);

/**
 * The journal sequence as a number, defaulting to 0 when it is missing or not
 * numeric: a comparator that returns `NaN` leaves the order to the sort.
 *
 * @param {any} summary
 * @returns {number}
 */
const seqOf = summary => {
  const seq = Number(summary?.seq ?? 0);
  return Number.isFinite(seq) ? seq : 0;
};

/**
 * Newest first. Runs are compared on `updatedAt`, falling back to the journal
 * sequence — which is monotonic per run but not comparable ACROSS runs, so it
 * is only a tie-breaker for entries that carry no timestamp at all.
 *
 * @param {any[] | undefined} summaries - the rail's summaries, which come from
 *   an eventual send and so may be absent
 * @returns {any[]} a new array; the input is left alone
 */
export const newestFirst = summaries =>
  [...(summaries ?? [])].sort((a, b) => {
    const aAt = epochMs(a?.updatedAt);
    const bAt = epochMs(b?.updatedAt);
    if (aAt !== undefined && bAt !== undefined) return bAt - aAt;
    // A timestamped run sorts above one without a timestamp rather than
    // interleaving unpredictably.
    if (aAt !== undefined) return -1;
    if (bAt !== undefined) return 1;
    return seqOf(b) - seqOf(a);
  });
harden(newestFirst);
