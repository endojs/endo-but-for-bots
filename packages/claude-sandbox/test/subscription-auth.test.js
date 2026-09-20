// @ts-check

import '@endo/init';
import test from 'ava';
import {
  importClaudeSubscription,
  makeClaudeSubscriptionCredential,
  makeClaudeSubscriptionRefresh,
  makeClaudeAccountRead,
  readingFromClaudeUsage,
} from '../src/subscription-auth.js';

const login = harden({
  accessToken: 'ephemeral-original',
  refreshToken: 'renewal-original',
  expiresAt: 900_000,
  scopes: ['user:inference', 'user:profile'],
});

const fixture = (value = JSON.stringify({ claudeAiOauth: login })) => {
  let base64 = btoa(value);
  let generation = 0n;
  const writes = [];
  const requests = [];
  const secret = harden({
    async readBase64WithGeneration() {
      return { base64, generation };
    },
    async replaceBase64(next, options) {
      if (options.ifGeneration !== generation) throw Error('Conflict');
      writes.push(JSON.parse(atob(next)));
      base64 = next;
      generation += 1n;
      return generation;
    },
  });
  const powers = {
    secret,
    rotate: secret,
    accountRef: 'secondary',
    now: () => 1000,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return new Response(
        JSON.stringify({
          access_token: 'ephemeral-refreshed',
          refresh_token: 'renewal-rotated',
          expires_in: 3600,
          scope: 'user:inference user:profile',
          token_type: 'Bearer',
        }),
      );
    },
  };
  return { powers, writes, requests, read: () => JSON.parse(atob(base64)) };
};

test('Claude login import keeps only renewal authority and scopes', t => {
  const expected = {
    version: 'BrokerOAuthRefreshStateV1',
    refreshToken: login.refreshToken,
    accountId: 'secondary',
    scopes: login.scopes,
  };
  t.deepEqual(importClaudeSubscription(login, 'secondary'), expected);
  t.deepEqual(
    importClaudeSubscription(
      { claudeAiOauth: login, otherSecret: 'no' },
      'secondary',
    ),
    expected,
  );
  t.throws(
    () =>
      importClaudeSubscription(
        { ...login, refreshToken: undefined },
        'secondary',
      ),
    { message: /Invalid Claude/ },
  );
  t.throws(
    () =>
      importClaudeSubscription(
        { ...login, scopes: ['user:profile'] },
        'secondary',
      ),
    { message: /inference scope/ },
  );
});

test('static Claude token needs no write or exchange', async t => {
  await null;
  const f = fixture('sk-ant-oat01-static-token');
  const credential = makeClaudeSubscriptionCredential(f.powers);
  t.is(
    (await credential.current()).state.accessToken,
    'sk-ant-oat01-static-token',
  );
  t.is(f.writes.length, 0);
  t.is(f.requests.length, 0);
  await t.throwsAsync(
    () => credential.current({ rejected: 'sk-ant-oat01-static-token' }),
    {
      message: /static subscription token rejected/,
    },
  );
});

test('normalization, concurrent use, restart never persist access tokens', async t => {
  const f = fixture();
  const credential = makeClaudeSubscriptionCredential(f.powers);
  const results = await Promise.all([
    credential.current(),
    credential.current(),
  ]);
  t.true(
    results.every(result => result.state.accessToken === 'ephemeral-refreshed'),
  );
  t.is(f.requests.length, 1);
  t.true(f.writes.length >= 3);
  for (const record of f.writes) {
    t.false('accessToken' in record);
    t.false('expiresAt' in record);
  }
  t.is(f.read().refreshToken, 'renewal-rotated');
  t.deepEqual(f.read().scopes, login.scopes);
  await credential.current();
  t.is(f.requests.length, 1);
  await makeClaudeSubscriptionCredential(f.powers).current();
  t.is(f.requests.length, 2);
  t.is(JSON.parse(f.requests[1].options.body).refresh_token, 'renewal-rotated');
});

test('refresh uses fixed endpoint and client with no redirects', async t => {
  const f = fixture();
  const result = await makeClaudeSubscriptionRefresh(f.powers).refresh({
    refreshToken: 'r',
    accountId: 'secondary',
    scopes: login.scopes,
  });
  t.is(result.expiresAt, 3_601_000);
  t.is(f.requests[0].url, 'https://platform.claude.com/v1/oauth/token');
  t.is(f.requests[0].options.redirect, 'error');
  t.deepEqual(JSON.parse(f.requests[0].options.body), {
    client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    grant_type: 'refresh_token',
    scope: 'user:inference user:profile',
    refresh_token: 'r',
  });
});

