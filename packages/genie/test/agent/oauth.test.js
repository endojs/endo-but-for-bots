// @ts-check

/**
 * Tests for `src/agent/oauth.js` — Genie's subscription-OAuth wiring over
 * `@earendil-works/pi-ai`'s OAuth scaffolding, and its integration into
 * `makePiAgent`.
 *
 * The invariants pinned here:
 *
 * - The in-process reference store (`makeMemoryOAuthStore`) round-trips
 *   credentials by provider id.
 * - `makeApiKeyResolver` resolves an OAuth subscription token for a provider
 *   that has stored credentials, refreshing and re-persisting on expiry, and
 *   falls back to an environment API key for key-based providers.
 * - `loginOAuthProvider` runs a provider's login flow and persists the result.
 * - `applyOAuthModelModifications` applies a provider's credential-derived
 *   model rewrites (only) when credentials are present.
 * - `makePiAgent` installs a `getApiKey` callback that hands an OAuth
 *   subscription token to pi-agent-core, while the local ollama masquerade
 *   still authenticates with its own sentinel key.
 *
 * Faux OAuth providers are registered into pi-ai's OAuth registry (the same
 * registry `resolveOAuthApiKey` reads through) so the refresh/persist loop is
 * exercised end to end without a real browser or network.
 */

import '@endo/harden';

import test from 'ava';

import {
  registerOAuthProvider,
  unregisterOAuthProvider,
} from '@earendil-works/pi-ai/oauth';

/** @import { ExecutionContext } from 'ava' */
/**
 * @import {
 *   OAuthCredentials,
 *   OAuthProviderInterface,
 * } from '@earendil-works/pi-ai/oauth'
 */

import {
  applyOAuthModelModifications,
  isOAuthProvider,
  listOAuthProviderIds,
  loginOAuthProvider,
  makeApiKeyResolver,
  makeMemoryOAuthStore,
  resolveOAuthApiKey,
} from '../../src/agent/oauth.js';
import { makePiAgent } from '../../src/agent/index.js';

// Fixtures

const HOUR = 60 * 60 * 1000;

/**
 * Register a controllable faux OAuth provider and schedule its removal.
 *
 * @param {ExecutionContext} t
 * @param {object} options
 * @param {string} options.id
 * @param {OAuthCredentials} [options.loginResult]
 * @param {OAuthCredentials} [options.refreshResult]
 * @param {(models: any[], creds: any) => any[]} [options.modifyModels]
 * @returns {{ loginCalls: any[], refreshCalls: any[] }}
 */
const registerFauxOAuthProvider = (
  t,
  { id, loginResult, refreshResult, modifyModels },
) => {
  const loginCalls = [];
  const refreshCalls = [];
  /** @type {OAuthProviderInterface} */
  const provider = {
    id,
    name: `Faux ${id}`,
    async login(callbacks) {
      loginCalls.push(callbacks);
      return (
        loginResult || {
          access: `${id}-login-access`,
          refresh: `${id}-login-refresh`,
          expires: Date.now() + HOUR,
        }
      );
    },
    async refreshToken(creds) {
      refreshCalls.push(creds);
      return (
        refreshResult || {
          access: `${id}-refreshed-access`,
          refresh: `${id}-refreshed-refresh`,
          expires: Date.now() + HOUR,
        }
      );
    },
    getApiKey(creds) {
      return creds.access;
    },
    ...(modifyModels ? { modifyModels } : {}),
  };
  registerOAuthProvider(provider);
  t.teardown(() => unregisterOAuthProvider(id));
  return { loginCalls, refreshCalls };
};

/**
 * A minimal pre-constructed `Model` object for a given provider — avoids the
 * pi-ai model registry so `makePiAgent`'s object-model path is exercised.
 *
 * @param {string} provider
 * @param {object} [overrides]
 * @returns {any}
 */
const fauxModel = (provider, overrides = {}) => ({
  id: 'faux-model',
  name: `${provider}/faux-model`,
  api: 'openai-completions',
  provider,
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
  ...overrides,
});

// makeMemoryOAuthStore

test('memory store round-trips credentials by provider id', async t => {
  const store = makeMemoryOAuthStore();
  t.is(await store.get('anthropic'), undefined);
  t.deepEqual(await store.list(), []);

  const creds = { access: 'a', refresh: 'r', expires: 1 };
  await store.set('anthropic', creds);
  t.is(await store.get('anthropic'), creds);
  t.deepEqual(await store.list(), ['anthropic']);

  await store.delete('anthropic');
  t.is(await store.get('anthropic'), undefined);
  t.deepEqual(await store.list(), []);
});

