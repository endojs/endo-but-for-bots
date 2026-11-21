// @ts-check
/**
 * Subscription credentials (M4 W4.4; `designs/m4-interfaces.md` 7; R7-16,
 * R7-25, R8-35..R8-37): the one JSON value a pool member's Secret holds,
 * parsed and validated at every read, and written back by the renewal.
 *
 * Stored form (what `formatCredential` writes):
 *
 *   { version: 1, provider, accessToken, refreshToken?, expiresAtMs,
 *     accountId?, scopes?, pendingRefresh?: { startedAtMs } }
 *
 * `provider` and `scopes` are additions to the contract's form (section 7):
 * `provider` makes a credential of the other provider refusable (`INVALID`)
 * without decoding tokens; `scopes` keeps the scopes a Claude refresh must
 * present again (claude-sandbox `subscription-auth.js`).
 *
 * Accepted inputs besides the stored form, as the reference importers
 * accept them (claude-sandbox and codex-sandbox `subscription-auth.js`
 * `import*Subscription`, 1315bef86), so an operator can paste a provider
 * login file into the Secret and the first renewal rewrites it in the
 * stored form:
 *
 * - `claude`: a credentials export `{ claudeAiOauth: { accessToken,
 *   refreshToken, expiresAt, scopes } }` or its inner object; the scopes
 *   must include `user:inference`.
 * - `codex`: a login cache `{ tokens: { access_token, refresh_token,
 *   account_id } }` with no API key; the access token is a JWT whose `exp`
 *   gives the expiry and whose account claim must equal `account_id`.
 *
 * The renewal manager also accepts an activated Claude refresh-only import
 * until its first exchange supplies an access credential. A staged import
 * cannot be used by either reader.
 *
 * Anything else, a value over 8,192 bytes (R7-25), or a credential of the
 * other provider: code `INVALID`. Errors carry a fixed text and a code
 * (`subscriptionCodes`), never a token, a value or a parse message.
 *
 * Node only (adapter). Values never enter a vat (D-6).
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { Buffer } from 'node:buffer';

import { textOf } from '../../../../guest/lib/interfaces.js';
import { subscriptionLimits } from '../../../../guest/lib/subscription-limits.js';
import { subscriptionTexts } from '../../../../guest/lib/subscription-texts.js';
/* eslint-enable import/no-relative-packages */

/**
 * The parsed credential (`types.js` `Credential`, plus `provider` and
 * `scopes`).
 * @typedef {object} StoredCredential
 * @property {import('./types.js').Provider} provider
 * @property {string} accessToken
 * @property {string} [refreshToken]
 * @property {number} expiresAtMs
 * @property {string} [accountId]
 * @property {string[]} [scopes]
 * @property {{ startedAtMs: number }} [pendingRefresh]
 */

/** Codes with their own fixed text; the rest use `textOf.secretFailed`. */
const codeTexts = harden({
  CONSUMED: subscriptionTexts.credentialConsumed,
  EXPIRED: subscriptionTexts.credentialExpired,
  INVALID: subscriptionTexts.credentialInvalid,
  REJECTED: subscriptionTexts.credentialRejected,
});

/**
 * A credential failure with a fixed code (`subscriptionCodes`): the message is a
 * fixed text, never a token or a provider body.
 * @param {string} code
 */
export const credentialError = code =>
  Object.assign(
    Error(
      /** @type {Record<string, string>} */ (codeTexts)[code] ??
        textOf.secretFailed(code),
    ),
    { code },
  );
harden(credentialError);

const PROVIDERS = harden(['claude', 'codex']);
const TOKEN = /^[\x21-\x7e]+$/;
const SCOPE = /^[A-Za-z0-9_:.-]{1,128}$/;
const CLAUDE_INFERENCE_SCOPE = 'user:inference';
const MAX_SCOPES = 64;
const ACCOUNT_UNITS = 256;

/** @param {unknown} value */
const isRecord = value =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @param {unknown} value
 * @returns {string}
 */
export const assertToken = value => {
  if (
    typeof value !== 'string' ||
    value.length > subscriptionLimits.credentialBytes ||
    !TOKEN.test(value)
  )
    throw credentialError('INVALID');
  return value;
};
harden(assertToken);

