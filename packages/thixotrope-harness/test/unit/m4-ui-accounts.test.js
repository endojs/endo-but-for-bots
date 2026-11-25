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
import { addMemberTexts } from '../../ui/src/accounts/AddMember.js';
import {
  subscriptionTextOf,
  subscriptionTexts,
} from '../../guest/lib/subscription-texts.js';
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

/** @param {{ cold?: boolean, initiallyEmpty?: boolean, beforeRefresh?: () => Promise<void>, checks?: Map<string, any> }} [options] */
const setup = async ({
  cold = false,
  initiallyEmpty = false,
  beforeRefresh,
  checks,
} = {}) => {
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
      windows: [{ name: 'primary', windowMinutes: 10_080, usedPercent: 100 }],
    }),
  ];
  const sessionsToPools = new Map();
  const pools = [poolOf(poolBackend, 'team-claude', members)];
  const accounts = makeFakeAccounts({
    pools: cold || initiallyEmpty ? [] : pools,
    coldPools: cold ? pools : [],
    beforeRefresh,
    sessions: sessionsToPools,
  });
  const secrets = makeFakeSecrets({
    accounts: accounts.accounts,
    poolBackends: initiallyEmpty ? [] : [poolBackend],
    checks,
    // The adapter's view after `poolsChanged`: the pool with the new member.
    onAdded: (_pool, label) =>
      accounts.publish(
        accounts
          .view()
          .pools.map(pool =>
            poolOf(pool.backend, pool.label, [
              ...pool.members,
              memberAccount({ label }),
            ]),
          ),
      ),
  });
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
    secrets,
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
  t.is(
    chipText(observed, nowMs),
    'a: weekly used up, back in 3h · 5h quota 99% used',
  );
  t.is(
    chipText(
      memberAccount({
        label: 'Pro',
        windows: [{ name: 'primary', windowMinutes: 10_080, usedPercent: 67 }],
      }),
      nowMs,
    ),
    'Pro: weekly 67% used',
  );
  const unknownDuration = memberAccount({
    label: 'a',
    windows: [{ name: 'secondary', usedPercent: 0 }],
  });
  t.is(chipText(unknownDuration, nowMs), 'a: secondary quota 0% used');
  t.deepEqual(accountRows(unknownDuration, nowMs)[0], [
    'secondary quota',
    '0% used, 100% left',
  ]);
  t.is(
    chipText(
      {
        ...unknownDuration,
        windows: [{ name: 'secondary', windowMinutes: 90, usedPercent: 12 }],
      },
      nowMs,
    ),
    'a: 90m quota 12% used',
  );
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
  t.is(
    chipText(declared, nowMs),
    `b: pro · ${subscriptionTexts.provenanceDeclared}`,
  );
  t.is(
    chipText(
      memberAccount({ label: 'c', provenance: 'unavailable', credits: '12' }),
      nowMs,
    ),
    `c: 12 credits · ${subscriptionTexts.provenanceUnavailable}`,
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
    `d: marked · ${subscriptionTexts.provenanceRemembered}, 2h ago`,
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
    ['5h quota', `25% used, 75% left · resets in 1h (${iso(nowMs + HOUR)})`],
    ['Status', `marked · EXHAUSTED · until ${iso(nowMs + HOUR)}`],
    ['Credits', '5'],
    ['Banked reset', `weekly reset · expires ${iso(nowMs + 48 * HOUR)}`],
    ['Source', 'observed, 0s ago'],
  ]);
});

test.serial(
  'Subscriptions panel: list, then live batches; refresh on open and on demand',
  async t => {
    const s = await setup();
    s.controller.openSettings('accounts');
    await flush();
    t.truthy(s.$('[data-panel="accounts"] .m4-subscriptions'));
    t.is(s.$('.m4-pool h3')?.textContent, 'team-claude');
    t.deepEqual(
      s.$$('.m4-account').map(li => li.getAttribute('data-provenance')),
      ['observed', 'declared'],
    );
    t.regex(String(s.$('.m4-account')?.textContent), /Plan.*max/);
    t.regex(String(s.$('.m4-account')?.textContent), /40% used, 60% left/);
    const declaredRow = s.$('[data-provenance="declared"]');
    t.regex(String(declaredRow?.textContent), /100% used, 0% left/);
    t.false(declaredRow?.classList.contains('blocked'));
    t.deepEqual(s.accounts.callsOf('Accounts.list').length, 1);
    t.deepEqual(s.accounts.callsOf('Accounts.watch'), [
      ['Accounts', 'watch', 1],
    ]);
    t.is(
      s.accounts.callsOf('Accounts.refresh').length,
      1,
      'opening refreshes all pools',
    );

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
      [undefined, undefined, s.poolBackend],
    );
    await s.dom.close();
  },
);

