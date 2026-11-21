// @ts-check
/**
 * The quota history of a pool's members as time-series graphs (one per
 * provider window), under each pool of the Subscriptions panel. Data:
 * `Accounts.history(pool)` (`PoolHistory`, observed samples only), asked
 * again whenever the accounts view's `rev` moves. What is drawn and what is
 * projected follows `quota-projection.js`: observed readings as a solid
 * line with a dot per reading, the projection (when the evidence supports
 * one) dashed and labelled, a confirmed upcoming weekly reset as a marked
 * vertical line, "now" as a faint one. Every graph has a text equivalent
 * (its accessible label, caption and a table of readings).
 */
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { windowName } from './labels.js';
import {
  analyseSeries,
  formatInstant,
  formatTick,
  projectionText,
  remainingOf,
} from './quota-projection.js';

/** The graph's own words (harness texts). */
export const quotaGraphTexts = harden({
  title: 'Quota history',
  loading: 'Reading quota history…',
  unavailable: 'Quota history unavailable',
  noReadings:
    'No quota readings recorded yet. History starts with the next provider reading; earlier usage is not reconstructed.',
  unit: 'Remaining quota, % of window (provider reports % used); times UTC',
  observed: 'Observed readings',
  projected: 'Projection',
  weeklyReset: 'Weekly reset',
  now: 'now',
  readings: 'Readings',
});

const WIDTH = 360;
const HEIGHT = 150;
const LEFT = 40;
const RIGHT = 10;
const TOP = 14;
const BOTTOM = 30;
const HOUR = 3_600_000;

/**
 * @param {unknown} error
 * @returns {string}
 */
const messageOf = error =>
  error && typeof error === 'object' && 'message' in error
    ? String(/** @type {{ message: unknown }} */ (error).message)
    : String(error);

/**
 * The time domain of a graph: from the first reading to the latest of now,
 * the projection's end and the weekly reset.
 *
 * @param {import('./quota-projection.js').SeriesAnalysis} analysis
 * @param {number} nowMs
 */
export const domainOf = (analysis, nowMs) => {
  const first = analysis.points[0];
  const last = analysis.points.at(-1);
  let start = first === undefined ? nowMs - HOUR : first.atMs;
  let end = Math.max(
    nowMs,
    last?.seenMs ?? nowMs,
    analysis.projection?.toMs ?? 0,
    analysis.weeklyResetMs ?? 0,
  );
  if (end - start < HOUR) {
    start = Math.min(start, end - HOUR);
  }
  // A little room on both sides so dots and markers are not on the edge.
  const pad = (end - start) * 0.03;
  start -= pad;
  end += pad;
  return { start, end };
};

/**
 * @param {{ series: any, account: { label: string, provider: string }, nowMs: number }} props
 */