test('failed exchange stays fenced and never echoes response', async t => {
  const f = fixture();
  f.powers.fetch = async () =>
    new Response('VERY-SECRET-RESPONSE', { status: 403 });
  const credential = makeClaudeSubscriptionCredential(f.powers);
  await t.throwsAsync(() => credential.current(), {
    message: /Claude subscription renewal failed/,
  });
  t.truthy(f.read().pendingRefresh);
  await t.throwsAsync(
    () => makeClaudeSubscriptionCredential(f.powers).current(),
    { message: /consumed|pending/i },
  );
});

test('malformed refresh replies never leak provider body or credentials', async t => {
  await null;
  for (const body of [
    'secret-not-json',
    JSON.stringify({ access_token: 'SECRET', expires_in: 0 }),
    JSON.stringify({
      access_token: 'SECRET',
      expires_in: 3600,
      scope: 'user:profile',
    }),
    'x'.repeat(65_537),
  ]) {
    const refresh = makeClaudeSubscriptionRefresh({
      fetch: async () => new Response(body),
      now: () => 0,
    });
    // eslint-disable-next-line no-await-in-loop
    const error = await t.throwsAsync(() =>
      refresh.refresh({
        refreshToken: 'r',
        accountId: 'secondary',
        scopes: login.scopes,
      }),
    );
    t.is(
      error.message,
      'Claude subscription renewal failed; a fresh login may be required',
    );
  }
});

test('malformed non-object credentials are not forwarded as tokens', async t => {
  await null;
  for (const input of ['null', '[]', '"sk-ant-oat01-quoted"', 'not-a-token']) {
    const f = fixture(input);
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      () => makeClaudeSubscriptionCredential(f.powers).current(),
      {
        message: /Expected Claude subscription token or login JSON/,
      },
    );
    t.is(f.writes.length, 0);
    t.is(f.requests.length, 0);
  }
});

test('usage server errors are not reported as a scope failure', async t => {
  const read = makeClaudeAccountRead({
    credential: {
      async current() {
        return { state: { accessToken: 'access' } };
      },
    },
    fetch: async () => new Response('PRIVATE', { status: 500 }),
  });
  const error = await t.throwsAsync(read);
  t.regex(error.message, /500/);
  t.false(error.message.includes('scope'));
});

test('model-specific exhaustion cannot block the whole subscription', t => {
  const reading = readingFromClaudeUsage({
    five_hour: { utilization: 20 },
    seven_day: { utilization: 20 },
    seven_day_opus: { utilization: 100 },
    seven_day_sonnet: { utilization: 100 },
  });
  t.false(reading.rateLimits.limitReached);
  t.deepEqual(
    reading.rateLimits.windows.map(window => window.windowId),
    ['primary', 'secondary'],
  );
});

test('usage response maps bounded known windows without arbitrary text', t => {
  t.deepEqual(
    readingFromClaudeUsage({
      five_hour: { utilization: 25, resets_at: '2026-09-21T10:00:00Z' },
      seven_day: { utilization: 110, resets_at: 'not-a-date' },
      arbitrary: 'secret',
    }),
    {
      rateLimits: {
        limitReached: true,
        windows: [
          {
            windowId: 'primary',
            title: '5-hour window',
            windowSeconds: 18_000,
            usedPercent: 25,
            resetsAt: '2026-09-21T10:00:00.000Z',
          },
          {
            windowId: 'secondary',
            title: 'Weekly window',
            windowSeconds: 604_800,
            usedPercent: 100,
            resetsAt: '',
          },
        ],
      },
    },
  );
  t.deepEqual(readingFromClaudeUsage(null), {});
});

test('usage read uses broker token and sanitizes permission errors', async t => {
  let calls = 0;
  const read = makeClaudeAccountRead({
    credential: {
      async current() {
        calls += 1;
        return { state: { accessToken: 'access' } };
      },
    },
    fetch: async (url, options) => {
      t.is(url, 'https://api.anthropic.com/api/oauth/usage');
      t.is(options.headers.authorization, 'Bearer access');
      return new Response('PRIVATE', { status: 403 });
    },
  });
  await t.throwsAsync(read, {
    message: /Claude usage permission refused.*403/,
  });
  t.is(calls, 1);
});
