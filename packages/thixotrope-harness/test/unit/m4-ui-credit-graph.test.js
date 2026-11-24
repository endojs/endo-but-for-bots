// Credit balance chart (`MemberHistory.credits`): a numeric wallet balance
// of the current account only, in credits (not %), with observation
// times, top-ups splitting the trace, and a bounded labelled spending
// forecast that never runs through a refill or a quota reset.
import test from '@endo/ses-ava/prepare-endo.js';

import { Far } from '@endo/far';
import { h, render } from 'preact';

import { makeTestDom } from './_m3-fake-powers.js';
import { memberAccount, runEffectsPromptly } from './_m4-ui-fakes.js';
import {
  analyseCredits,
  creditForecastText,
  creditNumber,
  creditSettings,
  formatCredits,
} from '../../ui/src/accounts/credit-projection.js';
import { creditAxisTop } from '../../ui/src/accounts/CreditGraph.js';
import { PoolQuotaHistory } from '../../ui/src/accounts/PoolQuotaHistory.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const AT10 = Date.parse('2026-11-18T10:00:00.000Z');
const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();

/**
 * @param {Array<[number, string, number?, number?]>} rows [from, value, to, count]
 */
const creditsOf = rows =>
  rows.map(([from, value, to, count]) => ({
    from: iso(from),
    value,
    ...(to === undefined ? {} : { to: iso(to), count: count ?? 2 }),
  }));

const flush = async () => {
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 0));
  }
};

/**
 * Mount one pool's history with members as the pool view reports them.
 *
 * @param {{ current: any[], members: any[], nowMs: number }} options
 */
const mountPool = async ({ current, members, nowMs }) => {
  runEffectsPromptly();
  const dom = makeTestDom();
  const backend = Far('Backend', {});
  const history = harden({
    backend,
    kind: 'codex-pool',
    label: 'codex',
    members,
  });
  /** @type {number[]} */
  const calls = [];
  const feed = /** @type {any} */ ({
    history: async (/** @type {any} */ _b, offset = 0) => {
      calls.push(offset);
      return history;
    },
  });
  render(
    h(PoolQuotaHistory, {
      feed,
      pool: { backend, label: 'codex', kind: 'codex-pool', members: current },
      rev: 1,
      now: () => nowMs,
    }),
    dom.root,
  );
  await flush();
  const details = dom.root.querySelector('details.m4-individual-subscriptions');
  details.open = true;
  details.dispatchEvent(new dom.window.Event('toggle'));
  await flush();
  return {
    calls,
    $: (/** @type {string} */ sel) => dom.root.querySelector(sel),
    $$: (/** @type {string} */ sel) => [...dom.root.querySelectorAll(sel)],
    close: async () => {
      render(null, dom.root);
      await dom.close();
    },
  };
};

const weekly = {
  name: 'secondary',
  windowMinutes: 10_080,
  records: [
    { from: iso(AT10), usedPercent: 5, resetsAt: iso(AT10 + 2 * HOUR) },
  ],
};

test('only a plain decimal is a balance', t => {
  t.is(creditNumber('62500.0000000000'), 62_500);
  t.is(creditNumber('0'), 0);
  t.is(creditNumber('-3.25'), -3.25);
  for (const text of [
    undefined,
    '',
    'unlimited',
    '1e5',
    '+3',
    '0.1234567890123',
    '1234567890123456789012345',
    'NaN',
    '62,500',
    62_500,
  ]) {
    t.is(creditNumber(text), undefined, String(text));
  }
  t.is(formatCredits(62_500), '62,500');
  t.is(creditAxisTop(62_500), 100_000);
  t.is(creditAxisTop(410), 500);
});

test.serial(
  'observed balances keep all provider digits; indistinguishable plot values have no forecast',
  async t => {
    const first = '999999999999999999999999.000000000002';
    const last = '999999999999999999999999.000000000001';
    const credits = creditsOf([
      [AT10, first],
      [AT10 + HOUR, last],
    ]);
    const s = await mountPool({
      nowMs: AT10 + HOUR,
      current: [
        memberAccount({ label: 'precise', provider: 'codex', credits: last }),
      ],
      members: [{ label: 'precise', provider: 'codex', windows: [], credits }],
    });
    t.teardown(s.close);
    const graph = s.$('.m4-credit-graph');
    const exact = '999,999,999,999,999,999,999,999.000000000001';
    t.true(graph.querySelector('.m4-quota-latest').textContent.includes(exact));
    t.is(graph.querySelector('tbody tr td:last-child').textContent, exact);
    t.is(graph.getAttribute('data-status'), 'precision');
    t.is(graph.querySelector('.m4-credit-forecast'), null);
    t.is(
      analyseCredits(
        creditsOf([
          [AT10, last],
          [AT10 + HOUR, first],
        ]),
        AT10 + HOUR,
      ).runs.length,
      2,
    );
    t.is(
      analyseCredits(creditsOf([[AT10, '-0.000000000001']]), AT10).status,
      'debt',
    );
    t.is(
      analyseCredits(creditsOf([[AT10, '-0.00000']]), AT10).status,
      'exhausted',
    );
    t.is(formatCredits('-01234.0012300'), '-1,234.00123');
  },
);

