// @ts-check
/* global setTimeout */

// Establish a SES perimeter (provides the `harden` global).
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';

import { makeAccount } from '../src/account.js';
import { makePrivacyClient } from '../src/client.js';
import { makeBudgetLedger } from '../src/ledger.js';
import { nodeFetch } from '../src/node-fetch.js';
import { makeMockPrivacyApi } from './mock-privacy-api.js';

const API_KEY = 'test-key-do-not-leak';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** @param {number} ms */
const realDelay = ms =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

/**
 * Assembles a core account over the mock API with a hand-cranked clock,
 * so renewal accrual is deterministic.
 *
 * @param {import('ava').ExecutionContext} t
 */
const prepareCore = async t => {
  const api = await makeMockPrivacyApi({ apiKey: API_KEY });
  t.teardown(() => api.close());
  const clock = { nowMs: 0 };
  const ledger = makeBudgetLedger({ now: () => clock.nowMs });
  const client = makePrivacyClient({
    apiKey: API_KEY,
    baseUrl: api.baseUrl,
    fetchFn: nodeFetch,
  });
  const { account, dispose } = makeAccount({
    client,
    ledger,
    delay: realDelay,
  });
  t.teardown(dispose);
  return { api, account, ledger, clock };
};

test('renewing budgets accrue per elapsed period, with carryover', async t => {
  const { account, clock } = await prepareCore(t);
  const { issuer } = account.makeIssuer(
    'bob',
    harden({
      budgetCents: 20_000,
      renewal: { amountCents: 20_000, periodMs: WEEK_MS },
    }),
  );
  t.is(issuer.remainingCents(), 20_000);

  await issuer.createCard(harden({ spendLimitCents: 15_000 }));
  t.is(issuer.remainingCents(), 5000);

  // One period elapses: the allowance tops the budget up.
  clock.nowMs += WEEK_MS;
  t.is(issuer.remainingCents(), 25_000);
  t.is(issuer.budgetCents(), 40_000);

  // Three idle periods carry over rather than resetting.
  clock.nowMs += 3 * WEEK_MS;
  t.is(issuer.remainingCents(), 85_000);
});

test('revocation stops renewal accrual', async t => {
  const { account, clock } = await prepareCore(t);
  const { issuer, control } = account.makeIssuer(
    'bob',
    harden({
      budgetCents: 1000,
      renewal: { amountCents: 1000, periodMs: WEEK_MS },
    }),
  );
  await control.revoke();
  clock.nowMs += 10 * WEEK_MS;
  t.true(control.audit().revoked);
  // The dead grant's budget did not keep growing.
  t.is(issuer.remainingCents(), 0);
  t.is(account.listGrants()[0].budgetCents, 0);
  await t.throwsAsync(() => issuer.createCard(harden({ spendLimitCents: 1 })), {
    message: /has been revoked/,
  });
});

test('renewal is refused on sub-grants', async t => {
  const { account } = await prepareCore(t);
  const { issuer } = account.makeIssuer('bob', harden({ budgetCents: 1000 }));
  t.throws(
    () =>
      issuer.makeSubIssuer(
        'sub',
        /** @type {any} */ (
          harden({
            budgetCents: 500,
            renewal: { amountCents: 100, periodMs: WEEK_MS },
          })
        ),
      ),
    { message: /only supported on root grants/ },
  );
});

test('renewal requires a clock authority', async t => {
  const api = await makeMockPrivacyApi({ apiKey: API_KEY });
  t.teardown(() => api.close());
  const ledger = makeBudgetLedger(); // no now hook
  const client = makePrivacyClient({
    apiKey: API_KEY,
    baseUrl: api.baseUrl,
    fetchFn: nodeFetch,
  });
  const { account, dispose } = makeAccount({ client, ledger });
  t.teardown(dispose);
  t.throws(
    () =>
      account.makeIssuer(
        'bob',
        harden({
          budgetCents: 1000,
          renewal: { amountCents: 100, periodMs: WEEK_MS },
        }),
      ),
    { message: /clock authority/ },
  );
});

