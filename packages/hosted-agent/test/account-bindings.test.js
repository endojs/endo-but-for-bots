// @ts-check
import '@endo/init';
import test from 'ava';
import { Far } from '@endo/far';
import {
  assertAccountBindings,
  makeAccountId,
} from '../src/account-bindings.js';

const account = harden({
  accountId: makeAccountId({
    providerId: 'provider',
    accountAuthority: 'pool',
    subscriptionId: 'first',
  }),
  providerId: 'provider',
  title: 'Account',
  oracle: Far('oracle', {}),
  uses: [{ backendId: 'runtime' }],
});

test('account identity separates provider, declared authority, and member', t => {
  const identity = {
    providerId: 'provider',
    accountAuthority: 'pool',
    subscriptionId: 'first',
  };
  t.is(makeAccountId(identity), account.accountId);
  for (const change of [
    { providerId: 'other' },
    { accountAuthority: 'other' },
    { subscriptionId: 'other' },
    { subscriptionId: undefined },
  ]) {
    t.not(makeAccountId({ ...identity, ...change }), account.accountId);
  }
  t.throws(() => makeAccountId({ ...identity, accountAuthority: '' }));
});

test('publication accepts only paired capabilities and explicit unique uses', t => {
  t.is(
    assertAccountBindings(harden({ version: 1, accounts: [account] }))
      .accounts[0],
    account,
  );
  for (const entry of [
    { ...account, adminId: 'admin' },
    { ...account, admin: Far('admin', {}) },
    { ...account, oracle: 'pet-name' },
    { ...account, uses: [] },
    { ...account, uses: [{ backendId: 'runtime' }, { backendId: 'runtime' }] },
    { ...account, legacyName: 'old' },
  ]) {
    t.throws(() =>
      assertAccountBindings(harden({ version: 1, accounts: [entry] })),
    );
  }
  t.throws(() =>
    assertAccountBindings(harden({ version: 1, accounts: [account, account] })),
  );
});

test('unavailable publication never carries account authority', t => {
  t.true(
    assertAccountBindings(
      harden({ version: 1, accounts: [], unavailable: true }),
    ).unavailable,
  );
  t.throws(() =>
    assertAccountBindings(
      harden({ version: 1, accounts: [account], unavailable: true }),
    ),
  );
  t.throws(() =>
    assertAccountBindings(
      harden({ version: 1, accounts: [], unavailable: false }),
    ),
  );
});
