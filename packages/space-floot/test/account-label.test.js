// @ts-check
import test from 'ava';

import {
  accountBlocked,
  accountRedeem,
  accountChip,
  accountSections,
  accountsOfSession,
  formatSpan,
  windowNow,
} from '../src/account-label.js';

const NOW = Date.parse('2026-09-20T12:00:00.000Z');

const codex = {
  backendId: 'codex',
  title: 'Codex',
  plan: { planId: 'pro', title: 'Pro', state: 'active', source: 'observed' },
  windows: [
    {
      windowId: 'primary',
      title: '5-hour window',
      usedPercent: 12,
      resetsAt: '2026-09-20T14:30:00.000Z',
      windowSeconds: 18_000,
      limit: null,
      used: null,
      remaining: null,
    },
    {
      windowId: 'secondary',
      title: 'Weekly window',
      usedPercent: 62.5,
      resetsAt: '2026-09-23T16:00:00.000Z',
      windowSeconds: 604_800,
      limit: null,
      used: null,
      remaining: null,
    },
  ],
  limitReached: false,
  credits: { balance: '3.25', hasCredits: true, unlimited: false },
  resetCredits: {
    availableCount: 2,
    credits: [
      {
        id: 'a',
        status: 'available',
        grantedAt: '',
        expiresAt: '2026-10-01T12:00:00.000Z',
      },
      {
        id: 'b',
        status: 'available',
        grantedAt: '',
        expiresAt: '2026-09-25T12:00:00.000Z',
      },
    ],
  },
  source: 'observed',
  observedAt: '2026-09-20T11:57:00.000Z',
};

test('spans read in their two largest units', t => {
  t.is(formatSpan(3 * 86_400_000 + 4 * 3_600_000 + 5 * 60_000), '3d 4h');
  t.is(formatSpan(2 * 3_600_000 + 10 * 60_000), '2h 10m');
  t.is(formatSpan(45_000), '45s');
  t.is(formatSpan(0), '0s');
  t.is(formatSpan(-5), '0s');
});

test('the chip leads with the long window', t => {
  t.is(accountChip(codex, NOW), 'wk 63% · 5h 12%');
  t.is(accountChip(undefined, NOW), '');
});

test('the panel words each window, credits, banked resets and the age of the figures', t => {
  t.deepEqual(accountSections([codex], NOW), [
    {
      id: 'codex',
      title: 'Codex',
      rows: [
        ['Plan', 'Pro'],
        ['5-hour window', '12% used — resets in 2h 30m'],
        ['Weekly window', '62.5% used — resets in 3d 4h'],
        ['Credits', '3.25'],
        ['Banked resets', '2, the first expires in 5d'],
        ['Figures', 'as of 3m ago'],
      ],
      // No admin is bound for this account: nothing is offered.
      redeem: null,
    },
  ]);
  t.deepEqual(accountSections(undefined, NOW), []);
});

test('a drained window says when it is back, and a reading ages past its reset', t => {
  const drained = {
    ...codex,
    limitReached: true,
    windows: [{ ...codex.windows[1], usedPercent: 100 }],
    source: 'remembered',
  };
  t.is(accountChip(drained, NOW), 'wk used up, back in 3d 4h');
  t.true(accountBlocked(drained, NOW));
  t.true(
    accountSections([drained], NOW)[0].rows.some(
      ([label, value]) => label === 'Status' && value === 'limit reached',
    ),
  );
  // After its reset time the same remembered reading is an empty window.
  const later = Date.parse('2026-09-24T00:00:00.000Z');
  t.deepEqual(windowNow(drained.windows[0], later), {
    usedPercent: 0,
    expired: true,
    exhausted: false,
    resetsInMs: null,
  });
  t.false(accountBlocked(drained, later));
  t.is(accountChip(drained, later), 'wk 0%');
  t.true(
    accountSections([drained], later)[0].rows[1][1].includes(
      'has reset since this reading',
    ),
  );
});

test('counts are shown when the provider publishes them', t => {
  const openrouter = {
    backendId: 'opencode',
    title: 'OpenCode',
    plan: {
      planId: 'pay-as-you-go',
      title: 'OpenRouter',
      state: 'active',
      source: 'observed',
    },
    windows: [
      {
        windowId: 'secondary',
        title: 'Free-model requests today',
        usedPercent: 3.7,
        resetsAt: '2026-09-21T00:00:00.000Z',
        windowSeconds: 86_400,
        limit: '1000',
        used: '37',
        remaining: '963',
      },
    ],
    limitReached: false,
    credits: { balance: '20.8000', hasCredits: true, unlimited: false },
    resetCredits: null,
    source: 'observed',
    observedAt: '2026-09-20T12:00:00.000Z',
  };
  t.is(
    accountSections([openrouter], NOW)[0].rows[1][1],
    '3.7% used, 963 of 1000 left — resets in 12h',
  );
  t.is(accountChip(openrouter, NOW), 'day 4%');
  const unknown = {
    ...openrouter,
    windows: [],
    source: 'unavailable',
    credits: null,
  };
  t.is(accountChip(unknown, NOW), '');
  t.deepEqual(accountSections([unknown], NOW)[0].rows.at(-1), [
    'Figures',
    'nothing known yet',
  ]);
});

