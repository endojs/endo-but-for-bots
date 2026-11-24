// @ts-check
// Quota history graph (ui/src/accounts/quota-projection.js, QuotaGraph.js):
// period and projection rules from real distinct readings (insufficient,
// stale, no reset, reset passed, exhausted, reset boundaries), weekly reset
// markers only for a confirmed upcoming 7-day reset, and the rendered
// Subscriptions panel in happy-dom for a Claude and a Codex pool: time
// axis, observed and projected series, accessible label, empty states.
// Review regressions: an equal pair compacted to one record is a flat
// forecast with a truthful count; traces split where the slope does; the
// open view's own clock drops stale/reached projections and passed markers
// with no further read; a failed read keeps the cached graph; caption,
// aligned ticks, inset and readings view; weekly windows in either slot;
// pages followed.
import test from '@endo/ses-ava/prepare-endo.js';

import { Far } from '@endo/far';
import { h, render } from 'preact';

import { makeController } from '../../ui/src/controller/index.js';
import { mount } from '../../ui/src/shell/index.js';
import { feature as accountFeatures } from '../../ui/src/accounts/feature.js';
import {
  analyseSeries,
  currentPeriod,
  formatInstant,
  latestText,
  pointsOf,
  projectionText,
  staleMs,
  timeTicks,
} from '../../ui/src/accounts/quota-projection.js';
import { PoolQuotaHistory } from '../../ui/src/accounts/PoolQuotaHistory.js';
import { QuotaGraph } from '../../ui/src/accounts/QuotaGraph.js';
import { makeFakePowers, makeTestDom } from './_m3-fake-powers.js';
import {
  makeFakeAccounts,
  makeFakeSecrets,
  memberAccount,
  runEffectsPromptly,
} from './_m4-ui-fakes.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();

/**
 * A `QuotaSeries` as the adapter answers it.
 *
 * @param {number} windowMinutes
 * @param {Array<[number, number, number?, number?, number?]>} rows [from, used, resetsAt, to, count]
 * @param {string} [name]
 */
const seriesOf = (windowMinutes, rows, name = 'primary') => ({
  name,
  windowMinutes,
  records: rows.map(([from, used, reset, to, count]) => ({
    from: iso(from),
    usedPercent: used,
    ...(reset === undefined ? {} : { resetsAt: iso(reset) }),
    ...(to === undefined ? {} : { to: iso(to), count: count ?? 2 }),
  })),
});

test('projection: linear from distinct readings of this period, ends at the reported reset', t => {
  const reset = NOW + 2 * HOUR;
  const a = analyseSeries(
    seriesOf(300, [
      [NOW - 60 * MIN, 20, reset],
      [NOW - 30 * MIN, 30, reset, NOW - 10 * MIN],
    ]),
    NOW,
  );
  t.is(a.status, 'projected');
  const p = /** @type {any} */ (a.projection);
  // 10 points over 50 minutes (first reading to latest confirmation).
  t.is(p.fromMs, NOW - 10 * MIN);
  t.is(p.toMs, reset);
  t.true(Math.abs(p.usedPerHour - 12) < 1e-9);
  t.true(Math.abs(p.toUsed - (30 + 12 * (130 / 60))) < 1e-9);
  t.is(p.exhaustsAtMs, undefined);
  t.regex(projectionText(a, { name: 'primary', windowMinutes: 300 }), /remaining at the reset/);
  t.is(a.weeklyResetMs, undefined, 'a 5h window has no weekly marker');

  // Fast use: used up before the reset, clamped at 100.
  const fast = analyseSeries(
    seriesOf(300, [
      [NOW - 30 * MIN, 40, reset],
      [NOW - 5 * MIN, 80, reset],
    ]),
    NOW,
  );
  const q = /** @type {{ toUsed: number, exhaustsAtMs: number }} */ (
    fast.projection
  );
  t.is(q.toUsed, 100);
  t.true(q.exhaustsAtMs > NOW && q.exhaustsAtMs < reset);
  t.regex(projectionText(fast, { name: 'primary' }), /used up around/);
});

