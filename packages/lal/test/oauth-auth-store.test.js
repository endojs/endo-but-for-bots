import test from '@endo/ses-ava/prepare-endo.js';

import { bytesFromText } from '@endo/bytes/from-string.js';
import { bytesToText } from '@endo/bytes/to-string.js';
import { makeOAuthAuthStore } from '../providers/oauth/auth-store.js';
import { makeAesGcmCipher } from '../providers/oauth/node-crypto.js';

const KEY = new Uint8Array(32);
for (let i = 0; i < 32; i += 1) {
  KEY[i] = (i * 7 + 3) % 256;
}

// Wrap a cipher to capture the sealed bytes it produces, so a test can assert
// that at-rest state is ciphertext rather than plaintext.
const makeSpyCipher = inner => {
  const sealedOutputs = [];
  return {
    cipher: {
      encrypt(plaintext) {
        const sealed = inner.encrypt(plaintext);
        sealedOutputs.push(sealed);
        return sealed;
      },
      decrypt(sealed) {
        return inner.decrypt(sealed);
      },
    },
    sealedOutputs,
  };
};

const sampleCredentials = harden({
  accessToken: 'access-secret-token',
  tokenType: 'Bearer',
  refreshToken: 'refresh-secret-token',
  scope: 'inference',
  expiresAt: 1_700_000_000_000,
  obtainedAt: 1_699_999_000_000,
});

test('store then get round-trips credentials through the cipher', t => {
  const store = makeOAuthAuthStore({ cipher: makeAesGcmCipher(KEY) });
  store.store('anthropic', 'acct-1', sampleCredentials);
  t.deepEqual(store.get('anthropic', 'acct-1'), sampleCredentials);
});

test('credentials are sealed at rest, not stored as plaintext', t => {
  const { cipher, sealedOutputs } = makeSpyCipher(makeAesGcmCipher(KEY));
  const store = makeOAuthAuthStore({ cipher });
  store.store('anthropic', 'acct-1', sampleCredentials);

  t.is(sealedOutputs.length, 1);
  const sealed = sealedOutputs[0];
  const plaintext = bytesFromText(JSON.stringify(sampleCredentials));
  // The sealed blob differs from the plaintext serialization...
  t.notDeepEqual(sealed, plaintext);
  // ...and the secret token text does not survive into the sealed bytes.
  t.false(bytesToText(sealed).includes('access-secret-token'));
  t.true(bytesToText(plaintext).includes('access-secret-token'));
});

test('get returns undefined for an unknown provider or account', t => {
  const store = makeOAuthAuthStore({ cipher: makeAesGcmCipher(KEY) });
  t.is(store.get('anthropic', 'missing'), undefined);
  store.store('anthropic', 'acct-1', sampleCredentials);
  t.is(store.get('anthropic', 'other-account'), undefined);
  t.is(store.get('openai', 'acct-1'), undefined);
});

test('has and delete track presence', t => {
  const store = makeOAuthAuthStore({ cipher: makeAesGcmCipher(KEY) });
  t.false(store.has('anthropic', 'acct-1'));
  store.store('anthropic', 'acct-1', sampleCredentials);
  t.true(store.has('anthropic', 'acct-1'));
  t.true(store.delete('anthropic', 'acct-1'));
  t.false(store.has('anthropic', 'acct-1'));
  // Deleting again reports nothing was present.
  t.false(store.delete('anthropic', 'acct-1'));
});

test('listAccounts and listProviders reflect stored credentials', t => {
  const store = makeOAuthAuthStore({ cipher: makeAesGcmCipher(KEY) });
  store.store('anthropic', 'acct-1', sampleCredentials);
  store.store('anthropic', 'acct-2', sampleCredentials);
  store.store('openai', 'acct-9', sampleCredentials);
  t.deepEqual([...store.listAccounts('anthropic')].sort(), [
    'acct-1',
    'acct-2',
  ]);
  t.deepEqual(store.listAccounts('openai'), ['acct-9']);
  t.deepEqual([...store.listProviders()].sort(), ['anthropic', 'openai']);
  // A provider drops out of listProviders once its last account is removed.
  store.delete('openai', 'acct-9');
  t.deepEqual(store.listProviders(), ['anthropic']);
});

test('the store interface guard rejects a non-string access token', t => {
  const store = makeOAuthAuthStore({ cipher: makeAesGcmCipher(KEY) });
  t.throws(() =>
    // @ts-expect-error deliberately wrong type to exercise the runtime guard
    store.store('anthropic', 'acct-1', harden({ accessToken: 123 })),
  );
});
