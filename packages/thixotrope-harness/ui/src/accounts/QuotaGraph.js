// @ts-check
/**
 * The quota history of a pool's members as time-series graphs (one per
 * provider window, per member), under each pool of the Subscriptions
 * panel. Data: `Accounts.history(pool, offset?)` (`PoolHistory` pages,
 * observed records only), asked again whenever the accounts view's `rev`
 * moves. What is drawn and projected follows `quota-projection.js`:
 *
 * - observed readings as a solid line per period with a dot per real
 *   reading (a repeated value: its first read and its last confirmation);
 * - the projection, when the evidence supports one, dashed;
 * - "now" as a grey dotted line labelled below the plot, a confirmed
 *   upcoming weekly reset as a solid red line labelled above it;
 * - a visible caption with the latest remaining % and when it was
 *   confirmed, and, when the readings are squeezed (a weekly reset days
 *   away), a zoomed "recent readings" inset of the observed span;
 * - a text equivalent: the accessible label and a table of every record.
 *
 * The view keeps its own clock (`useNow`): an open panel drops a projection
 * that went stale or reached its reset, and a reset marker that passed,
 * without asking the provider. A failed history read keeps the last graph
 * and says so beside it.
 */
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';

/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { subscriptionLimits } from '../../../guest/lib/subscription-limits.js';
/* eslint-enable import/no-relative-packages */
import { windowName } from './labels.js';
import {
  analyseSeries,
  formatInstant,
  latestText,
  projectionText,
  remainingOf,
  timeTicks,
} from './quota-projection.js';

/** The graph's own words (harness texts). */
export const quotaGraphTexts = harden({
  title: 'Quota history',
  loading: 'Reading quota history…',
  unavailable: 'Quota history unavailable',
  stale: 'Quota history could not be refreshed; showing the last one read',
  noReadings:
    'No quota readings recorded yet. History starts with the next provider reading; earlier usage is not reconstructed.',
  unit: 'remaining (%) · UTC',
  observed: 'Observed readings',
  projected: 'Projection',
  weeklyReset: 'Weekly reset',
  reset: 'reset',
  now: 'now',
  readings: 'Readings',
  recent: 'Recent readings (zoomed)',
});

const WIDTH = 360;
const HEIGHT = 160;
const LEFT = 34;
const RIGHT = 10;
const TOP = 16;
const BOTTOM = 32;
const INSET_HEIGHT = 110;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const PLOT_WIDTH = WIDTH - LEFT - RIGHT;
/** The inset is drawn when the observed span is narrower than this. */
const SQUEEZED_PX = PLOT_WIDTH * 0.25;
/** How often an open view advances its clock. */
export const QUOTA_TICK_MS = 30_000;

const COLOURS = harden({
  observed: '#2b6cb0',
  projected: '#b7791f',
  now: '#718096',
  reset: '#c53030',
  grid: '#ccc',
  text: '#555',
});

/**
 * @param {unknown} error
 * @returns {string}
 */
const messageOf = error =>
  error && typeof error === 'object' && 'message' in error
    ? String(/** @type {{ message: unknown }} */ (error).message)
    : String(error);

/** @typedef {import('./quota-projection.js').SeriesAnalysis} SeriesAnalysis */
/** @typedef {import('./quota-projection.js').Point} Point */

/**
 * The time domain of a graph: from the first reading to the latest of now,
 * the projection's end and the weekly reset.
 *
 * @param {SeriesAnalysis} analysis
 * @param {number} nowMs
 */
export const domainOf = (analysis, nowMs) => {
  const first = analysis.points[0];
  const last = analysis.points.at(-1);
  let start = first === undefined ? nowMs - HOUR : first.atMs;
  const end = Math.max(
    nowMs,
    last?.seenMs ?? nowMs,
    analysis.projection?.toMs ?? 0,
    analysis.weeklyResetMs ?? 0,
  );
  if (end - start < HOUR) start = end - HOUR;
  // A little room on both sides so dots and markers are not on the edge.
  const pad = (end - start) * 0.03;
  return { start: start - pad, end: end + pad };
};