test('projection withheld: empty, one reading, too short, stale, no reset, reset passed, exhausted', t => {
  const reset = NOW + HOUR;
  /** @param {any} s */
  const status = s => analyseSeries(s, NOW).status;
  t.is(status(seriesOf(300, [])), 'empty');
  t.is(status(seriesOf(300, [[NOW - 20 * MIN, 10, reset]])), 'insufficient');
  // One record confirmed later is two real readings: a flat forecast.
  t.is(
    status(seriesOf(300, [[NOW - 50 * MIN, 10, reset, NOW - MIN]])),
    'projected',
  );
  t.is(
    status(
      seriesOf(300, [
        [NOW - 3 * MIN, 10, reset],
        [NOW - MIN, 11, reset],
      ]),
    ),
    'insufficient',
    'spanning under 10 minutes',
  );
  const old = NOW - staleMs(300) - MIN;
  t.is(
    status(
      seriesOf(300, [
        [old - HOUR, 10, NOW + HOUR],
        [old, 20, NOW + HOUR],
      ]),
    ),
    'stale',
  );
  t.is(
    status(
      seriesOf(300, [
        [NOW - HOUR, 10],
        [NOW - 10 * MIN, 20],
      ]),
    ),
    'no-reset',
  );
  t.is(
    status(
      seriesOf(300, [
        [NOW - 3 * HOUR, 10, NOW - HOUR],
        [NOW - 2 * HOUR, 20, NOW - HOUR],
      ]),
    ),
    'reset-passed',
  );
  t.is(
    status(
      seriesOf(300, [
        [NOW - HOUR, 90, reset],
        [NOW - 10 * MIN, 100, reset],
      ]),
    ),
    'exhausted',
  );
  t.is(staleMs(300), 75 * MIN);
  t.is(staleMs(10_080), 6 * HOUR);
  t.is(staleMs(60), 30 * MIN);
});

test('reset boundaries: a new reported reset or a fall in usage starts a new period', t => {
  const oldReset = NOW - 2 * HOUR;
  const newReset = NOW + 3 * HOUR;
  const points = pointsOf(
    seriesOf(300, [
      [NOW - 5 * HOUR, 30, oldReset],
      [NOW - 3 * HOUR, 60, oldReset],
      [NOW - 40 * MIN, 5, newReset],
      [NOW - 10 * MIN, 15, newReset],
    ]),
  );
  t.deepEqual(
    currentPeriod(points).map(p => p.usedPercent),
    [5, 15],
  );
  const a = analyseSeries(
    seriesOf(300, [
      [NOW - 5 * HOUR, 30, oldReset],
      [NOW - 3 * HOUR, 60, oldReset],
      [NOW - 40 * MIN, 5, newReset],
      [NOW - 10 * MIN, 15, newReset],
    ]),
    NOW,
  );
  t.is(a.status, 'projected');
  // Rate from this period only: 10 points in 30 minutes.
  t.true(Math.abs(/** @type {any} */ (a.projection).usedPerHour - 20) < 1e-9);
  // A fall without a reported reset is also a boundary.
  t.deepEqual(
    currentPeriod(
      pointsOf(
        seriesOf(300, [
          [NOW - 3 * HOUR, 70],
          [NOW - 2 * HOUR, 10],
          [NOW - HOUR, 20],
        ]),
      ),
    ).map(p => p.usedPercent),
    [10, 20],
  );
  // A single reading after a reset: insufficient (the earlier period is not used).
  t.is(
    analyseSeries(
      seriesOf(300, [
        [NOW - 3 * HOUR, 30, oldReset],
        [NOW - 2.5 * HOUR, 60, oldReset],
        [NOW - 10 * MIN, 5, newReset],
      ]),
      NOW,
    ).status,
    'insufficient',
  );
});

