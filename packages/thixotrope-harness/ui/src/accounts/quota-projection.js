// @ts-check
/**
 * What the observed quota history of one window (`QuotaSeries`,
 * `guest/lib/interfaces-m4.js`) supports saying, for the Subscriptions
 * panel's graph. Pure functions of the series and the browser's clock.
 *
 * Units: the providers report the **used percent** of a window (Claude's
 * utilisation, Codex's used percent); the graph shows **remaining quota %**
 * (100 - used), the same figure turned over, and nothing else. No credit
 * unit is derived from a percent.
 *
 * Rules (nothing is invented):
 *
 * - **Current period**: the samples since the window last reset, told by
 *   the provider's reported reset time (a sample with another reset belongs
 *   to an earlier period) and by usage falling (a reset the reading did not
 *   name). Samples of earlier periods are drawn, never projected from.
 * - **Projection**: only from at least `minReadings` distinct readings of
 *   the current period spanning at least `minSpanMs`, the newest confirmed
 *   within `staleMs(window)` of now, and only up to the provider's reported
 *   reset of that period (a reset bounds a projection: usage after it is a
 *   new period). The rate is the observed change from the period's first
 *   reading to its latest confirmation; a flat rate projects flat.
 *   Otherwise the projection is withheld and the reason says why:
 *   `empty`, `insufficient`, `stale`, `no-reset`, `reset-passed`,
 *   `exhausted`.
 * - **Weekly reset marker**: only a reset the provider reported in the
 *   newest reading of a 7-day window, and only while it is still ahead.
 *   Later weeks are never extrapolated.
 */

export const WEEK_MINUTES = 10_080;

export const projectionSettings = harden({
  /** Distinct readings of the current period needed to project. */
  minReadings: 2,
  /** The current period's readings must span at least this long. */
  minSpanMs: 10 * 60_000,
  /** Two reported reset times this close are the same reset. */
  resetToleranceMs: 120_000,
});

/**
 * How long after its latest confirmation a series still supports a
 * projection: a quarter of the window, at least 30 minutes, at most 6 hours.
 *
 * @param {number | undefined} windowMinutes
 */
export const staleMs = windowMinutes => {
  const windowMs = (windowMinutes ?? 300) * 60_000;
  return Math.min(6 * 3_600_000, Math.max(30 * 60_000, windowMs / 4));
};

/**
 * @typedef {object} Point
 * @property {number} atMs
 * @property {number} usedPercent
 * @property {number} [resetsAtMs]
 * @property {number} seenMs the latest confirmation (`lastAt`, else `at`)
 *
 * @typedef {'projected' | 'empty' | 'insufficient' | 'stale' | 'no-reset' | 'reset-passed' | 'exhausted'} ProjectionStatus
 *
 * @typedef {object} SeriesAnalysis
 * @property {Point[]} points every observed sample, oldest first
 * @property {Point[]} period the current period's samples
 * @property {ProjectionStatus} status
 * @property {{ fromMs: number, fromUsed: number, toMs: number, toUsed: number, exhaustsAtMs?: number, usedPerHour: number }} [projection]
 * @property {number} [weeklyResetMs] a confirmed upcoming weekly reset
 * @property {number} [resetMs] the reset the newest reading reported
 */

/** @param {unknown} text */
const msOf = text => (typeof text === 'string' ? Date.parse(text) : NaN);

/**
 * @param {number | undefined} a
 * @param {number | undefined} b
 */
const sameReset = (a, b) =>
  a === undefined || b === undefined
    ? a === b
    : Math.abs(a - b) <= projectionSettings.resetToleranceMs;

/**
 * The samples of a series as numbers, oldest first; unreadable ones left out.
 *
 * @param {{ samples?: readonly any[] }} series
 * @returns {Point[]}
 */
export const pointsOf = series => {
  /** @type {Point[]} */
  const points = [];
  for (const sample of series.samples ?? []) {
    const atMs = msOf(sample.at);
    const usedPercent = Number(sample.usedPercent);
    const resetsAtMs = msOf(sample.resetsAt);
    const lastMs = msOf(sample.lastAt);
    const previous = points.at(-1);
    if (
      Number.isFinite(atMs) &&
      Number.isFinite(usedPercent) &&
      (previous === undefined || atMs > previous.seenMs)
    ) {
      points.push({
        atMs,
        usedPercent: Math.min(100, Math.max(0, usedPercent)),
        ...(Number.isFinite(resetsAtMs) ? { resetsAtMs } : {}),
        seenMs: Number.isFinite(lastMs) && lastMs > atMs ? lastMs : atMs,
      });
    }
  }
  return points;
};

/**
 * The samples since the last reset: walking back from the newest, stop at
 * a sample of another reported reset, or where usage rose into the next
 * (a fall going forward is a reset).
 *
 * @param {readonly Point[]} points
 * @returns {Point[]}
 */
