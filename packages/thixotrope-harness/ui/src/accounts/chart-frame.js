// @ts-check
/**
 * The frame shared by the quota and credit graphs (`QuotaGraph.js`,
 * `CreditGraph.js`): one SVG coordinate system, colours, the time scale,
 * hour/day-aligned time ticks and the "now" marker.
 */
import { h } from 'preact';

import { formatInstant, timeTicks } from './quota-projection.js';

/** @param {number} n */
export const fixed = n => n.toFixed(1);

export const WIDTH = 360;
export const HEIGHT = 160;
export const LEFT = 34;
export const RIGHT = 10;
export const TOP = 16;
export const BOTTOM = 32;
export const PLOT_WIDTH = WIDTH - LEFT - RIGHT;

export const COLOURS = harden({
  observed: '#2b6cb0',
  projected: '#b7791f',
  now: '#718096',
  reset: '#c53030',
  grid: '#ccc',
  text: '#555',
});

/**
 * @param {number} start
 * @param {number} end
 * @param {number} height
 */
export const scaleOf = (start, end, height) => ({
  x: (/** @type {number} */ ms) =>
    LEFT + ((ms - start) / (end - start)) * PLOT_WIDTH,
  y: (/** @type {number} */ used) =>
    TOP + (used / 100) * (height - TOP - BOTTOM),
});

/**
 * A marker label beside its line, on the side with room: left of it, unless
 * that would run into the y-axis labels.
 *
 * @param {number} x
 */
export const labelAt = x =>
  x - LEFT < 30
    ? { x: fixed(x + 3), 'text-anchor': 'start' }
    : { x: fixed(x - 3), 'text-anchor': 'end' };

/**
 * The base line and hour/day-aligned time ticks of a plot `WIDTH` wide
 * (shared with the credit chart, `CreditGraph.js`).
 *
 * @param {{ start: number, end: number, height: number, maxTicks: number }} frame
 */
export const timeAxis = ({ start, end, height, maxTicks }) => {
  const { x } = scaleOf(start, end, height);
  const base = height - BOTTOM;
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

/**
 * The "now" marker: grey, dotted, labelled under the plot.
 *
 * @param {number} nowMs
 * @param {{ start: number, end: number, height: number }} frame
 */
export const nowMarker = (nowMs, { start, end, height }) => {
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
      'now',
    ),
    h('title', null, `${'now'}: ${formatInstant(nowMs)}`),
  );
};