test('weekly reset marker: only a 7-day window with a reported reset still ahead', t => {
  const ahead = NOW + 2 * DAY;
  const week = analyseSeries(
    seriesOf(10_080, [[NOW - HOUR, 40, ahead]], 'secondary'),
    NOW,
  );
  t.is(week.weeklyResetMs, ahead);
  t.is(
    analyseSeries(seriesOf(10_080, [[NOW - HOUR, 40, NOW - MIN]]), NOW)
      .weeklyResetMs,
    undefined,
    'a passed reset is not upcoming',
  );
  t.is(
    analyseSeries(seriesOf(10_080, [[NOW - HOUR, 40]]), NOW).weeklyResetMs,
    undefined,
    'no reported reset, no marker (not extrapolated)',
  );
  t.is(
    analyseSeries(seriesOf(300, [[NOW - HOUR, 40, NOW + HOUR]]), NOW)
      .weeklyResetMs,
    undefined,
    'not a weekly window',
  );
  // Only the newest reading's reset counts.
  t.is(
    analyseSeries(
      seriesOf(10_080, [
        [NOW - 2 * HOUR, 40, ahead],
        [NOW - HOUR, 41],
      ]),
      NOW,
    ).weeklyResetMs,
    undefined,
  );
  t.is(formatInstant(Date.parse('2026-11-18T02:05:00Z')), 'Nov 18 02:05 UTC');
});

const flush = async (rounds = 20) => {
  await null;
  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setImmediate(resolve));
  }
};

/**
 * @param {import('ava').ExecutionContext} t
 * @param {Map<any, any>} histories
 * @param {any[]} pools
 */
const mountPanel = async (t, histories, pools) => {
  runEffectsPromptly();
  const dom = makeTestDom();
  const accounts = makeFakeAccounts({ pools, histories });
  const secrets = makeFakeSecrets({ accounts: accounts.accounts });
  const features = [...accountFeatures];
  const { powers } = makeFakePowers({
    sessions: [{ key: 's-pool' }],
    operatorMethods: { getSecrets: () => secrets.getSecrets() },
  });
  const controller = makeController({
    storage: undefined,
    locks: { request: (_name, callback) => callback() },
    features,
  });
  const shell = mount({
    root: dom.root,
    controller,
    features,
    window: dom.window,
    schedule: fn => fn(),
  });
  t.teardown(async () => {
    shell.unmount();
    await dom.close();
  });
  await controller.attach(powers);
  await flush();
  controller.openPanel('accounts');
  await flush();
  return {
    accounts,
    $: (/** @type {string} */ sel) => dom.document.querySelector(sel),
    $$: (/** @type {string} */ sel) => [
      ...dom.document.querySelectorAll(sel),
    ],
  };
};

