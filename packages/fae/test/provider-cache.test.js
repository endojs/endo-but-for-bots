// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { makeRotatingProvider } from '../src/provider-cache.js';

test('an injected provider is used as-is and no token is read', async t => {
  const injected = harden({ chat: async () => harden({ message: {} }) });
  let reads = 0;
  const currentProvider = makeRotatingProvider({
    config: { provider: injected },
    provideAuthToken: async () => {
      reads += 1;
      return 'unused';
    },
  });
  t.is(await currentProvider(), injected);
  t.is(reads, 0);
});

test('the token is re-read every turn and the provider follows a rotation', async t => {
  /** @type {string[]} */
  const built = [];
  let token = 'first-token';
  let reads = 0;
  const currentProvider = makeRotatingProvider({
    config: { host: 'https://example.invalid', model: 'm' },
    provideAuthToken: async () => {
      reads += 1;
      return token;
    },
    buildProvider: env => {
      built.push(`${env.LAL_AUTH_TOKEN}`);
      return harden({ token: env.LAL_AUTH_TOKEN });
    },
  });

  const first = await currentProvider();
  const second = await currentProvider();
  t.is(reads, 2, 'the secret is read for every turn, not once per loop');
  t.is(second, first, 'an unrotated token reuses the provider it built');
  t.deepEqual(built, ['first-token']);

  // A rotation replaces the bytes behind the same capability, so nothing here
  // changes except what the read returns.
  token = 'rotated-token';
  const third = await currentProvider();
  t.not(third, first);
  t.deepEqual(built, ['first-token', 'rotated-token']);
});

test('a revoked secret fails the turn rather than falling back', async t => {
  const currentProvider = makeRotatingProvider({
    config: { host: 'https://example.invalid', model: 'm' },
    provideAuthToken: async () => {
      throw Error('SECRET_REVOKED');
    },
    buildProvider: () => harden({}),
  });
  await t.throwsAsync(currentProvider(), { message: /SECRET_REVOKED/ });
});

test('without a token thunk the configured plaintext token is used once', async t => {
  /** @type {string[]} */
  const built = [];
  const currentProvider = makeRotatingProvider({
    config: { host: 'h', model: 'm', authToken: 'legacy' },
    buildProvider: env => {
      built.push(`${env.LAL_AUTH_TOKEN}`);
      return harden({});
    },
  });
  await currentProvider();
  await currentProvider();
  t.deepEqual(built, ['legacy']);
});
