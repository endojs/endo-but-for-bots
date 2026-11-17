// @ts-check

import { Fail, q } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { boundedJson } from '@endo/hosted-agent/bounded-json.js';
import { makeBrokerMemoryOAuthCredential } from '@endo/hosted-agent/provider-broker.js';

// The public client and endpoint shipped by Claude Code, not operator input.
const TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const MAX_BYTES = 64 * 1024;

/** @param {unknown} value @returns {string} */
const assertToken = value => {
  if (!(
    typeof value === 'string' &&
    value.length <= MAX_BYTES &&
    /^[\x21-\x7e]+$/.test(value)
  ))
    throw Fail`Invalid Claude subscription credential`;
  return value;
};

/** @param {unknown} value @returns {string[]} */
const assertScopes = value => {
  if (!(
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every(
      scope =>
        typeof scope === 'string' && /^[A-Za-z0-9_:.-]{1,128}$/.test(scope),
    ) &&
    value.includes('user:inference')
  ))
    throw Fail`Claude subscription requires inference scope`;
  return harden([...new Set(value)]);
};

/**
 * Import a complete Keychain/.credentials.json export or its claudeAiOauth
 * member. Access tokens, expiry, and unrelated Keychain data are discarded.
 * accountRef is the operator's pool binding, not a verified provider identity.
 * @param {any} input
 * @param {string} accountRef
 */
export const importClaudeSubscription = (input, accountRef) => {
  const auth = input?.claudeAiOauth ?? input;
  (auth && typeof auth === 'object' && !Array.isArray(auth)) ||
    Fail`Expected Claude subscription login JSON`;
  auth.version === undefined || Fail`Unsupported Claude subscription format`;
  return harden({
    version: /** @type {const} */ ('BrokerOAuthRefreshStateV1'),
    refreshToken: assertToken(auth.refreshToken),
    accountId: accountRef,
    scopes: assertScopes(auth.scopes),
  });
};
harden(importClaudeSubscription);

/** @param {{ fetch: typeof globalThis.fetch, now: () => number }} powers */
export const makeClaudeSubscriptionRefresh = ({ fetch, now }) =>
  harden({
    /** @param {{refreshToken: string, accountId: string, scopes?: string[]}} request */
    async refresh({ refreshToken, accountId, scopes }) {
      await null;
      try {
        const response = await fetch(TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            client_id: CLIENT_ID,
            grant_type: 'refresh_token',
            refresh_token: assertToken(refreshToken),
            scope: assertScopes(scopes).join(' '),
          }),
          redirect: 'error',
          credentials: 'omit',
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw Error('Renewal refused');
        }
        const result = await boundedJson(response, MAX_BYTES, 'Claude renewal');
        const lifetime = /** @type {unknown} */ (result.expires_in);
        if (!(
          typeof lifetime === 'number' &&
          Number.isFinite(lifetime) &&
          lifetime > 60 &&
          lifetime <= 366 * 86_400
        ))
          throw Fail`Invalid Claude token lifetime`;
        result.token_type === undefined ||
          (typeof result.token_type === 'string' &&
            result.token_type.toLowerCase() === 'bearer') ||
          Fail`Invalid Claude token type`;
        const nextScopes =
          result.scope === undefined
            ? assertScopes(scopes)
            : assertScopes(
                typeof result.scope === 'string'
                  ? result.scope.split(/ +/)
                  : undefined,
              );
        return harden({
          version: /** @type {const} */ ('BrokerOAuthStateV1'),
          accountId,
          accessToken: assertToken(result.access_token),
          refreshToken:
            result.refresh_token === undefined
              ? refreshToken
              : assertToken(result.refresh_token),
          expiresAt: now() + lifetime * 1000,
          scopes: nextScopes,
        });
      } catch {
        // Neither provider error bodies nor credentials leave this boundary.
        // No retries: the broker's durable intent fences ambiguous exchanges.
        throw Error(
          'Claude subscription renewal failed; a fresh login may be required',
        );
      }
    },
  });
harden(makeClaudeSubscriptionRefresh);

/**
 * One authority per secret. Legacy setup-tokens remain usable directly.
 * Login JSON is normalized with CAS before any exchange, keeping only renewal
 * authority in Secrets. Imported access tokens are deliberately not reused.
 * @param {Omit<Parameters<typeof makeBrokerMemoryOAuthCredential>[0], 'refresh'> & {fetch: typeof globalThis.fetch}} powers
 * @returns {ReturnType<typeof makeBrokerMemoryOAuthCredential>}
 */