test('forecast: two genuine times, bounded horizon, run-out time', t => {
  const records = creditsOf([
    [AT10, '62500.0000000000'],
    [AT10 + HOUR, '62400.0000000000'],
  ]);
  const a = analyseCredits(records, AT10 + HOUR + 5 * MIN);
  t.is(a.status, 'forecast');
  const f = /** @type {any} */ (a.forecast);
  t.is(f.perHour, 100);
  t.is(f.fromMs, AT10 + HOUR);
  t.is(f.toMs - f.fromMs, 2 * HOUR, 'twice the observed span, not to zero');
  t.is(f.toValue, 62_200);
  t.is(f.emptyAtMs, undefined);
  t.regex(
    creditForecastText(a),
    /^Spending forecast \(linear, to Nov 18 13:00 UTC only\): about 100 credits\/hour; about 62,200 credits left then\.$/,
  );
  // The horizon never exceeds the cap however long the span.
  const long = analyseCredits(
    creditsOf([
      [AT10, '1000'],
      [AT10 + 5 * DAY, '999'],
    ]),
    AT10 + 5 * DAY,
  );
  t.is(
    /** @type {any} */ (long.forecast).toMs - (AT10 + 5 * DAY),
    creditSettings.maxHorizonMs,
  );
  // Reaching zero inside the horizon ends the line at zero.
  const near = analyseCredits(
    creditsOf([
      [AT10, '300'],
      [AT10 + HOUR, '100'],
    ]),
    AT10 + HOUR,
  );
  t.is(/** @type {any} */ (near.forecast).emptyAtMs, AT10 + 90 * MIN);
  t.is(/** @type {any} */ (near.forecast).toValue, 0);
  t.regex(
    creditForecastText(near),
    /would run out around Nov 18 11:30 UTC unless topped up/,
  );
  // Past the horizon: withdrawn.
  t.is(analyseCredits(records, AT10 + 4 * HOUR).status, 'stale');
  // One reading, or two too close: none.
  t.is(analyseCredits(creditsOf([[AT10, '5']]), AT10).status, 'insufficient');
  t.is(
    analyseCredits(
      creditsOf([
        [AT10, '5'],
        [AT10 + MIN, '4'],
      ]),
      AT10 + MIN,
    ).status,
    'insufficient',
  );
});

test('unchanged balance: one record, count 2, a flat forecast', t => {
  const a = analyseCredits(
    creditsOf([[AT10, '62500.0000000000', AT10 + 15 * MIN, 2]]),
    AT10 + 20 * MIN,
  );
  t.is(a.points.length, 1);
  t.is(a.readings, 2);
  t.is(a.status, 'unchanged');
  t.is(/** @type {any} */ (a.forecast).perHour, 0);
  t.regex(
    creditForecastText(a),
    /no spending observed; balance unchanged at 62,500 credits/,
  );
});

test('a top-up starts a new run; no forecast through the refill', t => {
  const records = creditsOf([
    [AT10, '500'],
    [AT10 + HOUR, '100'],
    [AT10 + 2 * HOUR, '10100'],
  ]);
  const a = analyseCredits(records, AT10 + 2 * HOUR + MIN);
  t.deepEqual(
    a.runs.map(run => run.map(p => p.value)),
    [[500, 100], [10_100]],
  );
  t.is(a.topUpMs, AT10 + 2 * HOUR);
  t.is(a.status, 'insufficient', 'the pre-top-up slope is not reused');
  t.regex(creditForecastText(a), /since the top-up seen Nov 18 12:00 UTC/);
  const later = analyseCredits(
    [...records, ...creditsOf([[AT10 + 3 * HOUR, '10000']])],
    AT10 + 3 * HOUR,
  );
  t.is(later.status, 'forecast');
  t.is(
    /** @type {any} */ (later.forecast).perHour,
    100,
    'slope of the new run only',
  );
});

