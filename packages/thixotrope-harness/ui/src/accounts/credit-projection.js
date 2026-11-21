// @ts-check
/**
 * Credit balance history of one account (`MemberHistory.credits`, records
 * `{ from, value, to?, count? }`, `value` a decimal string): a wallet,
 * separate from the quota windows and in its own unit (credits, not %).
 *
 * - Only a genuine number is a balance: `value` must be a plain decimal
 *   (`62500.0000000000`); anything else is not plotted.
 * - A rise in the balance is a top-up and starts a new run: no line and
 *   no forecast across it. A quota (weekly) reset says nothing about the
 *   wallet and is not used here.
 * - The forecast of spending is linear from the current run's first read
 *   to its latest confirmation, needs 2 real reading times at least
 *   `minSpanMs` apart (a value read and confirmed again counts as two), a
 *   latest reading under `staleMs` old, and is bounded: it covers at most
 *   `maxHorizonMs` (and twice the observed span), stops at zero, and is
 *   withdrawn once its horizon passes. An unchanged balance is a flat
 *   forecast (no spending seen), never a guess.
 */
import { formatInstant } from './quota-projection.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const creditSettings = harden({
  minReadings: 2,
  minSpanMs: 10 * MINUTE,
  staleMs: 6 * HOUR,
  minHorizonMs: HOUR,
  maxHorizonMs: 7 * 24 * HOUR,
});

const DECIMAL = /^-?\d{1,24}(\.\d{1,12})?$/;

/**
 * The number a reported balance stands for, or `undefined` when it is not
 * a plain signed decimal.
 *
 * @param {unknown} text
 * @returns {number | undefined}
 */
export const creditNumber = text => {
  if (typeof text !== 'string' || !DECIMAL.test(text)) return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
};

const grouping = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/**
 * Exact trillionths for comparing observed balances without binary rounding.
 * @param {string} text a validated provider decimal
 */
const unitsOf = text => {
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole + fraction.padEnd(12, '0'));
};

/**
 * Keep every significant provider digit. Numeric inputs are approximate forecasts.
 * @param {number | string} value
 */
export const formatCredits = value => {
  if (typeof value === 'number') return grouping.format(value);
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const integer = whole
    .replace(/^0+(?=\d)/, '')
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const decimals = fraction.replace(/0+$/, '');
  const sign =
    value.startsWith('-') && (integer !== '0' || decimals) ? '-' : '';
  const magnitude = decimals ? `${integer}.${decimals}` : integer;
  return `${sign}${magnitude}`;
};

/**
 * A short axis label (`62.5k`, `1.2M`, `350`).
 *
 * @param {number} value
 */
export const formatCreditsShort = value => {
  const abs = Math.abs(value);
  /** @param {number} n */
  const trim = n => String(Number(n.toFixed(1)));
  if (abs >= 1e12 || (abs > 0 && abs < 0.1))
    return value.toExponential(1).replace('.0e', 'e');
  if (abs >= 1e6) return `${trim(value / 1e6)}M`;
  if (abs >= 1e3) return `${trim(value / 1e3)}k`;
  return trim(value);
};

/**
 * @typedef {object} CreditPoint
 * @property {number} atMs first read
 * @property {number} seenMs latest confirmation (`to`, else `from`)
 * @property {number} count readings the record stands for
 * @property {number} value
 * @property {string} reported
 * @property {bigint} units
 *
 * @typedef {'empty' | 'insufficient' | 'stale' | 'unchanged' | 'forecast' | 'exhausted' | 'debt' | 'precision'} CreditStatus
 *
 * @typedef {object} CreditForecast
 * @property {number} fromMs
 * @property {number} fromValue
 * @property {number} toMs end of the bounded horizon (or zero reached)
 * @property {number} toValue
 * @property {number} perHour credits spent per hour (0 when unchanged)
 * @property {number} [emptyAtMs] when the balance would reach zero
 *
 * @typedef {object} CreditAnalysis
 * @property {CreditPoint[]} points
 * @property {CreditPoint[][]} runs split at top-ups
 * @property {CreditStatus} status
 * @property {number} readings
 * @property {CreditPoint} [latest]
 * @property {number} [topUpMs] first read after the last top-up
 * @property {CreditForecast} [forecast]
 */

/**
 * @param {readonly any[] | undefined} records
 * @returns {CreditPoint[]}
 */
export const creditPointsOf = records => {
  /** @type {CreditPoint[]} */
  const points = [];
  for (const record of records ?? []) {
    const atMs =
      typeof record?.from === 'string' ? Date.parse(record.from) : NaN;
    const toMs = typeof record?.to === 'string' ? Date.parse(record.to) : NaN;
    const value = creditNumber(record?.value);
    const previous = points.at(-1);
    if (
      Number.isFinite(atMs) &&
      value !== undefined &&
      (previous === undefined || atMs > previous.seenMs)
    ) {
      const repeated = Number.isFinite(toMs) && toMs > atMs;
      points.push({
        atMs,
        seenMs: repeated ? toMs : atMs,
        count: repeated
          ? Math.max(2, Number.isSafeInteger(record.count) ? record.count : 2)
          : 1,
        value,
        reported: record.value,
        units: unitsOf(record.value),
      });
    }
  }
  return points;
};

