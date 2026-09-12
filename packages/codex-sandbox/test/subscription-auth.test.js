// @ts-check
import '@endo/init';

import test from 'ava';
import { Far } from '@endo/far';

import {
  importCodexSubscription,
  makeCodexSubscriptionCredential,
  makeCodexSubscriptionRefresh,
} from '../src/subscription-auth.js';

const now = () => 1_800_000_000_000;
const token = (accountId = 'account-1', expiresAt = now() + 3_600_000) =>
  `e30.${btoa(
    JSON.stringify({
      exp: expiresAt / 1000,
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    }),
  )}.signature`;
const initial = () =>
  importCodexSubscription({
    tokens: {
      access_token: token('account-1', 0),
      refresh_token: 'long-lived-renewal',
      account_id: 'account-1',
    },
  });

test('import requires renewal credential and binds the account', t => {
  t.is(initial().refreshToken, 'long-lived-renewal');
  for (const tokens of [
    { access_token: token(), account_id: 'account-1' },
    { access_token: token(), refresh_token: 'renewal', account_id: 'other' },
  ])
    t.throws(() => importCodexSubscription({ tokens }));
  t.throws(() => importCodexSubscription({ OPENAI_API_KEY: 'api-key' }));
});

test('fixed stock renewal request persists the rotated renewal token', async t => {
  const refresh = makeCodexSubscriptionRefresh({
    now,
    fetch: async (url, options) => {
      t.is(url, 'https://auth.openai.com/oauth/token');
      t.is(options?.redirect, 'error');
      t.is(options?.credentials, 'omit');
      t.deepEqual(JSON.parse(String(options?.body)), {
        client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
        grant_type: 'refresh_token',
        refresh_token: 'renewal',
      });
      return Response.json({ access_token: token(), refresh_token: 'rotated' });
    },
  });
  const result = await refresh.refresh({
    refreshToken: 'renewal',
    accountId: 'account-1',
  });
  t.is(result.refreshToken, 'rotated');
  t.is(result.accountId, 'account-1');
});

test('omitted renewal token retains the old long-lived credential', async t => {
  const refresh = makeCodexSubscriptionRefresh({
    now,
    fetch: async () => Response.json({ access_token: token() }),
  });
  t.is(
    (await refresh.refresh({ refreshToken: 'renewal', accountId: 'account-1' }))
      .refreshToken,
    'renewal',
  );
});

test('invalid, expired, switched-account, and oversized responses fail without secrets', async t => {
  const responses = [
    Response.json({ error: 'SECRET-ECHO' }, { status: 401 }),
    Response.json({ access_token: 'SECRET-ECHO' }),
    Response.json({
      access_token: token('other'),
      refresh_token: 'SECRET-ECHO',
    }),
    Response.json({ access_token: token('account-1', 0) }),
    new Response('SECRET-ECHO'.repeat(8000)),
  ];
  for (const response of responses) {
    const refresh = makeCodexSubscriptionRefresh({
      now,
      fetch: async () => response,
    });
    // eslint-disable-next-line no-await-in-loop
    const error = await t.throwsAsync(() =>
      refresh.refresh({ refreshToken: 'SECRET-ECHO', accountId: 'account-1' }),
    );
    t.false(error?.message.includes('SECRET-ECHO'));
  }
});

const store = () => {
  /** @type {ReturnType<typeof initial> & {pendingRefresh?: {startedAt: number}}} */
  let state = initial();
  let generation = 0n;
  return {
    read: () => state,
    secret: Far('subscription read', {
      async readBase64WithGeneration() {
        return harden({ base64: btoa(JSON.stringify(state)), generation });
      },
    }),
    rotate: Far('subscription rotate', {
      async replaceBase64(base64, options) {
        if (options?.ifGeneration !== generation)
          throw Error('GENERATION_CONFLICT');
        state = JSON.parse(atob(base64));
        generation += 1n;
        return generation;
      },
    }),
  };
};