test('a sub-grant cannot choose its memo prefix', async t => {
  const { account } = await prepareCore(t);
  const { issuer } = account.makeIssuer('agent', harden({ budgetCents: 1000 }));
  // The prefix is how repair() attributes stranded cards; a delegatee
  // who could pick one could shed budget accounting (empty prefix) or
  // pin their stranded cards on a foreign grant.
  t.throws(
    () =>
      issuer.makeSubIssuer(
        'rogue',
        /** @type {any} */ (harden({ budgetCents: 500, memoPrefix: '' })),
      ),
    { message: /cannot be overridden/ },
  );
});

test('close reconciliation walks all transaction pages', async t => {
  const { api, account } = await prepareCore(t);
  const { issuer } = account.makeIssuer(
    'shopper',
    harden({ budgetCents: 10_000 }),
  );
  const card = await issuer.createCard(harden({ spendLimitCents: 6000 }));
  // Five transactions at the mock's page size of two spread across
  // three pages; an unwalked page would inflate the refund.
  for (let i = 0; i < 5; i += 1) {
    api.addTransaction(card.cardToken, {
      amount: -1000,
      result: 'APPROVED',
      status: 'SETTLED',
    });
  }
  t.is(await issuer.closeCard(card.cardToken), 1000);
});

test('pause and resume refuse closed cards', async t => {
  const { account } = await prepareCore(t);
  const { issuer } = account.makeIssuer(
    'shopper',
    harden({ budgetCents: 10_000 }),
  );
  const card = await issuer.createCard(harden({ spendLimitCents: 1000 }));
  await issuer.closeCard(card.cardToken);
  await t.throwsAsync(() => issuer.pauseCard(card.cardToken), {
    message: /is closed/,
  });
  await t.throwsAsync(() => issuer.resumeCard(card.cardToken), {
    message: /is closed/,
  });
});

test('revoke reports cards it could not pause and still bricks the grant', async t => {
  const { api, account } = await prepareCore(t);
  const { issuer, control } = account.makeIssuer(
    'shopper',
    harden({ budgetCents: 10_000 }),
  );
  const good = await issuer.createCard(harden({ spendLimitCents: 1000 }));
  const stuck = await issuer.createCard(harden({ spendLimitCents: 1000 }));
  api.setPatchFailing(stuck.cardToken);

  const { pausedCardTokens, failedCardTokens } = await control.revoke();
  t.deepEqual(pausedCardTokens, [good.cardToken]);
  t.deepEqual(failedCardTokens, [stuck.cardToken]);
  t.is(api.cards.get(good.cardToken).state, 'PAUSED');
  // The grant is bricked regardless of the API failure.
  await t.throwsAsync(() => issuer.createCard(harden({ spendLimitCents: 1 })), {
    message: /has been revoked/,
  });
});

test('the spend monitor reports polling errors and recovers', async t => {
  const { api, account } = await prepareCore(t);
  const { issuer, control } = account.makeIssuer(
    'shopper',
    harden({ budgetCents: 10_000 }),
  );
  await issuer.createCard(harden({ spendLimitCents: 1000 }));
  api.setTransactionsFailing(true);
  control.startSpendMonitor(harden({ intervalMs: 10 }));

  /** @type {any} */
  let report = control.readSpendMonitor();
  const deadline = Date.now() + 5000;
  while (report.lastError === undefined && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await realDelay(10);
    report = control.readSpendMonitor();
  }
  t.regex(String(report.lastError), /transactions/);
  t.true(report.active);

  api.setTransactionsFailing(false);
  while (report.lastError !== undefined && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await realDelay(10);
    report = control.readSpendMonitor();
  }
  t.is(report.lastError, undefined);
  control.stopSpendMonitor();
});

