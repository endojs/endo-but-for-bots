// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';

import { providerCredentialOptions } from '../driver.js';

const noSecretPowers = () =>
  Far('NoSecretPowers', {
    has: async () => false,
  });

test('a brokered recipe receives no credential resolver or session', t => {
  const options = providerCredentialOptions({
    powers: noSecretPowers(),
    storedConfig: { kind: 'brokered-messages' },
  });
  t.deepEqual(Object.keys(options), []);
});

test('a subscription session carries its identity and no credential resolver', t => {
  const options = providerCredentialOptions({
    powers: noSecretPowers(),
    storedConfig: { kind: 'subscription-responses' },
    sessionId: '12abc',
  });
  t.deepEqual(options, { sessionId: '12abc' });
});

test('any other provider reads its token through the resolver', t => {
  const options = providerCredentialOptions({
    powers: noSecretPowers(),
    storedConfig: {},
  });
  t.deepEqual(Object.keys(options), ['provideAuthToken']);
  t.is(typeof options.provideAuthToken, 'function');
});