test('memory store seeds from an initial record', async t => {
  const creds = { access: 'a', refresh: 'r', expires: 1 };
  const store = makeMemoryOAuthStore({ anthropic: creds });
  t.is(await store.get('anthropic'), creds);
  t.deepEqual(await store.list(), ['anthropic']);
});

// isOAuthProvider / listOAuthProviderIds

test('recognises the three built-in subscription providers', t => {
  for (const id of ['anthropic', 'openai-codex', 'github-copilot']) {
    t.true(isOAuthProvider(id), `${id} should be an OAuth provider`);
  }
  t.false(isOAuthProvider('ollama'));
  t.false(isOAuthProvider('definitely-not-a-provider'));

  const ids = listOAuthProviderIds();
  t.true(ids.includes('anthropic'));
  t.true(ids.includes('openai-codex'));
  t.true(ids.includes('github-copilot'));
});

// resolveOAuthApiKey

test('resolveOAuthApiKey returns undefined without stored credentials', async t => {
  registerFauxOAuthProvider(t, { id: 'faux-empty' });
  const store = makeMemoryOAuthStore();
  t.is(
    await resolveOAuthApiKey({ providerId: 'faux-empty', store }),
    undefined,
  );
});

test('resolveOAuthApiKey returns the token and does not refresh when valid', async t => {
  const { refreshCalls } = registerFauxOAuthProvider(t, { id: 'faux-valid' });
  const creds = {
    access: 'valid-access',
    refresh: 'valid-refresh',
    expires: Date.now() + HOUR,
  };
  const store = makeMemoryOAuthStore({ 'faux-valid': creds });

  t.is(
    await resolveOAuthApiKey({ providerId: 'faux-valid', store }),
    'valid-access',
  );
  t.is(refreshCalls.length, 0, 'unexpired token must not refresh');
  t.is(await store.get('faux-valid'), creds, 'store unchanged');
});

test('resolveOAuthApiKey refreshes an expired token and persists the new credentials', async t => {
  const refreshResult = {
    access: 'fresh-access',
    refresh: 'fresh-refresh',
    expires: Date.now() + HOUR,
  };
  const { refreshCalls } = registerFauxOAuthProvider(t, {
    id: 'faux-expired',
    refreshResult,
  });
  const expired = {
    access: 'stale-access',
    refresh: 'stale-refresh',
    expires: 0,
  };
  const store = makeMemoryOAuthStore({ 'faux-expired': expired });

  t.is(
    await resolveOAuthApiKey({ providerId: 'faux-expired', store }),
    'fresh-access',
  );
  t.is(refreshCalls.length, 1, 'expired token must refresh exactly once');
  t.is(
    await store.get('faux-expired'),
    refreshResult,
    'refreshed credentials must be persisted',
  );
});

// makeApiKeyResolver

test('resolver prefers an OAuth token for an OAuth provider with credentials', async t => {
  registerFauxOAuthProvider(t, { id: 'faux-resolve' });
  const store = makeMemoryOAuthStore({
    'faux-resolve': {
      access: 'oauth-token',
      refresh: 'r',
      expires: Date.now() + HOUR,
    },
  });
  const resolve = makeApiKeyResolver({
    oauthStore: store,
    // An env key exists too; the OAuth token must win.
    env: { 'faux-resolve': 'env-key' },
  });
  t.is(await resolve('faux-resolve'), 'oauth-token');
});

test('resolver falls back to the environment key for a key-based provider', async t => {
  const resolve = makeApiKeyResolver({
    oauthStore: makeMemoryOAuthStore(),
    env: { OPENAI_API_KEY: 'sk-env' },
  });
  t.is(await resolve('openai'), 'sk-env');
});

test('resolver falls back to the environment key when an OAuth provider has no credentials', async t => {
  // `anthropic` is a built-in OAuth provider that also accepts an API key; with
  // no stored OAuth credentials the resolver must fall through to the env key.
  const resolve = makeApiKeyResolver({
    oauthStore: makeMemoryOAuthStore(),
    env: { ANTHROPIC_API_KEY: 'env-key' },
  });
  t.is(await resolve('anthropic'), 'env-key');
});

