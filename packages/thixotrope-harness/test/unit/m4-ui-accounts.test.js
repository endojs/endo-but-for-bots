// @ts-check
/* eslint-disable import/no-relative-packages */
// W4.7 Subscriptions panel and account chips (P-45; R4-84..R4-86, R6-52,
// R6-54; m4-interfaces.md 6, 9.1, 16): component tests in happy-dom with
// M3's fake powers and a fake adapter `Accounts`. Both update from
// `AccountsBatch` pushes, re-watch after `accountsWatchClosed`, refresh on
// demand only; the chip follows the session on screen by its pool's
// `Backend` presence and shows nothing for a backend that is not a pool.
import test from '@endo/ses-ava/prepare-endo.js';

import { Far } from '@endo/far';

import { makeController } from '../../ui/src/controller/index.js';
import { mount } from '../../ui/src/shell/index.js';
import { feature as accountFeatures } from '../../ui/src/accounts/feature.js';
import { activeSessionOf } from '../../ui/src/accounts/AccountChip.js';
import { accountsFeed, REWATCH_LIMIT } from '../../ui/src/accounts/feed.js';
import {
  accountBlocked,
  accountRows,
  chipText,
  formatSpan,
  provenanceText,
} from '../../ui/src/accounts/labels.js';
import { m4Texts } from '../../guest/lib/texts-m4.js';
import { makeFakePowers, makeTestDom } from './_m3-fake-powers.js';
import {
  makeFakeAccounts,
  makeFakeSecrets,
  memberAccount,
  runEffectsPromptly,
} from './_m4-ui-fakes.js';

const flush = async (rounds = 20) => {
  await null;
  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setImmediate(resolve));
  }
};

const HOUR = 3_600_000;
const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();

/**
 * @param {any} backend
 * @param {string} label
 * @param {any[]} members
 */
const poolOf = (backend, label, members) =>
  harden({ backend, kind: 'claude-pool', label, selection: 'auto', members });

const setup = async () => {
  runEffectsPromptly();
  const dom = makeTestDom();
  const poolBackend = Far('Backend', {});
  const nowMs = Date.now();
  const members = [
    memberAccount({
      label: 'first',
      plan: 'max',
      windows: [
        {
          name: 'primary',
          usedPercent: 40,
          windowMinutes: 300,
          resetsAt: iso(nowMs + 2 * HOUR),
        },
      ],
      at: iso(nowMs - 60_000),
    }),
    memberAccount({
      label: 'second',
      provenance: 'declared',
      plan: 'pro',
    }),
  ];
  const sessionsToPools = new Map();
  const accounts = makeFakeAccounts({
    pools: [poolOf(poolBackend, 'team-claude', members)],
    sessions: sessionsToPools,
  });
  const secrets = makeFakeSecrets({ accounts: accounts.accounts });
  const features = [...accountFeatures];
  const { powers, control } = makeFakePowers({
    sessions: [{ key: 's-pool' }, { key: 's-api' }],
    operatorMethods: { getSecrets: () => secrets.getSecrets() },
  });
  sessionsToPools.set(control.session('s-pool'), poolBackend);
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
  await controller.attach(powers);
  await flush();
  const $ = (/** @type {string} */ selector) =>
    dom.document.querySelector(selector);
  const $$ = (/** @type {string} */ selector) => [
    ...dom.document.querySelectorAll(selector),
  ];
  const click = async (/** @type {any} */ element) => {
    element.dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true }),
    );
    await flush();
  };
  return {
    dom,
    controller,
    shell,
    powers,
    control,
    accounts,
    poolBackend,
    members,
    nowMs,
    $,
    $$,
    click,
  };
};

