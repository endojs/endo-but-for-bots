// @ts-check
import {
  analyseCredits,
  creditSettings,
  formatCredits,
  creditNumber,
} from './credit-projection.js';
import { analyseSeries, staleMs, WEEK_MINUTES } from './quota-projection.js';
import { windowName } from './labels.js';

/** @typedef {{at: number, value: number, units?: bigint, period: number, reset?: number}} Sample */
/** @typedef {{name: string, samples: Sample[], maxAge: number, weeklyReset?: number, forecast?: {from: number, until: number, rate: number, value: number}}} AccountSeries */
/** @typedef {{id: string, title: string, wallet: boolean, series: AccountSeries[]}} Metric */
/** @typedef {{at: number, value: number, exact?: string, contributors: number, segment: string}} Aggregate */

/**
 * Exact decimal sum of balances expressed as trillionths.
 * @param {bigint} sum
 */
const decimal = sum => {
  const digits = (sum < 0n ? -sum : sum).toString().padStart(13, '0');
  const fraction = digits.slice(-12).replace(/0+$/, '');
  return (
    (sum < 0n ? '-' : '') +
    digits.slice(0, -12) +
    (fraction ? `.${fraction}` : '')
  );
};

/**
 * @param {string} name
 * @param {any} row
 * @param {number} now
 * @returns {AccountSeries}
 */
const quota = (name, row, now) => {
  const analysis = analyseSeries(row, now);
  const samples = analysis.periods.flatMap((group, period) =>
    group.flatMap(point => {
      const value = 100 - point.usedPercent;
      const sample = { at: point.atMs, value, period, reset: point.resetsAtMs };
      return point.seenMs === point.atMs
        ? [sample]
        : [sample, { ...sample, at: point.seenMs }];
    }),
  );
  const p = analysis.projection;
  const latest = analysis.latest;
  // A fully consumed allowance stays at zero until its confirmed reset.
  const exhausted =
    latest &&
    latest.seenMs <= now &&
    now - latest.seenMs <= staleMs(row.windowMinutes) &&
    analysis.status === 'exhausted' &&
    analysis.resetMs !== undefined &&
    analysis.resetMs > now
      ? { from: latest.seenMs, until: analysis.resetMs, value: 0, rate: 0 }
      : undefined;
  return {
    name,
    samples,
    maxAge: staleMs(row.windowMinutes),
    weeklyReset: analysis.weeklyResetMs,
    forecast: exhausted,
    ...(p
      ? {
          forecast: {
            from: p.fromMs,
            until: p.toMs,
            value: 100 - p.fromUsed,
            rate: p.usedPerHour / 3_600_000,
          },
        }
      : {}),
  };
};

/**
 * @param {string} name
 * @param {any[]} records
 * @param {number} now
 * @returns {AccountSeries}
 */
const wallet = (name, records, now) => {
  const analysis = analyseCredits(records, now);
  const samples = analysis.runs.flatMap((group, period) =>
    group.flatMap(point => {
      const sample = {
        at: point.atMs,
        value: point.value,
        units: point.units,
        period,
      };
      return point.seenMs === point.atMs
        ? [sample]
        : [sample, { ...sample, at: point.seenMs }];
    }),
  );
  const p = analysis.forecast;
  return {
    name,
    samples,
    maxAge: creditSettings.staleMs,
    ...(p
      ? {
          forecast: {
            from: p.fromMs,
            until: p.toMs,
            value: p.fromValue,
            rate: p.perHour / 3_600_000,
          },
        }
      : {}),
  };
};

/**
 * @param {Sample | undefined} sample
 * @param {number} at
 * @param {number} maxAge
 */
const validAt = (sample, at, maxAge) =>
  sample !== undefined &&
  at - sample.at <= maxAge &&
  (sample.reset === undefined || at < sample.reset);

/**
 * Combine the most recent still-valid observation for each account at each
 * actual sample time. Do not carry readings across a reported reset or expiry.
 * @param {Metric} metric
 * @param {number} now
 */
const combine = (metric, now) => {
  const { series } = metric;
  const times = new Set(
    series.flatMap(row => row.samples.map(p => p.at)).filter(at => at <= now),
  );
  const cursors = series.map(() => -1);
  /**
   * @param {number} at
   * @returns {Aggregate | undefined}
   */
  const snapshot = at => {
    let value = 0;
    let units = 0n;
    let contributors = 0;
    const parts = [];
    for (let index = 0; index < series.length; index += 1) {
      const row = series[index];
      while (row.samples[cursors[index] + 1]?.at <= at) cursors[index] += 1;
      const sample = row.samples[cursors[index]];
      if (validAt(sample, at, row.maxAge)) {
        value += sample.value;
        units += sample.units ?? 0n;
        contributors += 1;
        parts.push(`${index}.${sample.period}`);
      }
    }
    if (!contributors) return undefined;
    return {
      at,
      value: metric.wallet ? Number(units) / 1e12 : value / contributors,
      ...(metric.wallet ? { exact: decimal(units) } : {}),
      contributors,
      segment: parts.join('/'),
    };
  };
  /** @type {Aggregate[][]} */
  const runs = [];
  let previousAt = -Infinity;
  for (const at of [...times].sort((a, b) => a - b)) {
    // Changes in coverage between readings break the trace even when all
    // accounts next report at the same instant.
    const previous = runs.at(-1)?.at(-1);
    const uninterrupted =
      !previous ||
      series.every((row, index) => {
        const point = row.samples[cursors[index]];
        return (
          !validAt(point, previous.at, row.maxAge) ||
          validAt(point, at, row.maxAge)
        );
      });
    const point = snapshot(at);
    if (point) {
      if (
        !uninterrupted ||
        point.segment !== previous?.segment ||
        previousAt !== previous?.at
      )
        runs.push([]);
      runs[runs.length - 1].push(point);
    }
    previousAt = at;
  }
  const latest = snapshot(now);
  return { runs, latest };
};