export const makeClaudeSubscriptionCredential = powers => {
  /** @type {Promise<any> | undefined} */
  let reading;
  const read = () => {
    if (reading) return reading;
    const pending = (async () => {
      await null;
      const record = await E(powers.secret).readBase64WithGeneration();
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true })
          .decode(
            Uint8Array.from(globalThis.atob(record.base64), c =>
              c.charCodeAt(0),
            ),
          )
          .trim();
      } catch {
        throw Error('Invalid Claude subscription credential');
      }
      text.length <= MAX_BYTES ||
        Fail`Claude subscription credential too large`;
      if (!text.startsWith('{')) {
        text.startsWith('sk-ant-oat') ||
          Fail`Expected Claude subscription token or login JSON`;
        return { token: assertToken(text), record };
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw Error('Invalid Claude subscription credential JSON');
      }
      if (parsed.version === 'BrokerOAuthRefreshStateV1') {
        assertScopes(parsed.scopes);
        return { record };
      }
      const state = importClaudeSubscription(parsed, powers.accountRef);
      const base64 = globalThis.btoa(JSON.stringify(state));
      const generation = await E(powers.rotate).replaceBase64(
        base64,
        harden({ ifGeneration: record.generation }),
      );
      typeof generation === 'bigint' ||
        Fail`Claude credential normalization failed`;
      return { record: { base64, generation } };
    })().finally(() => {
      reading = undefined;
    });
    reading = pending;
    return pending;
  };
  const credential = makeBrokerMemoryOAuthCredential({
    ...powers,
    secret: harden({
      async readBase64WithGeneration() {
        const result = await read();
        result.token === undefined ||
          Fail`Claude credential changed to static token`;
        return result.record;
      },
    }),
    refresh: makeClaudeSubscriptionRefresh(powers),
  });
  return harden({
    accountRef: powers.accountRef,
    /** @param {{rejected?: string}} [options] */
    async current(options = {}) {
      const { token } = await read();
      if (token === undefined) return credential.current(options);
      token !== options.rejected ||
        Fail`Claude static subscription token rejected`;
      return harden({
        state: {
          version: /** @type {const} */ ('BrokerOAuthStateV1'),
          accessToken: token,
          accountId: powers.accountRef,
          expiresAt: 8_640_000_000_000_000,
        },
        outcome: /** @type {const} */ ('unchanged'),
      });
    },
  });
};
harden(makeClaudeSubscriptionCredential);

/** @param {any} payload */
export const readingFromClaudeUsage = payload => {
  const windows = [];
  for (const [field, windowId, title, windowSeconds] of [
    ['five_hour', 'primary', '5-hour window', 18_000],
    ['seven_day', 'secondary', 'Weekly window', 604_800],
  ]) {
    const window = payload?.[field];
    const utilization = /** @type {unknown} */ (window?.utilization);
    if (
      typeof utilization === 'number' &&
      Number.isFinite(utilization) &&
      utilization >= 0
    ) {
      const reset =
        typeof window.resets_at === 'string'
          ? Date.parse(window.resets_at)
          : NaN;
      windows.push({
        windowId,
        title,
        windowSeconds,
        usedPercent: Math.min(100, utilization),
        resetsAt: Number.isFinite(reset) ? new Date(reset).toISOString() : '',
      });
    }
  }
  return harden(
    windows.length
      ? {
          rateLimits: {
            windows,
            limitReached: windows.some(window => window.usedPercent >= 100),
          },
        }
      : {},
  );
};
harden(readingFromClaudeUsage);

/**
 * A direct read, not inference and not a quota reset. Static setup-tokens may
 * lack user:profile; report refusal without invalidating inference credentials.
 * @param {{credential: {current(): Promise<{state: {accessToken: string}}>}, fetch: typeof globalThis.fetch}} powers
 */
export const makeClaudeAccountRead =
  ({ credential, fetch }) =>
  async () => {
    const { state } = await credential.current();
    const response = await fetch(USAGE_ENDPOINT, {
      headers: {
        authorization: `Bearer ${state.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        accept: 'application/json',
      },
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 403) {
        throw Fail`Claude usage permission refused (HTTP 403); check user:profile scope`;
      }
      throw Fail`Claude usage read refused (HTTP ${q(response.status)})`;
    }
    return readingFromClaudeUsage(
      await boundedJson(response, MAX_BYTES, 'Claude usage read'),
    );
  };
harden(makeClaudeAccountRead);