test.serial(
  'opening a cold panel registers its pools before refreshing and shares pending work on reopen',
  async t => {
    let finish = () => {};
    const pending = new Promise(
      /** @param {(value?: any) => void} resolve */ resolve => {
        finish = resolve;
      },
    );
    const s = await setup({ cold: true, beforeRefresh: () => pending });
    t.teardown(async () => {
      finish();
      s.shell.unmount();
      await s.dom.close();
    });
    s.controller.openSettings('accounts');
    await flush();
    const names = s.accounts.calls.map(call => call[1]);
    t.true(names.indexOf('forBackend') < names.indexOf('refresh'));
    t.is(s.accounts.callsOf('Accounts.refresh').length, 1);
    t.true(s.$('[data-action="refresh-all"]').disabled);
    s.controller.closeSettings();
    await flush();
    s.controller.openSettings('accounts');
    await flush();
    t.is(s.accounts.callsOf('Accounts.refresh').length, 1);
    finish();
    await flush();
    t.false(s.$('[data-action="refresh-all"]').disabled);
    s.controller.closeSettings();
    await flush();
    s.controller.openSettings('accounts');
    await flush();
    t.is(s.accounts.callsOf('Accounts.refresh').length, 2);
  },
);

test.serial(
  'an open empty panel refreshes once when its first pool is registered',
  async t => {
    const s = await setup({ initiallyEmpty: true });
    t.teardown(async () => {
      s.shell.unmount();
      await s.dom.close();
    });
    s.controller.openSettings('accounts');
    await flush();
    t.is(s.accounts.callsOf('Accounts.refresh').length, 0);
    const pools = [poolOf(s.poolBackend, 'newly-registered', s.members)];
    s.accounts.publish(pools);
    await flush();
    s.accounts.publish(pools);
    await flush();
    t.is(s.accounts.callsOf('Accounts.refresh').length, 1);
  },
);

test.serial(
  'failed opening refresh stays visible until a manual retry succeeds',
  async t => {
    let fail = true;
    const s = await setup({
      beforeRefresh: async () => {
        if (fail) throw Error('usage unavailable');
      },
    });
    t.teardown(async () => {
      s.shell.unmount();
      await s.dom.close();
    });
    s.controller.openSettings('accounts');
    await flush();
    t.is(s.$('.m4-error')?.textContent, 'usage unavailable');
    fail = false;
    await s.click(s.$('[data-action="refresh-all"]'));
    t.is(s.$('.m4-error'), null);
    t.is(s.accounts.callsOf('Accounts.refresh').length, 2);
  },
);

test.serial(
  're-watch after accountsWatchClosed, from the last rev',
  async t => {
    const s = await setup();
    s.controller.openSettings('accounts');
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
  s.controller.openSettings('accounts');
  await flush();
  for (let i = 0; i <= REWATCH_LIMIT; i += 1) {
    s.accounts.evict(i);
    // eslint-disable-next-line no-await-in-loop
    await flush();
  }
  t.is(s.$('.m4-error')?.textContent, subscriptionTexts.accountsWatchClosed);
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
      'first: 5h quota 40% used',
      `second: pro · ${subscriptionTexts.provenanceDeclared}`,
    ]);
    t.true(s.$('.m4-chip')?.title.includes('subscription allowance used'));
    const declaredChip = s.$$('.m4-chip')[1];
    t.false(declaredChip.title.includes('subscription allowance used'));
    t.false(declaredChip.classList.contains('blocked'));
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
    s.controller.openSettings('accounts');
    await flush();
    t.is(s.accounts.live(), 1);
    s.controller.closeSettings();
    await flush();
    t.is(s.accounts.live(), 0);
    t.is(s.accounts.callsOf('AccountsSubscription.close').length, 1);
    // One feed per connection: the panel and the chip share it.
    t.is(accountsFeed(s.powers), accountsFeed(s.powers));
    s.controller.openSettings('accounts');
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

