// @ts-check

// Establish a SES perimeter (provides the `harden` global).
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';

import { assertCents, makeBudgetLedger } from '../src/ledger.js';

test('reserve, commit, and remaining accounting', t => {
  const ledger = makeBudgetLedger();
  ledger.createGrant('bob', { budgetCents: 100_000 });
  t.is(ledger.remainingCents('bob'), 100_000);

  const pendingId = ledger.reservePending('bob', 30_000);
  t.is(ledger.remainingCents('bob'), 70_000);
  ledger.commitPending('bob', pendingId, 'card-1');
  t.is(ledger.remainingCents('bob'), 70_000);

  t.deepEqual(ledger.grantInfo('bob').cards, [
    {
      cardToken: 'card-1',
      reservedCents: 30_000,
      closed: false,
      refundedCents: 0,
    },
  ]);
});

test('rollback returns the reservation', t => {
  const ledger = makeBudgetLedger();
  ledger.createGrant('bob', { budgetCents: 1000 });
  const pendingId = ledger.reservePending('bob', 600);
  t.is(ledger.remainingCents('bob'), 400);
  ledger.rollbackPending('bob', pendingId);
  t.is(ledger.remainingCents('bob'), 1000);
});

test('cannot reserve past the budget across many cards', t => {
  const ledger = makeBudgetLedger();
  ledger.createGrant('bob', { budgetCents: 100_000 });
  for (let i = 0; i < 4; i += 1) {
    ledger.commitPending('bob', ledger.reservePending('bob', 25_000), `c${i}`);
  }
  t.is(ledger.remainingCents('bob'), 0);
  t.throws(() => ledger.reservePending('bob', 1), {
    message: /exceeds the remaining budget/,
  });
});

test('closing a card refunds the unspent reservation, conservatively', t => {
  const ledger = makeBudgetLedger();
  ledger.createGrant('bob', { budgetCents: 10_000 });
  ledger.commitPending('bob', ledger.reservePending('bob', 6000), 'card-1');
  const refund = ledger.closeCard('bob', 'card-1', 2500);
  t.is(refund, 3500);
  t.is(ledger.remainingCents('bob'), 7500);
  // Over-spend beyond the reservation never yields a negative refund.
  ledger.commitPending('bob', ledger.reservePending('bob', 1000), 'card-2');
  t.is(ledger.closeCard('bob', 'card-2', 9999), 0);
  t.throws(() => ledger.closeCard('bob', 'card-2', 0), {
    message: /already closed/,
  });
});

test('card ownership is scoped to the grant', t => {
  const ledger = makeBudgetLedger();
  ledger.createGrant('bob', { budgetCents: 1000 });
  ledger.createGrant('eve', { budgetCents: 1000 });
  ledger.commitPending('bob', ledger.reservePending('bob', 500), 'card-bob');
  t.throws(() => ledger.getOwnCard('eve', 'card-bob'), {
    message: /has no card with token/,
  });
});

test('sub-grants escrow their whole budget from the parent', t => {
  const ledger = makeBudgetLedger();
  ledger.createGrant('bob', { budgetCents: 100_000 });
  ledger.createGrant('bob/helper', {
    budgetCents: 25_000,
    parentName: 'bob',
  });
  t.is(ledger.remainingCents('bob'), 75_000);
  t.is(ledger.remainingCents('bob/helper'), 25_000);
  // Parent and child together cannot exceed the original budget.
  t.throws(() => ledger.reservePending('bob', 80_000), {
    message: /exceeds the remaining budget/,
  });
  t.throws(
    () =>
      ledger.createGrant('bob/greedy', {
        budgetCents: 80_000,
        parentName: 'bob',
      }),
    { message: /exceeds the remaining budget/ },
  );
});

test('revoking a sub-grant refunds its unconsumed budget to the parent', t => {
  const ledger = makeBudgetLedger();
  ledger.createGrant('bob', { budgetCents: 100_000 });
  ledger.createGrant('bob/helper', {
    budgetCents: 25_000,
    parentName: 'bob',
  });
  ledger.commitPending(
    'bob/helper',
    ledger.reservePending('bob/helper', 10_000),
    'card-h',
  );
  const { openCardTokens } = ledger.revokeGrant('bob/helper');
  t.deepEqual(openCardTokens, ['card-h']);
  // The 15k the helper never used returns to bob; the 10k card stays
  // accounted against him.
  t.is(ledger.remainingCents('bob'), 90_000);
  t.throws(() => ledger.reservePending('bob/helper', 1), {
    message: /has been revoked/,
  });
});

test('revocation cascades through descendants', t => {
  const ledger = makeBudgetLedger();
  ledger.createGrant('a', { budgetCents: 10_000 });
  ledger.createGrant('a/b', { budgetCents: 5000, parentName: 'a' });
  ledger.createGrant('a/b/c', { budgetCents: 2000, parentName: 'a/b' });
  ledger.commitPending('a/b/c', ledger.reservePending('a/b/c', 500), 'card-c');
  const { openCardTokens } = ledger.revokeGrant('a/b');
  t.deepEqual(openCardTokens, ['card-c']);
  t.true(ledger.grantInfo('a/b/c').revoked);
  // Only the 500-cent card remains consumed out of the 5000 escrow.
  t.is(ledger.remainingCents('a'), 9500);
});