test.serial('labels: chip text, rows, provenance, blocked', t => {
  const nowMs = Date.parse('2026-11-18T00:00:00.000Z');
  t.is(formatSpan(2 * HOUR + 10 * 60_000), '2h 10m');
  t.is(formatSpan(45_000), '45s');
  const observed = memberAccount({
    label: 'a',
    windows: [
      {
        name: 'secondary',
        usedPercent: 100,
        windowMinutes: 10_080,
        resetsAt: iso(nowMs + 3 * HOUR),
      },
      { name: 'primary', usedPercent: 99.6, windowMinutes: 300 },
    ],
    limitReached: true,
    at: iso(nowMs - 120_000),
  });
  t.is(chipText(observed, nowMs), 'a: wk used up, back in 3h · 5h 99%');
  t.true(accountBlocked(observed, nowMs));
  t.true(
    accountBlocked(observed, nowMs + 4 * HOUR),
    'limit reached stands while a window without a reset time remains',
  );
  t.false(
    accountBlocked(
      { ...observed, windows: [observed.windows[0]] },
      nowMs + 4 * HOUR,
    ),
    'every named window has reset',
  );
  t.is(provenanceText(observed, nowMs), 'observed, 2m ago');
  const declared = memberAccount({
    label: 'b',
    provenance: 'declared',
    plan: 'pro',
  });
  t.is(chipText(declared, nowMs), `b: pro · ${m4Texts.provenanceDeclared}`);
  t.is(
    chipText(
      memberAccount({ label: 'c', provenance: 'unavailable', credits: '12' }),
      nowMs,
    ),
    `c: 12 credits · ${m4Texts.provenanceUnavailable}`,
  );
  t.is(
    chipText(
      memberAccount({
        label: 'd',
        provenance: 'remembered',
        state: 'marked',
        at: iso(nowMs - 2 * HOUR),
      }),
      nowMs,
    ),
    `d: marked · ${m4Texts.provenanceRemembered}, 2h ago`,
  );
  t.true(accountBlocked(memberAccount({ state: 'unusable' }), nowMs));
  const rows = accountRows(
    memberAccount({
      plan: 'max',
      windows: [
        {
          name: 'primary',
          usedPercent: 25,
          windowMinutes: 300,
          resetsAt: iso(nowMs + HOUR),
        },
      ],
      credits: '5',
      banked: [{ label: 'weekly reset', expiresAt: iso(nowMs + 48 * HOUR) }],
      code: 'EXHAUSTED',
      state: 'marked',
      markedUntil: iso(nowMs + HOUR),
      at: iso(nowMs),
    }),
    nowMs,
  );
  t.deepEqual(rows, [
    ['Plan', 'max'],
    ['5h', `25% used, 75% left · resets in 1h (${iso(nowMs + HOUR)})`],
    ['Status', `marked · EXHAUSTED · until ${iso(nowMs + HOUR)}`],
    ['Credits', '5'],
    ['Banked reset', `weekly reset · expires ${iso(nowMs + 48 * HOUR)}`],
    ['Source', 'observed, 0s ago'],
  ]);
});

test.serial(
  'Subscriptions panel: list, then live batches; refresh on demand only',
  async t => {
    const s = await setup();
    s.controller.openPanel('accounts');
    await flush();
    t.truthy(s.$('[data-panel="accounts"] .m4-subscriptions'));
    t.is(s.$('.m4-pool h3')?.textContent, 'team-claude');
    t.deepEqual(
      s.$$('.m4-account').map(li => li.getAttribute('data-provenance')),
      ['observed', 'declared'],
    );
    t.regex(String(s.$('.m4-account')?.textContent), /Plan.*max/);
    t.regex(String(s.$('.m4-account')?.textContent), /40% used, 60% left/);
    t.deepEqual(s.accounts.callsOf('Accounts.list').length, 1);
    t.deepEqual(s.accounts.callsOf('Accounts.watch'), [
      ['Accounts', 'watch', 1],
    ]);
    t.is(s.accounts.callsOf('Accounts.refresh').length, 0, 'no first refresh');

    // A push: the whole view, rev + 1.
    s.accounts.publish([
      poolOf(s.poolBackend, 'team-claude', [
        { ...s.members[0], windows: [{ name: 'primary', usedPercent: 70 }] },
        s.members[1],
      ]),
    ]);
    await flush();
    t.regex(String(s.$('.m4-account')?.textContent), /70% used, 30% left/);
    t.is(s.accounts.callsOf('Accounts.list').length, 1, 'pushed, never polled');

    await s.click(s.$('[data-action="refresh-all"]'));
    await s.click(s.$('[data-action="refresh-pool"]'));
    t.deepEqual(
      s.accounts.callsOf('Accounts.refresh').map(call => call[2]),
      [undefined, s.poolBackend],
    );
    await s.dom.close();
  },
);