test.serial('panel: Claude and Codex graphs with time axis, observed, projected, weekly reset, labels', async t => {
  const now = Date.now();
  const claudePool = Far('Backend', {});
  const codexPool = Far('Backend', {});
  const weekReset = now + 2 * DAY;
  const fiveReset = now + 2 * HOUR;
  const histories = new Map([
    [
      claudePool,
      harden({
        backend: claudePool,
        kind: 'claude-pool',
        label: 'claude',
        members: [
          {
            label: 'claude-max',
            provider: 'claude',
            windows: [
              seriesOf(300, [
                [now - 60 * MIN, 10, fiveReset],
                [now - 20 * MIN, 30, fiveReset, now - 5 * MIN],
              ]),
              seriesOf(
                10_080,
                [
                  [now - 3 * HOUR, 40, weekReset],
                  [now - 30 * MIN, 44, weekReset],
                ],
                'secondary',
              ),
            ],
          },
        ],
      }),
    ],
    [
      codexPool,
      harden({
        backend: codexPool,
        kind: 'codex-pool',
        label: 'codex',
        members: [
          {
            label: 'codex-pro',
            provider: 'codex',
            windows: [
              seriesOf(10_080, [[now - HOUR, 55, weekReset]], 'secondary'),
            ],
          },
          { label: 'codex-spare', provider: 'codex', windows: [] },
        ],
      }),
    ],
  ]);
  const pools = [
    harden({
      backend: claudePool,
      kind: 'claude-pool',
      label: 'claude',
      selection: 'auto',
      members: [memberAccount({ label: 'claude-max' })],
    }),
    harden({
      backend: codexPool,
      kind: 'codex-pool',
      label: 'codex',
      selection: 'auto',
      members: [
        memberAccount({ label: 'codex-pro', provider: 'codex', credits: '17' }),
        memberAccount({ label: 'codex-spare', provider: 'codex' }),
      ],
    }),
  ];
  const s = await mountPanel(t, histories, pools);
  t.is(s.accounts.callsOf('Accounts.history').length, 2);
  const disclosures = s.$$('details.m4-individual-subscriptions');
  t.is(disclosures.length, 2);
  t.true(disclosures.every(details => !details.open));
  t.is(s.$('.m4-quota-member svg'), null, 'individual charts mount on expansion');
  for (const details of disclosures) openSubscriptions(details);
  await flush();
  const graphs = s.$$('.m4-quota-member .m4-quota-graph');
  t.is(graphs.length, 3);
  const [five, week, codexWeek] = graphs;

  // Claude 5h: observed line, dots, projection dashed, no weekly marker.
  t.is(five.getAttribute('data-window-minutes'), '300');
  t.is(five.getAttribute('data-status'), 'projected');
  t.truthy(five.querySelector('polyline.m4-quota-observed'));
  // Three real reading times: one, then a value read and confirmed again.
  t.is(five.querySelectorAll('circle.m4-quota-dot').length, 3);
  const dashed = five.querySelector('polyline.m4-quota-projected');
  t.is(dashed?.getAttribute('stroke-dasharray'), '5 4');
  t.is(five.querySelector('[data-reset="weekly"]'), null);
  const svg = five.querySelector('svg');
  t.is(svg?.getAttribute('role'), 'img');
  t.regex(
    String(svg?.getAttribute('aria-label')),
    /5h quota for claude-max \(claude\), remaining % over time\. 3 readings from .* UTC to .* UTC\. Latest: 70% remaining, confirmed .* UTC\. Projected:/,
  );
  const ticks = [...five.querySelectorAll('svg > g.m4-quota-time')];
  t.true(ticks.length >= 3 && ticks.length <= 6, 'time axis');
  t.true(
    ticks.every(node => Number(node.getAttribute('data-ms')) % (15 * MIN) === 0),
    'ticks on whole quarter hours or coarser',
  );
  t.true(
    ticks.every(node =>
      /^(\d{2}:\d{2}|[A-Z][a-z]{2} \d{1,2})$/.test(
        String(node.querySelector('text')?.textContent),
      ),
    ),
    'short labels',
  );
  t.regex(
    String(five.querySelector('figcaption .m4-quota-latest')?.textContent),
    /^Latest: 70% remaining, confirmed [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2} UTC$/,
  );
  t.is(five.querySelector('.m4-quota-name')?.textContent, '5h quota remaining (%) · UTC');
  t.is(five.querySelectorAll('.m4-quota-readings tbody tr').length, 2);

  // Claude weekly: a confirmed upcoming weekly reset is marked.
  t.is(week.getAttribute('data-window-minutes'), '10080');
  t.truthy(week.querySelector('[data-reset="weekly"] line'));
  t.regex(String(week.textContent), new RegExp(`Weekly reset ${formatInstant(weekReset)}`));
  t.regex(String(week.querySelector('svg')?.getAttribute('aria-label')), /Weekly reset at/);

  // Codex weekly with one reading: no projection, says why; marker kept.
  t.is(codexWeek.getAttribute('data-status'), 'insufficient');
  t.is(codexWeek.querySelector('[data-view="recent"]'), null);
  t.is(codexWeek.querySelector('polyline.m4-quota-projected'), null);
  t.truthy(codexWeek.querySelector('[data-reset="weekly"]'));
  t.regex(String(codexWeek.querySelector('.m4-quota-status')?.textContent), /No projection: needs readings/);

  // A member with no readings: the empty state, no graph.
  const members = s.$$('.m4-quota-member');
  t.deepEqual(
    members.map(node => node.getAttribute('data-provider')),
    ['claude', 'codex', 'codex'],
  );
  t.regex(String(members[2].textContent), /No quota readings recorded yet/);
  t.is(members[2].querySelector('svg'), null);
  // No credential or store key in the rendered panel.
  t.false(/k[0-9]+\b|sk-|Bearer/.test(String(s.$('.m4-subscriptions')?.textContent)));

  // A push re-reads the history without closing the disclosure.
  s.accounts.publish(pools);
  await flush();
  t.is(s.accounts.callsOf('Accounts.history').length, 4);
  t.true(disclosures.every(details => details.open));
});

