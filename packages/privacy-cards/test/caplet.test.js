// @ts-check
/* global setTimeout */

// Establish a SES perimeter (provides the `harden` global).
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { make } from '../src/caplet.js';
import { makeMockPrivacyApi } from './mock-privacy-api.js';

const API_KEY = 'test-key-do-not-leak';

/**
 * @param {import('ava').ExecutionContext} t
 * @param {Record<string, string>} [extraEnv]
 */
const prepareAccount = async (t, extraEnv = {}) => {
  const api = await makeMockPrivacyApi({ apiKey: API_KEY });
  t.teardown(() => api.close());
  const account = make(undefined, undefined, {
    env: {
      PRIVACY_API_KEY: API_KEY,
      PRIVACY_API_BASE_URL: api.baseUrl,
      ...extraEnv,
    },
  });
  return { api, account };
};

test('make requires an API key', t => {
  t.throws(() => make(undefined, undefined, { env: {} }), {
    message: /PRIVACY_API_KEY is required/,
  });
});

test('status probes the API', async t => {
  const { account } = await prepareAccount(t);
  t.true(await account.status());
});

test('issuer creates cards only up to its budget, across any number of cards', async t => {
  const { api, account } = await prepareAccount(t);
  const { issuer } = account.makeIssuer(
    'shopper',
    harden({ budgetCents: 100_000 }),
  );

  const first = await issuer.createCard(harden({ spendLimitCents: 60_000 }));
  t.regex(first.pan, /^\d{16}$/);
  t.is(first.cvv, '776');
  t.is(first.state, 'OPEN');
  await issuer.createCard(harden({ spendLimitCents: 30_000 }));
  t.is(issuer.remainingCents(), 10_000);

  await t.throwsAsync(
    () => issuer.createCard(harden({ spendLimitCents: 20_000 })),
    { message: /exceeds the remaining budget/ },
  );
  t.is(issuer.remainingCents(), 10_000);

  // Privacy.com enforces each card's cap for the card's lifetime.
  const created = api.cards.get(first.cardToken);
  t.is(created.spend_limit, 60_000);
  t.is(created.spend_limit_duration, 'FOREVER');
});

test('card memos carry the grant tag', async t => {
  const { api, account } = await prepareAccount(t);
  const { issuer } = account.makeIssuer('reno', harden({ budgetCents: 5000 }));
  const bare = await issuer.createCard(harden({ spendLimitCents: 1000 }));
  const tagged = await issuer.createCard(
    harden({ spendLimitCents: 1000, memo: 'lumber' }),
  );
  t.is(api.cards.get(bare.cardToken).memo, '[reno]');
  t.is(api.cards.get(tagged.cardToken).memo, '[reno] lumber');
});

test('card types outside the grant are refused before any API call', async t => {
  const { account } = await prepareAccount(t);
  const { issuer } = account.makeIssuer(
    'shopper',
    harden({ budgetCents: 5000 }),
  );
  await t.throwsAsync(
    () =>
      issuer.createCard(harden({ spendLimitCents: 1000, type: 'UNLOCKED' })),
    { message: /not allowed for grant/ },
  );
  const { issuer: privileged } = account.makeIssuer(
    'trusted',
    harden({ budgetCents: 5000, allowedTypes: ['UNLOCKED'] }),
  );
  const card = await privileged.createCard(
    harden({ spendLimitCents: 1000, type: 'UNLOCKED' }),
  );
  t.is(card.type, 'UNLOCKED');
});

test('closing a card reconciles transactions and refunds the rest', async t => {
  const { api, account } = await prepareAccount(t);
  const { issuer } = account.makeIssuer(
    'shopper',
    harden({ budgetCents: 10_000 }),
  );
  const card = await issuer.createCard(harden({ spendLimitCents: 6000 }));
  api.addTransaction(card.cardToken, {
    amount: -2500,
    result: 'APPROVED',
    status: 'SETTLED',
  });
  api.addTransaction(card.cardToken, {
    amount: -9999,
    result: 'CARD_PAUSED',
    status: 'DECLINED',
  });
  const refund = await issuer.closeCard(card.cardToken);
  t.is(refund, 3500);
  t.is(issuer.remainingCents(), 7500);
  t.is(api.cards.get(card.cardToken).state, 'CLOSED');
  await t.throwsAsync(() => issuer.closeCard(card.cardToken), {
    message: /already closed/,
  });
});