/**
 * The points split where the balance rose (a top-up).
 *
 * @param {readonly CreditPoint[]} points
 * @returns {CreditPoint[][]}
 */
export const creditRunsOf = points => {
  /** @type {CreditPoint[][]} */
  const runs = [];
  for (const point of points) {
    const run = runs.at(-1);
    const previous = run?.at(-1);
    if (
      run === undefined ||
      previous === undefined ||
      point.units > previous.units
    )
      runs.push([point]);
    else run.push(point);
  }
  return runs;
};

/** @param {readonly CreditPoint[]} points */
const readingTimes = points =>
  points.reduce((sum, point) => sum + (point.seenMs > point.atMs ? 2 : 1), 0);

/**
 * @param {readonly any[] | undefined} records
 * @param {number} nowMs
 * @returns {CreditAnalysis}
 */
export const analyseCredits = (records, nowMs) => {
  const points = creditPointsOf(records);
  const runs = creditRunsOf(points);
  const run = runs.at(-1) ?? [];
  const latest = run.at(-1);
  const readings = points.reduce((sum, point) => sum + point.count, 0);
  if (latest === undefined) return { points, runs, status: 'empty', readings };
  const first = run[0];
  /** @type {CreditAnalysis} */
  const base = {
    points,
    runs,
    status: 'insufficient',
    readings,
    latest,
    ...(runs.length > 1 ? { topUpMs: first.atMs } : {}),
  };
  if (latest.units < 0n) return { ...base, status: 'debt' };
  if (latest.units === 0n) return { ...base, status: 'exhausted' };
  const spanMs = latest.seenMs - first.atMs;
  if (
    readingTimes(run) < creditSettings.minReadings ||
    spanMs < creditSettings.minSpanMs
  )
    return base;
  if (nowMs - latest.seenMs > creditSettings.staleMs)
    return { ...base, status: 'stale' };
  const horizonMs = Math.min(
    creditSettings.maxHorizonMs,
    Math.max(creditSettings.minHorizonMs, 2 * spanMs),
  );
  const spent = Number(first.units - latest.units) / 1e12;
  const plottedChange = first.value - latest.value;
  if (Math.abs(plottedChange - spent) > spent * 1e-9) {
    return { ...base, status: 'precision' };
  }
  const perMs = spent / spanMs;
  let toMs = latest.seenMs + horizonMs;
  /** @type {CreditForecast} */
  const forecast = {
    fromMs: latest.seenMs,
    fromValue: latest.value,
    toMs,
    toValue: latest.value,
    perHour: perMs * HOUR,
  };
  if (perMs > 0) {
    const emptyAtMs = latest.seenMs + latest.value / perMs;
    if (emptyAtMs <= toMs) {
      toMs = emptyAtMs;
      forecast.emptyAtMs = emptyAtMs;
    }
    forecast.toMs = toMs;
    forecast.toValue = Math.max(
      0,
      latest.value - perMs * (toMs - latest.seenMs),
    );
  }
  // Past its horizon the forecast says nothing more.
  if (nowMs > forecast.toMs) return { ...base, status: 'stale' };
  return {
    ...base,
    status: perMs > 0 ? 'forecast' : 'unchanged',
    forecast,
  };
};

/**
 * @param {CreditAnalysis} analysis
 */
export const creditLatestText = analysis =>
  analysis.latest === undefined
    ? ''
    : `Latest: ${formatCredits(analysis.latest.reported)} credits, confirmed ${formatInstant(analysis.latest.seenMs)}`;

/**
 * The sentence that says what the forecast is, or why there is none.
 *
 * @param {CreditAnalysis} analysis
 */
export const creditForecastText = analysis => {
  const { forecast } = analysis;
  const since =
    analysis.topUpMs === undefined
      ? ''
      : ` since the top-up seen ${formatInstant(analysis.topUpMs)}`;
  switch (analysis.status) {
    case 'forecast': {
      const f = /** @type {CreditForecast} */ (forecast);
      const rate = `about ${formatCredits(f.perHour)} credits/hour${since}`;
      if (f.emptyAtMs !== undefined)
        return `Spending forecast (linear, not a promise): ${rate}; would run out around ${formatInstant(f.emptyAtMs)} unless topped up.`;
      return `Spending forecast (linear, to ${formatInstant(f.toMs)} only): ${rate}; about ${formatCredits(f.toValue)} credits left then.`;
    }
    case 'unchanged': {
      const f = /** @type {CreditForecast} */ (forecast);
      return `Spending forecast (to ${formatInstant(f.toMs)} only): no spending observed${since}; balance unchanged at ${formatCredits(analysis.latest?.reported ?? f.fromValue)} credits.`;
    }
    case 'empty':
      return 'No credit balance readings recorded yet.';
    case 'insufficient':
      return `No spending forecast: needs balance readings at least ${Math.round(creditSettings.minSpanMs / MINUTE)} minutes apart${since || ''}.`;
    case 'stale':
      return 'No spending forecast: the latest balance reading is too old.';
    case 'precision':
      return 'No spending forecast: the observed change is below the precision of the plotted balances.';
    case 'debt':
      return 'The reported balance is negative; no spending forecast.';
    case 'exhausted':
      return 'No credits left as of the latest reading.';
    default:
      return '';
  }
};