/**
 * The domain of the recent-readings inset: the observed span (and now, when
 * it is close), at least an hour.
 *
 * @param {SeriesAnalysis} analysis
 * @param {number} nowMs
 */
export const recentDomainOf = (analysis, nowMs) => {
  const first = analysis.points[0];
  const last = analysis.points.at(-1);
  if (first === undefined || last === undefined) return undefined;
  const span = Math.max(HOUR, last.seenMs - first.atMs);
  let end = last.seenMs;
  if (nowMs > end && nowMs - end <= span / 2) end = nowMs;
  let start = first.atMs;
  if (end - start < HOUR) start = end - HOUR;
  const pad = (end - start) * 0.04;
  return { start: start - pad, end: end + pad };
};

/**
 * @param {number} start
 * @param {number} end
 * @param {number} height
 */
const scaleOf = (start, end, height) => ({
  x: (/** @type {number} */ ms) => LEFT + ((ms - start) / (end - start)) * PLOT_WIDTH,
  y: (/** @type {number} */ used) => TOP + (used / 100) * (height - TOP - BOTTOM),
});

/** @param {number} n */
const fixed = n => n.toFixed(1);

/**
 * A marker label beside its line, on the side with room: left of it, unless
 * that would run into the y-axis labels.
 *
 * @param {number} x
 */
const labelAt = x =>
  x - LEFT < 30
    ? { x: fixed(x + 3), 'text-anchor': 'start' }
    : { x: fixed(x - 3), 'text-anchor': 'end' };

/**
 * Grid, axes and hour/day-aligned time ticks. Every other tick label is
 * `minor` (hidden on narrow screens by the stylesheet).
 *
 * @param {{ start: number, end: number, height: number, maxTicks: number }} frame
 */
const axes = ({ start, end, height, maxTicks }) => {
  const { x, y } = scaleOf(start, end, height);
  const base = height - BOTTOM;
  const yTicks = [100, 50, 0].map(remaining =>
    h(
      'g',
      { class: 'm4-quota-tick' },
      h('line', {
        x1: LEFT,
        x2: WIDTH - RIGHT,
        y1: y(100 - remaining),
        y2: y(100 - remaining),
        stroke: COLOURS.grid,
      }),
      h(
        'text',
        {
          x: LEFT - 4,
          y: y(100 - remaining) + 3.5,
          'text-anchor': 'end',
          fill: COLOURS.text,
        },
        `${remaining}%`,
      ),
    ),
  );
  const ticks = timeTicks(start, end, maxTicks);
  const xTicks = ticks.map((tick, index) =>
    h(
      'g',
      {
        class: `m4-quota-time${index % 2 === 1 ? ' minor' : ''}`,
        'data-ms': tick.ms,
      },
      h('line', {
        x1: fixed(x(tick.ms)),
        x2: fixed(x(tick.ms)),
        y1: base,
        y2: base + 3,
        stroke: COLOURS.text,
      }),
      h(
        'text',
        {
          x: fixed(x(tick.ms)),
          y: base + 13,
          'text-anchor': 'middle',
          fill: COLOURS.text,
        },
        tick.time ?? tick.date,
      ),
      tick.time !== undefined && tick.date !== undefined
        ? h(
            'text',
            {
              x: fixed(x(tick.ms)),
              y: base + 24,
              'text-anchor': 'middle',
              fill: COLOURS.text,
            },
            tick.date,
          )
        : null,
    ),
  );
  return [
    ...yTicks,
    h('line', {
      class: 'm4-quota-axis',
      stroke: COLOURS.text,
      x1: LEFT,
      x2: WIDTH - RIGHT,
      y1: base,
      y2: base,
    }),
    ...xTicks,
  ];
};

