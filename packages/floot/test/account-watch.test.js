// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { makeAccountOracleKit } from '@endo/hosted-agent/account-oracle.js';
import { makeAccountReadingSource } from '@endo/hosted-agent/account-source.js';

import { makeAccountsWatch, projectAccount } from '../src/account-watch.js';

const T0 = '2026-09-20T12:00:00.000Z';

const pushedOracle = (t, providerId) => {
  const account = makeAccountReadingSource({ now: () => T0 });
  const kit = makeAccountOracleKit({
    providerId,
    now: () => T0,
    provideObserved: () => E(account.source).observe(),
    watchObserved: async () => E(account.source).watch(),
    refreshObserved: () => E(account.source).refresh(),
  });
  t.teardown(() => kit.close());
  return { account, oracle: kit.account };
};

const weekly = usedPercent =>
  harden({
    rateLimits: {
      windows: [
        {
          windowId: 'secondary',
          title: 'Weekly window',
          usedPercent,
          windowSeconds: 604_800,
          resetsAt: '2026-09-25T00:00:00.000Z',
        },
      ],
      limitReached: false,
    },
  });

test('a view is told every account now and when any of them changes', async t => {
  const codex = pushedOracle(t, 'codex');
  const claude = pushedOracle(t, 'anthropic');
  const watch = makeAccountsWatch({
    listOracles: async () => ({
      entries: [
        { backendId: 'codex', title: 'Codex', oracle: codex.oracle },
        { backendId: 'claude', title: 'Claude Code', oracle: claude.oracle },
      ],
      unknown: [],
    }),
  });
  const reader = iterateReader(watch.watch());
  const seen = async predicate => {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { value, done } = await reader.next();
      if (done) throw Error('stream ended');
      if (predicate(value)) return value;
    }
  };
  const first = await seen(event => event.accounts.length === 2);
  t.is(first.type, 'accounts');
  t.deepEqual(
    first.accounts.map(account => [account.backendId, account.source]),
    [
      ['claude', 'unavailable'],
      ['codex', 'unavailable'],
    ],
  );
  // A request is served on Codex: its broker's reading reaches the view.
  codex.account.accept(weekly(62.5));
  const next = await seen(
    event =>
      event.accounts.find(account => account.backendId === 'codex')?.source ===
      'observed',
  );
  const account = next.accounts.find(entry => entry.backendId === 'codex');
  t.deepEqual(account.windows, [
    {
      windowId: 'secondary',
      title: 'Weekly window',
      usedPercent: 62.5,
      resetsAt: '2026-09-25T00:00:00.000Z',
      windowSeconds: 604_800,
      limit: null,
      used: null,
      remaining: null,
    },
  ]);
  t.is(account.title, 'Codex');
  await reader.return(undefined);
  await watch.close();
});

test('an oracle bound after the first view subscribed is found by the next', async t => {
  const codex = pushedOracle(t, 'codex');
  let bound = false;
  const watch = makeAccountsWatch({
    listOracles: async () => ({
      entries: bound
        ? [{ backendId: 'codex', title: 'Codex', oracle: codex.oracle }]
        : [],
      unknown: [],
    }),
  });
  const early = iterateReader(watch.watch());
  t.deepEqual((await early.next()).value, { type: 'accounts', accounts: [] });
  bound = true;
  const late = iterateReader(watch.watch());
  let event = (await late.next()).value;
  while (event.accounts.length === 0) {
    // eslint-disable-next-line no-await-in-loop
    event = (await late.next()).value;
  }
  t.is(event.accounts[0].backendId, 'codex');
  // The early view hears of it too.
  let heard = (await early.next()).value;
  while (heard.accounts.length === 0) {
    // eslint-disable-next-line no-await-in-loop
    heard = (await early.next()).value;
  }
  t.is(heard.accounts[0].backendId, 'codex');
  await watch.close();
});

