// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { Far } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';

import { makeProviderOwner } from '../src/provider-owner.js';

test('Fae constructs OpenRouter with a rotating secret and fails after revocation', async t => {
  let token = 'first-test-key';
  const owner = makeProviderOwner({
    config: { host: 'https://openrouter.ai/api/v1', model: 'vendor/model' },
    provideAuthToken: async () => token,
  });
  t.teardown(() => owner.dispose());
  const provider = owner.forTurn;
  const first = await provider();
  t.is(typeof first.chat, 'function');
  token = 'second-test-key';
  t.not(await provider(), first);
  token = '';
  await t.throwsAsync(provider, { message: /key/ });
});

test('an injected provider is used as-is and no token is read', async t => {
  const injected = harden({ chat: async () => harden({ message: {} }) });
  let reads = 0;
  const owner = makeProviderOwner({
    config: { provider: injected },
    provideAuthToken: async () => {
      reads += 1;
      return 'unused';
    },
  });
  t.teardown(() => owner.dispose());
  const currentProvider = owner.forTurn;
  t.is(await currentProvider(), injected);
  t.is(reads, 0);
});

test('the token is re-read every turn and the provider follows a rotation', async t => {
  /** @type {string[]} */
  const built = [];
  let token = 'first-token';
  let reads = 0;
  const owner = makeProviderOwner({
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
  t.teardown(() => owner.dispose());
  const currentProvider = owner.forTurn;

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
  const owner = makeProviderOwner({
    config: { host: 'https://example.invalid', model: 'm' },
    provideAuthToken: async () => {
      throw Error('SECRET_REVOKED');
    },
    buildProvider: () => harden({}),
  });
  t.teardown(() => owner.dispose());
  const currentProvider = owner.forTurn;
  await t.throwsAsync(currentProvider(), { message: /SECRET_REVOKED/ });
});

test('without a token thunk a tokenless provider is cached', async t => {
  /** @type {string[]} */
  const built = [];
  const owner = makeProviderOwner({
    config: { host: 'http://localhost:11434', model: 'm' },
    buildProvider: env => {
      built.push(`${env.LAL_AUTH_TOKEN}`);
      return harden({});
    },
  });
  t.teardown(() => owner.dispose());
  const currentProvider = owner.forTurn;
  await currentProvider();
  await currentProvider();
  t.deepEqual(built, ['']);
});

test('inline authToken is rejected even beside a Secret resolver', t => {
  for (const authToken of ['legacy', '', undefined]) {
    t.throws(
      () =>
        makeProviderOwner({
          config: { authToken },
          provideAuthToken: async () => 'secret',
        }),
      { message: /Inline provider authToken is unsupported/ },
    );
  }
});

test('subscription recipe never reads a Secret and retains one local adapter', async t => {
  let reads = 0;
  let descriptions = 0;
  const subscription = Far('Subscription', {
    describe: () => {
      descriptions += 1;
      return harden({ models: ['luna'] });
    },
  });
  const owner = makeProviderOwner({
    config: { kind: 'subscription-responses', subscription, model: 'luna' },
    sessionId: 'agent-identity',
    provideAuthToken: async () => {
      reads += 1;
      throw Error('must not read');
    },
  });
  t.teardown(() => owner.dispose());
  const first = await owner.forTurn();
  t.is(await owner.forTurn(), first);
  t.is(
    descriptions,
    0,
    'provider selection is inert; admission occurs on inference',
  );
  t.is(reads, 0);
  await owner.dispose();
  await t.throwsAsync(owner.forTurn, { message: /owner disposed/ });
  await t.throwsAsync(() => first.chat([], []), {
    message: /provider disposed/,
  });
});

test('a subscription cannot carry ambient host, secret or injected provider options', t => {
  const config = {
    kind: 'subscription-responses',
    subscription: Far('Subscription', {}),
    model: 'luna',
  };
  for (const fields of [
    { host: 'https://example.invalid' },
    { authSecretName: 'key' },
    { provider: {} },
    { unknown: true },
  ]) {
    t.throws(
      () =>
        makeProviderOwner({ config: { ...config, ...fields }, sessionId: 's' }),
      { message: /Invalid subscription Responses recipe/ },
    );
  }
  t.throws(() => makeProviderOwner({ config }), {
    message: /identity required/,
  });
  t.throws(() => makeProviderOwner({ config: { kind: 'other' } }), {
    message: /Unsupported/,
  });
  t.throws(
    () => makeProviderOwner({ config: { subscription: config.subscription } }),
    { message: /requires/ },
  );
});

test('disposal fences a provider construction waiting for a Secret', async t => {
  t.timeout(5000);
  const token = makePromiseKit();
  let built = 0;
  const owner = makeProviderOwner({
    config: { host: 'https://example.invalid', model: 'm' },
    provideAuthToken: () => token.promise,
    buildProvider: () => {
      built += 1;
      return harden({});
    },
  });
  t.teardown(() => owner.dispose());
  const pending = owner.forTurn();
  const rejected = t.throwsAsync(pending, { message: /owner disposed/ });
  await owner.dispose();
  token.resolve('late token');
  await rejected;
  t.is(built, 0);
});
