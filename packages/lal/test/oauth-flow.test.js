import test from '@endo/ses-ava/prepare-endo.js';

import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  isExpired,
} from '../providers/oauth/flow.js';

// A fetch stand-in that records the last request and replies with a canned
// response. `ok`/`status`/`body` are configurable per test.
const makeFakeFetch = ({ status = 200, body = '{}' } = {}) => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return harden({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    });
  };
  return { fetch, calls };
};

test('buildAuthorizationUrl sets the PKCE and authorization-code params', t => {
  const url = buildAuthorizationUrl({
    authorizationEndpoint: 'https://auth.example.com/authorize',
    clientId: 'client-123',
    redirectUri: 'http://127.0.0.1:8787/callback',
    scopes: ['profile', 'inference'],
    state: 'state-xyz',
    codeChallenge: 'CHALLENGE',
  });
  const parsed = new URL(url);
  t.is(parsed.origin + parsed.pathname, 'https://auth.example.com/authorize');
  t.is(parsed.searchParams.get('response_type'), 'code');
  t.is(parsed.searchParams.get('client_id'), 'client-123');
  t.is(
    parsed.searchParams.get('redirect_uri'),
    'http://127.0.0.1:8787/callback',
  );
  t.is(parsed.searchParams.get('scope'), 'profile inference');
  t.is(parsed.searchParams.get('state'), 'state-xyz');
  t.is(parsed.searchParams.get('code_challenge'), 'CHALLENGE');
  t.is(parsed.searchParams.get('code_challenge_method'), 'S256');
});

test('buildAuthorizationUrl merges extra params and omits empty scope', t => {
  const url = buildAuthorizationUrl({
    authorizationEndpoint: 'https://auth.example.com/authorize',
    clientId: 'c',
    redirectUri: 'http://127.0.0.1/cb',
    codeChallenge: 'CH',
    extraParams: { audience: 'https://api.example.com' },
  });
  const parsed = new URL(url);
  t.is(parsed.searchParams.get('scope'), null);
  t.is(parsed.searchParams.get('audience'), 'https://api.example.com');
});

test('exchangeAuthorizationCode posts the code + verifier and normalizes tokens', async t => {
  const { fetch, calls } = makeFakeFetch({
    body: JSON.stringify({
      access_token: 'access-abc',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'refresh-def',
      scope: 'inference',
    }),
  });
  const credentials = await exchangeAuthorizationCode(
    {
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'client-123',
      redirectUri: 'http://127.0.0.1/cb',
      code: 'code-789',
      codeVerifier: 'verifier-000',
    },
    { fetch, now: () => 1_000_000 },
  );

  // The request carried the PKCE verifier and the authorization_code grant.
  t.is(calls.length, 1);
  t.is(calls[0].url, 'https://auth.example.com/token');
  t.is(calls[0].init.method, 'POST');
  const sent = new URLSearchParams(calls[0].init.body);
  t.is(sent.get('grant_type'), 'authorization_code');
  t.is(sent.get('code'), 'code-789');
  t.is(sent.get('code_verifier'), 'verifier-000');
  t.is(sent.get('client_id'), 'client-123');
  t.is(sent.get('redirect_uri'), 'http://127.0.0.1/cb');

  // The response was normalized, including a computed absolute expiry.
  t.is(credentials.accessToken, 'access-abc');
  t.is(credentials.tokenType, 'Bearer');
  t.is(credentials.refreshToken, 'refresh-def');
  t.is(credentials.scope, 'inference');
  t.is(credentials.obtainedAt, 1_000_000);
  t.is(credentials.expiresAt, 1_000_000 + 3600 * 1000);
});

test('exchangeAuthorizationCode throws on a non-2xx response with the body', async t => {
  const { fetch } = makeFakeFetch({ status: 400, body: 'invalid_grant' });
  await t.throwsAsync(
    () =>
      exchangeAuthorizationCode(
        {
          tokenEndpoint: 'https://auth.example.com/token',
          clientId: 'c',
          redirectUri: 'http://127.0.0.1/cb',
          code: 'bad',
          codeVerifier: 'v',
        },
        { fetch },
      ),
    { message: /status 400.*invalid_grant/u },
  );
});

test('exchangeAuthorizationCode throws when access_token is absent', async t => {
  const { fetch } = makeFakeFetch({
    body: JSON.stringify({ token_type: 'Bearer' }),
  });
  await t.throwsAsync(
    () =>
      exchangeAuthorizationCode(
        {
          tokenEndpoint: 'https://auth.example.com/token',
          clientId: 'c',
          redirectUri: 'http://127.0.0.1/cb',
          code: 'x',
          codeVerifier: 'v',
        },
        { fetch },
      ),
    { message: /missing a string `access_token`/u },
  );
});