test.serial('panel: history unavailable or unknown pool shows a clear state', async t => {
  const pool = Far('Backend', {});
  const pools = [
    harden({
      backend: pool,
      kind: 'claude-pool',
      label: 'claude',
      selection: 'auto',
      members: [memberAccount({ label: 'a' })],
    }),
  ];
  const s = await mountPanel(t, new Map(), pools);
  t.regex(String(s.$('.m4-quota')?.textContent), /No quota readings recorded yet/);
  t.is(s.$('.m4-quota-graph'), null);
  t.is(s.$('.m4-quota')?.getAttribute('aria-label'), 'Quota history: claude');
});

test('review: an equal pair (40% left at 10:00 and 10:15) is one record, count 2, a flat forecast', t => {
  const at10 = Date.parse('2026-11-18T10:00:00.000Z');
  const reset = at10 + 3 * DAY;
  const series = seriesOf(
    10_080,
    [[at10, 60, reset, at10 + 15 * MIN, 2]],
    'secondary',
  );
  const a = analyseSeries(series, at10 + 20 * MIN);
  t.is(a.points.length, 1, 'no intermediate point invented');
  t.is(a.readings, 2);
  t.is(a.status, 'projected');
  const p = /** @type {any} */ (a.projection);
  t.is(p.usedPerHour, 0);
  t.is(p.fromMs, at10 + 15 * MIN, 'projected from the last confirmation');
  t.is(p.toUsed, 60);
  t.regex(projectionText(a, series), /^Projected: unchanged, 40% remaining/);
  t.is(
    latestText(a),
    'Latest: 40% remaining, confirmed Nov 18 10:15 UTC',
  );
  // A count above 2 is reported as given; it is not invented from time.
  t.is(
    analyseSeries(seriesOf(300, [[at10, 60, reset, at10 + 15 * MIN, 5]]), at10)
      .readings,
    5,
  );
});

test('review: weekly windows are marked in a primary or a secondary slot, either provider', t => {
  const ahead = NOW + 3 * DAY;
  for (const name of ['primary', 'secondary']) {
    t.is(
      analyseSeries(seriesOf(10_080, [[NOW - HOUR, 40, ahead]], name), NOW)
        .weeklyResetMs,
      ahead,
      name,
    );
  }
  t.is(
    analyseSeries(seriesOf(300, [[NOW - HOUR, 40, ahead]], 'secondary'), NOW)
      .weeklyResetMs,
    undefined,
  );
});

test('review: time ticks land on whole hours or days', t => {
  const start = Date.parse('2026-11-18T09:47:00.000Z');
  const hours = timeTicks(start, start + 5 * HOUR, 6);
  t.true(hours.length >= 3 && hours.length <= 6);
  t.true(hours.every(tick => tick.ms % HOUR === 0));
  t.is(hours[0].date, 'Nov 18', 'the first tick names its day');
  t.true(hours.slice(1).every(tick => tick.date === undefined));
  const days = timeTicks(start, start + 4 * DAY, 6);
  t.true(days.every(tick => tick.ms % (6 * HOUR) === 0));
  t.true(days.filter(tick => tick.date !== undefined).length >= 3);
  const week = timeTicks(start, start + 7 * DAY, 6);
  t.true(week.every(tick => tick.ms % DAY === 0));
  t.true(week.every(tick => tick.time === undefined), 'day ticks show dates only');
});

/**
 * Render one component into a fresh happy-dom document.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {any} vnode
 * @param {{ width?: number }} [options]
 */
const renderAlone = (t, vnode, options) => {
  runEffectsPromptly();
  const dom = makeTestDom(options);
  t.teardown(async () => {
    render(null, dom.root);
    await dom.close();
  });
  render(vnode, dom.root);
  return {
    dom,
    $: (/** @type {string} */ sel) => dom.root.querySelector(sel),
    $$: (/** @type {string} */ sel) => [...dom.root.querySelectorAll(sel)],
  };
};

/** @param {any} node */
const xsOf = node =>
  [...node.querySelectorAll('circle.m4-quota-dot')].map(dot =>
    Number(dot.getAttribute('cx')),
  );