test('the auditor facet observes but cannot mutate', async t => {
  const { api, account } = await prepareCore(t);
  const { issuer, control } = account.makeIssuer(
    'reno',
    harden({ budgetCents: 10_000 }),
  );
  const card = await issuer.createCard(harden({ spendLimitCents: 6000 }));
  api.addTransaction(card.cardToken, {
    amount: -1200,
    result: 'APPROVED',
    status: 'SETTLING',
  });

  const auditor = control.makeAuditor();
  t.is(auditor.audit().remainingCents, 4000);
  const reconciled = await auditor.reconcile();
  t.is(reconciled.cards[0].approvedCents, 1200);

  // eslint-disable-next-line no-underscore-dangle
  const methods = /** @type {any} */ (auditor).__getMethodNames__();
  for (const name of ['createCard', 'deposit', 'revoke', 'makeSubIssuer']) {
    t.false(methods.includes(name));
  }
});

test('the spend monitor polls live approved spend', async t => {
  const { api, account } = await prepareCore(t);
  const { issuer, control } = account.makeIssuer(
    'shopper',
    harden({ budgetCents: 10_000 }),
  );
  const card = await issuer.createCard(harden({ spendLimitCents: 6000 }));

  control.startSpendMonitor(harden({ intervalMs: 10 }));
  api.addTransaction(card.cardToken, {
    amount: -2500,
    result: 'APPROVED',
    status: 'SETTLED',
  });

  /** @type {any} */
  let report = control.readSpendMonitor();
  const deadline = Date.now() + 5000;
  while (
    (Number(report.polls) === 0 ||
      Number(report.cards[0]?.approvedCents ?? 0) < 2500) &&
    Date.now() < deadline
  ) {
    // eslint-disable-next-line no-await-in-loop
    await realDelay(10);
    report = control.readSpendMonitor();
  }
  t.true(report.active);
  t.true(Number(report.polls) > 0);
  t.deepEqual(report.cards, [
    { cardToken: card.cardToken, reservedCents: 6000, approvedCents: 2500 },
  ]);

  control.stopSpendMonitor();
  t.false(control.readSpendMonitor().active);
});

test('revoke stops the grant’s spend monitor', async t => {
  const { account } = await prepareCore(t);
  const { issuer, control } = account.makeIssuer(
    'shopper',
    harden({ budgetCents: 10_000 }),
  );
  await issuer.createCard(harden({ spendLimitCents: 1000 }));
  control.startSpendMonitor(harden({ intervalMs: 10 }));
  t.true(control.readSpendMonitor().active);
  await control.revoke();
  t.false(control.readSpendMonitor().active);
});

test('spend monitoring without a timer authority is refused', async t => {
  const api = await makeMockPrivacyApi({ apiKey: API_KEY });
  t.teardown(() => api.close());
  const client = makePrivacyClient({
    apiKey: API_KEY,
    baseUrl: api.baseUrl,
    fetchFn: nodeFetch,
  });
  const { account, dispose } = makeAccount({
    client,
    ledger: makeBudgetLedger(),
  });
  t.teardown(dispose);
  const { control } = account.makeIssuer('bob', harden({ budgetCents: 1000 }));
  t.throws(() => control.startSpendMonitor(harden({ intervalMs: 10 })), {
    message: /timer authority/,
  });
});

