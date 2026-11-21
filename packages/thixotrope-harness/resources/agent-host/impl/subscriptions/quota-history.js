// @ts-check
/**
 * Quota history: the observed quota readings of each member account, per
 * provider window, kept bounded and durable with the readings file
 * (`account-file.js`, format 3) so the Subscriptions panel can draw a time
 * series and a projection from real readings only.
 *
 * - **Keyed** by the member's store key (the readings file entry), its
 *   provider (a key whose provider changes starts empty) and the window
 *   (`name` + `windowMinutes`: a slot whose period changes is another
 *   window).
 * - **Observed only**: a sample is appended when a provider reading
 *   arrives (inference headers or an on-demand usage read), at the time
 *   the reading was taken. Nothing is interpolated or backfilled; an entry
 *   loaded from an older file format starts with no history, and the
 *   remembered last reading is not turned into a sample.
 * - **Units as supplied**: `usedPercent` (0..100) as the provider reported
 *   it (Claude's utilisation fraction x 100, Codex's used percent) and the
 *   reset time it reported, if any. No credit unit is derived.
 * - **Deduplicated**: a reading that repeats the last sample of its window
 *   (same used percent to 0.01, same reset within `RESET_TOLERANCE_MS`)
 *   extends that sample's `lastAt` instead of adding one, so repeated
 *   headers of a busy session cost nothing and the sample still says how
 *   long the value was confirmed. A reading not newer than the last
 *   confirmation is dropped.
 * - **Bounded**: at most `subscriptionLimits.historySamples` samples per
 *   window (oldest dropped) and `subscriptionLimits.maxWindows` windows per
 *   member (the least recently observed dropped).
 *
 * Pure functions over plain data; no credential, header text or provider
 * body is ever held (D-6).
 *
 * Node only (with the guest prelude's `harden`).
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { subscriptionLimits } from '../../../../guest/lib/subscription-limits.js';
/* eslint-enable import/no-relative-packages */

/** @import { Reading, ReadingWindow } from './types.js' */

/**
 * Two reset times this close are the same reset (providers round or
 * recompute a reset from `reset_after_seconds`).
 */
export const RESET_TOLERANCE_MS = 120_000;

/**
 * @typedef {object} HistorySample
 * @property {number} at when the reading was taken (ms)
 * @property {number} usedPercent 0..100, as the provider reported it
 * @property {number} [resetsAtMs] the reset the provider reported
 * @property {number} [lastAt] the last time a reading confirmed this same
 *   value (ms; absent when only one reading did)
 *
 * @typedef {object} HistorySeries
 * @property {'primary' | 'secondary' | 'other'} name
 * @property {number} [windowMinutes]
 * @property {HistorySample[]} samples oldest first
 */

/**
 * @param {unknown} value
 * @returns {value is number}
 */
const isTime = value =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** @param {number} value */
const roundPercent = value =>
  Math.round(Math.min(100, Math.max(0, value)) * 100) / 100;

/**
 * @param {number | undefined} a
 * @param {number | undefined} b
 */
export const sameReset = (a, b) =>
  a === undefined || b === undefined
    ? a === b
    : Math.abs(a - b) <= RESET_TOLERANCE_MS;
harden(sameReset);

/**
 * @param {{ name: string, windowMinutes?: number }} a
 * @param {{ name: string, windowMinutes?: number }} b
 */
const sameWindow = (a, b) =>
  a.name === b.name && a.windowMinutes === b.windowMinutes;

/** @param {HistorySample} sample */
const seenAt = sample => sample.lastAt ?? sample.at;

/**
 * The history kept after `windows` of a reading taken at `at` were
 * observed; `series` is not changed. Answers `undefined` when nothing
 * changed (every window was a duplicate older than or equal to what is
 * kept, or there was no window).
 *
 * @param {readonly HistorySeries[]} series
 * @param {number} at
 * @param {readonly ReadingWindow[]} windows the windows this reading
 *   reported (never windows carried over from an earlier reading)
 * @returns {HistorySeries[] | undefined}
 */
/**
 * Record one window of a reading into `next` (copies, changed in place).
 * Answers whether anything changed.
 *
 * @param {HistorySeries[]} next
 * @param {number} at
 * @param {ReadingWindow} window
 */