test.serial(
  'Add subscription: choose an active secret, check it in plain words, add it; the pool refreshes; no secret content shown',
  async t => {
    const s = await setup({
      checks: new Map([['bad-login', { ok: false, code: 'WRONG_PROVIDER' }]]),
    });
    // Fake values only; the page must never show them.
    const goodValue = ['fake', 'good', 'credential'].join('-');
    const badValue = ['fake', 'other', 'credential'].join('-');
    s.secrets.add('team-login', goodValue);
    s.secrets.add('bad-login', badValue);
    const gone = s.secrets.add('old-login', 'fake-revoked');
    await gone.secret.revoke();
    s.controller.openPanel('accounts');
    await flush();
    const panel = () => s.$('[data-panel="accounts"] .m4-subscriptions');
    await s.click(s.$('[data-action="add-subscription"]'));
    const form = () => s.$('.m4-add-member.open');
    t.truthy(form());
    t.true(form().textContent.includes(addMemberTexts.provider('claude')));
    const select = () => form().querySelector('select[name="secret"]');
    const options = [...select().querySelectorAll('option')].map(
      o => o.textContent,
    );
    t.is(options.length, 3, 'the placeholder and the two active secrets');
    t.false(
      options.some(text => text.includes('old-login')),
      'revoked: not offered',
    );

    // Nothing chosen: Add refuses inline, with no call.
    await s.click(form().querySelector('[data-action="add-member"]'));
    t.is(
      form().querySelector('[role="alert"]').textContent,
      addMemberTexts.needSecret,
    );
    t.is(s.secrets.callsOf('SubscriptionsAdmin.makeMember').length, 0);

    /** @param {number} index */
    const choose = async index => {
      select().value = String(index);
      select().dispatchEvent(
        new s.dom.window.Event('change', { bubbles: true }),
      );
      await flush();
    };
    /** @param {string} text */
    const typeLabel = async text => {
      const input = form().querySelector('input[name="label"]');
      input.value = text;
      input.dispatchEvent(new s.dom.window.Event('input', { bubbles: true }));
      await flush();
    };

    // The wrong-provider secret: the check says so, Add is held back.
    await choose(1);
    t.is(form().querySelector('input[name="label"]').value, 'bad-login');
    await s.click(form().querySelector('[data-action="check-credential"]'));
    const failed = form().querySelector('[data-check]');
    t.is(failed.dataset.check, 'WRONG_PROVIDER');
    t.is(
      failed.textContent,
      subscriptionTextOf.credentialCheckFailed('WRONG_PROVIDER'),
    );
    t.true(form().querySelector('[data-action="add-member"]').disabled);

    // The good one: checked ok, then added under the typed label.
    await choose(0);
    t.is(
      form().querySelector('[data-check]'),
      null,
      'a new choice clears the check',
    );
    await typeLabel('');
    await typeLabel('team member');
    await s.click(form().querySelector('[data-action="check-credential"]'));
    t.is(
      form().querySelector('[data-check]').textContent,
      subscriptionTexts.credentialReady,
    );
    const refreshesBefore = s.accounts.callsOf('Accounts.refresh').length;
    await s.click(form().querySelector('[data-action="add-member"]'));
    t.deepEqual(
      s.secrets.callsOf('SubscriptionsAdmin.makeMember').map(c => c[2]),
      [{ provider: 'claude', label: 'team member' }],
    );
    t.deepEqual(
      s.secrets.callsOf('SubscriptionsAdmin.addPoolMember').map(c => c[2]),
      ['team member'],
    );
    t.is(s.secrets.poolMembers.get(s.poolBackend)?.length, 1);
    // Each add asked the admin first, passing the Secret presence itself.
    t.deepEqual(
      s.secrets.callsOf('SubscriptionsAdmin.checkCredential').map(c => c[2]),
      ['bad-login', 'team-login', 'team-login'],
    );
    t.true(form().textContent.includes(addMemberTexts.added));
    t.true(
      s.accounts.callsOf('Accounts.refresh').length > refreshesBefore,
      'the pool was refreshed after the add',
    );
    t.true(
      panel().textContent.includes('team member'),
      'the pool shows the new member',
    );
    for (const value of [goodValue, badValue, 'fake-revoked'])
      t.false(
        s.dom.document.body.innerHTML.includes(value),
        'no secret content',
      );
  },
);

test.serial(
  'Add subscription: a member left in no pool is shown; it can be added or retired; a refused add is shown inline',
  async t => {
    const s = await setup();
    s.secrets.add('kept', 'fake-a');
    s.secrets.add('dropped', 'fake-b');
    const subs = await s.secrets.admin.subscriptions();
    // makeMember committed, addPoolMember never ran (a break between them).
    const [kept, dropped] = ['kept', 'dropped'].map(label =>
      subs.makeMember({
        provider: 'claude',
        label,
        credential: s.secrets.records.find(r => r.label === label)?.secret,
      }),
    );
    subs.makeMember({
      provider: 'codex',
      label: 'elsewhere',
      credential: s.secrets.records[0].secret,
    });
    s.controller.openPanel('accounts');
    await flush();
    await s.click(s.$('[data-action="add-subscription"]'));
    const rows = () =>
      s.$$('.m4-unpooled [data-unpooled]').map(row => row.dataset.unpooled);
    t.deepEqual(rows(), ['kept', 'dropped'], 'only this provider, in no pool');
    await s.click(
      s.$('[data-unpooled="dropped"] [data-action="retire-member"]'),
    );
    t.deepEqual(rows(), ['kept']);
    await s.click(s.$('[data-unpooled="kept"] [data-action="add-existing"]'));
    t.deepEqual(rows(), []);
    t.deepEqual(s.secrets.poolMembers.get(s.poolBackend), [kept]);
    t.not(kept, dropped);
    // The same label and Secret again: the manager answers the member,
    // the pool refuses it; the text shows inline.
    const select = s.$('.m4-add-member.open select[name="secret"]');
    select.value = '0';
    select.dispatchEvent(new s.dom.window.Event('change', { bubbles: true }));
    await flush();
    await s.click(s.$('.m4-add-member.open [data-action="add-member"]'));
    t.is(
      s.$('.m4-add-member.open [role="alert"]').textContent,
      'This member is already in the pool',
    );
  },
);