test('counts become text and nothing but data reaches a view', t => {
  const view = projectAccount(
    { backendId: 'opencode', title: 'OpenCode' },
    {
      plan: {
        planId: 'pay-as-you-go',
        title: 'OpenRouter',
        state: 'active',
        source: 'observed',
      },
      rateLimits: {
        windows: [
          {
            windowId: 'secondary',
            title: 'Free-model requests today',
            limit: 1000n,
            used: 37n,
            remaining: 963n,
            usedFraction: 0.037,
            windowSeconds: 86_400,
            resetsAt: '2026-09-21T00:00:00.000Z',
          },
        ],
        limitReached: false,
        credits: { balance: '20.8000', hasCredits: true, unlimited: false },
        resetCredits: null,
        source: 'observed',
        observedAt: T0,
      },
    },
  );
  t.is(view.windows[0].limit, '1000');
  t.is(view.windows[0].remaining, '963');
  t.is(view.windows[0].usedPercent, 3.7);
  t.is(view.credits.balance, '20.8000');
  t.notThrows(() => JSON.stringify(view));
});

test('an oracle that cannot stream costs one line and a growing pause', async t => {
  const lines = [];
  /** @type {Array<{ callback: () => void, ms: number }>} */
  const timers = [];
  let watches = 0;
  const old = Far('oracle from before watch()', {
    watch: () => {
      watches += 1;
      throw Error('target has no method "watch"');
    },
  });
  const watch = makeAccountsWatch({
    listOracles: async () => ({
      entries: [{ backendId: 'codex', title: 'Codex', oracle: old }],
      unknown: [],
    }),
    setTimer: (callback, ms) => timers.push({ callback, ms }),
    clearTimer: () => {},
    log: (...args) => lines.push(args.join(' ')),
  });
  const reader = iterateReader(watch.watch());
  await reader.next();
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  await settle();
  t.is(watches, 1);
  t.is(timers.length, 1);
  t.is(timers[0].ms, 5000);
  // A second view arriving during the pause does not start a second loop.
  const second = iterateReader(watch.watch());
  await settle();
  t.is(watches, 1);
  // Each retry waits longer, and the outage is said once.
  timers[0].callback();
  await settle();
  timers[1].callback();
  await settle();
  t.deepEqual(
    timers.map(timer => timer.ms),
    [5000, 10_000, 20_000],
  );
  t.is(
    lines.filter(line => line.includes('account watch for codex')).length,
    1,
  );
  await reader.return(undefined);
  await second.return(undefined);
  await watch.close();
});

test('a backend that could not be looked up keeps the account it had', async t => {
  const codex = pushedOracle(t, 'codex');
  let failing = false;
  const watch = makeAccountsWatch({
    listOracles: async () =>
      failing
        ? { entries: [], unknown: ['codex'] }
        : {
            entries: [
              { backendId: 'codex', title: 'Codex', oracle: codex.oracle },
            ],
            unknown: [],
          },
  });
  const reader = iterateReader(watch.watch());
  let event = (await reader.next()).value;
  while (event.accounts.length === 0) {
    // eslint-disable-next-line no-await-in-loop
    event = (await reader.next()).value;
  }
  failing = true;
  // Another view subscribes while the lookup fails: the account stays, and
  // still follows its oracle.
  const other = iterateReader(watch.watch());
  t.is((await other.next()).value.accounts.length, 1);
  codex.account.accept(weekly(71));
  let heard = (await reader.next()).value;
  while (heard.accounts[0]?.windows[0]?.usedPercent !== 71) {
    // eslint-disable-next-line no-await-in-loop
    heard = (await reader.next()).value;
  }
  t.pass();
  await watch.close();
});

test('a backend with several subscriptions is one account each, told apart by key', async t => {
  const work = pushedOracle(t, 'codex');
  const home = pushedOracle(t, 'codex');
  const watch = makeAccountsWatch({
    listOracles: async () => ({
      entries: [
        {
          backendId: 'codex',
          key: 'codex:work',
          subscriptionId: 'work',
          label: 'Work Pro',
          title: 'Codex',
          oracle: work.oracle,
        },
        {
          backendId: 'codex',
          key: 'codex:home',
          subscriptionId: 'home',
          label: 'Home Plus',
          title: 'Codex',
          oracle: home.oracle,
        },
      ],
      unknown: [],
    }),
  });
  const reader = iterateReader(watch.watch());
  let event = (await reader.next()).value;
  while (Number(event.accounts.length) < 2) {
    // eslint-disable-next-line no-await-in-loop
    event = (await reader.next()).value;
  }
  t.deepEqual(
    event.accounts.map(account => [
      account.key,
      account.backendId,
      account.subscriptionId,
      account.label,
    ]),
    [
      ['codex:home', 'codex', 'home', 'Home Plus'],
      ['codex:work', 'codex', 'work', 'Work Pro'],
    ],
  );
  // A reading of one is not the other's.
  home.account.accept(weekly(88));
  let heard = (await reader.next()).value;
  while (
    heard.accounts.find(account => account.key === 'codex:home')?.windows[0]
      ?.usedPercent !== 88
  ) {
    // eslint-disable-next-line no-await-in-loop
    heard = (await reader.next()).value;
  }
  t.deepEqual(
    heard.accounts.find(account => account.key === 'codex:work').windows,
    [],
  );
  await reader.return(undefined);
  await watch.close();
});