test.serial(
  're-watch after accountsWatchClosed, from the last rev',
  async t => {
    const s = await setup();
    s.controller.openPanel('accounts');
    await flush();
    s.accounts.publish([poolOf(s.poolBackend, 'team-claude', [s.members[1]])]);
    await flush();
    t.is(s.$$('.m4-account').length, 1);
    // The adapter evicts this viewer (idle): its waiting next() rejects.
    s.accounts.evict(0);
    await flush();
    t.deepEqual(s.accounts.callsOf('Accounts.watch').at(-1), [
      'Accounts',
      'watch',
      2,
    ]);
    t.is(s.$('.m4-error'), null, 'no error for an eviction');
    s.accounts.publish([poolOf(s.poolBackend, 'renamed-pool', s.members)]);
    await flush();
    t.is(s.$('.m4-pool h3')?.textContent, 'renamed-pool');
    t.is(s.$$('.m4-account').length, 2);
    await s.dom.close();
  },
);

test.serial('a watch that keeps closing stops with the text shown', async t => {
  const s = await setup();
  s.controller.openPanel('accounts');
  await flush();
  for (let i = 0; i <= REWATCH_LIMIT; i += 1) {
    s.accounts.evict(i);
    // eslint-disable-next-line no-await-in-loop
    await flush();
  }
  t.is(s.$('.m4-error')?.textContent, m4Texts.accountsWatchClosed);
  t.is(s.accounts.callsOf('Accounts.watch').length, REWATCH_LIMIT + 1);
  await s.dom.close();
});

test.serial(
  'account chips follow the session on screen; none for a non-pool backend',
  async t => {
    const s = await setup();
    t.is(s.$('.m4-chips'), null, 'no session on screen: no chip');
    await s.controller.selectSession('s-pool');
    await flush();
    const chips = () => s.$$('.m4-chip').map(chip => chip.textContent);
    t.deepEqual(chips(), [
      'first: 5h 40%',
      `second: pro · ${m4Texts.provenanceDeclared}`,
    ]);
    t.is(s.$('.m4-chips')?.classList.contains('all-blocked'), false);
    t.is(
      s.accounts.callsOf('Accounts.forSession')[0][2],
      s.control.session('s-pool'),
      'asked by the Session object',
    );

    // Live: every account at its limit turns the chips red.
    s.accounts.publish([
      poolOf(s.poolBackend, 'team-claude', [
        { ...s.members[0], limitReached: true },
        { ...s.members[1], state: 'unusable', code: 'REJECTED' },
        memberAccount({ label: 'gone', state: 'retired' }),
      ]),
    ]);
    await flush();
    t.is(chips().length, 2, 'retired members have no chip');
    t.is(s.$('.m4-chips')?.classList.contains('all-blocked'), true);

    await s.controller.selectSession('s-api');
    await flush();
    t.is(s.$('.m4-chips'), null, 'not a pool: no chip');
    t.true(s.accounts.callsOf('Accounts.forSession').length >= 2);
    await s.dom.close();
  },
);

test.serial(
  'the feed closes its subscription when nothing listens',
  async t => {
    const s = await setup();
    s.controller.openPanel('accounts');
    await flush();
    t.is(s.accounts.live(), 1);
    s.controller.closePanel();
    await flush();
    t.is(s.accounts.live(), 0);
    t.is(s.accounts.callsOf('AccountsSubscription.close').length, 1);
    // One feed per connection: the panel and the chip share it.
    t.is(accountsFeed(s.powers), accountsFeed(s.powers));
    s.controller.openPanel('accounts');
    await s.controller.selectSession('s-pool');
    await flush();
    t.is(s.accounts.live(), 1, 'one watch for panel and chip together');
    await s.dom.close();
  },
);

test.serial(
  'activeSessionOf: the controller accessor first, else findSession',
  async t => {
    await null;
    const session = Far('Session', {});
    t.is(
      await activeSessionOf(
        /** @type {any} */ ({ controller: { activeSession: () => session } }),
        'ignored',
      ),
      session,
    );
    const { powers, control } = makeFakePowers({ sessions: [{ key: 'k1' }] });
    const context = /** @type {any} */ ({ controller: {}, powers });
    t.is(await activeSessionOf(context, 'k1'), control.session('k1'));
    t.is(await activeSessionOf(context, undefined), undefined);
  },
);
