// @ts-check
import '@endo/init';
import test from 'ava';
import { createHash } from 'node:crypto';
import { makeClaudeSubscriptionLogin } from '../src/subscription-login.js';

test('browser login uses current PKCE flow, refuses wrong state and returns only broker renewal authority', async t => {
  const requests = [];
  const login = makeClaudeSubscriptionLogin({
    accountRef: 'primary',
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      return new Response(
        JSON.stringify({
          token_type: 'Bearer',
          refresh_token: 'refresh-fixture',
          access_token: 'must-be-discarded',
          scope: 'user:inference user:profile',
        }),
      );
    },
  });
  const url = new URL(login.authorizationUrl);
  const state = url.searchParams.get('state');
  t.is(url.origin, 'https://claude.com');
  t.is(url.pathname, '/cai/oauth/authorize');
  t.is(
    url.searchParams.get('code_challenge'),
    createHash('sha256').update(state).digest('base64url'),
  );
  await t.throwsAsync(login.exchange('code#wrong-state'), { message: /state/ });
  t.is(requests.length, 0);
  const record = await login.exchange(`code#${state}`);
  t.deepEqual(record, {
    version: 'BrokerOAuthRefreshStateV1',
    refreshToken: 'refresh-fixture',
    accountId: 'primary',
    scopes: ['user:inference', 'user:profile'],
  });
  t.is(requests[0].redirect, 'error');
  t.is(JSON.parse(requests[0].body).code_verifier, state);
  await t.throwsAsync(login.exchange(`code#${state}`), {
    message: /already exchanged/,
  });
});
test('ambiguous token exchange is not retried and provider text is never echoed', async t => {
  const login = makeClaudeSubscriptionLogin({
    accountRef: 'primary',
    fetch: async () => {
      throw Error('secret echo');
    },
  });
  const state = new URL(login.authorizationUrl).searchParams.get('state');
  const error = await t.throwsAsync(login.exchange(`code#${state}`));
  t.false(error.message.includes('secret echo'));
  await t.throwsAsync(login.exchange(`code#${state}`), {
    message: /already exchanged/,
  });
});
