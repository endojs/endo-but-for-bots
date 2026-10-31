// @ts-check

/**
 * The per-provider encrypted auth-storage exo. Credentials are held keyed by
 * provider name and account id, sealed at rest by an injected authenticated-
 * encryption capability (see `Cipher`). The exo never sees the encryption key
 * and never persists plaintext: `store` seals on the way in and `get` unseals
 * on the way out, so at-rest state is ciphertext only.
 *
 * Persistence into the daemon's formula-graph store (per the design's
 * "encrypted at rest, in the same store as the formula graph") is a separate
 * follow-up: this exo owns the in-memory sealed map and the seal/unseal
 * discipline; wiring the sealed bytes to durable daemon storage is layered on
 * top without changing this interface.
 */

/** @import { Cipher, OAuthCredentials } from './oauth.types.js' */

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

// Captured once at module load so post-lockdown mutation of the globals cannot
// redirect the calls; both are UTF-8 and stateless.
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const OAuthCredentialsShape = M.splitRecord(
  { accessToken: M.string() },
  {
    tokenType: M.string(),
    refreshToken: M.string(),
    scope: M.string(),
    expiresAt: M.number(),
    obtainedAt: M.number(),
  },
);

const OAuthAuthStoreInterface = M.interface('OAuthAuthStore', {
  store: M.call(M.string(), M.string(), OAuthCredentialsShape).returns(
    M.undefined(),
  ),
  get: M.call(M.string(), M.string()).returns(
    M.or(OAuthCredentialsShape, M.undefined()),
  ),
  has: M.call(M.string(), M.string()).returns(M.boolean()),
  delete: M.call(M.string(), M.string()).returns(M.boolean()),
  listAccounts: M.call(M.string()).returns(M.arrayOf(M.string())),
  listProviders: M.call().returns(M.arrayOf(M.string())),
  help: M.call().optional(M.string()).returns(M.string()),
});

// NUL separates the two key segments. It cannot occur in a provider name or
// account id, so the composite key is unambiguous; `assertKeySegment`
// enforces that precondition rather than trusting it, and the separator is
// written as the `\u0000` escape so the source stays reviewable text.
const assertKeySegment = (label, value) => {
  if (value.includes('\u0000')) {
    throw new Error(`OAuth ${label} must not contain a NUL character.`);
  }
};
const compositeKey = (provider, accountId) => {
  assertKeySegment('provider', provider);
  assertKeySegment('accountId', accountId);
  return `${provider}\u0000${accountId}`;
};

/** @type {Record<string, string>} */
const METHOD_HELP = {
  store:
    'store(provider, accountId, credentials): seal and retain credentials.',
  get: 'get(provider, accountId): unseal and return credentials, or undefined.',
  has: 'has(provider, accountId): whether credentials are retained.',
  delete:
    'delete(provider, accountId): drop credentials; returns whether any were present.',
  listAccounts:
    'listAccounts(provider): account ids with retained credentials for a provider.',
  listProviders: 'listProviders(): providers with any retained credentials.',
};

/**
 * Make a per-provider encrypted OAuth credential store.
 *
 * @param {{ cipher: Cipher }} powers
 */
export const makeOAuthAuthStore = ({ cipher }) => {
  /** @type {Map<string, Uint8Array>} sealed credential bytes by composite key */
  const sealedByKey = new Map();
  /** @type {Map<string, Set<string>>} account ids by provider */
  const accountsByProvider = new Map();

  return makeExo('OAuthAuthStore', OAuthAuthStoreInterface, {
    /**
     * @param {string} provider
     * @param {string} accountId
     * @param {OAuthCredentials} credentials
     */
    store(provider, accountId, credentials) {
      const plaintext = textEncoder.encode(JSON.stringify(credentials));
      const sealed = cipher.encrypt(plaintext);
      sealedByKey.set(compositeKey(provider, accountId), sealed);
      let accounts = accountsByProvider.get(provider);
      if (accounts === undefined) {
        accounts = new Set();
        accountsByProvider.set(provider, accounts);
      }
      accounts.add(accountId);
    },

    /**
     * @param {string} provider
     * @param {string} accountId
     * @returns {OAuthCredentials | undefined}
     */
    get(provider, accountId) {
      const sealed = sealedByKey.get(compositeKey(provider, accountId));
      if (sealed === undefined) {
        return undefined;
      }
      const plaintext = cipher.decrypt(sealed);
      return harden(JSON.parse(textDecoder.decode(plaintext)));
    },

    /**
     * @param {string} provider
     * @param {string} accountId
     */
    has(provider, accountId) {
      return sealedByKey.has(compositeKey(provider, accountId));
    },

    /**
     * @param {string} provider
     * @param {string} accountId
     */
    delete(provider, accountId) {
      const existed = sealedByKey.delete(compositeKey(provider, accountId));
      const accounts = accountsByProvider.get(provider);
      if (accounts !== undefined) {
        accounts.delete(accountId);
        if (accounts.size === 0) {
          accountsByProvider.delete(provider);
        }
      }
      return existed;
    },

    /**
     * @param {string} provider
     */
    listAccounts(provider) {
      const accounts = accountsByProvider.get(provider);
      return harden(accounts === undefined ? [] : [...accounts]);
    },

    listProviders() {
      return harden([...accountsByProvider.keys()]);
    },

    /**
     * @param {string} [methodName]
     */
    help(methodName) {
      if (methodName === undefined) {
        return 'Per-provider encrypted OAuth credential store. Credentials are sealed at rest by the injected cipher.';
      }
      return (
        METHOD_HELP[methodName] ||
        `No documentation for method "${methodName}".`
      );
    },
  });
};
harden(makeOAuthAuthStore);