test('repair adopts stranded cards by memo prefix and clears stale reservations', async t => {
  const { api, account, ledger } = await prepareCore(t);
  const { issuer } = account.makeIssuer(
    'shopper',
    harden({ budgetCents: 100_000 }),
  );
  await issuer.createCard(harden({ spendLimitCents: 10_000 }));

  // Simulate a crash between reserving and recording the card token:
  // the reservation persisted, and the card exists server-side with
  // the grant's memo tag, but the ledger has no card entry for it.
  const stalePendingId = ledger.reservePending('shopper', 30_000);
  const stranded = api.seedCard({
    memo: '[shopper] widget',
    spend_limit: 30_000,
    spend_limit_duration: 'FOREVER',
    state: 'OPEN',
    type: 'SINGLE_USE',
  });
  // A foreign card whose memo does not match must not be adopted.
  api.seedCard({
    memo: 'unrelated',
    spend_limit: 99_999,
    state: 'OPEN',
    type: 'SINGLE_USE',
  });
  t.is(issuer.remainingCents(), 60_000);

  const report = await account.repair();
  t.deepEqual(report.adoptedCards, [
    { grantName: 'shopper', cardToken: stranded.token },
  ]);
  t.deepEqual(report.rolledBackPendings, [
    { grantName: 'shopper', pendingId: stalePendingId },
  ]);
  // The stranded card's 30k is now held as a card reservation instead
  // of a stale pending: real exposure, same budget arithmetic.
  t.is(issuer.remainingCents(), 60_000);
  t.is(issuer.listCards().length, 2);

  // Repair is idempotent.
  const again = await account.repair();
  t.deepEqual(again.adoptedCards, []);
  t.deepEqual(again.rolledBackPendings, []);
});

test('repair records already-closed stranded cards as closed', async t => {
  const { api, account } = await prepareCore(t);
  const { issuer } = account.makeIssuer(
    'shopper',
    harden({ budgetCents: 10_000 }),
  );
  const stranded = api.seedCard({
    memo: '[shopper]',
    spend_limit: 4000,
    state: 'CLOSED',
    type: 'SINGLE_USE',
  });
  await account.repair();
  const [entry] = issuer.listCards();
  t.is(entry.cardToken, stranded.token);
  t.true(entry.closed);
  // Conservative: no refund is presumed for a card that already closed.
  t.is(entry.refundedCents, 0);
  t.is(issuer.remainingCents(), 6000);
});

test('repair leaves revoked grants alone', async t => {
  const { api, account } = await prepareCore(t);
  const { control } = account.makeIssuer(
    'shopper',
    harden({ budgetCents: 10_000 }),
  );
  await control.revoke();
  api.seedCard({
    memo: '[shopper] late arrival',
    spend_limit: 4000,
    state: 'OPEN',
    type: 'SINGLE_USE',
  });
  const report = await account.repair();
  t.deepEqual(report.adoptedCards, []);
});

test('a resume racing revocation cannot undo it', async t => {
  const { api, account } = await prepareCore(t);
  const { issuer, control } = account.makeIssuer(
    'shopper',
    harden({ budgetCents: 10_000 }),
  );
  const card = await issuer.createCard(harden({ spendLimitCents: 1000 }));
  await issuer.pauseCard(card.cardToken);
  // Revocation and the resume contend; the mutex serializes the
  // resume behind the revocation, so it finds the grant bricked
  // instead of landing its OPEN after the revocation's PAUSED.
  const revoked = control.revoke();
  await t.throwsAsync(() => issuer.resumeCard(card.cardToken), {
    message: /has been revoked/,
  });
  await revoked;
  t.is(api.cards.get(card.cardToken).state, 'PAUSED');
});

test('dispose stops all monitors', async t => {
  const api = await makeMockPrivacyApi({ apiKey: API_KEY });
  t.teardown(() => api.close());
  const client = makePrivacyClient({
    apiKey: API_KEY,
    baseUrl: api.baseUrl,
    fetchFn: nodeFetch,
  });
  const { account, dispose } = makeAccount({
    client,
    ledger: makeBudgetLedger(),
    delay: realDelay,
  });
  const { control } = account.makeIssuer('a', harden({ budgetCents: 1000 }));
  const { control: controlB } = account.makeIssuer(
    'b',
    harden({ budgetCents: 1000 }),
  );
  control.startSpendMonitor(harden({ intervalMs: 10 }));
  controlB.startSpendMonitor(harden({ intervalMs: 10 }));
  dispose();
  t.false(control.readSpendMonitor().active);
  t.false(controlB.readSpendMonitor().active);
});
