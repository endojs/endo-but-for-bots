// @ts-check

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeBrokerOAuthCredential } from '@endo/hosted-agent/provider-broker.js';

// Matches the stock Codex public OAuth client. Never accept an endpoint or
// client identifier from model-facing configuration.
const TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const MAX_TOKEN_BYTES = 64 * 1024;

/** @param {unknown} token */
const assertToken = token => {
  if (!(
    typeof token === 'string' &&
    token.length <= MAX_TOKEN_BYTES &&
    /^[\x21-\x7e]+$/.test(token)
  )) {
    throw Fail`Invalid subscription credential`;
  }
  return token;
};

/**
 * Claims are metadata, not signature verification. Only the fixed TLS token
 * endpoint may provide a refreshed token; the operator supplies initial state.
 * @param {unknown} token
 */
const tokenClaims = token => {
  const text = assertToken(token);
  try {
    const parts = text.split('.');
    if (parts.length !== 3) throw Error('Invalid JWT');
    const binary = globalThis.atob(
      parts[1].replace(/-/g, '+').replace(/_/g, '/'),
    );
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const claims = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
    const accountId = claims['https://api.openai.com/auth']?.chatgpt_account_id;
    if (
      typeof accountId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(accountId) ||
      typeof claims.exp !== 'number' ||
      !Number.isFinite(claims.exp * 1000)
    ) {
      throw Error('Invalid claims');
    }
    return harden({ accountId, expiresAt: claims.exp * 1000 });
  } catch {
    throw Error('Invalid subscription token claims');
  }
};

/**
 * Explicit one-time conversion of the operator's stock Codex login cache.
 * The renewal-bearing record, not the access token alone, belongs in Secrets.
 * The existing broker persists rotated refresh tokens with a CAS write-ahead
 * intent and caches the access token in the same encrypted record.
 * @param {unknown} input
 */
export const importCodexSubscription = input => {
  const auth = /** @type {any} */ (input);
  (!auth?.OPENAI_API_KEY && auth?.tokens) ||
    Fail`Expected ChatGPT subscription login`;
  const refreshToken = assertToken(auth.tokens.refresh_token);
  const accessToken = assertToken(auth.tokens.access_token);
  const claims = tokenClaims(accessToken);
  auth.tokens.account_id === claims.accountId ||
    Fail`Subscription account mismatch`;
  return harden({
    version: /** @type {const} */ ('BrokerOAuthStateV1'),
    accessToken,
    refreshToken,
    ...claims,
  });
};
harden(importCodexSubscription);

/**
 * Host-only exchange. No retries: an ambiguous dispatch must leave the durable
 * pending-refresh intent intact instead of replaying a possibly rotated token.
 * Never include endpoint response text or request data in errors.
 * @param {{ fetch: typeof globalThis.fetch, now: () => number }} powers
 */
export const makeCodexSubscriptionRefresh = ({ fetch, now }) =>
  harden({
    /** @param {{ refreshToken: string, accountId: string }} request */
    async refresh({ refreshToken, accountId }) {
      assertToken(refreshToken);
      let reader;
      try {
        const response = await fetch(TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            client_id: CLIENT_ID,
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
          }),
          redirect: 'error',
          credentials: 'omit',
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw Error('Subscription renewal refused');
        }
        reader = response.body?.getReader();
        if (!reader) throw Error('Missing response');
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let text = '';
        let size = 0;
        for (;;) {
          // eslint-disable-next-line no-await-in-loop
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_TOKEN_BYTES) throw Error('Oversized response');
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        const result = JSON.parse(text);
        const accessToken = assertToken(result.access_token);
        const claims = tokenClaims(accessToken);
        if (
          claims.accountId !== accountId ||
          claims.expiresAt <= now() + 60_000
        ) {
          throw Error('Invalid refreshed account or expiry');
        }
        return harden({
          version: /** @type {const} */ ('BrokerOAuthStateV1'),
          accessToken,
          refreshToken:
            result.refresh_token === undefined
              ? refreshToken
              : assertToken(result.refresh_token),
          ...claims,
        });
      } catch {
        throw Error(
          'Codex subscription renewal failed; sign in again if the renewal outcome cannot be recovered',
        );
      } finally {
        await reader?.cancel().catch(() => {});
      }
    },
  });
harden(makeCodexSubscriptionRefresh);

/**
 * Compose one shared host-only credential authority per Secrets record.
 * Never give this authority, its read facet, or its rotation facet to a session.
 * @param {Omit<Parameters<typeof makeBrokerOAuthCredential>[0], 'refresh'> & { fetch: typeof globalThis.fetch }} powers
 */
export const makeCodexSubscriptionCredential = powers =>
  makeBrokerOAuthCredential({
    ...powers,
    secret: harden({
      async readBase64WithGeneration() {
        const record = await E(powers.secret).readBase64WithGeneration();
        let state;
        try {
          state = JSON.parse(globalThis.atob(record.base64));
        } catch {
          throw Error('Invalid subscription credential');
        }
        // An operator replacement must also retain renewal authority. A live
        // access token alone is not a configured subscription credential.
        assertToken(state?.refreshToken);
        const claims = tokenClaims(state.accessToken);
        (claims.accountId === state.accountId &&
          claims.expiresAt === state.expiresAt) ||
          Fail`Subscription credential metadata mismatch`;
        return record;
      },
    }),
    refresh: makeCodexSubscriptionRefresh(powers),
  });
harden(makeCodexSubscriptionCredential);