export const currentPeriod = points => {
  const newest = points.at(-1);
  if (newest === undefined) return [];
  let start = points.length - 1;
  while (start > 0) {
    const earlier = points[start - 1];
    const later = points[start];
    if (!sameReset(earlier.resetsAtMs, newest.resetsAtMs)) break;
    if (earlier.usedPercent > later.usedPercent) break;
    // A reported reset between the two readings ends the earlier period.
    if (earlier.resetsAtMs !== undefined && earlier.resetsAtMs <= later.atMs)
      break;
    start -= 1;
  }
  return points.slice(start);
};

/**
 * @param {{ name: string, windowMinutes?: number, samples?: readonly any[] }} series
 * @param {number} nowMs
 * @returns {SeriesAnalysis}
 */
export const analyseSeries = (series, nowMs) => {
  const points = pointsOf(series);
  const period = currentPeriod(points);
  const newest = period.at(-1);
  if (newest === undefined) return { points, period, status: 'empty' };
  const resetMs = newest.resetsAtMs;
  /** @type {SeriesAnalysis} */
  const base = {
    points,
    period,
    status: 'insufficient',
    ...(resetMs === undefined ? {} : { resetMs }),
  };
  const upcoming = resetMs !== undefined && resetMs > nowMs;
  if (series.windowMinutes === WEEK_MINUTES && upcoming) {
    base.weeklyResetMs = resetMs;
  }
  if (resetMs !== undefined && !upcoming) return { ...base, status: 'reset-passed' };
  if (newest.usedPercent >= 100) return { ...base, status: 'exhausted' };
  const first = period[0];
  const distinct = period.length;
  const spanMs = newest.seenMs - first.atMs;
  if (
    distinct < projectionSettings.minReadings ||
    spanMs < projectionSettings.minSpanMs
  )
    return { ...base, status: 'insufficient' };
  if (nowMs - newest.seenMs > staleMs(series.windowMinutes))
    return { ...base, status: 'stale' };
  if (resetMs === undefined) return { ...base, status: 'no-reset' };
  const ratePerMs = Math.max(0, (newest.usedPercent - first.usedPercent) / spanMs);
  const fromMs = newest.seenMs;
  const fromUsed = newest.usedPercent;
  const toMs = resetMs;
  const reach = fromUsed + ratePerMs * (toMs - fromMs);
  /** @type {NonNullable<SeriesAnalysis['projection']>} */
  const projection = {
    fromMs,
    fromUsed,
    toMs,
    toUsed: Math.min(100, reach),
    usedPerHour: ratePerMs * 3_600_000,
  };
  if (reach >= 100 && ratePerMs > 0) {
    projection.exhaustsAtMs = fromMs + (100 - fromUsed) / ratePerMs;
  }
  return { ...base, status: 'projected', projection };
};
harden(analyseSeries);

/**
 * A time as the graph labels it: UTC, to the minute ("Nov 18 02:11 UTC").
 *
 * @param {number} ms
 */
export const formatInstant = ms => {
  const date = new Date(ms);
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()} ${pad(
    date.getUTCHours(),
  )}:${pad(date.getUTCMinutes())} UTC`;
};

/**
 * A time as an axis tick: "Nov 18 02:11" (the axis says UTC once).
 *
 * @param {number} ms
 */
export const formatTick = ms => formatInstant(ms).replace(/ UTC$/, '');

/** @param {number} used */
export const remainingOf = used =>
  Math.round(Math.max(0, 100 - used) * 10) / 10;

/**
 * The sentence that says what the projection is, or why there is none.
 *
 * @param {SeriesAnalysis} analysis
 * @param {{ name: string, windowMinutes?: number }} series
 */
export const projectionText = (analysis, series) => {
  const { status, projection } = analysis;
  switch (status) {
    case 'projected': {
      const p = /** @type {NonNullable<SeriesAnalysis['projection']>} */ (
        projection
      );
      if (p.exhaustsAtMs !== undefined)
        return `Projected: used up around ${formatInstant(p.exhaustsAtMs)}, before the reset at ${formatInstant(p.toMs)} (from ${analysis.period.length} readings this period).`;
      return `Projected: ${remainingOf(p.toUsed)}% remaining at the reset at ${formatInstant(p.toMs)} (from ${analysis.period.length} readings this period).`;
    }
    case 'empty':
      return 'No quota readings recorded yet.';
    case 'insufficient':
      return `No projection: need at least ${projectionSettings.minReadings} distinct readings at least ${Math.round(projectionSettings.minSpanMs / 60_000)} minutes apart since the last reset.`;
    case 'stale':
      return `No projection: the newest reading is older than ${Math.round(staleMs(series.windowMinutes) / 60_000)} minutes.`;
    case 'no-reset':
      return 'No projection: the provider has not reported when this window resets.';
    case 'reset-passed':
      return 'No projection: this window has reset since the newest reading.';
    case 'exhausted':
      return 'Used up as of the newest reading; no projection until it resets.';
    default:
      return '';
  }
};