/**
 * @param {unknown} value
 * @returns {string}
 */
const assertAccount = value => {
  if (
    typeof value !== 'string' ||
    value.length > ACCOUNT_UNITS ||
    !TOKEN.test(value)
  )
    throw credentialError('INVALID');
  return value;
};

/** @param {unknown} value */
const assertTime = value => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw credentialError('INVALID');
  return value;
};

/**
 * @param {unknown} value
 * @param {boolean} requireInference
 * @returns {string[]}
 */
export const assertScopes = (value, requireInference) => {
  if (
    !Array.isArray(value) ||
    value.length > MAX_SCOPES ||
    !value.every(scope => typeof scope === 'string' && SCOPE.test(scope)) ||
    (requireInference && !value.includes(CLAUDE_INFERENCE_SCOPE))
  )
    throw credentialError('INVALID');
  return harden([...new Set(value)]);
};
harden(assertScopes);

/**
 * The claims of a JWT's payload, or `undefined` when it is not one. Claims
 * are metadata, not a verified identity: only the token endpoint mints a
 * renewed token, and the operator supplies the first one.
 * @param {string} token
 * @returns {Record<string, any> | undefined}
 */
export const jwtClaims = token => {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const claims = JSON.parse(json);
    return isRecord(claims) ? claims : undefined;
  } catch {
    return undefined;
  }
};
harden(jwtClaims);

/**
 * The ChatGPT account id among a Codex access token's claims: the
 * `chatgpt_account_id` of the provider's namespaced auth claim (looked for
 * in every object-valued claim, so no claim name is spelled here).
 * @param {Record<string, any>} claims
 * @returns {string | undefined}
 */
export const codexAccountOf = claims => {
  for (const value of Object.values(claims)) {
    if (isRecord(value) && typeof value.chatgpt_account_id === 'string')
      return value.chatgpt_account_id;
  }
  return undefined;
};
harden(codexAccountOf);

/**
 * @param {Record<string, any>} input
 * @param {import('./types.js').Provider} provider
 * @returns {StoredCredential}
 */
const fromStored = (input, provider) => {
  if (input.provider !== undefined && input.provider !== provider)
    throw credentialError('INVALID');
  const { pendingRefresh } = input;
  if (
    pendingRefresh !== undefined &&
    !(isRecord(pendingRefresh) && Number.isFinite(pendingRefresh.startedAtMs))
  )
    throw credentialError('INVALID');
  return harden({
    provider,
    accessToken: assertToken(input.accessToken),
    ...(input.refreshToken === undefined
      ? {}
      : { refreshToken: assertToken(input.refreshToken) }),
    expiresAtMs: assertTime(input.expiresAtMs),
    ...(input.accountId === undefined
      ? {}
      : { accountId: assertAccount(input.accountId) }),
    ...(input.scopes === undefined
      ? {}
      : { scopes: assertScopes(input.scopes, provider === 'claude') }),
    ...(pendingRefresh === undefined
      ? {}
      : { pendingRefresh: { startedAtMs: pendingRefresh.startedAtMs } }),
  });
};

/**
 * Claude's credentials export (claude-sandbox `importClaudeSubscription`).
 * @param {Record<string, any>} input
 * @returns {StoredCredential}
 */
const fromClaudeLogin = input => {
  const auth = isRecord(input.claudeAiOauth) ? input.claudeAiOauth : input;
  if (auth.tokens !== undefined || auth.version !== undefined)
    throw credentialError('INVALID');
  return harden({
    provider: 'claude',
    accessToken: assertToken(auth.accessToken),
    refreshToken: assertToken(auth.refreshToken),
    expiresAtMs: assertTime(auth.expiresAt),
    scopes: assertScopes(auth.scopes, true),
  });
};

/**
 * Codex's login cache (codex-sandbox `importCodexSubscription`).
 * @param {Record<string, any>} input
 * @returns {StoredCredential}
 */
