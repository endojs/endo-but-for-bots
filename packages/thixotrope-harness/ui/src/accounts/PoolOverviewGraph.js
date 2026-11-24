// @ts-check
import { h } from 'preact';
import { useState } from 'preact/hooks';
import {
  WIDTH,
  HEIGHT,
  LEFT,
  RIGHT,
  TOP,
  BOTTOM,
  COLOURS,
  scaleOf,
  timeAxis,
  nowMarker,
} from './chart-frame.js';
import { formatCreditsShort } from './credit-projection.js';
import { formatInstant } from './quota-projection.js';
import { poolOverview, poolValue } from './pool-overview.js';

/** @typedef {ReturnType<typeof poolOverview>[number]} Summary */

/** @param {number} count @param {number} total */
const coverage = (count, total) =>
  `${count} of ${total} ${total === 1 ? 'account' : 'accounts'}`;

/** @param {{metric:Summary, nowMs:number}} props */
const PoolChart = ({ metric, nowMs }) => {
  const [zoom, setZoom] = useState(false);
  const points = metric.runs.flat();
  if (!points.length) return h('p', null, 'No confirmed readings yet.');
  const projected = zoom ? [] : metric.projection;
  const resets = zoom ? [] : metric.resets;
  const start = points[0].at;
  const last = points[points.length - 1].at;
  const extent = zoom
    ? last
    : Math.max(
        last,
        nowMs,
        ...projected.map(p => p.at),
        ...resets.map(r => r.at),
      );
  const pad = Math.max(60_000, (extent - start) * 0.035);
  const frame = {
    start: start - pad,
    end: extent + pad,
    height: HEIGHT,
    maxTicks: 4,
  };
  const { x } = scaleOf(frame.start, frame.end, HEIGHT);
  const values = [...points, ...projected].map(p => p.value);
  const low = metric.wallet ? Math.min(0, ...values) : 0;
  const high = metric.wallet ? Math.max(low === 0 ? 1 : 0, ...values) : 100;
  /** @param {number} value */
  const y = value =>
    TOP + ((high - value) / (high - low)) * (HEIGHT - BOTTOM - TOP);
  /** @param {{at:number,value:number}[]} rows */
  const coords = rows =>
    rows.map(p => `${x(p.at).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const chartLabel = metric.wallet
    ? 'Sum of reported credit balances'
    : 'Mean remaining quota per account';
  const latest = metric.latest;
  const lastPoint = points[points.length - 1];
  const count = latest?.contributors ?? 0;
  return h(
    'figure',
    { class: 'm4-pool-graph' },
    h(
      'figcaption',
      null,
      h(
        'strong',
        { 'data-pool-value': true },
        latest
          ? poolValue(metric.wallet, latest.value, latest.exact)
          : 'No fresh reading',
      ),
      ` · ${coverage(count, metric.total)}`,
      h(
        'p',
        { class: 'm4-note' },
        metric.wallet
          ? count === metric.total
            ? 'Sum of reported member balances.'
            : 'Subtotal of members with fresh numeric balances.'
          : 'Unweighted mean of the latest confirmed remaining percentages.',
      ),
    ),
    h(
      'svg',
      {
        class: 'm4-quota-svg',
        viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
        role: 'img',
        'aria-label': `${chartLabel} over time`,
      },
      [low, (low + high) / 2, high].map(v =>
        h(
          'g',
          { key: v, class: 'm4-quota-tick' },
          h('line', {
            x1: LEFT,
            x2: WIDTH - RIGHT,
            y1: y(v),
            y2: y(v),
            stroke: COLOURS.grid,
          }),
          h(
            'text',
            { x: LEFT - 3, y: y(v) + 3, 'text-anchor': 'end' },
            metric.wallet ? formatCreditsShort(v) : `${v}%`,
          ),
        ),
      ),
      ...timeAxis(frame),
      nowMarker(nowMs, frame),
      ...resets.map(r =>
        h(
          'line',
          {
            key: r.name,
            x1: x(r.at),
            x2: x(r.at),
            y1: TOP,
            y2: HEIGHT - BOTTOM,
            stroke: COLOURS.reset,
            'stroke-dasharray': '2 3',
            'data-pool-reset': r.name,
          },
          h('title', null, `${r.name} · ${formatInstant(r.at)}`),
        ),
      ),
      ...metric.runs.map((run, i) =>
        h('polyline', {
          key: `r${i}`,
          class: 'm4-quota-observed',
          fill: 'none',
          stroke: COLOURS.observed,
          'stroke-width': 2,
          points: coords(run),
        }),
      ),
      ...points.map(p =>
        h(
          'circle',
          {
            key: p.at,
            class: 'm4-quota-dot',
            cx: x(p.at),
            cy: y(p.value),
            r: 2.4,
            fill: COLOURS.observed,
          },
          h(
            'title',
            null,
            `${formatInstant(p.at)} · ${poolValue(
              metric.wallet,
              p.value,
              p.exact,
            )} · ${coverage(p.contributors, metric.total)}`,
          ),
        ),
      ),
      projected.length
        ? h('polyline', {
            class: 'm4-quota-projected',
            fill: 'none',
            stroke: COLOURS.projected,
            'stroke-width': 2,
            'stroke-dasharray': '5 3',
            points: coords(projected),
            'data-pool-projection': true,
          })
        : null,
    ),
    h(
      'div',
      { class: 'm4-note' },
      h(
        'span',
        null,
        latest?.segment === lastPoint.segment
          ? `Latest reading · ${formatInstant(last)}`
          : `Last recorded: ${poolValue(metric.wallet, lastPoint.value, lastPoint.exact)} across ${coverage(lastPoint.contributors, metric.total)} · ${formatInstant(last)}`,
      ),
      ' ',
      extent > last || zoom
        ? h(
            'button',
            {
              type: 'button',
              'aria-pressed': zoom,
              onClick: () => setZoom(!zoom),
            },
            zoom ? 'Show full timeline' : 'Focus on readings',
          )
        : null,
    ),
    projected.length
      ? h(
          'p',
          { class: 'm4-note' },
          `Projected ${poolValue(
            metric.wallet,
            projected.at(-1)?.value ?? 0,
          )} at ${formatInstant(projected.at(-1)?.at ?? nowMs)} (dashed).`,
        )
      : !zoom
        ? h(
            'p',
            { class: 'm4-note' },
            'No pool forecast from the current readings.',
          )
        : null,
    metric.resets.length
      ? h(
          'ul',
          { 'aria-label': 'Upcoming weekly resets' },
          metric.resets.map(r =>
            h(
              'li',
              { key: r.name },
              `${r.name} · weekly quota reset ${formatInstant(r.at)}`,
            ),
          ),
        )
      : null,
  );
};

/** @param {{pool:any, history:any, nowMs:number}} props */
export const PoolOverviewGraph = ({ pool, history, nowMs }) => {
  const metrics = poolOverview(pool, history, nowMs);
  const [selection, setSelection] = useState('');
  const chosen = metrics.find(m => m.id === selection) ?? metrics[0];
  if (!chosen)
    return h('p', { class: 'm4-note' }, 'No confirmed pool history yet.');
  return h(
    'section',
    { 'aria-label': 'Combined pool history', class: 'm4-pool-overview' },
    metrics.length > 1
      ? h(
          'label',
          null,
          'Measure ',
          h(
            'select',
            {
              value: chosen.id,
              onChange: (/** @type {any} */ e) =>
                setSelection(e.currentTarget.value),
            },
            metrics.map(m => h('option', { key: m.id, value: m.id }, m.title)),
          ),
        )
      : h('h4', null, chosen.title),
    h(PoolChart, { key: chosen.id, metric: chosen, nowMs }),
  );
};
