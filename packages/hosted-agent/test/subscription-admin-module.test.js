// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import { makeAccountReadingSource } from '../src/account-source.js';
import { makeResetRedeemer } from '../src/reset-redeemer.js';
import { make } from '../src/subscription-admin-module.js';

/**
 * A namespace like the guest a formula gets as its powers.
 * @param initial
 */
const makeNamespace = (initial = {}) => {
  const names = new Map(Object.entries(initial));
  return {
    names,
    powers: Far('powers', {
      has: async name => names.has(name),
      list: async () => [...names.keys()],
      lookup: async name => names.get(name),
      storeValue: async (value, name) => {
        names.set(name, value);
      },
      remove: async name => {
        names.delete(name);
      },
    }),
  };
};

const banked = harden({
  rateLimits: {
    windows: [],
    limitReached: true,
    resetCredits: {
      availableCount: 1,
      credits: [
        {
          id: 'credit-1',
          status: 'available',
          grantedAt: '',
          expiresAt: '2030-01-01T00:00:00.000Z',
        },
      ],
    },
  },
});

test('the intent lives in the admin’s own namespace and outlives the admin and the broker', async t => {
  const account = makeAccountReadingSource({ activeRead: async () => banked });
  /** @type {any[]} */
  const first = [];
  const space = makeNamespace({
    'account-source': account.source,
    'reset-redeemer': makeResetRedeemer(async request => {
      first.push(request);
      throw Error('lost');
    }),
  });
  const admin = await make(space.powers);
  // Nothing was read since the daemon started: the admin reads once, then
  // stores the key, then asks.
  await t.throwsAsync(() => E(admin).consumeResetCredit(), {
    message: /unconfirmed/,
  });
  t.is(first.length, 1);
  t.is(first[0].creditId, 'credit-1');
  t.regex(first[0].idempotencyKey, /^[0-9a-f-]{36}$/);
  const stored = [...space.names.keys()].filter(name =>
    name.startsWith('reset-intent-v1-'),
  );
  t.is(stored.length, 1);
  t.is(
    space.names.get(stored[0]).intent.idempotencyKey,
    first[0].idempotencyKey,
  );

  // A deploy: the broker is re-minted, setup re-points both names, and the
  // admin formula revives over the same namespace.
  /** @type {any[]} */
  const second = [];
  const account2 = makeAccountReadingSource();
  space.names.set('account-source', account2.source);
  space.names.set(
    'reset-redeemer',
    makeResetRedeemer(async request => {
      second.push(request);
      return { outcome: 'alreadyRedeemed' };
    }),
  );
  const revived = await make(space.powers);
  t.is((await E(revived).getResetState()).pending.creditId, 'credit-1');
  t.deepEqual(second, [], 'revival asks the provider nothing');
  const result = await E(revived).consumeResetCredit({ replay: true });
  t.deepEqual(result, {
    outcome: 'alreadyRedeemed',
    creditId: 'credit-1',
    replayed: true,
    pending: false,
  });
  t.is(second[0].idempotencyKey, first[0].idempotencyKey);
  t.is((await E(revived).getResetState()).pending, null);
});

test('an admin with nothing bound refuses without storing', async t => {
  const space = makeNamespace({});
  const admin = await make(space.powers);
  await t.throwsAsync(() => E(admin).consumeResetCredit());
  t.is((await E(admin).getResetState()).pending, null);
});
