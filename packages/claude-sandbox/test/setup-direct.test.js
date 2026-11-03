// @ts-check
import '@endo/init';
import test from 'ava';
import { Far } from '@endo/far';
import { main } from '../setup-direct.js';

test('direct setup publishes only a capability binding and is idempotent, with no CLI operations', async t => {
  const copies = [];
  const profile = Far('Profile', { has: () => false });
  const host = Far('Host', {
    lookup: () => profile,
    has: () => true,
    copy: (from, to) => {
      copies.push([from, to]);
    },
  });
  await main(host, { env: {} });
  await main(host, { env: {} });
  t.deepEqual(
    copies,
    Array(2).fill([
      ['@pins', 'installations', 'claude-sandbox', 'subscription'],
      ['floot', 'controller-profile', 'claude-inference'],
    ]),
  );
});
test('direct setup refuses missing dependencies before copying anything', async t => {
  const host = Far('Host', {
    has: () => false,
    copy: () => t.fail('must not publish'),
  });
  await t.throwsAsync(main(host, { env: {} }), {
    message: /Configure the Claude subscription broker/,
  });
});

test('direct setup preserves both pool account authorities and adds quota aliases exactly once', async t => {
  const accounts = ['primary-oauth', 'secondary-oauth'].map(id => ({
    accountId: id,
    providerId: 'anthropic',
    title: 'Claude',
    oracle: Far(id),
    uses: [{ backendId: 'claude', subscriptionId: id }],
  }));
  let publication = harden({ version: 1, accounts });
  let writes = 0;
  const directory = Far('Directory', {
    has: () => true,
    lookup: () => publication,
  });
  const profile = Far('Profile', {
    has: () => true,
    lookup: () => directory,
    storeValue: value => {
      publication = value;
      writes += 1;
    },
  });
  const host = Far('Host', {
    has: () => true,
    lookup: () => profile,
    copy: () => {},
  });
  await main(host, { env: {} });
  await main(host, { env: {} });
  t.is(writes, 1);
  for (const [index, account] of publication.accounts.entries()) {
    t.is(account.oracle, accounts[index].oracle);
    t.is(account.accountId, accounts[index].accountId);
    t.deepEqual(account.uses, [
      ...accounts[index].uses,
      { backendId: 'fae-claude', subscriptionId: accounts[index].accountId },
    ]);
  }
});