test('every Secrets read checks access claims and requires renewal authority', async t => {
  for (const replacement of [
    { ...initial(), accessToken: token('other') },
    { ...initial(), expiresAt: now() + 3_600_000 },
    {
      ...initial(),
      accessToken: token(),
      expiresAt: now() + 3_600_000,
      refreshToken: undefined,
    },
  ]) {
    const storage = store();
    // eslint-disable-next-line no-await-in-loop
    await storage.rotate.replaceBase64(btoa(JSON.stringify(replacement)), {
      ifGeneration: 0n,
    });
    const credential = makeCodexSubscriptionCredential({
      ...storage,
      accountRef: 'account-1',
      now,
      fetch: async () => {
        t.fail('Invalid replacement must not dispatch');
        throw Error('Unexpected fetch');
      },
    });
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => credential.current());
  }
});

test('concurrent callers exchange once and commit renewal before using access', async t => {
  const storage = store();
  let exchanges = 0;
  const credential = makeCodexSubscriptionCredential({
    ...storage,
    accountRef: 'account-1',
    now,
    fetch: async () => {
      exchanges += 1;
      t.truthy(storage.read().pendingRefresh);
      return Response.json({
        access_token: token(),
        refresh_token: 'next-renewal',
      });
    },
  });
  const results = await Promise.all([
    credential.current(),
    credential.current(),
  ]);
  t.is(exchanges, 1);
  t.is(storage.read().refreshToken, 'next-renewal');
  t.is(storage.read().pendingRefresh, undefined);
  t.is(results[0].state.accessToken, token());
});

test('unknown renewal outcome remains fenced across owner reconstruction', async t => {
  const storage = store();
  let exchanges = 0;
  const powers = {
    ...storage,
    accountRef: 'account-1',
    now,
    fetch: async () => {
      exchanges += 1;
      throw Error('SECRET-ECHO');
    },
  };
  await t.throwsAsync(() => makeCodexSubscriptionCredential(powers).current(), {
    message: /renewal failed/,
  });
  await t.throwsAsync(() => makeCodexSubscriptionCredential(powers).current(), {
    message: /consumed/,
  });
  t.is(exchanges, 1);
});

test('failed persistence after renewal never hands out access or replays renewal', async t => {
  const storage = store();
  let writes = 0;
  let exchanges = 0;
  const powers = {
    ...storage,
    accountRef: 'account-1',
    now,
    rotate: Far('failing persistence', {
      async replaceBase64(base64, options) {
        writes += 1;
        if (writes === 2) throw Error('disk failure');
        return storage.rotate.replaceBase64(base64, options);
      },
    }),
    fetch: async () => {
      exchanges += 1;
      return Response.json({ access_token: token(), refresh_token: 'rotated' });
    },
  };
  await t.throwsAsync(() => makeCodexSubscriptionCredential(powers).current(), {
    message: /rotation failed/,
  });
  await t.throwsAsync(() => makeCodexSubscriptionCredential(powers).current(), {
    message: /consumed/,
  });
  t.is(exchanges, 1);
});

test('operator replacement wins over an in-flight renewal', async t => {
  const storage = store();
  const credential = makeCodexSubscriptionCredential({
    ...storage,
    accountRef: 'account-1',
    now,
    fetch: async () => {
      await storage.rotate.replaceBase64(
        btoa(
          JSON.stringify({
            ...initial(),
            accessToken: token(),
            expiresAt: now() + 3_600_000,
            refreshToken: 'operator-renewal',
          }),
        ),
        { ifGeneration: 1n },
      );
      return Response.json({
        access_token: token(),
        refresh_token: 'discard-this',
      });
    },
  });
  const result = await credential.current();
  t.is(result.outcome, 'adopted');
  t.is(storage.read().refreshToken, 'operator-renewal');
});

test('rejected or mismatched renewal is durably fenced', async t => {
  for (const reply of [
    () => new Response('private', { status: 401 }),
    () => Response.json({ access_token: token('other') }),
  ]) {
    const storage = store();
    let exchanges = 0;
    const powers = {
      ...storage,
      accountRef: 'account-1',
      now,
      fetch: async () => {
        exchanges += 1;
        return reply();
      },
    };
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      () => makeCodexSubscriptionCredential(powers).current(),
      { message: /renewal failed/ },
    );
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      () => makeCodexSubscriptionCredential(powers).current(),
      { message: /consumed/ },
    );
    t.is(exchanges, 1);
  }
});
