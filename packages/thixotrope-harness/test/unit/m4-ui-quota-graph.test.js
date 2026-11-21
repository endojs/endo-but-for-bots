// @ts-check
// Quota history graph (ui/src/accounts/quota-projection.js, QuotaGraph.js):
// period and projection rules from real distinct readings (insufficient,
// stale, no reset, reset passed, exhausted, reset boundaries), weekly reset
// markers only for a confirmed upcoming 7-day reset, and the rendered
// Subscriptions panel in happy-dom for a Claude and a Codex pool: time
// axis, observed and projected series, accessible label, empty states.
import test from '@endo/ses-ava/prepare-endo.js';

import { Far } from '@endo/far';

import { makeController } from '../../ui/src/controller/index.js';
import { mount } from '../../ui/src/shell/index.js';
import { feature as accountFeatures } from '../../ui/src/accounts/feature.js';
import {
  analyseSeries,
  currentPeriod,
  formatInstant,
  pointsOf,
  projectionText,
  staleMs,
} from '../../ui/src/accounts/quota-projection.js';
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
 * @param {number} windowMinutes
 * @param {Array<[number, number, number?, number?]>} rows [at, used, resetsAt, lastAt]
 * @param {string} [name]
 */
const seriesOf = (windowMinutes, rows, name = 'primary') => ({
  name,
  windowMinutes,
  samples: rows.map(([at, used, reset, last]) => ({
    at: iso(at),
    usedPercent: used,
    ...(reset === undefined ? {} : { resetsAt: iso(reset) }),
    ...(last === undefined ? {} : { lastAt: iso(last) }),
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
  // A single reading confirmed for long is still one distinct reading.
  t.is(
    status(seriesOf(300, [[NOW - 50 * MIN, 10, reset, NOW - MIN]])),
    'insufficient',
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
 * @param {Map<any, any>} histories
 * @param {any[]} pools
 */
const mountPanel = async (histories, pools) => {
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
  mount({
    root: dom.root,
    controller,
    features,
    window: dom.window,
    schedule: fn => fn(),
  });
  await controller.attach(powers);
  await flush();
  controller.openPanel('accounts');
  await flush();
  return {
    dom,
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
            series: [
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
            series: [
              seriesOf(10_080, [[now - HOUR, 55, weekReset]], 'secondary'),
            ],
          },
          { label: 'codex-spare', provider: 'codex', series: [] },
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
  const s = await mountPanel(histories, pools);
  t.is(s.accounts.callsOf('Accounts.history').length, 2);
  const graphs = s.$$('.m4-quota-graph');
  t.is(graphs.length, 3);
  const [five, week, codexWeek] = graphs;

  // Claude 5h: observed line, dots, projection dashed, no weekly marker.
  t.is(five.getAttribute('data-window-minutes'), '300');
  t.is(five.getAttribute('data-status'), 'projected');
  t.truthy(five.querySelector('polyline.m4-quota-observed'));
  t.is(five.querySelectorAll('circle.m4-quota-dot').length, 2);
  const dashed = five.querySelector('polyline.m4-quota-projected');
  t.is(dashed?.getAttribute('stroke-dasharray'), '5 4');
  t.is(five.querySelector('[data-reset="weekly"]'), null);
  const svg = five.querySelector('svg');
  t.is(svg?.getAttribute('role'), 'img');
  t.regex(
    String(svg?.getAttribute('aria-label')),
    /5h quota for claude-max \(claude\), remaining % over time\. 2 readings from .* UTC; newest 70% remaining\. Projected:/,
  );
  t.is(five.querySelectorAll('text.m4-quota-time').length, 3, 'time axis');
  t.true(
    [...five.querySelectorAll('text.m4-quota-time')].every(node =>
      /^[A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}$/.test(String(node.textContent)),
    ),
  );
  t.regex(String(five.textContent), /Remaining quota, % of window/);
  t.is(five.querySelectorAll('.m4-quota-readings tbody tr').length, 2);

  // Claude weekly: a confirmed upcoming weekly reset is marked.
  t.is(week.getAttribute('data-window-minutes'), '10080');
  t.truthy(week.querySelector('[data-reset="weekly"] line'));
  t.regex(String(week.textContent), new RegExp(`Weekly reset ${formatInstant(weekReset)}`));
  t.regex(String(week.querySelector('svg')?.getAttribute('aria-label')), /Weekly reset at/);

  // Codex weekly with one reading: no projection, says why; marker kept.
  t.is(codexWeek.getAttribute('data-status'), 'insufficient');
  t.is(codexWeek.querySelector('polyline.m4-quota-projected'), null);
  t.truthy(codexWeek.querySelector('[data-reset="weekly"]'));
  t.regex(String(codexWeek.querySelector('.m4-quota-status')?.textContent), /need at least 2 distinct readings/);

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

  // A push re-reads the history.
  s.accounts.publish(pools);
  await flush();
  t.is(s.accounts.callsOf('Accounts.history').length, 4);
  await s.dom.close();
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
  const s = await mountPanel(new Map(), pools);
  t.regex(String(s.$('.m4-quota')?.textContent), /No quota readings recorded yet/);
  t.is(s.$('.m4-quota-graph'), null);
  t.is(s.$('.m4-quota')?.getAttribute('aria-label'), 'Quota history: claude');
  await s.dom.close();
});