test.serial('review: readings 15 minutes apart, weekly reset days away: inset and readings view', async t => {
  const at10 = Date.parse('2026-11-18T10:00:00.000Z');
  const reset = at10 + 5 * DAY;
  const series = seriesOf(
    10_080,
    [
      [at10, 50, reset],
      [at10 + 15 * MIN, 52, reset, at10 + 30 * MIN, 2],
    ],
    'secondary',
  );
  const account = { label: 'claude-max', provider: 'claude' };
  const s = renderAlone(
    t,
    h(QuotaGraph, { series, account, nowMs: at10 + 35 * MIN }),
  );
  // The main plot: 360 units wide, drawn at 343px (375px screen) to 576px.
  const main = s.$('figure > svg');
  const [a, b] = xsOf(main);
  t.true(b - a < 1.2, `main plot squeezes 15 minutes to ${b - a} units`);
  const inset = s.$('[data-view="recent"]');
  t.truthy(inset, 'a zoomed inset of the observed span');
  const zoomed = xsOf(inset);
  t.is(zoomed.length, 3);
  t.true(zoomed[1] - zoomed[0] > 40, 'the inset spreads them apart');
  t.is(inset.querySelector('[data-reset="weekly"]'), null);
  t.true(
    [...inset.querySelectorAll('g.m4-quota-time')].every(
      node => Number(node.getAttribute('data-ms')) % (15 * MIN) === 0,
    ),
  );
  const disclosure = s.$('.m4-quota-readings summary');
  t.is(disclosure?.textContent, 'Readings (3)');
  t.is(disclosure?.getAttribute('aria-label'), 'Readings (3) for claude-max, weekly');
  const rows = s
    .$$('.m4-quota-readings tbody tr')
    .map(row => [...row.querySelectorAll('td')].map(td => td.textContent));
  t.deepEqual(rows, [
    ['Nov 18 10:15 UTC', 'Nov 18 10:30 UTC', '2', '48%', formatInstant(reset)],
    ['Nov 18 10:00 UTC', '\u2014', '1', '50%', formatInstant(reset)],
  ]);
  // "now" and the reset are told apart: line style, colour and label.
  const now = s.$('figure > svg [data-marker="now"]');
  const mark = s.$('figure > svg [data-marker="reset"]');
  t.truthy(now?.querySelector('line')?.getAttribute('stroke-dasharray'));
  t.is(mark?.querySelector('line')?.getAttribute('stroke-dasharray'), null);
  t.not(
    now?.querySelector('line')?.getAttribute('stroke'),
    mark?.querySelector('line')?.getAttribute('stroke'),
  );
  t.is(now?.querySelector('text')?.textContent?.trim(), 'now');
  t.is(mark?.querySelector('text')?.textContent?.trim(), 'reset');

  // Readings spread over the plot: no inset.
  const spread = renderAlone(
    t,
    h(QuotaGraph, {
      series: seriesOf(300, [
        [at10, 10, at10 + 4 * HOUR],
        [at10 + 2 * HOUR, 30, at10 + 4 * HOUR],
      ]),
      account,
      nowMs: at10 + 2 * HOUR,
    }),
  );
  t.is(spread.$('[data-view="recent"]'), null);
});

test.serial('review: observed traces split where the slope does', async t => {
  const oldReset = NOW - 2 * HOUR;
  const newReset = NOW + 3 * HOUR;
  const series = seriesOf(300, [
    [NOW - 5 * HOUR, 30, oldReset],
    [NOW - 3 * HOUR, 60, oldReset],
    [NOW - 40 * MIN, 5, newReset],
    [NOW - 10 * MIN, 15, newReset],
  ]);
  const a = analyseSeries(series, NOW);
  t.deepEqual(
    a.periods.map(period => period.map(point => point.usedPercent)),
    [
      [30, 60],
      [5, 15],
    ],
  );
  const s = renderAlone(
    t,
    h(QuotaGraph, {
      series,
      account: { label: 'x', provider: 'claude' },
      nowMs: NOW,
    }),
  );
  const lines = s.$$('figure > svg polyline.m4-quota-observed');
  t.is(lines.length, 2, 'no line drawn across the reset');
  t.deepEqual(
    lines.map(line => String(line.getAttribute('points')).split(' ').length),
    [2, 2],
  );
});

/**
 * A fake feed answering `history(backend, offset)` from `answer`.
 *
 * @param {(offset: number, call: number) => any} answer
 */