/** @param {Point} point */
const recordTitle = point =>
  point.seenMs > point.atMs
    ? `${remainingOf(point.usedPercent)}% remaining: ${point.count} readings from ${formatInstant(point.atMs)} to ${formatInstant(point.seenMs)}`
    : `${remainingOf(point.usedPercent)}% remaining: read ${formatInstant(point.atMs)}`;

/**
 * Observed traces (one polyline per period, the projection's split) and a
 * dot at each real reading time.
 *
 * @param {SeriesAnalysis} analysis
 * @param {ReturnType<typeof scaleOf>} scale
 * @param {number} [start] leave out what ends before this
 */
const observed = (analysis, { x, y }, start = -Infinity) => {
  const lines = analysis.periods.map((period, index) =>
    h('polyline', {
      class: 'm4-quota-observed',
      'data-period': index,
      fill: 'none',
      stroke: COLOURS.observed,
      points: period
        .flatMap(point =>
          point.seenMs > point.atMs
            ? [
                `${fixed(x(point.atMs))},${fixed(y(point.usedPercent))}`,
                `${fixed(x(point.seenMs))},${fixed(y(point.usedPercent))}`,
              ]
            : [`${fixed(x(point.atMs))},${fixed(y(point.usedPercent))}`],
        )
        .join(' '),
    }),
  );
  const dots = analysis.points
    .filter(point => point.seenMs >= start)
    .flatMap(point =>
      (point.seenMs > point.atMs ? [point.atMs, point.seenMs] : [point.atMs]).map(
        ms =>
          h(
            'circle',
            {
              class: 'm4-quota-dot',
              fill: COLOURS.observed,
              cx: fixed(x(ms)),
              cy: fixed(y(point.usedPercent)),
              r: 2.6,
            },
            h('title', null, recordTitle(point)),
          ),
      ),
    );
  return [...lines, ...dots];
};

/**
 * The "now" marker: grey, dotted, labelled under the plot.
 *
 * @param {number} nowMs
 * @param {{ start: number, end: number, height: number }} frame
 */
const nowMarker = (nowMs, { start, end, height }) => {
  if (nowMs < start || nowMs > end) return null;
  const x = scaleOf(start, end, height).x(nowMs);
  const at = fixed(x);
  return h(
    'g',
    { class: 'm4-quota-now', 'data-marker': 'now' },
    h('line', {
      x1: at,
      x2: at,
      y1: TOP,
      y2: height - BOTTOM,
      stroke: COLOURS.now,
      'stroke-dasharray': '1.5 2.5',
    }),
    h(
      'text',
      {
        ...labelAt(x),
        y: height - BOTTOM - 3,
        fill: COLOURS.now,
        class: 'm4-quota-marker-label',
      },
      quotaGraphTexts.now,
    ),
    h('title', null, `${quotaGraphTexts.now}: ${formatInstant(nowMs)}`),
  );
};

/**
 * @param {{ series: any, account: { label: string, provider: string }, nowMs: number }} props
 */