/**
 * @param {Metric} metric
 * @param {number} now
 * @param {number} total
 */
const project = (metric, now, total) => {
  const forecasts = metric.series.flatMap(row =>
    row.forecast ? [row.forecast] : [],
  );
  if (!forecasts.length || forecasts.length !== total) return [];
  const until = Math.min(...forecasts.map(p => p.until));
  if (until <= now || forecasts.some(p => p.from > now)) return [];
  // Include depletion knees so the sum never spends an already empty account.
  const times = new Set([now, until]);
  for (const p of forecasts) {
    const zero = p.rate > 0 ? p.from + p.value / p.rate : Infinity;
    if (zero > now && zero < until) times.add(zero);
  }
  return [...times]
    .sort((a, b) => a - b)
    .map(at => ({
      at,
      value:
        forecasts.reduce(
          (sum, p) => sum + Math.max(0, p.value - (at - p.from) * p.rate),
          0,
        ) / (metric.wallet ? 1 : total),
    }));
};

/**
 * @param {any} pool
 * @param {any} history
 * @param {number} now
 */
export const poolOverview = (pool, history, now) => {
  /** @type {Map<string,Metric>} */
  const metrics = new Map();
  /** @type {any[]} */
  const accounts = pool?.members ?? [];
  const active = accounts.filter(
    (/** @type {any} */ m) => m.state !== 'retired',
  );
  accounts.forEach(
    (/** @type {any} */ account, /** @type {number} */ index) => {
      if (account.state === 'retired') return;
      const member = history?.members?.[index];
      if (
        !member ||
        account.label !== member.label ||
        account.provider !== member.provider
      )
        return;
      const duplicate =
        active.filter((/** @type {any} */ m) => m.label === account.label)
          .length > 1;
      const name = duplicate
        ? `${account.label} (member ${index + 1})`
        : account.label;
      if (
        creditNumber(account.credits) !== undefined &&
        member.credits?.length
      ) {
        const metric = metrics.get('credits') ?? {
          id: 'credits',
          title: 'Credit balance',
          wallet: true,
          series: [],
        };
        metric.series.push(wallet(name, member.credits, now));
        metrics.set(metric.id, metric);
      }
      const windows = account.windows ?? [];
      windows.forEach((/** @type {any} */ row) => {
        const minutes = row.windowMinutes;
        if (
          typeof minutes !== 'number' ||
          !Number.isFinite(minutes) ||
          minutes <= 0
        )
          return;
        const comparable = windows.filter(
          (/** @type {any} */ w) => w.windowMinutes === minutes,
        );
        const matching = (member.windows ?? []).filter(
          (/** @type {any} */ w) =>
            w.windowMinutes === minutes && w.name === row.name,
        );
        if (comparable.length !== 1 || matching.length !== 1) return;
        const id = `quota-${minutes}`;
        const metric = metrics.get(id) ?? {
          id,
          title: minutes === WEEK_MINUTES ? 'Weekly quota' : windowName(row),
          wallet: false,
          series: [],
        };
        metric.series.push(quota(name, matching[0], now));
        metrics.set(id, metric);
      });
    },
  );
  const weekly = metrics.get(`quota-${WEEK_MINUTES}`);
  const resets = (weekly?.series ?? []).flatMap(row =>
    row.weeklyReset === undefined
      ? []
      : [{ name: row.name, at: row.weeklyReset }],
  );
  return [...metrics.values()]
    .sort(
      (a, b) =>
        Number(b.wallet) - Number(a.wallet) || a.title.localeCompare(b.title),
    )
    .map(metric => {
      const total = active.length;
      return {
        ...metric,
        ...combine(metric, now),
        total,
        projection: project(metric, now, total),
        resets,
      };
    });
};

/**
 * @param {boolean} walletMetric
 * @param {number} value
 * @param {string} [exact]
 */
export const poolValue = (walletMetric, value, exact) =>
  walletMetric
    ? `${formatCredits(exact ?? value)} credits`
    : `${Number(value.toFixed(1))}%`;
