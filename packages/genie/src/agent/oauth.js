// @ts-check
/* global process */

/**
 * Subscription-OAuth wiring for Genie.
 *
 * `@earendil-works/pi-ai` ships the OAuth scaffolding for the three
 * subscription providers a user can log in to with an account they already
 * pay for — Anthropic (Claude Pro/Max), OpenAI Codex (ChatGPT Plus/Pro), and
 * GitHub Copilot — but Genie does not exercise it: `makePiAgent` only supplies
 * an API key for the local ollama masquerade, so every other provider reaches
 * pi-agent-core with no credential at all.
 *
 * This module is the missing seam.  It turns a small persistence surface (an
 * {@link OAuthStore}) plus pi-ai's per-provider login/refresh logic into:
 *
 * - {@link loginOAuthProvider}: run a provider's OAuth login flow and persist
 *   the resulting credentials.
 * - {@link makeApiKeyResolver}: the `getApiKey` callback pi-agent-core calls
 *   before each request, resolving an OAuth subscription token (refreshing and
 *   re-persisting on expiry) with an environment-variable API key as the
 *   fallback for key-based providers.
 * - {@link applyOAuthModelModifications}: apply a provider's credential-derived
 *   model rewrites (the GitHub Copilot base-URL, for one) at model-resolution
 *   time.
 *
 * The credential store is deliberately an injected capability rather than a
 * concrete implementation: the Endo daemon is expected to back it with an
 * encrypted, formula-graph-resident exo (see the design's *Subscription OAuth*
 * section), whereas tests and the dev-repl use {@link makeMemoryOAuthStore}.
 * The provider-picking policy (whether these live under `@endo/genie`,
 * `@endo/lal`, or a shared `@endo/ai` package) and the encrypted at-rest store
 * remain open questions on the design and are intentionally not resolved here.
 *
 * pi-ai handles the provider-specific request shape once a token is in hand:
 * its Anthropic provider detects an OAuth access token and attaches the Claude
 * Code identity headers, Copilot uses bearer auth, and so on.  Genie's only job
 * is to hand the right token to the right provider.
 */

/** @import { Api, Model } from '@earendil-works/pi-ai' */
/**
 * @import {
 *   OAuthCredentials,
 *   OAuthLoginCallbacks,
 * } from '@earendil-works/pi-ai/oauth'
 */

import harden from '@endo/harden';

import { getEnvApiKey } from '@earendil-works/pi-ai';
import {
  getOAuthApiKey,
  getOAuthProvider,
  getOAuthProviders,
} from '@earendil-works/pi-ai/oauth';

/**
 * A persistence surface for OAuth subscription credentials, keyed by pi-ai
 * OAuth provider id (`'anthropic'`, `'openai-codex'`, `'github-copilot'`, or a
 * custom-registered id).  Every method is async so a store may be backed by a
 * daemon exo over eventual-send.
 *
 * The daemon supplies an encrypted, formula-graph-backed implementation;
 * {@link makeMemoryOAuthStore} is the in-process reference used by tests and
 * the dev-repl.
 *
 * @typedef {object} OAuthStore
 * @property {(providerId: string) => Promise<OAuthCredentials | undefined>} get
 *   - Resolve the stored credentials for a provider, or `undefined` when the
 *     user has not logged in to it.
 * @property {(providerId: string, credentials: OAuthCredentials) => Promise<void>} set
 *   - Persist (or replace) a provider's credentials.  Called on login and
 *     again whenever a token refresh mints fresh credentials.
 * @property {(providerId: string) => Promise<void>} delete
 *   - Forget a provider's credentials (a logout).
 * @property {() => Promise<string[]>} list
 *   - The provider ids that currently have stored credentials.
 */

/**
 * Whether pi-ai knows an OAuth provider by this id.  Recognises the three
 * built-ins plus anything registered via pi-ai's `registerOAuthProvider`.
 *
 * @param {string} providerId
 * @returns {boolean}
 */
export const isOAuthProvider = providerId =>
  getOAuthProvider(providerId) !== undefined;
harden(isOAuthProvider);

/**
 * The ids of every OAuth provider pi-ai currently knows.  A snapshot: it
 * reflects the built-ins and any providers registered before the call.
 *
 * @returns {string[]}
 */
export const listOAuthProviderIds = () =>
  getOAuthProviders().map(provider => provider.id);
harden(listOAuthProviderIds);

/**
 * An in-process reference {@link OAuthStore}, backed by a `Map`.  Suitable for
 * tests and the dev-repl; the daemon supplies its own persistent, encrypted
 * store.  Credentials are stored by reference (not copied or hardened), because
 * pi-ai returns and consumes plain mutable credential records.
 *
 * @param {Record<string, OAuthCredentials>} [initial]
 *   - Seed credentials, keyed by provider id.
 * @returns {OAuthStore}
 */
export const makeMemoryOAuthStore = (initial = {}) => {
  /** @type {Map<string, OAuthCredentials>} */
  const byProvider = new Map(Object.entries(initial));
  return harden({
    get: async providerId => byProvider.get(providerId),
    set: async (providerId, credentials) => {
      byProvider.set(providerId, credentials);
    },
    delete: async providerId => {
      byProvider.delete(providerId);
    },
    list: async () => Array.from(byProvider.keys()),
  });
};
harden(makeMemoryOAuthStore);