test('an account with an admin shows where its redeems stand, and a redeem goes through that admin only', async t => {
  const codex = pushedOracle(t, 'codex');
  const claude = pushedOracle(t, 'anthropic');
  /** @type {any} */
  let state = { pending: null, last: null };
  /** @type {any[]} */
  const consumed = [];
  let fail = false;
  const admin = Far('admin', {
    getResetState: async () => harden(state),
    consumeResetCredit: async options => {
      consumed.push(options);
      if (fail) {
        state = {
          pending: {
            creditId: 'credit-1',
            startedAt: T0,
            lastAttemptAt: T0,
            attempts: 1,
          },
          last: null,
        };
        throw Error('Reset credit redeem is unconfirmed');
      }
      state = {
        pending: null,
        last: { outcome: 'reset', creditId: 'credit-1', at: T0 },
      };
      return harden({
        outcome: 'reset',
        creditId: 'credit-1',
        replayed: false,
      });
    },
  });
  const watch = makeAccountsWatch({
    listOracles: async () => ({
      entries: [
        { backendId: 'codex', title: 'Codex', oracle: codex.oracle, admin },
        { backendId: 'claude', title: 'Claude Code', oracle: claude.oracle },
      ],
      unknown: [],
    }),
  });
  const reader = iterateReader(watch.watch());
  const seen = async predicate => {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { value, done } = await reader.next();
      if (done) throw Error('stream ended');
      if (predicate(value)) return value;
    }
  };
  const of = (event, backendId) =>
    event.accounts.find(account => account.backendId === backendId);
  const first = await seen(
    event => of(event, 'codex')?.reset && of(event, 'claude') !== undefined,
  );
  t.deepEqual(of(first, 'codex').reset, { pending: null, last: null });
  // No admin, no redeem: the view offers nothing there.
  t.is(of(first, 'claude').reset, null);
  await t.throwsAsync(() => watch.redeemReset('claude'), {
    message: /No banked reset can be redeemed for claude/,
  });

  fail = true;
  await t.throwsAsync(() => watch.redeemReset('codex'), {
    message: /unconfirmed/,
  });
  const pending = await seen(event => of(event, 'codex')?.reset?.pending);
  t.is(of(pending, 'codex').reset.pending.creditId, 'credit-1');

  fail = false;
  t.deepEqual(await watch.redeemReset('codex', { creditId: 'credit-1' }), {
    outcome: 'reset',
    creditId: 'credit-1',
    replayed: false,
  });
  t.deepEqual(consumed, [{}, { creditId: 'credit-1' }]);
  await t.throwsAsync(() => watch.abandonReset('claude'));
  const settled = await seen(event => of(event, 'codex')?.reset?.last);
  t.is(of(settled, 'codex').reset.pending, null);
  t.is(of(settled, 'codex').reset.last.outcome, 'reset');
  await reader.return(undefined);
  await watch.close();
});

test('a reset state is plain data whatever the admin answered', t => {
  const view = projectAccount(
    { backendId: 'codex', title: 'Codex' },
    {},
    { pending: { creditId: null, attempts: 'x' }, last: { outcome: 7 } },
  );
  t.deepEqual(view.reset, {
    pending: {
      creditId: null,
      startedAt: '',
      lastAttemptAt: '',
      attempts: 1,
      lastAnswer: 'unknown',
    },
    last: { outcome: '7', creditId: null, at: '' },
  });
  t.is(projectAccount({ backendId: 'codex', title: 'Codex' }, {}).reset, null);
});