test('resolver returns undefined when no OAuth store and no env key apply', async t => {
  const resolve = makeApiKeyResolver({ env: {} });
  t.is(await resolve('openai'), undefined);
});

// loginOAuthProvider

test('loginOAuthProvider runs the flow and persists the credentials', async t => {
  const loginResult = {
    access: 'new-access',
    refresh: 'new-refresh',
    expires: Date.now() + HOUR,
  };
  const { loginCalls } = registerFauxOAuthProvider(t, {
    id: 'faux-login',
    loginResult,
  });
  const store = makeMemoryOAuthStore();
  /** @type {any} */
  const callbacks = {
    onAuth: () => {},
    onPrompt: async () => '',
    onSelect: async () => undefined,
    onDeviceCode: () => {},
  };

  const returned = await loginOAuthProvider({
    providerId: 'faux-login',
    store,
    callbacks,
  });

  t.is(returned, loginResult);
  t.is(loginCalls.length, 1);
  t.is(loginCalls[0], callbacks, 'callbacks are threaded to the provider flow');
  t.is(await store.get('faux-login'), loginResult, 'credentials are persisted');
});

test('loginOAuthProvider rejects an unknown provider', async t => {
  await t.throwsAsync(
    loginOAuthProvider({
      providerId: 'nope',
      store: makeMemoryOAuthStore(),
      callbacks: /** @type {any} */ ({}),
    }),
    { message: /Unknown OAuth provider/ },
  );
});

// applyOAuthModelModifications

test('applyOAuthModelModifications rewrites the model when the provider defines modifyModels', async t => {
  registerFauxOAuthProvider(t, {
    id: 'faux-modify',
    modifyModels: (models, creds) =>
      models.map(m => ({ ...m, baseUrl: `https://acct/${creds.access}` })),
  });
  const store = makeMemoryOAuthStore({
    'faux-modify': {
      access: 'acct-1',
      refresh: 'r',
      expires: Date.now() + HOUR,
    },
  });
  const model = fauxModel('faux-modify');
  const modified = await applyOAuthModelModifications({ model, store });
  t.is(modified.baseUrl, 'https://acct/acct-1');
});

test('applyOAuthModelModifications is a no-op without modifyModels, store, or credentials', async t => {
  // Provider without modifyModels.
  registerFauxOAuthProvider(t, { id: 'faux-plain' });
  const plainModel = fauxModel('faux-plain');
  const store = makeMemoryOAuthStore({
    'faux-plain': { access: 'x', refresh: 'r', expires: Date.now() + HOUR },
  });
  t.is(
    await applyOAuthModelModifications({ model: plainModel, store }),
    plainModel,
  );

  // Provider with modifyModels but no stored credentials.
  registerFauxOAuthProvider(t, {
    id: 'faux-modify-nocreds',
    modifyModels: models => models.map(m => ({ ...m, baseUrl: 'rewritten' })),
  });
  const model2 = fauxModel('faux-modify-nocreds');
  t.is(
    await applyOAuthModelModifications({
      model: model2,
      store: makeMemoryOAuthStore(),
    }),
    model2,
  );

  // No store at all.
  const model3 = fauxModel('faux-plain');
  t.is(await applyOAuthModelModifications({ model: model3 }), model3);
});

// makePiAgent integration

test('makePiAgent installs a getApiKey that resolves an OAuth subscription token', async t => {
  registerFauxOAuthProvider(t, { id: 'faux-agent' });
  const store = makeMemoryOAuthStore({
    'faux-agent': {
      access: 'agent-token',
      refresh: 'r',
      expires: Date.now() + HOUR,
    },
  });
  const piAgent = await makePiAgent({
    model: fauxModel('faux-agent'),
    oauthStore: store,
  });
  t.is(typeof piAgent.getApiKey, 'function');
  t.is(await piAgent.getApiKey?.('faux-agent'), 'agent-token');
});

test('makePiAgent keeps the ollama sentinel key for the local masquerade', async t => {
  const store = makeMemoryOAuthStore();
  const piAgent = await makePiAgent({
    model: fauxModel('openai', { name: 'ollama/llama3.2' }),
    oauthStore: store,
  });
  // The ollama masquerade reports provider 'openai' but must still use its own
  // sentinel key, never the OAuth/env path.
  t.is(await piAgent.getApiKey?.('openai'), 'ollama');
});
