import test from '@endo/ses-ava/prepare-endo.js';

import {
  makeMinionTownMcpOAuthConfig,
  MINION_TOWN_MCP_REGISTERED_REDIRECT_URIS,
  MINION_TOWN_MCP_SCOPES,
} from '../providers/oauth/presets.js';
import { makeOAuthClient } from '../providers/oauth/index.js';
import { getRandomValues, sha256 } from '../providers/oauth/node-crypto.js';

// These assertions pin the preset to the minion.town MCP's published OAuth
// metadata (the RFC 9728 protected-resource document and the Cognito OIDC
// discovery document it names), fetched read-only from the live deployment on
// 2026-07-13. They validate that the flow, driven by the preset, emits exactly
// the authorization request and token-exchange body that server contract
// expects. They do not perform a live token exchange: that needs an
// interactive user consent this non-interactive suite cannot drive.

const AUTHORIZE_ENDPOINT =
  'https://minion-town.auth.us-west-1.amazoncognito.com/oauth2/authorize';
const TOKEN_ENDPOINT =
  'https://minion-town.auth.us-west-1.amazoncognito.com/oauth2/token';
const PUBLIC_CLIENT_ID = '1uesun672b9a0lidth983v0vc9';

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

test('minion.town MCP preset carries the validated Cognito endpoints and public client id', t => {
  const config = makeMinionTownMcpOAuthConfig();
  t.is(config.provider, 'minion-town-mcp');
  t.is(config.authorizationEndpoint, AUTHORIZE_ENDPOINT);
  t.is(config.tokenEndpoint, TOKEN_ENDPOINT);
  t.is(config.clientId, PUBLIC_CLIENT_ID);
  t.deepEqual(config.scopes, [
    'mcp/tools',
    'mcp/minions:read',
    'mcp/minions:write',
  ]);
  // The default redirect is the daemon-only build's loopback listener, and it
  // is one of the registered callbacks.
  t.is(config.redirectUri, 'http://localhost:8080/callback');
  t.true(MINION_TOWN_MCP_REGISTERED_REDIRECT_URIS.includes(config.redirectUri));
});

test('minion.town MCP preset accepts either registered redirect and a scope subset', t => {
  const web = makeMinionTownMcpOAuthConfig({
    redirectUri: 'https://minion.town/callback',
    scopes: ['mcp/tools'],
  });
  t.is(web.redirectUri, 'https://minion.town/callback');
  t.deepEqual(web.scopes, ['mcp/tools']);
});

test('minion.town MCP preset rejects an unregistered redirect the server would refuse', t => {
  t.throws(
    () =>
      makeMinionTownMcpOAuthConfig({
        redirectUri: 'https://evil.example.com/callback',
      }),
    { message: /registered callbacks/ },
  );
});

test('the flow, driven by the preset, builds the authorization request the minion.town server contract expects', t => {
  const { fetch } = makeFakeFetch();
  const client = makeOAuthClient(makeMinionTownMcpOAuthConfig(), {
    sha256,
    getRandomValues,
    fetch,
    generateState: () => 'state-xyz',
  });
  const { authorizationUrl, codeChallenge } = client.beginAuthorization();
  const url = new URL(authorizationUrl);
  t.is(
    `${url.origin}${url.pathname}`,
    AUTHORIZE_ENDPOINT,
    'points at the Cognito authorize endpoint',
  );
  t.is(url.searchParams.get('response_type'), 'code');
  t.is(url.searchParams.get('client_id'), PUBLIC_CLIENT_ID);
  t.is(url.searchParams.get('redirect_uri'), 'http://localhost:8080/callback');
  t.is(url.searchParams.get('code_challenge_method'), 'S256');
  t.is(url.searchParams.get('code_challenge'), codeChallenge);
  t.is(url.searchParams.get('state'), 'state-xyz');
  // Cognito accepts the space-joined custom scope set even though its OIDC
  // discovery does not advertise the `mcp/*` scopes.
  t.is(
    url.searchParams.get('scope'),
    'mcp/tools mcp/minions:read mcp/minions:write',
  );
});

test('the flow, driven by the preset, posts the public-PKCE token body the minion.town server contract expects', async t => {
  const { fetch, calls } = makeFakeFetch({
    body: JSON.stringify({
      access_token: 'access-token',
      token_type: 'Bearer',
      refresh_token: 'refresh-token',
      expires_in: 3600,
    }),
  });
  const client = makeOAuthClient(makeMinionTownMcpOAuthConfig(), {
    sha256,
    getRandomValues,
    fetch,
  });
  const credentials = await client.completeAuthorization({
    code: 'authorization-code',
    codeVerifier: 'the-code-verifier',
  });
  t.is(calls.length, 1);
  const [{ url, init }] = calls;
  t.is(url, TOKEN_ENDPOINT);
  t.is(init.method, 'POST');
  t.is(init.headers['content-type'], 'application/x-www-form-urlencoded');
  const body = new URLSearchParams(init.body);
  // A public PKCE client sends no client secret; Cognito's public-client token
  // endpoint expects exactly these five parameters.
  t.is(body.get('grant_type'), 'authorization_code');
  t.is(body.get('code'), 'authorization-code');
  t.is(body.get('client_id'), PUBLIC_CLIENT_ID);
  t.is(body.get('redirect_uri'), 'http://localhost:8080/callback');
  t.is(body.get('code_verifier'), 'the-code-verifier');
  t.is(body.get('client_secret'), null);
  t.is(credentials.accessToken, 'access-token');
  t.is(credentials.refreshToken, 'refresh-token');
});

test('the flow carries the refresh token forward, matching Cognito non-rotating refresh', async t => {
  // Cognito does not issue a fresh refresh_token on renewal for this client, so
  // the returned credentials must retain the caller's existing one.
  const { fetch, calls } = makeFakeFetch({
    body: JSON.stringify({
      access_token: 'renewed-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
    }),
  });
  const client = makeOAuthClient(makeMinionTownMcpOAuthConfig(), {
    sha256,
    getRandomValues,
    fetch,
  });
  const credentials = await client.refresh('the-refresh-token');
  const [{ url, init }] = calls;
  t.is(url, TOKEN_ENDPOINT);
  const body = new URLSearchParams(init.body);
  t.is(body.get('grant_type'), 'refresh_token');
  t.is(body.get('refresh_token'), 'the-refresh-token');
  t.is(body.get('client_id'), PUBLIC_CLIENT_ID);
  t.is(credentials.accessToken, 'renewed-access-token');
  t.is(credentials.refreshToken, 'the-refresh-token');
});

test('the published scope set is exported for callers that want to narrow it', t => {
  t.deepEqual(MINION_TOWN_MCP_SCOPES, [
    'mcp/tools',
    'mcp/minions:read',
    'mcp/minions:write',
  ]);
});
