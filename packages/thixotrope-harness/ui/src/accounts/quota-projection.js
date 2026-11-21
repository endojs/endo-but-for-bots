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
 * - **Records**: a record is one reported value, first read `from` and,
 *   when `count` (2 or more) readings repeated it, last confirmed `to`. Its
 *   two times are real readings; nothing between them is drawn or implied,
 *   and the counts said are the recorded ones.
 * - **Periods** (`periodsOf`): one rule splits both the drawn traces and
 *   the slope. A new period starts where usage falls, where a reported
 *   reset is at or before the next reading, or where two readings report
 *   different resets (beyond the 2-minute tolerance).
 * - **Projection**: only from the current period, with at least
 *   `minReadings` distinct reading times (a repeated value read at 10:00
 *   and again at 10:15 is two) spanning at least `minSpanMs`, the latest
 *   confirmed within `staleMs(window)` of now, and only up to the reset the
 *   newest record reported while it is still ahead. The rate is the change
 *   from the period's first reading to its latest confirmation (flat when
 *   the value did not move). Otherwise the status says why: `empty`,
 *   `insufficient`, `stale`, `no-reset`, `reset-passed`, `exhausted`.
 *   Everything is a function of `nowMs`, so an open view that advances its
 *   clock drops a projection that went stale or reached its reset, and a
 *   reset marker that passed, without asking the provider.
 * - **Weekly reset marker**: a window of 10,080 minutes (in whichever slot,
 *   primary or secondary, of either provider) whose newest record reported
 *   a reset still ahead. Later weeks are never extrapolated.
 */