export const QuotaGraph = ({ series, account, nowMs }) => {
  const analysis = analyseSeries(series, nowMs);
  const name = windowName(series);
  const { start, end } = domainOf(analysis, nowMs);
  const scale = scaleOf(start, end, HEIGHT);
  const { x, y } = scale;
  const status = projectionText(analysis, series);
  const latest = latestText(analysis);
  const first = analysis.points[0];
  const newest = analysis.latest;

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
        stroke: COLOURS.projected,
        'stroke-dasharray': '5 4',
        points: pts.map(([ms, used]) => `${fixed(x(ms))},${fixed(y(used))}`).join(' '),
      }),
    );
  }

  /** @type {any[]} */
  const markers = [nowMarker(nowMs, { start, end, height: HEIGHT })];
  if (analysis.weeklyResetMs !== undefined) {
    const resetX = x(analysis.weeklyResetMs);
    const at = fixed(resetX);
    markers.push(
      h(
        'g',
        { class: 'm4-quota-reset', 'data-reset': 'weekly', 'data-marker': 'reset' },
        h('line', {
          x1: at,
          x2: at,
          y1: TOP - 2,
          y2: HEIGHT - BOTTOM,
          stroke: COLOURS.reset,
          'stroke-width': 1.6,
        }),
        h(
          'text',
          {
            ...labelAt(resetX),
            y: TOP - 5,
            fill: COLOURS.reset,
            class: 'm4-quota-marker-label',
          },
          quotaGraphTexts.reset,
        ),
        h(
          'title',
          null,
          `${quotaGraphTexts.weeklyReset}: ${formatInstant(analysis.weeklyResetMs)}`,
        ),
      ),
    );
  }

  // Readings squeezed together (a reset days away): a zoomed inset.
  const squeezed =
    first !== undefined &&
    newest !== undefined &&
    newest.seenMs > first.atMs &&
    x(newest.seenMs) - x(first.atMs) < SQUEEZED_PX;
  const recent = squeezed ? recentDomainOf(analysis, nowMs) : undefined;
  const inset =
    recent === undefined
      ? null
      : h(
          'div',
          { class: 'm4-quota-inset', 'data-view': 'recent' },
          h(
            'p',
            { class: 'm4-quota-inset-title' },
            `${quotaGraphTexts.recent}: ${formatInstant(recent.start)} – ${formatInstant(recent.end)}`,
          ),
          h(
            'svg',
            {
              class: 'm4-quota-svg',
              viewBox: `0 0 ${WIDTH} ${INSET_HEIGHT}`,
              role: 'img',
              'aria-label': `${quotaGraphTexts.recent}, ${name}. ${latest}`,
              preserveAspectRatio: 'xMidYMid meet',
            },
            ...axes({ ...recent, height: INSET_HEIGHT, maxTicks: 6 }),
            nowMarker(nowMs, { ...recent, height: INSET_HEIGHT }),
            ...observed(
              analysis,
              scaleOf(recent.start, recent.end, INSET_HEIGHT),
              recent.start,
            ),
          ),
        );

  const summary = [
    `${name} for ${account.label} (${account.provider}), remaining % over time`,
    newest === undefined || first === undefined
      ? quotaGraphTexts.noReadings
      : `${analysis.readings} readings from ${formatInstant(first.atMs)} to ${formatInstant(newest.seenMs)}`,
    latest,
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
      h(
        'span',
        { class: 'm4-quota-name' },
        `${name === 'weekly' ? 'Weekly quota' : name} ${quotaGraphTexts.unit}`,
      ),
      latest === ''
        ? null
        : h('span', { class: 'm4-quota-latest', 'data-latest-ms': newest?.seenMs }, latest),
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
      ...axes({ start, end, height: HEIGHT, maxTicks: 6 }),
      ...markers,
      ...observed(analysis, scale),
      ...projected,
    ),
    h(
      'ul',
      { class: 'm4-quota-legend', 'aria-hidden': 'true' },
      h('li', { class: 'observed' }, quotaGraphTexts.observed),
      projection === undefined
        ? null
        : h('li', { class: 'projected' }, quotaGraphTexts.projected),
      h('li', { class: 'now' }, quotaGraphTexts.now),
      analysis.weeklyResetMs === undefined
        ? null
        : h(
            'li',
            { class: 'reset' },
            `${quotaGraphTexts.weeklyReset} ${formatInstant(analysis.weeklyResetMs)}`,
          ),
    ),
    inset,
    h('p', { class: 'm4-quota-status', 'data-status': analysis.status }, status),
    h(
      'details',
      { class: 'm4-quota-readings' },
      h(
        'summary',
        {
          'aria-label': `${quotaGraphTexts.readings} (${analysis.readings}) for ${account.label}, ${name}`,
        },
        `${quotaGraphTexts.readings} (${analysis.readings})`,
      ),
      h(
        'table',
        null,
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', { scope: 'col' }, 'First read'),
            h('th', { scope: 'col' }, 'Last confirmed'),
            h('th', { scope: 'col' }, 'Readings'),
            h('th', { scope: 'col' }, 'Remaining'),
            h('th', { scope: 'col' }, 'Reported reset'),
          ),
        ),
        h(
          'tbody',
          null,
          // Newest first: the latest figure leads.
          [...analysis.points].reverse().map(point =>
            h(
              'tr',
              null,
              h('td', null, formatInstant(point.atMs)),
              h(
                'td',
                null,
                point.seenMs > point.atMs ? formatInstant(point.seenMs) : '—',
              ),
              h('td', null, String(point.count)),
              h('td', null, `${remainingOf(point.usedPercent)}%`),
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
 * The browser's clock, advanced every `tickMs` while mounted and `running`
 * (no provider call: only the projection rules are re-applied). Nothing
 * runs while there is no graph to keep current.
 *
 * @param {() => number} now
 * @param {number} tickMs
 * @param {boolean} running
 */
export const useNow = (now, tickMs, running) => {
  const [nowMs, setNowMs] = useState(now);
  useEffect(() => {
    if (!running) return undefined;
    setNowMs(now());
    const timer = globalThis.setInterval(() => setNowMs(now()), tickMs);
    return () => globalThis.clearInterval(timer);
  }, [now, tickMs, running]);
  return nowMs;
};

const MAX_PAGES = Math.ceil(
  subscriptionLimits.maxPoolMembers / subscriptionLimits.historyPageMembers,
);

/**
 * Every page of a pool's history, joined; `null` when the adapter no longer
 * knows the pool.
 *
 * @param {import('./feed.js').AccountsFeed} feed
 * @param {any} backend
 */
const readHistory = async (feed, backend) => {
  const first = await feed.history(backend);
  if (first === undefined || first === null) return null;
  const members = [...(first.members ?? [])];
  let offset = Number(first.next);
  for (let page = 1; page < MAX_PAGES && Number.isSafeInteger(offset) && offset > 0; page += 1) {
    // eslint-disable-next-line no-await-in-loop -- each page names the next
    const more = await feed.history(backend, offset);
    if (more === undefined || more === null) break;
    members.push(...(more.members ?? []));
    const next = Number(more.next);
    offset = next > offset ? next : NaN;
  }
  return harden({ ...first, members });
};

/**
 * The quota history of one pool, asked again when `rev` moves.
 *
 * @param {{ feed: import('./feed.js').AccountsFeed, pool: any, rev: number, now?: () => number, tickMs?: number }} props
 */
export const PoolQuotaHistory = ({
  feed,
  pool,
  rev,
  now = Date.now,
  tickMs = QUOTA_TICK_MS,
}) => {
  const [state, setState] = useState(
    /** @type {{ history?: any, error?: string }} */ ({}),
  );
  const graphs = (state.history?.members ?? []).some(
    (/** @type {{ windows?: unknown }} */ member) =>
      Array.isArray(member.windows) && member.windows.length !== 0,
  );
  const nowMs = useNow(now, tickMs, graphs);
  useEffect(() => {
    let live = true;
    readHistory(feed, pool.backend).then(
      history => {
        if (live) setState({ history });
      },
      thrown => {
        // The last graph stays; the failure is said beside it.
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
    body = null;
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
          member.windows.length === 0
            ? h('p', { class: 'm4-note m4-quota-empty' }, quotaGraphTexts.noReadings)
            : member.windows.map((/** @type {any} */ series) =>
                h(QuotaGraph, { series, account: member, nowMs }),
              ),
        ),
    );
  }
  const failure =
    state.error === undefined
      ? null
      : h(
          'p',
          { class: 'm4-note m4-quota-error', role: 'status' },
          state.history === undefined
            ? `${quotaGraphTexts.unavailable}: ${state.error}`
            : `${quotaGraphTexts.stale}: ${state.error}`,
        );
  return h(
    'section',
    {
      class: 'm4-quota',
      'aria-label': `${quotaGraphTexts.title}: ${pool.label}`,
      'data-kind': pool.kind,
    },
    h('h4', { class: 'm4-quota-title' }, quotaGraphTexts.title),
    failure,
    body,
  );
};