const feedOf = answer => {
  /** @type {number[]} */
  const calls = [];
  return {
    calls,
    feed: /** @type {any} */ ({
      history: async (/** @type {any} */ _backend, offset = 0) => {
        calls.push(offset);
        return answer(offset, calls.length);
      },
    }),
  };
};

const openSubscriptions = (/** @type {any} */ details) => {
  details.open = true;
  details.dispatchEvent(new details.ownerDocument.defaultView.Event('toggle'));
};

const tick = (/** @type {number} */ ms) =>
  new Promise(resolve => setTimeout(resolve, ms));

test.serial('review: the open view advances its own clock: projection and passed reset go, no new read', async t => {
  const pool = Far('Backend', {});
  let clock = NOW;
  const reset = NOW + HOUR;
  const history = harden({
    backend: pool,
    kind: 'claude-pool',
    label: 'claude',
    members: [
      {
        label: 'claude-max',
        provider: 'claude',
        windows: [
          seriesOf(
            10_080,
            [
              [NOW - HOUR, 40, reset],
              [NOW - 10 * MIN, 45, reset],
            ],
            'secondary',
          ),
        ],
      },
    ],
  });
  const { feed, calls } = feedOf(() => history);
  const s = renderAlone(
    t,
    h(PoolQuotaHistory, {
      feed,
      pool: { backend: pool, label: 'claude', kind: 'claude-pool', members: history.members.map(m => memberAccount({ label: m.label })) },
      rev: 1,
      now: () => clock,
      tickMs: 5,
    }),
  );
  await flush();
  openSubscriptions(s.$('details.m4-individual-subscriptions'));
  await flush();
  t.is(s.$('.m4-quota-member .m4-quota-graph')?.getAttribute('data-status'), 'projected');
  t.truthy(s.$('[data-reset="weekly"]'));
  t.truthy(s.$('polyline.m4-quota-projected'));

  // Two hours pass with the panel open: stale, and the reset went by.
  clock = NOW + 2 * HOUR;
  await tick(30);
  await flush();
  t.is(s.$('.m4-quota-graph')?.getAttribute('data-status'), 'reset-passed');
  t.is(s.$('polyline.m4-quota-projected'), null);
  t.is(s.$('[data-reset="weekly"]'), null);
  t.regex(String(s.$('.m4-quota-status')?.textContent), /has reset since/);
  t.deepEqual(calls, [0], 'no provider or history call to move the clock');
});

test.serial('fresh pool history appears immediately between chart clock ticks', async t => {
  const backend = Far('Backend', {});
  const reset = NOW + DAY;
  const window = { name: 'secondary', windowMinutes: 10_080 };
  const account = memberAccount({ label: 'team', windows: [window] });
  const pool = { backend, label: 'Claude', kind: 'claude-pool', members: [account] };
  let clock = NOW;
  let used = 10;
  const { feed } = feedOf(() => ({
    members: [{ ...account, windows: [seriesOf(10_080, [[clock, used, reset]], 'secondary')] }],
  }));
  const props = { pool, feed, now: () => clock, tickMs: 60_000 };
  const s = renderAlone(t, h(PoolQuotaHistory, { ...props, rev: 1 }));
  await flush();
  t.is(s.$('[data-pool-value]')?.textContent, '90%');

  clock += 5000;
  used = 35;
  render(h(PoolQuotaHistory, { ...props, rev: 2 }), s.dom.root);
  await flush();
  t.is(s.$('[data-pool-value]')?.textContent, '65%');
  t.falsy(s.$('details.m4-individual-subscriptions')?.open);
});

