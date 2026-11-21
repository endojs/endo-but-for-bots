// @ts-check
/**
 * A member's credit balance over time (`MemberHistory.credits`), beside
 * its quota graphs, in the same layout and on the same clock
 * (`QuotaGraph.js`). Drawn only when the account's current reading reports
 * a numeric balance (`creditNumber`); absent or non-numeric balances (and
 * so Claude accounts) get no plot. Credits are their own unit: the y axis
 * is the balance, never a percent, and no quota reset is marked (a weekly
 * reset does not refill a wallet). A top-up starts a new trace; the
 * forecast (`credit-projection.js`) is bounded, dashed and labelled.
 */
import { h } from 'preact';

import {
  BOTTOM,
  COLOURS,
  HEIGHT,
  LEFT,
  RIGHT,
  TOP,
  WIDTH,
  fixed,
  labelAt,
  nowMarker,
  scaleOf,
  timeAxis,
} from './chart-frame.js';
import {
  analyseCredits,
  creditForecastText,
  creditLatestText,
  creditNumber,
  formatCredits,
  formatCreditsShort,
} from './credit-projection.js';
import { formatInstant } from './quota-projection.js';

export const creditGraphTexts = harden({
  name: 'Credit balance',
  unit: 'Credits (wallet balance, as reported; separate from quota %); times UTC',
  observed: 'Observed balance',
  forecast: 'Spending forecast (bounded)',
  topUp: 'top-up',
  readings: 'Balance readings',
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * A round axis top at or above `max` (1, 2 or 5 times a power of ten).
 *
 * @param {number} max
 */
export const creditAxisTop = max => {
  if (!(max > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  const step = [1, 2, 2.5, 5, 10].find(m => m * power >= max) ?? 10;
  return step * power;
};

/**
 * Whether a member's current account reports a numeric balance.
 *
 * @param {{ credits?: unknown } | undefined} account
 */
export const reportsNumericCredits = account =>
  creditNumber(account?.credits) !== undefined;

/**
 * @param {{ records: readonly any[], account: { label: string, provider: string }, nowMs: number }} props
 */
export const CreditGraph = ({ records, account, nowMs }) => {
  const analysis = analyseCredits(records, nowMs);
  const { points, latest, forecast } = analysis;
  const first = points[0];
  if (first === undefined || latest === undefined) return null;
  let start = first.atMs;
  const end = Math.max(nowMs, latest.seenMs, forecast?.toMs ?? 0);
  if (end - start < HOUR) start = end - HOUR;
  const pad = (end - start) * 0.03;
  const frame = { start: start - pad, end: end + pad };
  const { x } = scaleOf(frame.start, frame.end, HEIGHT);
  const high = Math.max(...points.map(p => p.value), 0);
  const low = Math.min(...points.map(p => p.value), 0);
  const bottom = low < 0 ? -creditAxisTop(-low) : 0;
  const top = high === 0 && bottom < 0 ? 0 : creditAxisTop(high);
  /** @param {number} value */
  const y = value =>
    TOP + ((top - value) / (top - bottom)) * (HEIGHT - TOP - BOTTOM);

  const grid = [top, (top + bottom) / 2, bottom].map(value =>
    h(
      'g',
      { class: 'm4-quota-tick m4-credit-tick' },
      h('line', {
        x1: LEFT,
        x2: WIDTH - RIGHT,
        y1: fixed(y(value)),
        y2: fixed(y(value)),
        stroke: COLOURS.grid,
      }),
      h(
        'text',
        {
          x: LEFT - 4,
          y: fixed(y(value) + 3.5),
          'text-anchor': 'end',
          fill: COLOURS.text,
        },
        formatCreditsShort(value),
      ),
    ),
  );
  const traces = analysis.runs.map((run, index) =>
    h('polyline', {
      class: 'm4-quota-observed m4-credit-observed',
      'data-run': index,
      fill: 'none',
      stroke: COLOURS.observed,
      points: run
        .flatMap(p =>
          (p.seenMs > p.atMs ? [p.atMs, p.seenMs] : [p.atMs]).map(
            ms => `${fixed(x(ms))},${fixed(y(p.value))}`,
          ),
        )
        .join(' '),
    }),
  );
  const dots = points.flatMap(p =>
    (p.seenMs > p.atMs ? [p.atMs, p.seenMs] : [p.atMs]).map(ms =>
      h(
        'circle',
        {
          class: 'm4-quota-dot',
          fill: COLOURS.observed,
          cx: fixed(x(ms)),
          cy: fixed(y(p.value)),
          r: 2.6,
        },
        h(
          'title',
          null,
          `${formatCredits(p.reported)} credits, read ${formatInstant(ms)}`,
        ),
      ),
    ),
  );
  const topUp =
    analysis.topUpMs === undefined
      ? null
      : h(
          'g',
          { class: 'm4-credit-topup', 'data-marker': 'top-up' },
          h(
            'text',
            {
              ...labelAt(x(analysis.topUpMs)),
              y: TOP - 5,
              fill: COLOURS.observed,
              class: 'm4-quota-marker-label',
            },
            creditGraphTexts.topUp,
          ),
        );
  const projected =
    forecast === undefined
      ? null
      : h('polyline', {
          class: 'm4-quota-projected m4-credit-forecast',
          fill: 'none',
          stroke: COLOURS.projected,
          'stroke-dasharray': '5 4',
          points: [
            [forecast.fromMs, forecast.fromValue],
            [forecast.toMs, forecast.toValue],
          ]
            .map(([ms, value]) => `${fixed(x(ms))},${fixed(y(value))}`)
            .join(' '),
        });
  const latestText = creditLatestText(analysis);
  const status = creditForecastText(analysis);
  const summary = [
    `${creditGraphTexts.name} for ${account.label} (${account.provider}), credits over time`,
    `${analysis.readings} readings from ${formatInstant(first.atMs)} to ${formatInstant(latest.seenMs)}`,
    latestText,
    status,
  ].join('. ');

  return h(
    'figure',
    {
      class: 'm4-quota-graph m4-credit-graph',
      'data-window': 'credits',
      'data-status': analysis.status,
    },
    h(
      'figcaption',
      null,
      h(
        'span',
        { class: 'm4-quota-name' },
        `${creditGraphTexts.name} \u00b7 ${account.label}`,
      ),
      h('span', { class: 'm4-quota-latest' }, latestText),
      h('span', { class: 'm4-secret-facts' }, creditGraphTexts.unit),
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
      ...grid,
      ...timeAxis({ ...frame, height: HEIGHT, maxTicks: 6 }),
      nowMarker(nowMs, { ...frame, height: HEIGHT }),
      topUp,
      ...traces,
      ...dots,
      projected,
    ),
    h(
      'ul',
      { class: 'm4-quota-legend', 'aria-hidden': 'true' },
      h('li', { class: 'observed' }, creditGraphTexts.observed),
      forecast === undefined
        ? null
        : h('li', { class: 'projected' }, creditGraphTexts.forecast),
      h('li', { class: 'now' }, 'now'),
    ),
    h(
      'p',
      { class: 'm4-quota-status', 'data-status': analysis.status },
      status,
    ),
    h(
      'details',
      { class: 'm4-quota-readings' },
      h(
        'summary',
        null,
        `${creditGraphTexts.readings} (${analysis.readings}) \u00b7 ${latestText}`,
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
            h('th', { scope: 'col' }, 'Balance (credits)'),
          ),
        ),
        h(
          'tbody',
          null,
          [...points]
            .reverse()
            .map(p =>
              h(
                'tr',
                null,
                h('td', null, formatInstant(p.atMs)),
                h(
                  'td',
                  null,
                  p.seenMs > p.atMs ? formatInstant(p.seenMs) : '\u2014',
                ),
                h('td', null, String(p.count)),
                h('td', null, formatCredits(p.reported)),
              ),
            ),
        ),
      ),
    ),
  );
};
