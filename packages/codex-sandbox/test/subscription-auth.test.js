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

const renewalFailure =
  'Codex subscription renewal failed; sign in again if the renewal outcome cannot be recovered';
/** @param {string} text */
const encoded = text => new TextEncoder().encode(text);
const splitReply = encoded(
  JSON.stringify({ access_token: token(), note: '🐙 café' }),
);
const splitAt = splitReply.indexOf(0xf0) + 2;

/** @type {[string, Uint8Array[], boolean][]} */
const renewalReplies = [
  [
    'split multibyte JSON',
    [splitReply.subarray(0, splitAt), splitReply.subarray(splitAt)],
    true,
  ],
  ['oversized bytes', [new Uint8Array(64 * 1024 + 1).fill(0x20)], false],
  ['invalid UTF-8', [Uint8Array.of(0xc3), Uint8Array.of(0x28)], false],
  ['incomplete UTF-8', [Uint8Array.of(0xc3)], false],
  ['invalid JSON', [encoded('PRIVATE-RESPONSE')], false],
  [
    'switched account claims',
    [encoded(JSON.stringify({ access_token: token('other') }))],
    false,
  ],
];
for (const [name, chunks, succeeds] of renewalReplies) {
  for (const rejectsCancellation of [false, true]) {
    test(`renewal awaits one owned cancellation for ${name} (rejects=${rejectsCancellation})`, async t => {
      t.timeout(5000);
      let release = () => {};
      const cancellationBarrier = new Promise(resolve => {
        release = () => resolve(undefined);
      });
      t.teardown(release);
      let entered = () => {};
      const cancellationStarted = new Promise(resolve => {
        entered = () => resolve(undefined);
      });
      let cancellations = 0;
      const response = new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
      );
      const body = response.body;
      if (!body) throw Error('Expected synthetic response body');
      const getReader = body.getReader.bind(body);
      Object.defineProperty(body, 'getReader', {
        value: () => {
          const reader = getReader();
          const cancel = reader.cancel.bind(reader);
          reader.cancel = async () => {
            cancellations += 1;
            entered();
            await cancellationBarrier;
            await cancel();
            if (rejectsCancellation) throw Error('PRIVATE-CANCEL-FAILURE');
          };
          return reader;
        },
      });
      let exchanges = 0;
      const refresh = makeCodexSubscriptionRefresh({
        now,
        fetch: async () => {
          exchanges += 1;
          return response;
        },
      });
      const renewing = refresh.refresh({
        refreshToken: 'renewal',
        accountId: 'account-1',
      });
      let settled = false;
      void renewing.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await cancellationStarted;
      await null;
      t.is(cancellations, 1);
      t.false(settled, 'renewal must await cancellation acknowledgement');
      release();
      if (succeeds) {
        t.is((await renewing).accessToken, token());
      } else {
        await t.throwsAsync(renewing, { message: renewalFailure });
      }
      t.is(cancellations, 1, 'the parser must not cancel its borrowed reader');
      t.is(exchanges, 1, 'parsing and cleanup must never retry renewal');
    });
  }
}

test('renewal accepts an exact 64 KiB JSON response', async t => {
  const text = JSON.stringify({ access_token: token() }).padEnd(64 * 1024);
  t.is(encoded(text).byteLength, 64 * 1024);
  const refresh = makeCodexSubscriptionRefresh({
    now,
    fetch: async () => new Response(text),
  });
  t.is(
    (await refresh.refresh({ refreshToken: 'renewal', accountId: 'account-1' }))
      .accessToken,
    token(),
  );
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