export const WEEK_MINUTES = 10_080;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const projectionSettings = harden({
  /** Distinct reading times of the current period needed to project. */
  minReadings: 2,
  /** The current period's readings must span at least this long. */
  minSpanMs: 10 * MINUTE,
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
  const windowMs = (windowMinutes ?? 300) * MINUTE;
  return Math.min(6 * HOUR, Math.max(30 * MINUTE, windowMs / 4));
};

/**
 * @typedef {object} Point
 * @property {number} atMs first read (`from`)
 * @property {number} seenMs latest confirmation (`to`, else `from`)
 * @property {number} count the readings the record stands for (1, or 2+)
 * @property {number} usedPercent
 * @property {number} [resetsAtMs]
 *
 * @typedef {'projected' | 'empty' | 'insufficient' | 'stale' | 'no-reset' | 'reset-passed' | 'exhausted'} ProjectionStatus
 *
 * @typedef {object} Projection
 * @property {number} fromMs
 * @property {number} fromUsed
 * @property {number} toMs
 * @property {number} toUsed
 * @property {number} usedPerHour
 * @property {number} [exhaustsAtMs]
 *
 * @typedef {object} SeriesAnalysis
 * @property {Point[]} points every observed record, oldest first
 * @property {Point[][]} periods the points split at period boundaries
 * @property {Point[]} period the current (last) period
 * @property {ProjectionStatus} status
 * @property {number} readings readings the whole series stands for
 * @property {number} periodReadings readings of the current period
 * @property {Point} [latest] the newest record
 * @property {Projection} [projection]
 * @property {number} [weeklyResetMs] a confirmed upcoming weekly reset
 * @property {number} [resetMs] the reset the newest record reported
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
 * The records of a series as numbers, oldest first; unreadable ones and
 * ones not after the previous confirmation left out.
 *
 * @param {{ records?: readonly any[] }} series
 * @returns {Point[]}
 */
export const pointsOf = series => {
  /** @type {Point[]} */
  const points = [];
  for (const record of series.records ?? []) {
    const atMs = msOf(record.from);
    const toMs = msOf(record.to);
    const usedPercent = Number(record.usedPercent);
    const resetsAtMs = msOf(record.resetsAt);
    const previous = points.at(-1);
    if (
      Number.isFinite(atMs) &&
      Number.isFinite(usedPercent) &&
      (previous === undefined || atMs > previous.seenMs)
    ) {
      const repeated = Number.isFinite(toMs) && toMs > atMs;
      points.push({
        atMs,
        seenMs: repeated ? toMs : atMs,
        count: repeated
          ? Math.max(2, Number.isSafeInteger(record.count) ? record.count : 2)
          : 1,
        usedPercent: Math.min(100, Math.max(0, usedPercent)),
        ...(Number.isFinite(resetsAtMs) ? { resetsAtMs } : {}),
      });
    }
  }
  return points;
};

/**
 * Whether `later` begins a new period after `earlier`: usage fell, the
 * reset `earlier` reported came at or before `later` was read, or the two
 * report different resets.
 *
 * @param {Point} earlier
 * @param {Point} later
 */
export const startsNewPeriod = (earlier, later) =>
  later.usedPercent < earlier.usedPercent ||
  (earlier.resetsAtMs !== undefined && earlier.resetsAtMs <= later.atMs) ||
  (earlier.resetsAtMs !== undefined &&
    later.resetsAtMs !== undefined &&
    !sameReset(earlier.resetsAtMs, later.resetsAtMs));

/**
 * The points split into periods (the drawn traces and the slope use the
 * same split).
 *
 * @param {readonly Point[]} points
 * @returns {Point[][]}
 */
export const periodsOf = points => {
  /** @type {Point[][]} */
  const periods = [];
  for (const point of points) {
    const run = periods.at(-1);
    const previous = run?.at(-1);
    if (run === undefined || previous === undefined) periods.push([point]);
    else if (startsNewPeriod(previous, point)) periods.push([point]);
    else run.push(point);
  }
  return periods;
};

/**
 * The points since the last reset.
 *
 * @param {readonly Point[]} points
 * @returns {Point[]}
 */
export const currentPeriod = points => periodsOf(points).at(-1) ?? [];

/**
 * Distinct reading times: a record's first read, and its last
 * confirmation when a later reading repeated it.
 *
 * @param {readonly Point[]} points
 */
export const readingTimes = points =>
  points.reduce((sum, point) => sum + (point.seenMs > point.atMs ? 2 : 1), 0);

/** @param {readonly Point[]} points */
const readingsOf = points =>
  points.reduce((sum, point) => sum + point.count, 0);

/**
 * @param {{ name: string, windowMinutes?: number, records?: readonly any[] }} series
 * @param {number} nowMs
 * @returns {SeriesAnalysis}
 */
export const analyseSeries = (series, nowMs) => {
  const points = pointsOf(series);
  const periods = periodsOf(points);
  const period = periods.at(-1) ?? [];
  const newest = period.at(-1);
  const readings = readingsOf(points);
  const periodReadings = readingsOf(period);
  if (newest === undefined)
    return {
      points,
      periods,
      period,
      status: 'empty',
      readings,
      periodReadings,
    };
  const resetMs = newest.resetsAtMs;
  /** @type {SeriesAnalysis} */
  const base = {
    points,
    periods,
    period,
    status: 'insufficient',
    readings,
    periodReadings,
    latest: newest,
    ...(resetMs === undefined ? {} : { resetMs }),
  };
  const upcoming = resetMs !== undefined && resetMs > nowMs;
  if (series.windowMinutes === WEEK_MINUTES && upcoming) {
    base.weeklyResetMs = resetMs;
  }
  if (resetMs !== undefined && !upcoming)
    return { ...base, status: 'reset-passed' };
  if (newest.usedPercent >= 100) return { ...base, status: 'exhausted' };
  const first = period[0];
  const spanMs = newest.seenMs - first.atMs;
  if (
    readingTimes(period) < projectionSettings.minReadings ||
    spanMs < projectionSettings.minSpanMs
  )
    return { ...base, status: 'insufficient' };
  if (nowMs - newest.seenMs > staleMs(series.windowMinutes))
    return { ...base, status: 'stale' };
  if (resetMs === undefined) return { ...base, status: 'no-reset' };
  const ratePerMs = Math.max(
    0,
    (newest.usedPercent - first.usedPercent) / spanMs,
  );
  const fromMs = newest.seenMs;
  const fromUsed = newest.usedPercent;
  const toMs = resetMs;
  const reach = fromUsed + ratePerMs * (toMs - fromMs);
  /** @type {Projection} */
  const projection = {
    fromMs,
    fromUsed,
    toMs,
    toUsed: Math.min(100, reach),
    usedPerHour: ratePerMs * HOUR,
  };
  if (reach >= 100 && ratePerMs > 0) {
    projection.exhaustsAtMs = fromMs + (100 - fromUsed) / ratePerMs;
  }
  return { ...base, status: 'projected', projection };
};
harden(analyseSeries);

const MONTHS = [
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

/** @param {number} n */
const pad = n => String(n).padStart(2, '0');

/**
 * A UTC date: "Nov 18".
 *
 * @param {number} ms
 */
export const formatDate = ms => {
  const date = new Date(ms);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
};

/**
 * A UTC time of day: "02:11".
 *
 * @param {number} ms
 */
export const formatClock = ms => {
  const date = new Date(ms);
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
};

/**
 * A time as the graph says it: UTC, to the minute ("Nov 18 02:11 UTC").
 *
 * @param {number} ms
 */
export const formatInstant = ms => `${formatDate(ms)} ${formatClock(ms)} UTC`;

/** Tick steps, smallest first: whole quarter hours, hours and days (UTC). */
const TICK_STEPS = [
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
];

/**
 * @typedef {object} TimeTick
 * @property {number} ms
 * @property {string} [time] "HH:MM" (steps under a day)
 * @property {string} [date] "Nov 18" (day steps, and where the day changes)
 */

/**
 * Time-axis ticks between `start` and `end` at whole UTC quarter hours,
 * hours or days, at most `maxTicks` of them. A tick gives its date on the
 * first tick and where the day changes, so narrow labels stay short.
 *
 * @param {number} start
 * @param {number} end
 * @param {number} maxTicks
 * @returns {TimeTick[]}
 */
export const timeTicks = (start, end, maxTicks) => {
  const most = Math.max(1, Math.floor(maxTicks));
  const span = Math.max(1, end - start);
  let step = TICK_STEPS.find(candidate => span / candidate <= most);
  if (step === undefined) step = Math.ceil(span / most / (7 * DAY)) * 7 * DAY;
  /** @type {TimeTick[]} */
  const ticks = [];
  let lastDate = '';
  for (let ms = Math.ceil(start / step) * step; ms <= end; ms += step) {
    const date = formatDate(ms);
    ticks.push({
      ms,
      ...(step < DAY ? { time: formatClock(ms) } : {}),
      ...(step >= DAY || date !== lastDate ? { date } : {}),
    });
    lastDate = date;
  }
  return ticks;
};

/** @param {number} used */
export const remainingOf = used =>
  Math.round(Math.max(0, 100 - used) * 10) / 10;

/** @param {number} n */
const readingsText = n => `${n} reading${n === 1 ? '' : 's'}`;

/**
 * The latest figure: "Latest: 60% remaining, confirmed Nov 18 11:50 UTC".
 *
 * @param {SeriesAnalysis} analysis
 */
export const latestText = analysis => {
  const { latest } = analysis;
  if (latest === undefined) return '';
  return `Latest: ${remainingOf(latest.usedPercent)}% remaining, confirmed ${formatInstant(latest.seenMs)}`;
};

/**
 * The sentence that says what the projection is, or why there is none.
 *
 * @param {SeriesAnalysis} analysis
 * @param {{ name: string, windowMinutes?: number }} series
 */
export const projectionText = (analysis, series) => {
  const { status, projection } = analysis;
  const from = `from ${readingsText(analysis.periodReadings)} this period`;
  switch (status) {
    case 'projected': {
      const p = /** @type {Projection} */ (projection);
      if (p.exhaustsAtMs !== undefined)
        return `Projected: used up around ${formatInstant(p.exhaustsAtMs)}, before the reset at ${formatInstant(p.toMs)} (${from}).`;
      if (p.usedPerHour === 0)
        return `Projected: unchanged, ${remainingOf(p.toUsed)}% remaining at the reset at ${formatInstant(p.toMs)} (${from}; no change observed).`;
      return `Projected: ${remainingOf(p.toUsed)}% remaining at the reset at ${formatInstant(p.toMs)} (${from}).`;
    }
    case 'empty':
      return 'No quota readings recorded yet.';
    case 'insufficient':
      return `No projection: needs readings at least ${Math.round(projectionSettings.minSpanMs / MINUTE)} minutes apart since the last reset.`;
    case 'stale':
      return `No projection: the latest reading is older than ${Math.round(staleMs(series.windowMinutes) / MINUTE)} minutes.`;
    case 'no-reset':
      return 'No projection: the provider has not reported when this window resets.';
    case 'reset-passed':
      return 'No projection: this window has reset since the latest reading.';
    case 'exhausted':
      return 'Used up as of the latest reading; no projection until it resets.';
    default:
      return '';
  }
};