test('refreshAccessToken carries the old refresh token forward when omitted', async t => {
  const { fetch, calls } = makeFakeFetch({
    body: JSON.stringify({
      access_token: 'access-new',
      token_type: 'Bearer',
      expires_in: 60,
    }),
  });
  const credentials = await refreshAccessToken(
    {
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'client-123',
      refreshToken: 'refresh-existing',
    },
    { fetch, now: () => 5000 },
  );
  const sent = new URLSearchParams(calls[0].init.body);
  t.is(sent.get('grant_type'), 'refresh_token');
  t.is(sent.get('refresh_token'), 'refresh-existing');
  t.is(credentials.accessToken, 'access-new');
  // No refresh_token in the response, so the caller's is preserved.
  t.is(credentials.refreshToken, 'refresh-existing');
  t.is(credentials.expiresAt, 5000 + 60 * 1000);
});

test('isExpired respects expiry and skew, and treats no-expiry as valid', t => {
  const expiring = harden({ accessToken: 'a', expiresAt: 1000 });
  t.false(isExpired(expiring, { now: () => 500 }));
  t.true(isExpired(expiring, { now: () => 1000 }));
  t.true(isExpired(expiring, { now: () => 900, skewMs: 200 }));
  t.false(isExpired(harden({ accessToken: 'a' }), { now: () => 10 ** 12 }));
});

const exchangeWith = (fetch, now) =>
  exchangeAuthorizationCode(
    {
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'c',
      redirectUri: 'http://127.0.0.1/cb',
      code: 'x',
      codeVerifier: 'v',
    },
    { fetch, now },
  );

test('exchangeAuthorizationCode throws on a non-JSON body', async t => {
  const { fetch } = makeFakeFetch({ status: 200, body: 'not json at all' });
  await t.throwsAsync(() => exchangeWith(fetch), {
    message: /non-JSON body/u,
  });
});

test('exchangeAuthorizationCode throws when the JSON body is not an object', async t => {
  const { fetch } = makeFakeFetch({ status: 200, body: 'null' });
  await t.throwsAsync(() => exchangeWith(fetch), {
    message: /not a JSON object/u,
  });
});

test('exchangeAuthorizationCode coerces a string expires_in', async t => {
  const { fetch } = makeFakeFetch({
    body: JSON.stringify({ access_token: 'a', expires_in: '3600' }),
  });
  const credentials = await exchangeWith(fetch, () => 1000);
  t.is(credentials.expiresAt, 1000 + 3600 * 1000);
});

test('exchangeAuthorizationCode ignores a non-finite, overflowing, or negative expires_in', async t => {
  await Promise.all(
    [1e308, -1, 'not-a-number', ''].map(async bad => {
      const { fetch } = makeFakeFetch({
        body: JSON.stringify({ access_token: 'a', expires_in: bad }),
      });
      const credentials = await exchangeWith(fetch, () => 1000);
      t.is(
        credentials.expiresAt,
        undefined,
        `expires_in ${bad} should be ignored`,
      );
      // With no known expiry the credential is treated as non-expiring.
      t.false(isExpired(credentials, { now: () => 10 ** 15 }));
    }),
  );
});

test('exchangeAuthorizationCode drops an empty-string refresh_token', async t => {
  const { fetch } = makeFakeFetch({
    body: JSON.stringify({ access_token: 'a', refresh_token: '' }),
  });
  const credentials = await exchangeWith(fetch);
  t.is(credentials.refreshToken, undefined);
});

test('refreshAccessToken keeps the old token when the response omits or empties it', async t => {
  await Promise.all(
    [
      JSON.stringify({ access_token: 'new' }),
      JSON.stringify({ access_token: 'new', refresh_token: '' }),
    ].map(async body => {
      const { fetch } = makeFakeFetch({ body });
      const credentials = await refreshAccessToken(
        {
          tokenEndpoint: 'https://auth.example.com/token',
          clientId: 'c',
          refreshToken: 'old-refresh',
        },
        { fetch },
      );
      t.is(credentials.refreshToken, 'old-refresh');
    }),
  );
});

test('refreshAccessToken adopts a rotated refresh_token from the response', async t => {
  const { fetch } = makeFakeFetch({
    body: JSON.stringify({ access_token: 'new', refresh_token: 'rotated' }),
  });
  const credentials = await refreshAccessToken(
    {
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'c',
      refreshToken: 'old-refresh',
    },
    { fetch },
  );
  t.is(credentials.refreshToken, 'rotated');
});