test('pause and resume reach only the grant’s own cards', async t => {
  const { api, account } = await prepareAccount(t);
  const { issuer } = account.makeIssuer('bob', harden({ budgetCents: 5000 }));
  const { issuer: other } = account.makeIssuer(
    'eve',
    harden({ budgetCents: 5000 }),
  );
  const card = await issuer.createCard(harden({ spendLimitCents: 1000 }));

  await issuer.pauseCard(card.cardToken);
  t.is(api.cards.get(card.cardToken).state, 'PAUSED');
  await issuer.resumeCard(card.cardToken);
  t.is(api.cards.get(card.cardToken).state, 'OPEN');

  await t.throwsAsync(() => other.pauseCard(card.cardToken), {
    message: /has no card with token/,
  });
});

test('a failed create rolls the reservation back', async t => {
  const { api, account } = await prepareAccount(t);
  const { issuer } = account.makeIssuer(
    'shopper',
    harden({ budgetCents: 5000 }),
  );
  api.failNextCreate();
  const error = await t.throwsAsync(() =>
    issuer.createCard(harden({ spendLimitCents: 4000 })),
  );
  // The client reports status and server message, never the key.
  t.false(/** @type {Error} */ (error).message.includes(API_KEY));
  t.is(issuer.remainingCents(), 5000);
  await issuer.createCard(harden({ spendLimitCents: 4000 }));
  t.is(issuer.remainingCents(), 1000);
});

test('concurrent card creation cannot double-spend the budget', async t => {
  const { account } = await prepareAccount(t);
  const { issuer } = account.makeIssuer(
    'racer',
    harden({ budgetCents: 100_000 }),
  );
  const settled = await Promise.allSettled([
    issuer.createCard(harden({ spendLimitCents: 60_000 })),
    issuer.createCard(harden({ spendLimitCents: 60_000 })),
  ]);
  const outcomes = settled.map(result => result.status).sort();
  t.deepEqual(outcomes, ['fulfilled', 'rejected']);
  t.is(issuer.remainingCents(), 40_000);
});

test('sub-issuers escrow from the parent and cannot escalate card types', async t => {
  const { api, account } = await prepareAccount(t);
  const { issuer } = account.makeIssuer(
    'agent',
    harden({ budgetCents: 100_000 }),
  );

  t.throws(
    () =>
      issuer.makeSubIssuer(
        'rogue',
        harden({ budgetCents: 1000, allowedTypes: ['UNLOCKED'] }),
      ),
    { message: /exceeds parent grant/ },
  );

  const { issuer: sub, control: subControl } = issuer.makeSubIssuer(
    'vendor-a',
    harden({ budgetCents: 25_000 }),
  );
  t.is(issuer.remainingCents(), 75_000);

  const card = await sub.createCard(harden({ spendLimitCents: 10_000 }));
  t.is(api.cards.get(card.cardToken).memo, '[agent/vendor-a]');
  t.is(sub.remainingCents(), 15_000);

  const { pausedCardTokens, failedCardTokens } = await subControl.revoke();
  t.deepEqual(pausedCardTokens, [card.cardToken]);
  t.deepEqual(failedCardTokens, []);
  t.is(api.cards.get(card.cardToken).state, 'PAUSED');
  // The unconsumed 15k returns to the parent; the 10k card stays spent.
  t.is(issuer.remainingCents(), 90_000);
  await t.throwsAsync(() => sub.createCard(harden({ spendLimitCents: 1 })), {
    message: /has been revoked/,
  });
});

test('revoking a grant pauses its open cards and bricks the issuer', async t => {
  const { api, account } = await prepareAccount(t);
  const { issuer, control } = account.makeIssuer(
    'shopper',
    harden({ budgetCents: 10_000 }),
  );
  const card = await issuer.createCard(harden({ spendLimitCents: 4000 }));

  const { pausedCardTokens } = await control.revoke();
  t.deepEqual(pausedCardTokens, [card.cardToken]);
  t.is(api.cards.get(card.cardToken).state, 'PAUSED');
  await t.throwsAsync(() => issuer.createCard(harden({ spendLimitCents: 1 })), {
    message: /has been revoked/,
  });
  // Revocation is idempotent.
  t.deepEqual((await control.revoke()).pausedCardTokens, []);
});

