// @ts-check
import '@endo/init';

import test from 'ava';

import { assertSubscriptionAccount } from '../src/subscription-setup.js';

test('revival requires formula-pinned account, not replacement secret account', t => {
  t.is(
    assertSubscriptionAccount('account-a', { accountId: 'account-a' }),
    'account-a',
  );
  t.throws(
    () => assertSubscriptionAccount('account-a', { accountId: 'account-b' }),
    { message: /account changed/ },
  );
  t.throws(
    () => assertSubscriptionAccount(undefined, { accountId: 'account-b' }),
    { message: /pinned account/ },
  );
});