test('the provider’s word that the limit is reached ages by what the reading named', t => {
  const at = iso => Date.parse(iso);
  // Depleted credits, no window full: one window resetting refills nothing.
  const depleted = {
    ...codex,
    limitReached: true,
    windows: [
      { ...codex.windows[0], usedPercent: 40 },
      { ...codex.windows[1], usedPercent: 40 },
    ],
  };
  t.true(accountBlocked(depleted, NOW));
  t.true(accountBlocked(depleted, at('2026-09-20T15:00:00.000Z')));
  t.false(accountBlocked(depleted, at('2026-09-24T00:00:00.000Z')));
  // A reading that named no window cannot say when it lifts: believed for an
  // hour, not for ever.
  const undated = { ...codex, limitReached: true, windows: [] };
  t.true(accountBlocked(undated, NOW));
  t.false(accountBlocked(undated, at('2026-09-20T13:30:00.000Z')));
  // A window that still has room never reads as full.
  const nearly = {
    ...codex,
    windows: [{ ...codex.windows[1], usedPercent: 99.6 }],
  };
  t.is(accountChip(nearly, NOW), 'wk 99%');
  t.false(accountBlocked(nearly, NOW));
  // A full window with no reset time says so without inventing one.
  const undatedFull = {
    ...codex,
    windows: [{ ...codex.windows[1], usedPercent: 100, resetsAt: '' }],
  };
  t.is(accountChip(undatedFull, NOW), 'wk used up');
});

test('a session shows the account it is pinned to, or every account of its backend', t => {
  const work = {
    ...codex,
    key: 'codex:work',
    subscriptionId: 'work',
    label: 'Work Pro',
  };
  const home = {
    ...codex,
    key: 'codex:home',
    subscriptionId: 'home',
    label: 'Home Plus',
  };
  const other = { ...codex, backendId: 'claude', key: 'claude' };
  const accounts = [work, home, other];
  t.deepEqual(
    accountsOfSession(accounts, { backendId: 'codex', subscription: 'home' }),
    [home],
  );
  t.deepEqual(
    accountsOfSession(accounts, { backendId: 'codex', subscription: 'auto' }),
    [work, home],
  );
  t.deepEqual(accountsOfSession(accounts, { backendId: 'claude' }), [other]);
  t.deepEqual(accountsOfSession(accounts, undefined), []);
  t.deepEqual(accountsOfSession(undefined, { backendId: 'codex' }), []);
  // The settings panel tells a backend's subscriptions apart by label.
  t.deepEqual(
    accountSections([work, home], NOW).map(section => [
      section.id,
      section.title,
    ]),
    [
      ['codex:work', 'Codex — Work Pro'],
      ['codex:home', 'Codex — Home Plus'],
    ],
  );
});

test('a redeem is offered where there is an admin and a credit, and asks again while one is unconfirmed', t => {
  t.is(accountRedeem(codex), null);
  const idle = { ...codex, reset: { pending: null, last: null } };
  t.like(accountRedeem(idle), {
    key: 'codex',
    label: 'Redeem a reset',
    pending: false,
  });
  t.regex(accountRedeem(idle)?.confirm || '', /cannot be undone/);
  t.is(
    accountRedeem({
      ...idle,
      resetCredits: { availableCount: 0, credits: [] },
    }),
    null,
  );
  t.is(accountRedeem({ ...idle, resetCredits: null }), null);

  const pending = {
    ...codex,
    key: 'codex:work',
    label: 'Work',
    resetCredits: { availableCount: 0, credits: [] },
    reset: {
      pending: {
        creditId: 'credit-1',
        startedAt: '2026-09-20T11:50:00.000Z',
        lastAttemptAt: '2026-09-20T11:55:00.000Z',
        attempts: 2,
      },
      last: null,
    },
  };
  // Even with no credit showing: the unconfirmed one may be why.
  t.like(accountRedeem(pending), {
    key: 'codex:work',
    label: 'Ask again',
    pending: true,
  });
  t.regex(accountRedeem(pending)?.confirm || '', /cannot spend a second/);
  // Giving up is offered only while one is unconfirmed, and says what it costs.
  t.is(accountRedeem(idle)?.abandon, null);
  t.is(accountRedeem(pending)?.abandon?.label, 'Give up');
  t.regex(accountRedeem(pending)?.abandon?.confirm || '', /spends a second/);
  t.deepEqual(
    accountSections(
      [
        {
          ...pending,
          reset: {
            ...pending.reset,
            pending: { ...pending.reset.pending, lastAnswer: 'refused' },
          },
        },
      ],
      NOW,
    )[0].rows.find(([label]) => label === 'Redeem'),
    [
      'Redeem',
      'unconfirmed: the last ask 5m ago was refused, but an earlier one may have been accepted',
    ],
  );
  const [section] = accountSections([pending], NOW);
  t.deepEqual(
    section.rows.find(([label]) => label === 'Redeem'),
    ['Redeem', 'unconfirmed: asked 5m ago and no answer came back'],
  );

  const settled = outcome =>
    accountSections(
      [
        {
          ...codex,
          reset: {
            pending: null,
            last: { outcome, creditId: null, at: '2026-09-20T11:00:00.000Z' },
          },
        },
      ],
      NOW,
    )[0].rows.find(([label]) => label === 'Last redeem');
  t.deepEqual(settled('reset'), [
    'Last redeem',
    'redeemed; the windows were reset 1h ago',
  ]);
  t.deepEqual(settled('refused'), [
    'Last redeem',
    'refused by the provider; no credit was spent 1h ago',
  ]);
  t.deepEqual(settled('abandoned'), [
    'Last redeem',
    'given up while unconfirmed 1h ago',
  ]);
  t.deepEqual(settled('<b>new</b>'), [
    'Last redeem',
    'answered in words this does not know 1h ago',
  ]);
});