export const QuotaGraph = ({ series, account, nowMs }) => {
  const analysis = analyseSeries(series, nowMs);
  const name = windowName(series);
  const { start, end } = domainOf(analysis, nowMs);
  const x = (/** @type {number} */ ms) =>
    LEFT + ((ms - start) / (end - start)) * (WIDTH - LEFT - RIGHT);
  const y = (/** @type {number} */ used) =>
    TOP + (used / 100) * (HEIGHT - TOP - BOTTOM);
  const status = projectionText(analysis, series);
  const newest = analysis.points.at(-1);

  // Observed: one polyline per period (never drawn across a reset).
  /** @type {Array<typeof analysis.points>} */
  const runs = [];
  for (const point of analysis.points) {
    const run = runs.at(-1);
    const previous = run?.at(-1);
    const reset =
      previous !== undefined &&
      (point.usedPercent < previous.usedPercent ||
        (previous.resetsAtMs !== undefined &&
          previous.resetsAtMs <= point.atMs));
    if (run === undefined || reset) runs.push([point]);
    else run.push(point);
  }
  const observedLines = runs.map(run =>
    h('polyline', {
      class: 'm4-quota-observed',
      fill: 'none',
      stroke: '#2b6cb0',
      points: run
        .flatMap(point => [
          `${x(point.atMs).toFixed(1)},${y(point.usedPercent).toFixed(1)}`,
          `${x(point.seenMs).toFixed(1)},${y(point.usedPercent).toFixed(1)}`,
        ])
        .join(' '),
    }),
  );
  const dots = analysis.points.map(point =>
    h(
      'circle',
      {
        class: 'm4-quota-dot',
        fill: '#2b6cb0',
        cx: x(point.atMs).toFixed(1),
        cy: y(point.usedPercent).toFixed(1),
        r: 2.6,
      },
      h(
        'title',
        null,
        `${formatInstant(point.atMs)}: ${remainingOf(point.usedPercent)}% remaining`,
      ),
    ),
  );

  const { projection } = analysis;
  /** @type {any[]} */
  const projected = [];
  if (projection !== undefined) {
    const pts = [[projection.fromMs, projection.fromUsed]];
    if (projection.exhaustsAtMs !== undefined) {
      pts.push([projection.exhaustsAtMs, 100], [projection.toMs, 100]);
    } else pts.push([projection.toMs, projection.toUsed]);
    projected.push(
      h('polyline', {
        class: 'm4-quota-projected',
        fill: 'none',
        stroke: '#b7791f',
        'stroke-dasharray': '5 4',
        points: pts
          .map(([ms, used]) => `${x(ms).toFixed(1)},${y(used).toFixed(1)}`)
          .join(' '),
      }),
    );
  }

  /** @type {any[]} */
  const markers = [];
  if (nowMs >= start && nowMs <= end) {
    markers.push(
      h('line', {
        class: 'm4-quota-now',
        stroke: '#888',
        x1: x(nowMs).toFixed(1),
        x2: x(nowMs).toFixed(1),
        y1: TOP,
        y2: HEIGHT - BOTTOM,
      }),
    );
  }
  if (analysis.weeklyResetMs !== undefined) {
    const at = x(analysis.weeklyResetMs).toFixed(1);
    markers.push(
      h(
        'g',
        { class: 'm4-quota-reset', 'data-reset': 'weekly' },
        h('line', {
          x1: at,
          x2: at,
          y1: TOP,
          y2: HEIGHT - BOTTOM,
          stroke: '#c53030',
        }),
        h(
          'text',
          { x: at, y: TOP - 3, 'text-anchor': 'end', fill: '#c53030' },
          quotaGraphTexts.weeklyReset,
        ),
        h(
          'title',
          null,
          `${quotaGraphTexts.weeklyReset}: ${formatInstant(analysis.weeklyResetMs)}`,
        ),
      ),
    );
  }

  const yTicks = [100, 50, 0].map(remaining =>
    h(
      'g',
      { class: 'm4-quota-tick' },
      h('line', {
        x1: LEFT,
        x2: WIDTH - RIGHT,
        y1: y(100 - remaining),
        y2: y(100 - remaining),
        stroke: '#ccc',
      }),
      h(
        'text',
        {
          x: LEFT - 4,
          y: y(100 - remaining) + 3,
          'text-anchor': 'end',
          fill: '#666',
        },
        `${remaining}%`,
      ),
    ),
  );
  const xTicks = [start, (start + end) / 2, end].map((ms, index) =>
    h(
      'text',
      {
        class: 'm4-quota-time',
        x: x(ms).toFixed(1),
        y: HEIGHT - BOTTOM + 14,
        'text-anchor': ['start', 'middle', 'end'][index],
        fill: '#666',
      },
      formatTick(ms),
    ),
  );

  const summary = [
    `${name} for ${account.label} (${account.provider}), remaining % over time`,
    newest === undefined
      ? quotaGraphTexts.noReadings
      : `${analysis.points.length} readings from ${formatInstant(
          analysis.points[0].atMs,
        )} to ${formatInstant(newest.seenMs)}; newest ${remainingOf(
          newest.usedPercent,
        )}% remaining`,
    status,
    analysis.weeklyResetMs === undefined
      ? ''
      : `${quotaGraphTexts.weeklyReset} at ${formatInstant(analysis.weeklyResetMs)}`,
  ]
    .filter(Boolean)
    .join('. ');

  return h(
    'figure',
    {
      class: 'm4-quota-graph',
      'data-window': series.name,
      'data-window-minutes': series.windowMinutes ?? '',
      'data-status': analysis.status,
    },
    h(
      'figcaption',
      null,
      h('span', { class: 'm4-quota-name' }, name),
      h('span', { class: 'm4-secret-facts' }, quotaGraphTexts.unit),
    ),
    h(
      'svg',
      {
        class: 'm4-quota-svg',
        viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
        role: 'img',
        'aria-label': summary,
        preserveAspectRatio: 'xMidYMid meet',
      },
      h('title', null, summary),
      ...yTicks,
      h('line', {
        class: 'm4-quota-axis',
        stroke: '#666',
        x1: LEFT,
        x2: WIDTH - RIGHT,
        y1: HEIGHT - BOTTOM,
        y2: HEIGHT - BOTTOM,
      }),
      ...xTicks,
      ...markers,
      ...observedLines,
      ...projected,
      ...dots,
    ),
    h(
      'ul',
      { class: 'm4-quota-legend', 'aria-hidden': 'true' },
      h(
        'li',
        { class: 'observed' },
        quotaGraphTexts.observed,
      ),
      projection === undefined
        ? null
        : h('li', { class: 'projected' }, quotaGraphTexts.projected),
      analysis.weeklyResetMs === undefined
        ? null
        : h(
            'li',
            { class: 'reset' },
            `${quotaGraphTexts.weeklyReset} ${formatInstant(analysis.weeklyResetMs)}`,
          ),
    ),
    h('p', { class: 'm4-quota-status', 'data-status': analysis.status }, status),
    h(
      'details',
      { class: 'm4-quota-readings' },
      h('summary', null, `${quotaGraphTexts.readings} (${analysis.points.length})`),
      h(
        'table',
        null,
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', { scope: 'col' }, 'Read at'),
            h('th', { scope: 'col' }, 'Remaining'),
            h('th', { scope: 'col' }, 'Confirmed until'),
            h('th', { scope: 'col' }, 'Reported reset'),
          ),
        ),
        h(
          'tbody',
          null,
          analysis.points.map(point =>
            h(
              'tr',
              null,
              h('td', null, formatInstant(point.atMs)),
              h('td', null, `${remainingOf(point.usedPercent)}%`),
              h(
                'td',
                null,
                point.seenMs > point.atMs ? formatInstant(point.seenMs) : '—',
              ),
              h(
                'td',
                null,
                point.resetsAtMs === undefined
                  ? 'not reported'
                  : formatInstant(point.resetsAtMs),
              ),
            ),
          ),
        ),
      ),
    ),
  );
};