const observeWindow = (next, at, window) => {
  if (!isTime(window.usedPercent)) return false;
  const usedPercent = roundPercent(window.usedPercent);
  const resetsAtMs = isTime(window.resetsAtMs) ? window.resetsAtMs : undefined;
  let entry = next.find(candidate => sameWindow(candidate, window));
  if (entry === undefined) {
    entry = {
      name: window.name,
      ...(isTime(window.windowMinutes)
        ? { windowMinutes: window.windowMinutes }
        : {}),
      samples: [],
    };
    next.push(entry);
  }
  const last = entry.samples.at(-1);
  if (last !== undefined && at <= seenAt(last)) return false;
  if (
    last !== undefined &&
    last.usedPercent === usedPercent &&
    sameReset(last.resetsAtMs, resetsAtMs)
  ) {
    entry.samples[entry.samples.length - 1] = { ...last, lastAt: at };
    return true;
  }
  entry.samples.push({
    at,
    usedPercent,
    ...(resetsAtMs === undefined ? {} : { resetsAtMs }),
  });
  if (entry.samples.length > subscriptionLimits.historySamples)
    entry.samples.splice(
      0,
      entry.samples.length - subscriptionLimits.historySamples,
    );
  return true;
};

export const recordObservation = (series, at, windows) => {
  if (!isTime(at) || windows.length === 0) return undefined;
  /** @type {HistorySeries[]} */
  const next = series.map(entry => ({
    ...entry,
    samples: [...entry.samples],
  }));
  let changed = false;
  for (const window of windows.slice(0, subscriptionLimits.maxWindows)) {
    if (observeWindow(next, at, window)) changed = true;
  }
  if (!changed) return undefined;
  // At most `maxWindows` windows: the least recently observed goes.
  const kept = next.filter(entry => entry.samples.length > 0);
  kept.sort(
    (a, b) =>
      seenAt(/** @type {HistorySample} */ (b.samples.at(-1))) -
      seenAt(/** @type {HistorySample} */ (a.samples.at(-1))),
  );
  const bounded = kept.slice(0, subscriptionLimits.maxWindows);
  // Stable order for display: by declared order of the slot, then period.
  const order = { primary: 0, secondary: 1, other: 2 };
  bounded.sort(
    (a, b) =>
      order[a.name] - order[b.name] ||
      (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0),
  );
  return bounded;
};
harden(recordObservation);

/**
 * @param {unknown} samples
 * @returns {HistorySample[]}
 */
const checkSamples = samples => {
  /** @type {HistorySample[]} */
  const kept = [];
  const candidates = Array.isArray(samples)
    ? samples.slice(-subscriptionLimits.historySamples)
    : [];
  for (const sample of candidates) {
    const { at, usedPercent, resetsAtMs, lastAt } =
      sample !== null && typeof sample === 'object' ? sample : {};
    const previous = kept.at(-1);
    if (
      isTime(at) &&
      isTime(usedPercent) &&
      (previous === undefined || at > seenAt(previous))
    ) {
      kept.push({
        at,
        usedPercent: roundPercent(usedPercent),
        ...(isTime(resetsAtMs) ? { resetsAtMs } : {}),
        ...(isTime(lastAt) && lastAt > at ? { lastAt } : {}),
      });
    }
  }
  return kept;
};

/**
 * @param {unknown} raw
 * @returns {HistorySeries | undefined}
 */
const checkSeries = raw => {
  if (raw === null || typeof raw !== 'object') return undefined;
  const { name, windowMinutes, samples } = /** @type {any} */ (raw);
  if (name !== 'primary' && name !== 'secondary' && name !== 'other')
    return undefined;
  if (windowMinutes !== undefined && !isTime(windowMinutes)) return undefined;
  const kept = checkSamples(samples);
  if (kept.length === 0) return undefined;
  return {
    name,
    ...(isTime(windowMinutes) ? { windowMinutes } : {}),
    samples: kept,
  };
};

/**
 * A history as the readings file may hold it, checked and bounded: unknown
 * fields dropped, samples that are not times and percents dropped, samples
 * kept in strictly increasing time order, one series per window. A damaged
 * file can only lose samples.
 *
 * @param {unknown} candidate
 * @returns {HistorySeries[]}
 */
export const checkHistory = candidate => {
  if (!Array.isArray(candidate)) return [];
  /** @type {HistorySeries[]} */
  const out = [];
  for (const raw of candidate.slice(0, subscriptionLimits.maxWindows)) {
    const series = checkSeries(raw);
    if (series !== undefined && !out.some(entry => sameWindow(entry, series)))
      out.push(series);
  }
  return out;
};
harden(checkHistory);
