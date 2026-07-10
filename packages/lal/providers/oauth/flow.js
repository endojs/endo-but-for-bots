// @ts-check

/**
 * The authorization-code-with-PKCE flow for subscription providers.
 *
 * Three steps:
 *  1. `buildAuthorizationUrl` composes the URL the user visits to consent.
 *  2. `exchangeAuthorizationCode` trades the returned code (plus the PKCE
 *     verifier) for tokens.
 *  3. `refreshAccessToken` renews an expired access token from a refresh
 *     token.
 *
 * `fetch` and the clock (`now`) are injected so the flow is testable without
 * network access and produces deterministic expiry timestamps.
 */

/** @import { OAuthCredentials, OAuthFetch } from './oauth.types.js' */

/**
 * Compose the authorization endpoint URL for the authorization-code + PKCE
 * grant.
 *
 * @param {object} params
 * @param {string} params.authorizationEndpoint
 * @param {string} params.clientId
 * @param {string} params.redirectUri
 * @param {string} [params.state]
 * @param {string[]} [params.scopes]
 * @param {string} params.codeChallenge
 * @param {'S256'} [params.codeChallengeMethod]
 * @param {Record<string, string>} [params.extraParams]
 * @returns {string}
 */
export const buildAuthorizationUrl = ({
  authorizationEndpoint,
  clientId,
  redirectUri,
  state,
  scopes = [],
  codeChallenge,
  codeChallengeMethod = 'S256',
  extraParams = {},
}) => {
  const url = new URL(authorizationEndpoint);
  const { searchParams } = url;
  searchParams.set('response_type', 'code');
  searchParams.set('client_id', clientId);
  searchParams.set('redirect_uri', redirectUri);
  if (scopes.length > 0) {
    searchParams.set('scope', scopes.join(' '));
  }
  if (state !== undefined) {
    searchParams.set('state', state);
  }
  searchParams.set('code_challenge', codeChallenge);
  searchParams.set('code_challenge_method', codeChallengeMethod);
  for (const [key, value] of Object.entries(extraParams)) {
    searchParams.set(key, value);
  }
  return url.href;
};
harden(buildAuthorizationUrl);

/**
 * Normalize a raw OAuth token endpoint payload into `OAuthCredentials`.
 *
 * @param {Record<string, unknown>} payload
 * @param {number} obtainedAt
 * @returns {OAuthCredentials}
 */
const normalizeTokenResponse = (payload, obtainedAt) => {
  const accessToken = payload.access_token;
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new Error(
      'OAuth token endpoint response is missing a string `access_token`.',
    );
  }
  /** @type {OAuthCredentials} */
  const credentials = { accessToken, obtainedAt };
  if (typeof payload.token_type === 'string') {
    credentials.tokenType = payload.token_type;
  }
  if (typeof payload.refresh_token === 'string') {
    credentials.refreshToken = payload.refresh_token;
  }
  if (typeof payload.scope === 'string') {
    credentials.scope = payload.scope;
  }
  if (typeof payload.expires_in === 'number') {
    credentials.expiresAt = obtainedAt + payload.expires_in * 1000;
  }
  return harden(credentials);
};

/**
 * POST an urlencoded body to a token endpoint and normalize the response.
 *
 * @param {string} tokenEndpoint
 * @param {URLSearchParams} body
 * @param {OAuthFetch} fetch
 * @param {() => number} now
 * @returns {Promise<OAuthCredentials>}
 */
const postToTokenEndpoint = async (tokenEndpoint, body, fetch, now) => {
  const obtainedAt = now();
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: body.toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `OAuth token endpoint returned status ${response.status}: ${text}`,
    );
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (cause) {
    throw new Error('OAuth token endpoint returned a non-JSON body.', {
      cause,
    });
  }
  return normalizeTokenResponse(payload, obtainedAt);
};

/**
 * Exchange an authorization code (with its PKCE verifier) for tokens.
 *
 * @param {object} params
 * @param {string} params.tokenEndpoint
 * @param {string} params.clientId
 * @param {string} params.redirectUri
 * @param {string} params.code
 * @param {string} params.codeVerifier
 * @param {Record<string, string>} [params.extraParams]
 * @param {{ fetch: OAuthFetch, now?: () => number }} powers
 * @returns {Promise<OAuthCredentials>}
 */
export const exchangeAuthorizationCode = async (
  {
    tokenEndpoint,
    clientId,
    redirectUri,
    code,
    codeVerifier,
    extraParams = {},
  },
  { fetch, now = () => Date.now() },
) => {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    ...extraParams,
  });
  return postToTokenEndpoint(tokenEndpoint, body, fetch, now);
};
harden(exchangeAuthorizationCode);

/**
 * Renew an access token from a refresh token. Providers that omit a fresh
 * `refresh_token` on renewal keep the caller's existing one, so the returned
 * credentials always carry a usable refresh token when the input did.
 *
 * @param {object} params
 * @param {string} params.tokenEndpoint
 * @param {string} params.clientId
 * @param {string} params.refreshToken
 * @param {string[]} [params.scopes]
 * @param {Record<string, string>} [params.extraParams]
 * @param {{ fetch: OAuthFetch, now?: () => number }} powers
 * @returns {Promise<OAuthCredentials>}
 */
export const refreshAccessToken = async (
  { tokenEndpoint, clientId, refreshToken, scopes, extraParams = {} },
  { fetch, now = () => Date.now() },
) => {
  /** @type {Record<string, string>} */
  const params = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    ...extraParams,
  };
  if (scopes && scopes.length > 0) {
    params.scope = scopes.join(' ');
  }
  const body = new URLSearchParams(params);
  const credentials = await postToTokenEndpoint(
    tokenEndpoint,
    body,
    fetch,
    now,
  );
  if (credentials.refreshToken === undefined) {
    return harden({ ...credentials, refreshToken });
  }
  return credentials;
};
harden(refreshAccessToken);

/**
 * Whether credentials are expired (or within `skewMs` of expiry). Credentials
 * without an `expiresAt` are treated as non-expiring.
 *
 * @param {OAuthCredentials} credentials
 * @param {{ now?: () => number, skewMs?: number }} [options]
 * @returns {boolean}
 */
export const isExpired = (
  credentials,
  { now = () => Date.now(), skewMs = 0 } = {},
) => {
  if (credentials.expiresAt === undefined) {
    return false;
  }
  return now() + skewMs >= credentials.expiresAt;
};
harden(isExpired);