/**
 * The quota history of one pool, asked again when `rev` moves.
 *
 * @param {{ feed: import('./feed.js').AccountsFeed, pool: any, rev: number, nowMs: number }} props
 */
export const PoolQuotaHistory = ({ feed, pool, rev, nowMs }) => {
  const [state, setState] = useState(
    /** @type {{ history?: any, error?: string }} */ ({}),
  );
  useEffect(() => {
    let live = true;
    feed.history(pool.backend).then(
      history => {
        // `undefined`: the adapter no longer knows the pool (no history).
        if (live) setState({ history: history ?? null });
      },
      thrown => {
        if (live) setState(previous => ({ ...previous, error: messageOf(thrown) }));
      },
    );
    return () => {
      live = false;
    };
  }, [feed, pool.backend, rev]);

  /** @type {any} */
  let body;
  if (state.history === undefined && state.error !== undefined) {
    body = h(
      'p',
      { class: 'm4-note', role: 'status' },
      `${quotaGraphTexts.unavailable}: ${state.error}`,
    );
  } else if (state.history === undefined) {
    body = h('p', { class: 'm4-note' }, quotaGraphTexts.loading);
  } else if (state.history === null) {
    body = h('p', { class: 'm4-note m4-quota-empty' }, quotaGraphTexts.noReadings);
  } else {
    body = (state.history.members ?? []).map(
      (/** @type {any} */ member) =>
        h(
          'div',
          {
            class: 'm4-quota-member',
            'data-provider': member.provider,
          },
          h(
            'h4',
            null,
            member.label,
            h('span', { class: 'm4-secret-facts' }, ` ${member.provider}`),
          ),
          member.series.length === 0
            ? h('p', { class: 'm4-note m4-quota-empty' }, quotaGraphTexts.noReadings)
            : member.series.map((/** @type {any} */ series) =>
                h(QuotaGraph, { series, account: member, nowMs }),
              ),
        ),
    );
  }
  return h(
    'section',
    { class: 'm4-quota', 'aria-label': `${quotaGraphTexts.title}: ${pool.label}` },
    h('h4', { class: 'm4-quota-title' }, quotaGraphTexts.title),
    body,
  );
};