test.serial('review: stale without a reset passing drops the projection on its own', async t => {
  const pool = Far('Backend', {});
  let clock = NOW;
  const history = harden({
    backend: pool,
    kind: 'codex-pool',
    label: 'codex',
    members: [
      {
        label: 'codex-pro',
        provider: 'codex',
        windows: [
          seriesOf(300, [
            [NOW - HOUR, 10, NOW + 4 * HOUR],
            [NOW - 10 * MIN, 20, NOW + 4 * HOUR],
          ]),
        ],
      },
    ],
  });
  const { feed, calls } = feedOf(() => history);
  const s = renderAlone(
    t,
    h(PoolQuotaHistory, {
      feed,
      pool: { backend: pool, label: 'codex', kind: 'codex-pool', members: history.members.map(m => memberAccount({ label: m.label, provider: m.provider })) },
      rev: 1,
      now: () => clock,
      tickMs: 5,
    }),
  );
  await flush();
  openSubscriptions(s.$('details.m4-individual-subscriptions'));
  await flush();
  t.is(s.$('.m4-quota-member .m4-quota-graph')?.getAttribute('data-status'), 'projected');
  clock = NOW + staleMs(300);
  await tick(30);
  await flush();
  t.is(s.$('.m4-quota-graph')?.getAttribute('data-status'), 'stale');
  t.is(s.$('polyline.m4-quota-projected'), null);
  t.deepEqual(calls, [0]);
});

test.serial('review: a failed history read is shown beside the cached graph', async t => {
  const pool = Far('Backend', {});
  const history = harden({
    backend: pool,
    kind: 'claude-pool',
    label: 'claude',
    members: [
      {
        label: 'claude-max',
        provider: 'claude',
        windows: [seriesOf(300, [[NOW - HOUR, 10, NOW + HOUR]])],
      },
    ],
  });
  const { feed } = feedOf((_offset, call) => {
    if (call === 1) return history;
    throw Error('adapter unreachable');
  });
  const props = {
    feed,
    pool: { backend: pool, label: 'claude', kind: 'claude-pool', members: history.members.map(m => memberAccount({ label: m.label })) },
    now: () => NOW,
  };
  const { dom } = renderAlone(t, h(PoolQuotaHistory, { ...props, rev: 1 }));
  await flush();
  openSubscriptions(dom.root.querySelector('details.m4-individual-subscriptions'));
  await flush();
  t.truthy(dom.root.querySelector('.m4-quota-member .m4-quota-graph'));
  t.is(dom.root.querySelector('.m4-quota-error'), null);
  render(h(PoolQuotaHistory, { ...props, rev: 2 }), dom.root);
  await flush();
  t.truthy(dom.root.querySelector('.m4-quota-graph'), 'the cached graph stays');
  t.is(
    dom.root.querySelector('.m4-quota-error')?.textContent,
    'Quota history could not be refreshed; showing the last one read: adapter unreachable',
  );
  t.is(dom.root.querySelector('.m4-quota-error')?.getAttribute('role'), 'status');

  // No graph yet and the read fails: said, with no graph.
  const failing = feedOf(() => {
    throw Error('no adapter');
  });
  const s = renderAlone(
    t,
    h(PoolQuotaHistory, { ...props, feed: failing.feed, rev: 1 }),
  );
  await flush();
  t.is(s.$('.m4-quota-graph'), null);
  t.is(s.$('.m4-quota-error')?.textContent, 'Quota history unavailable: no adapter');
});

test.serial('review: a pool of more than one page is read page by page', async t => {
  const pool = Far('Backend', {});
  /** @param {number} i */
  const member = i => ({
    label: `m${i}`,
    provider: 'claude',
    windows: [seriesOf(300, [[NOW - HOUR, 10 + i, NOW + HOUR]])],
  });
  const pages = [
    harden({
      backend: pool,
      kind: 'claude-pool',
      label: 'claude',
      members: [0, 1, 2, 3].map(member),
      next: 4,
    }),
    harden({
      backend: pool,
      kind: 'claude-pool',
      label: 'claude',
      members: [4, 5].map(member),
    }),
  ];
  const { feed, calls } = feedOf(offset => pages[offset / 4]);
  const s = renderAlone(
    t,
    h(PoolQuotaHistory, {
      feed,
      pool: { backend: pool, label: 'claude', kind: 'claude-pool', members: pages.flatMap(page => page.members.map(m => memberAccount({ label: m.label }))) },
      rev: 1,
      now: () => NOW,
    }),
  );
  await flush();
  t.deepEqual(calls, [0, 4]);
  t.deepEqual(
    s.$$('.m4-quota-member > h4').map(node => node.firstChild?.textContent),
    ['m0', 'm1', 'm2', 'm3', 'm4', 'm5'],
  );
});