/**
 * Run a provider's OAuth login flow and persist the resulting credentials in
 * `store`.  The `callbacks` carry the flow's interaction points (open this URL,
 * paste this code, pick a login method) out to the host deployment — a readline
 * prompt in the dev-repl, a daemon-mail round-trip in the guest.
 *
 * @param {object} options
 * @param {string} options.providerId - A pi-ai OAuth provider id.
 * @param {OAuthStore} options.store - Where to persist the credentials.
 * @param {OAuthLoginCallbacks} options.callbacks - The flow's interaction hooks.
 * @returns {Promise<OAuthCredentials>} The persisted credentials.
 */
export const loginOAuthProvider = async ({ providerId, store, callbacks }) => {
  const provider = getOAuthProvider(providerId);
  if (!provider) {
    throw new Error(`Unknown OAuth provider: ${providerId}`);
  }
  const credentials = await provider.login(callbacks);
  await store.set(providerId, credentials);
  return credentials;
};
harden(loginOAuthProvider);

/**
 * Resolve a usable API key for an OAuth subscription provider from stored
 * credentials, refreshing and re-persisting the credentials when the access
 * token has expired.
 *
 * @param {object} options
 * @param {string} options.providerId - A pi-ai OAuth provider id.
 * @param {OAuthStore} options.store - The credential store to read/refresh.
 * @returns {Promise<string | undefined>}
 *   - The provider's API key (an OAuth access token), or `undefined` when the
 *     provider has no stored credentials.
 */
export const resolveOAuthApiKey = async ({ providerId, store }) => {
  const credentials = await store.get(providerId);
  if (!credentials) {
    return undefined;
  }
  // `getOAuthApiKey` refreshes an expired token and returns the (possibly new)
  // credentials alongside the API key; it returns the same reference when no
  // refresh was needed, which is how we detect a refresh worth persisting.
  const result = await getOAuthApiKey(providerId, {
    [providerId]: credentials,
  });
  if (!result) {
    return undefined;
  }
  if (result.newCredentials !== credentials) {
    await store.set(providerId, result.newCredentials);
  }
  return result.apiKey;
};
harden(resolveOAuthApiKey);

/**
 * Build the `getApiKey` callback pi-agent-core invokes (with a model's
 * `provider` string) before each request.  Resolution order:
 *
 * 1. An OAuth subscription token from `oauthStore`, when the provider is an
 *    OAuth provider with stored credentials (refreshed and re-persisted on
 *    expiry).
 * 2. An environment-variable API key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
 *    ...) for key-based providers.
 *
 * Returns `undefined` when neither applies, letting pi-agent-core surface its
 * own "no API key for provider" error.  The local ollama masquerade is handled
 * by its own callback in `makePiAgent` (it cannot be recognised from the
 * provider string alone, since it reports itself as `openai`), so this resolver
 * never sees it.
 *
 * @param {object} [options]
 * @param {OAuthStore} [options.oauthStore]
 *   - The credential store consulted for OAuth providers.  When omitted, only
 *     the environment-variable fallback applies.
 * @param {Record<string, string | undefined>} [options.env]
 *   - Environment lookup for `getEnvApiKey`.  Defaults to `process.env`.
 * @returns {(providerId: string) => Promise<string | undefined>}
 */
export const makeApiKeyResolver = ({ oauthStore, env = process.env } = {}) => {
  return harden(async providerId => {
    if (oauthStore && isOAuthProvider(providerId)) {
      const oauthKey = await resolveOAuthApiKey({
        providerId,
        store: oauthStore,
      });
      if (oauthKey) {
        return oauthKey;
      }
    }
    // `getEnvApiKey` wants a `Record<string, string>`; `process.env` (and hence
    // this default) is typed with optional values, so narrow at the call.
    return getEnvApiKey(
      providerId,
      /** @type {Record<string, string>} */ (env),
    );
  });
};
harden(makeApiKeyResolver);

/**
 * Apply a provider's credential-derived model rewrites, when it defines any.
 * GitHub Copilot, for instance, derives the model `baseUrl` from the logged-in
 * account's endpoint; Anthropic and OpenAI Codex define no rewrites and the
 * model is returned unchanged.
 *
 * A no-op when the model's provider is not an OAuth provider, defines no
 * `modifyModels`, or has no stored credentials.
 *
 * @template {Api} T
 * @param {object} options
 * @param {Model<T>} options.model - The resolved model to (possibly) rewrite.
 * @param {OAuthStore} [options.store] - The credential store.
 * @returns {Promise<Model<T>>}
 */
export const applyOAuthModelModifications = async ({ model, store }) => {
  if (!store) {
    return model;
  }
  const provider = getOAuthProvider(model.provider);
  if (!provider?.modifyModels) {
    return model;
  }
  const credentials = await store.get(model.provider);
  if (!credentials) {
    return model;
  }
  const [modified] = provider.modifyModels([model], credentials);
  return /** @type {Model<T>} */ (modified) || model;
};
harden(applyOAuthModelModifications);