test('deposit grows a root budget and escrows from the parent otherwise', t => {
  const ledger = makeBudgetLedger();
  ledger.createGrant('bob', { budgetCents: 1000 });
  ledger.deposit('bob', 500);
  t.is(ledger.remainingCents('bob'), 1500);
  ledger.createGrant('bob/sub', { budgetCents: 1000, parentName: 'bob' });
  t.is(ledger.remainingCents('bob'), 500);
  ledger.deposit('bob/sub', 500);
  t.is(ledger.remainingCents('bob'), 0);
  t.is(ledger.remainingCents('bob/sub'), 1500);
  t.throws(() => ledger.deposit('bob/sub', 1), {
    message: /exceeds the remaining budget/,
  });
});

test('state round-trips through persistence hooks', t => {
  /** @type {any} */
  let persisted;
  const ledger = makeBudgetLedger({
    persist: state => {
      persisted = JSON.parse(JSON.stringify(state));
    },
  });
  ledger.createGrant('bob', { budgetCents: 2000 });
  ledger.commitPending('bob', ledger.reservePending('bob', 700), 'card-1');

  const revived = makeBudgetLedger({ restore: () => persisted });
  t.is(revived.remainingCents('bob'), 1300);
  t.deepEqual(revived.grantInfo('bob').cards, [
    {
      cardToken: 'card-1',
      reservedCents: 700,
      closed: false,
      refundedCents: 0,
    },
  ]);
});

test('cents validation rejects floats, negatives, and non-numbers', t => {
  t.is(assertCents(0, 'x'), 0);
  t.is(assertCents(100_000, 'x'), 100_000);
  for (const bad of [1.5, -1, NaN, Infinity, '100', 2 ** 53]) {
    t.throws(() => assertCents(bad, 'x'), {
      message: /non-negative safe integer/,
    });
  }
});

test('renewal accrues whole elapsed periods only, and survives persistence', t => {
  const clock = { nowMs: 0 };
  /** @type {any} */
  let persisted;
  const ledger = makeBudgetLedger({
    now: () => clock.nowMs,
    persist: state => {
      persisted = JSON.parse(JSON.stringify(state));
    },
  });
  ledger.createGrant('bob', {
    budgetCents: 1000,
    renewal: { amountCents: 500, periodMs: 100 },
  });
  clock.nowMs = 99;
  t.is(ledger.remainingCents('bob'), 1000);
  clock.nowMs = 100;
  t.is(ledger.remainingCents('bob'), 1500);
  clock.nowMs = 350;
  t.is(ledger.remainingCents('bob'), 2500);
  // A revived ledger picks up where the accrual left off.
  clock.nowMs = 450;
  const revived = makeBudgetLedger({
    now: () => clock.nowMs,
    restore: () => persisted,
  });
  t.is(revived.remainingCents('bob'), 3000);
});

test('renewal rejects sub-grants, missing clocks, and bad schedules', t => {
  const clock = { nowMs: 0 };
  const ledger = makeBudgetLedger({ now: () => clock.nowMs });
  ledger.createGrant('bob', { budgetCents: 1000 });
  t.throws(
    () =>
      ledger.createGrant('bob/sub', {
        budgetCents: 100,
        parentName: 'bob',
        renewal: { amountCents: 100, periodMs: 100 },
      }),
    { message: /only supported on root grants/ },
  );
  t.throws(
    () =>
      ledger.createGrant('bad', {
        budgetCents: 100,
        renewal: { amountCents: 0, periodMs: 100 },
      }),
    { message: /positive amountCents and periodMs/ },
  );
  t.throws(
    () =>
      ledger.createGrant('bad', {
        budgetCents: 100,
        renewal: { amountCents: 100, periodMs: 0 },
      }),
    { message: /positive amountCents and periodMs/ },
  );
  const clockless = makeBudgetLedger();
  t.throws(
    () =>
      clockless.createGrant('bob', {
        budgetCents: 100,
        renewal: { amountCents: 100, periodMs: 100 },
      }),
    { message: /clock authority/ },
  );
});

test('adoptCard records exposure without a budget check', t => {
  const ledger = makeBudgetLedger();
  ledger.createGrant('bob', { budgetCents: 1000 });
  // Adoption may overdraw: the card exists, so reality wins.
  ledger.adoptCard('bob', 'card-x', 5000);
  t.is(ledger.remainingCents('bob'), -4000);
  t.throws(() => ledger.reservePending('bob', 1), {
    message: /exceeds the remaining budget/,
  });
  t.throws(() => ledger.adoptCard('bob', 'card-x', 5000), {
    message: /already recorded/,
  });
  // Closing an adopted card refunds like any other.
  t.is(ledger.closeCard('bob', 'card-x', 5000), 0);
});

test('pendingIds lists stranded reservations', t => {
  const ledger = makeBudgetLedger();
  ledger.createGrant('bob', { budgetCents: 1000 });
  t.deepEqual(ledger.pendingIds('bob'), []);
  const pendingId = ledger.reservePending('bob', 500);
  t.deepEqual(ledger.pendingIds('bob'), [pendingId]);
});

test('grant names must be unique and well-formed', t => {
  const ledger = makeBudgetLedger();
  ledger.createGrant('bob', { budgetCents: 1 });
  t.throws(() => ledger.createGrant('bob', { budgetCents: 1 }), {
    message: /already exists/,
  });
  t.throws(() => ledger.createGrant('', { budgetCents: 1 }), {
    message: /non-empty single-line/,
  });
  t.throws(() => ledger.createGrant('a\nb', { budgetCents: 1 }), {
    message: /non-empty single-line/,
  });
});