test.serial(
  'ChatGPT 62500 credits and 5% weekly: separate charts, separate units, member named',
  async t => {
    const nowMs = AT10 + HOUR + 5 * MIN;
    const s = await mountPool({
      nowMs,
      current: [
        memberAccount({
          label: 'chatgpt-pro',
          provider: 'codex',
          credits: '62500.0000000000',
        }),
      ],
      members: [
        {
          label: 'chatgpt-pro',
          provider: 'codex',
          windows: [weekly],
          credits: creditsOf([
            [AT10, '62500.0000000000'],
            [AT10 + HOUR, '62400.0000000000'],
          ]),
        },
      ],
    });
    const quota = s.$('.m4-quota-graph:not(.m4-credit-graph)');
    const credit = s.$('.m4-credit-graph');
    t.truthy(quota);
    t.truthy(credit);
    t.is(credit.getAttribute('data-status'), 'forecast');
    t.regex(
      String(credit.querySelector('.m4-quota-name')?.textContent),
      /Credit balance \u00b7 chatgpt-pro/,
    );
    t.is(
      credit.querySelector('.m4-quota-latest')?.textContent,
      'Latest: 62,400 credits, confirmed Nov 18 11:00 UTC',
    );
    t.regex(
      String(credit.querySelector('figcaption')?.textContent),
      /separate from quota %/,
    );
    const yLabels = [...credit.querySelectorAll('.m4-credit-tick text')].map(
      n => n.textContent,
    );
    t.deepEqual(yLabels, ['100k', '50k', '0']);
    t.false(yLabels.some(text => String(text).includes('%')));
    t.true(
      [...credit.querySelectorAll('svg > g.m4-quota-time')].every(
        n => Number(n.getAttribute('data-ms')) % (15 * MIN) === 0,
      ),
      'aligned ticks',
    );
    t.truthy(credit.querySelector('[data-marker="now"]'));
    // A quota reset is quota only: none on the credit chart.
    t.is(credit.querySelector('[data-reset]'), null);
    t.is(credit.querySelector('[data-marker="reset"]'), null);
    t.truthy(
      credit.querySelector('polyline.m4-credit-forecast[stroke-dasharray]'),
    );
    t.regex(
      String(credit.querySelector('svg')?.getAttribute('aria-label')),
      /credits over time\. 2 readings from Nov 18 10:00 UTC to Nov 18 11:00 UTC/,
    );
    const rows = [
      ...credit.querySelectorAll('.m4-quota-readings tbody tr'),
    ].map(row => [...row.querySelectorAll('td')].map(td => td.textContent));
    t.deepEqual(rows, [
      ['Nov 18 11:00 UTC', '\u2014', '1', '62,400'],
      ['Nov 18 10:00 UTC', '\u2014', '1', '62,500'],
    ]);
    // The quota graph keeps its percent axis.
    t.regex(
      String(quota.querySelector('svg')?.getAttribute('aria-label')),
      /remaining %/,
    );
    await s.close();
  },
);

test.serial(
  'top-up drawn as two traces with a marker; the forecast starts after it',
  async t => {
    const s = await mountPool({
      nowMs: AT10 + 3 * HOUR,
      current: [
        memberAccount({ label: 'c', provider: 'codex', credits: '10000' }),
      ],
      members: [
        {
          label: 'c',
          provider: 'codex',
          windows: [],
          credits: creditsOf([
            [AT10, '500'],
            [AT10 + HOUR, '100'],
            [AT10 + 2 * HOUR, '10100'],
            [AT10 + 3 * HOUR, '10000'],
          ]),
        },
      ],
    });
    const credit = s.$('.m4-credit-graph');
    t.is(credit.querySelectorAll('polyline.m4-credit-observed').length, 2);
    t.is(
      credit.querySelector('[data-marker="top-up"] text')?.textContent,
      'top-up',
    );
    const [from] = String(
      credit
        .querySelector('polyline.m4-credit-forecast')
        ?.getAttribute('points'),
    ).split(' ');
    const dots = [...credit.querySelectorAll('circle.m4-quota-dot')].map(
      d => `${d.getAttribute('cx')},${d.getAttribute('cy')}`,
    );
    t.is(
      from,
      String(dots.at(-1)),
      'forecast starts at the latest reading after the top-up',
    );
    await s.close();
  },
);

test.serial(
  'no plot for absent or non-numeric balances, or for Claude',
  async t => {
    const recorded = creditsOf([
      [AT10, '100'],
      [AT10 + HOUR, '90'],
    ]);
    for (const current of [
      memberAccount({ label: 'm', provider: 'claude' }),
      memberAccount({ label: 'm', provider: 'codex' }),
      memberAccount({ label: 'm', provider: 'codex', credits: 'unlimited' }),
      memberAccount({ label: 'm', provider: 'codex', credits: '' }),
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const s = await mountPool({
        nowMs: AT10 + HOUR,
        current: [current],
        members: [
          {
            label: 'm',
            provider: current.provider,
            windows: [weekly],
            credits: recorded,
          },
        ],
      });
      t.is(
        s.$('.m4-credit-graph'),
        null,
        String(/** @type {any} */ (current).credits),
      );
      t.truthy(s.$('.m4-quota-graph'), 'the quota graph is still drawn');
      // eslint-disable-next-line no-await-in-loop
      await s.close();
    }
    // Numeric now, but no credit history: nothing to plot.
    const s = await mountPool({
      nowMs: AT10,
      current: [memberAccount({ label: 'm', provider: 'codex', credits: '5' })],
      members: [{ label: 'm', provider: 'codex', windows: [weekly] }],
    });
    t.is(s.$('.m4-credit-graph'), null);
    await s.close();
  },
);
