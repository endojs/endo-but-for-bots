import test from '@endo/ses-ava/prepare-endo.js';

import { makeOAuthClient } from '../providers/oauth/index.js';
import { computeCodeChallenge } from '../providers/oauth/pkce.js';
import {
  getRandomValues,
  makeNodeOAuthCryptoPowers,
  sha256,
} from '../providers/oauth/node-crypto.js';

const config = harden({
  provider: 'anthropic',
  authorizationEndpoint: 'https://auth.example.com/authorize',
  tokenEndpoint: 'https://auth.example.com/token',
  clientId: 'client-123',
  redirectUri: 'http://127.0.0.1:8787/callback',
  scopes: ['inference'],
});

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

test('beginAuthorization derives a consent URL carrying the PKCE challenge and state', t => {
  const { fetch } = makeFakeFetch();
  const client = makeOAuthClient(config, {
    ...makeNodeOAuthCryptoPowers(),
    fetch,
    generateState: () => 'fixed-state',
  });
  const { authorizationUrl, codeVerifier, state, codeChallenge } =
    client.beginAuthorization();
  t.is(state, 'fixed-state');
  // The returned challenge is the genuine S256 hash of the returned verifier.
  t.is(codeChallenge, computeCodeChallenge(codeVerifier, sha256));
  const url = new URL(authorizationUrl);
  t.is(url.searchParams.get('code_challenge'), codeChallenge);
  t.is(url.searchParams.get('code_challenge_method'), 'S256');
  t.is(url.searchParams.get('state'), 'fixed-state');
  t.is(url.searchParams.get('client_id'), 'client-123');
  t.is(url.searchParams.get('scope'), 'inference');
});

test('beginAuthorization falls back to a fresh random state when none is injected', t => {
  const { fetch } = makeFakeFetch();
  const client = makeOAuthClient(config, { sha256, getRandomValues, fetch });
  const a = client.beginAuthorization();
  const b = client.beginAuthorization();
  t.is(a.state.length, 43);
  t.not(a.state, b.state);
  t.not(a.codeVerifier, b.codeVerifier);
});

test('completeAuthorization exchanges the code and PKCE verifier for tokens', async t => {
  const { fetch, calls } = makeFakeFetch({
    body: JSON.stringify({ access_token: 'tok', token_type: 'Bearer' }),
  });
  const client = makeOAuthClient(config, {
    sha256,
    getRandomValues,
    fetch,
    now: () => 42,
  });
  const credentials = await client.completeAuthorization({
    code: 'code-1',
    codeVerifier: 'ver-1',
  });
  t.is(credentials.accessToken, 'tok');
  t.is(credentials.obtainedAt, 42);
  const sent = new URLSearchParams(calls[0].init.body);
  t.is(sent.get('grant_type'), 'authorization_code');
  t.is(sent.get('code'), 'code-1');
  t.is(sent.get('code_verifier'), 'ver-1');
  t.is(sent.get('redirect_uri'), 'http://127.0.0.1:8787/callback');
});

test('refresh renews an access token and carries the config scopes', async t => {
  const { fetch, calls } = makeFakeFetch({
    body: JSON.stringify({ access_token: 'tok2' }),
  });
  const client = makeOAuthClient(config, { sha256, getRandomValues, fetch });
  const credentials = await client.refresh('refresh-1');
  t.is(credentials.accessToken, 'tok2');
  // The response omitted a refresh token, so the caller's is carried forward.
  t.is(credentials.refreshToken, 'refresh-1');
  const sent = new URLSearchParams(calls[0].init.body);
  t.is(sent.get('grant_type'), 'refresh_token');
  t.is(sent.get('refresh_token'), 'refresh-1');
  t.is(sent.get('scope'), 'inference');
});