const fromCodexLogin = input => {
  if (input.OPENAI_API_KEY || !isRecord(input.tokens))
    throw credentialError('INVALID');
  const { tokens } = input;
  const accessToken = assertToken(tokens.access_token);
  const claims = jwtClaims(accessToken);
  const accountId = claims && codexAccountOf(claims);
  if (
    claims === undefined ||
    typeof claims.exp !== 'number' ||
    !Number.isFinite(claims.exp * 1000) ||
    accountId === undefined ||
    tokens.account_id !== accountId
  )
    throw credentialError('INVALID');
  return harden({
    provider: 'codex',
    accessToken,
    refreshToken: assertToken(tokens.refresh_token),
    expiresAtMs: claims.exp * 1000,
    accountId: assertAccount(accountId),
  });
};

/**
 * Parse and validate a member's credential value (at every read).
 * @param {string} text the Secret's value
 * @returns {Record<string, any>}
 */
const credentialRecord = text => {
  if (
    typeof text !== 'string' ||
    Buffer.byteLength(text, 'utf8') > subscriptionLimits.credentialBytes
  )
    throw credentialError('INVALID');
  /** @type {unknown} */
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    throw credentialError('INVALID');
  }
  if (!isRecord(input)) throw credentialError('INVALID');
  return /** @type {Record<string, any>} */ (input);
};

/**
 * @param {Record<string, any>} record
 * @param {import('./types.js').Provider} provider
 */
const accessCredential = (record, provider) => {
  if (!PROVIDERS.includes(provider)) throw credentialError('INVALID');
  if (record.version === 1) return fromStored(record, provider);
  return provider === 'claude'
    ? fromClaudeLogin(record)
    : fromCodexLogin(record);
};
/**
 * @param {string} text
 * @param {import('./types.js').Provider} provider
 */
export const parseCredential = (text, provider) =>
  accessCredential(credentialRecord(text), provider);
harden(parseCredential);

/**
 * Only the renewal manager can use this operator-activated credential.
 * @typedef {{version: 'LocalClaudeRefreshV1', refreshToken: string, scopes: string[], pendingRefresh?: {startedAtMs: number}}} LocalClaudeRefresh
 * @param {string} text
 * @param {import('./types.js').Provider} provider
 * @returns {StoredCredential | LocalClaudeRefresh}
 */
export const parseRenewalCredential = (text, provider) => {
  const record = credentialRecord(text);
  if (record.version !== 'LocalClaudeRefreshV1')
    return accessCredential(record, provider);
  if (
    provider !== 'claude' ||
    Object.keys(record).some(
      key =>
        !['version', 'refreshToken', 'scopes', 'pendingRefresh'].includes(key),
    )
  )
    throw credentialError('INVALID');
  return harden({
    version: 'LocalClaudeRefreshV1',
    refreshToken: assertToken(record.refreshToken),
    scopes: assertScopes(record.scopes, true),
    ...(record.pendingRefresh === undefined
      ? {}
      : {
          pendingRefresh: {
            startedAtMs: assertTime(record.pendingRefresh?.startedAtMs),
          },
        }),
  });
};
harden(parseRenewalCredential);

/**
 * The stored form, keys in a fixed order. Refused (`INVALID`) when it would
 * not parse back (over 8,192 bytes), so the renewal never writes a value
 * the next read refuses.
 * @param {StoredCredential | LocalClaudeRefresh} credential
 * @returns {string}
 */
export const formatCredential = credential => {
  if (!('accessToken' in credential)) {
    const { version, refreshToken, scopes, pendingRefresh } = credential;
    const text = JSON.stringify({
      version,
      refreshToken,
      scopes,
      pendingRefresh,
    });
    parseRenewalCredential(text, 'claude');
    return text;
  }
  const {
    provider,
    accessToken,
    refreshToken,
    expiresAtMs,
    accountId,
    scopes,
    pendingRefresh,
  } = credential;
  const text = JSON.stringify({
    version: 1,
    provider,
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    expiresAtMs,
    ...(accountId === undefined ? {} : { accountId }),
    ...(scopes === undefined ? {} : { scopes }),
    ...(pendingRefresh === undefined
      ? {}
      : { pendingRefresh: { startedAtMs: pendingRefresh.startedAtMs } }),
  });
  parseCredential(text, provider);
  return text;
};
harden(formatCredential);