test('audit and reconcile report per-card spend', async t => {
  const { api, account } = await prepareAccount(t);
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

  const audit = control.audit();
  t.is(audit.budgetCents, 10_000);
  t.is(audit.remainingCents, 4000);
  t.is(audit.cards.length, 1);

  const reconciled = await control.reconcile();
  t.is(reconciled.cards[0].approvedCents, 1200);
});

test('deposit grows the budget from the control facet only', async t => {
  const { account } = await prepareAccount(t);
  const { issuer, control } = account.makeIssuer(
    'bob',
    harden({ budgetCents: 1000 }),
  );
  control.deposit(500);
  t.is(issuer.remainingCents(), 1500);
  // eslint-disable-next-line no-underscore-dangle
  const issuerMethods = /** @type {any} */ (issuer).__getMethodNames__();
  t.false(issuerMethods.includes('deposit'));
  t.false(issuerMethods.includes('revoke'));
});

test('the ledger survives a caplet restart via the state file', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-cards-'));
  t.teardown(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'ledger.json');

  const { api, account } = await prepareAccount(t, {
    PRIVACY_STATE_FILE: stateFile,
  });
  const { issuer } = account.makeIssuer(
    'shopper',
    harden({ budgetCents: 100_000 }),
  );
  await issuer.createCard(harden({ spendLimitCents: 60_000 }));

  // Simulate a daemon restart: a fresh make() with the same env.
  const revived = make(undefined, undefined, {
    env: {
      PRIVACY_API_KEY: API_KEY,
      PRIVACY_API_BASE_URL: api.baseUrl,
      PRIVACY_STATE_FILE: stateFile,
    },
  });
  const { issuer: recovered } = revived.provideIssuer('shopper');
  t.is(recovered.remainingCents(), 40_000);
  await recovered.createCard(harden({ spendLimitCents: 40_000 }));
  await t.throwsAsync(
    () => recovered.createCard(harden({ spendLimitCents: 1 })),
    { message: /exceeds the remaining budget/ },
  );
});

test('a corrupt state file refuses to start rather than resetting budgets', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-cards-'));
  t.teardown(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'ledger.json');
  fs.writeFileSync(stateFile, 'not json at all{');
  const api = await makeMockPrivacyApi({ apiKey: API_KEY });
  t.teardown(() => api.close());
  // Swallowing the parse error here would silently reset every
  // grant's budget on restart — the exact failure persistence exists
  // to prevent — so the caplet must refuse to come up instead.
  t.throws(
    () =>
      make(undefined, undefined, {
        env: {
          PRIVACY_API_KEY: API_KEY,
          PRIVACY_API_BASE_URL: api.baseUrl,
          PRIVACY_STATE_FILE: stateFile,
        },
      }),
    { instanceOf: SyntaxError },
  );
});

test('caplet cancellation stops spend monitors', async t => {
  const api = await makeMockPrivacyApi({ apiKey: API_KEY });
  t.teardown(() => api.close());
  /** @type {(reason: Error) => void} */
  let cancel = () => {};
  const context = harden({
    whenCancelled: () =>
      new Promise((_resolve, reject) => {
        cancel = reject;
      }),
  });
  const account = make(undefined, context, {
    env: {
      PRIVACY_API_KEY: API_KEY,
      PRIVACY_API_BASE_URL: api.baseUrl,
    },
  });
  const { issuer, control } = account.makeIssuer(
    'shopper',
    harden({ budgetCents: 10_000 }),
  );
  await issuer.createCard(harden({ spendLimitCents: 1000 }));
  control.startSpendMonitor(harden({ intervalMs: 10 }));
  t.true(control.readSpendMonitor().active);

  cancel(new Error('formula cancelled'));
  const deadline = Date.now() + 5000;
  while (control.readSpendMonitor().active && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => {
      setTimeout(resolve, 10);
    });
  }
  t.false(control.readSpendMonitor().active);
});

test('no facet method or help text exposes the API key', async t => {
  const { account } = await prepareAccount(t);
  const { issuer, control } = account.makeIssuer(
    'bob',
    harden({ budgetCents: 1000 }),
  );
  for (const facet of [account, issuer, control]) {
    // eslint-disable-next-line no-underscore-dangle
    const methods = /** @type {any} */ (facet).__getMethodNames__();
    for (const name of methods) {
      t.false(/key|secret/i.test(String(name)));
    }
    t.false(facet.help().includes(API_KEY));
  }
});
