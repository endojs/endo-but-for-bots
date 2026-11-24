import test from '@endo/ses-ava/prepare-endo.js';
import { h, render } from 'preact';
import { poolOverview } from '../../ui/src/accounts/pool-overview.js';
import { PoolOverviewGraph } from '../../ui/src/accounts/PoolOverviewGraph.js';
import { makeTestDom } from './_m3-fake-powers.js';

const start = Date.parse('2026-11-18T10:00:00Z');
const at = (/** @type {number} */ min) => start + 60_000 * min;
const iso = (/** @type {number} */ min) => new Date(at(min)).toISOString();

/**
 * @param {string} label
 * @param {string} balance
 * @param {number} offset
 */
const fixture = (label, balance, offset) => {
  const window = {
    name: offset === 0 ? 'primary' : 'secondary',
    windowMinutes: 10_080,
  };
  return {
    account: { label, provider: 'codex', credits: balance, windows: [window] },
    history: {
      label,
      provider: 'codex',
      credits: [
        { from: iso(offset), value: balance, to: iso(20 + offset), count: 2 },
      ],
      windows: [
        {
          ...window,
          records: [
            {
              from: iso(offset),
              usedPercent: 20 + offset,
              resetsAt: iso(1440 + offset),
            },
            {
              from: iso(20 + offset),
              usedPercent: 30 + offset,
              resetsAt: iso(1440 + offset),
            },
          ],
        },
      ],
    },
  };
};

test('pool wallet adds exact decimals from distinct ordered members and weekly quotas use equal-member percentages', t => {
  const first = fixture('same', '999999999999999999999999.000000000001', 0);
  const second = fixture('same', '0.000000000002', 2);
  const pool = { members: [first.account, second.account] };
  const history = { members: [first.history, second.history] };
  const [wallet, weekly] = poolOverview(pool, history, at(22));
  t.is(wallet.latest?.exact, '999999999999999999999999.000000000003');
  t.is(wallet.latest?.contributors, 2);
  t.is(wallet.runs[0][0].contributors, 1);
  t.is(wallet.runs[1][0].contributors, 2);
  t.is(weekly.latest?.value, 69);
  t.deepEqual(weekly.resets, [
    { name: 'same (member 1)', at: at(1440) },
    { name: 'same (member 2)', at: at(1442) },
  ]);
  t.deepEqual(wallet.resets, weekly.resets);
  t.is(weekly.projection.at(-1)?.at, at(1440));
});

test('missing, retired, stale or reordered members cannot inflate a pool figure or supply a complete forecast', t => {
  const a = fixture('one', '40', 0);
  const b = fixture('two', '50', 2);
  const pool = {
    members: [
      a.account,
      b.account,
      { ...b.account, label: 'old', state: 'retired' },
    ],
  };
  const [wallet] = poolOverview(pool, { members: [a.history] }, at(30));
  t.is(wallet.total, 2);
  t.is(wallet.latest?.exact, '40');
  t.is(wallet.latest?.contributors, 1);
  t.deepEqual(wallet.projection, []);
  const [old] = poolOverview(
    pool,
    { members: [a.history, b.history] },
    at(450),
  );
  t.is(old.latest, undefined);
  t.is(old.runs.at(-1)?.at(-1)?.exact, '90');
  t.deepEqual(old.projection, []);
  t.deepEqual(
    poolOverview(pool, { members: [b.history, a.history] }, at(30)),
    [],
  );
});

test('a top-up splits the pool balance line and forecast; quota reset markers do not truncate wallet runway', t => {
  const a = fixture('a', '50', 0);
  const b = fixture('b', '30', 2);
  a.history.credits = [
    { from: iso(0), value: '10', to: iso(14), count: 2 },
    { from: iso(20), value: '50', to: iso(40), count: 2 },
  ];
  a.history.windows[0].records[1].resetsAt = iso(45);
  const [wallet] = poolOverview(
    { members: [a.account, b.account] },
    { members: [a.history, b.history] },
    at(40),
  );
  t.is(wallet.latest?.exact, '80');
  t.true(wallet.runs.length >= 3);
  t.true((wallet.projection.at(-1)?.at ?? 0) > at(45));
});

test.serial(
  'pool graph displays subtotal coverage, independent weekly resets and historical value after staleness',
  async t => {
    const a = fixture('team A', '40', 0);
    const b = fixture('team B', '50', 2);
    const dom = makeTestDom();
    t.teardown(async () => {
      render(null, dom.root);
      await dom.close();
    });
    const props = {
      pool: { members: [a.account, b.account] },
      history: { members: [a.history, b.history] },
      nowMs: at(22),
    };
    render(h(PoolOverviewGraph, props), dom.root);
    t.regex(dom.root.textContent, /90 credits/);
    t.regex(dom.root.textContent, /2 of 2 accounts/);
    t.is(dom.root.querySelectorAll('[data-pool-reset]').length, 2);
    t.truthy(dom.root.querySelector('[data-pool-projection]'));
    render(h(PoolOverviewGraph, { ...props, nowMs: at(1000) }), dom.root);
    t.regex(dom.root.textContent, /No fresh reading/);
    t.regex(dom.root.textContent, /Last recorded: 90 credits/);
    t.falsy(dom.root.querySelector('[data-pool-projection]'));
  },
);

test('weekly projection includes exhausted members at zero until the earliest confirmed reset', t => {
  const empty = fixture('empty', '0', 0);
  const active = fixture('active', '20', 2);
  empty.history.windows[0].records[1] = {
    from: iso(20),
    usedPercent: 100,
    resetsAt: iso(500),
  };
  const metrics = poolOverview(
    { members: [empty.account, active.account] },
    { members: [empty.history, active.history] },
    at(22),
  );
  const weekly = metrics.find(m => m.id === 'quota-10080');
  const path = weekly?.projection ?? [];
  t.is(path[0]?.value, 34);
  t.is(path.at(-1)?.at, at(500));
  t.is(path.at(-1)?.value, 0);
  t.true(
    path.some(p => p.at < at(500) && p.value === 0),
    'depletion is plotted before reset',
  );
});

test.serial(
  'debt-only wallet has a finite chart and a history-only view omits an out-of-range now marker',
  async t => {
    const a = fixture('debt', '-999999999999999999999999', 0);
    const dom = makeTestDom();
    t.teardown(async () => {
      render(null, dom.root);
      await dom.close();
    });
    render(
      h(PoolOverviewGraph, {
        pool: { members: [a.account] },
        history: { members: [a.history] },
        nowMs: at(50),
      }),
      dom.root,
    );
    const plot = dom.root.querySelector('svg');
    t.notRegex(plot?.outerHTML ?? '', /NaN|Infinity/);
    const zoom = dom.root.querySelector('button');
    zoom?.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    t.falsy(dom.root.querySelector('[data-marker="now"]'));
  },
);
