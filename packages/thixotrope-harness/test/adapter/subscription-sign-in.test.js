// @ts-check
// The browser's subscription sign-in (`AH/subscriptions/sign-in-service.js`
// over `sign-in.js`) against a fake provider on 127.0.0.1 (Claude's
// authorization code with PKCE, ChatGPT's device code) and a real Secrets
// store under H/tmp. A new account writes a Secret and joins (or makes) a
// pool; "sign in again" replaces the member's value in place, conditioned
// on its generation. Refusals: wrong state, bad paste, expired, refused,
// timed out, oversize answer, redirect, too many at once, another ChatGPT
// account, a label the pool has. No token reaches a description or a log.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { makeCredentialAccess } from '../../resources/agent-host/impl/secrets/credential-access.js';
import { parseCredential } from '../../resources/agent-host/impl/subscriptions/credentials.js';
import {
  defaultPoolLabels,
  makeSubscriptionSignIn,
} from '../../resources/agent-host/impl/subscriptions/sign-in-service.js';
import {
  claudeAuthorization,
  codexRequestCode,
  credentialFromLoginFile,
  signInDefaults,
} from '../../resources/agent-host/impl/subscriptions/sign-in.js';
import {
  fakeJwt,
  startFakeSignInProvider,
} from '../fixtures/fake-signin-provider.mjs';
import { makeStoreDirs, openStore, storedCredential } from './_m4-renewal.js';

const { E, Far } = /** @type {any} */ (globalThis);

/**
 * A pool, its fake manager and Accounts, a Secrets store, the provider,
 * and the service over them.
 * @param {import('ava').ExecutionContext} t
 * @param {{ kind?: string, members?: { label: string, value: string }[], bounds?: any, pendingPolls?: number, addFails?: boolean, wrapAccess?: (access: any, key: string, store: any) => any }} [options]
 */
const setup = async (
  t,
  {
    kind = 'claude-pool',
    members = [],
    bounds = {},
    pendingPolls = 1,
    addFails = false,
    wrapAccess = access => access,
  } = {},
) => {
  const dirs = makeStoreDirs('sign-in');
  t.teardown(dirs.done);
  const store = openStore(dirs.files);
  const provider = await startFakeSignInProvider({ pendingPolls });
  t.teardown(provider.close);

  let serial = 0;
  /** @type {WeakMap<any, string>} */
  const keyOfSecret = new WeakMap();
  /** @type {any[]} */
  const created = [];
  const makeSecret = (/** @type {string} */ key) => {
    const secret = Far('Secret', {
      revoke: () => store.revoke(key),
      delete: () => store.delete(key),
    });
    keyOfSecret.set(secret, key);
    return secret;
  };
  /** @type {{ member: any, label: string, key: string }[]} */
  const memberEntries = [];
  const makeMemberObject = (/** @type {string} */ label) =>
    Far('PoolMember', {
      describe: () =>
        harden({ provider: 'x', label, weight: 1, state: 'active' }),
    });
  for (const { label, value } of members) {
    serial += 1;
    const key = `k${serial}`;
    // eslint-disable-next-line no-await-in-loop
    await store.create(key, label, 'seeded');
    // eslint-disable-next-line no-await-in-loop
    await store.replace(key, value, 0);
    memberEntries.push({ member: makeMemberObject(label), label, key });
  }
  const pool = Far('Backend', {
    describe: () => harden({ kind, label: 'the pool' }),
  });
  /** @type {any[]} */
  const added = [];
  /** @type {any[]} */
  const madePools = [];
  const accounts = Far('Accounts', {
    poolMembers: (/** @type {any} */ backend) =>
      backend === pool ? memberEntries.map(entry => entry.member) : [],
    addMember: async (
      /** @type {any} */ backend,
      /** @type {any} */ request,
    ) => {
      if (addFails) throw Error('the pool refused');
      added.push({ backend, ...request });
      return makeMemberObject(request.label);
    },
  });
  const subscriptions = Far('SubscriptionsAdmin', {
    makeMember: (/** @type {any} */ request) => {
      added.push({ made: true, ...request });
      return makeMemberObject(request.label);
    },
    makePool: (/** @type {any} */ spec) => {
      madePools.push(spec);
      return Far('Backend', {});
    },
  });
  const secretsAdmin = Far('SecretsAdmin', {
    create: async (/** @type {{ label: string, description: string }} */ r) => {
      serial += 1;
      const key = `k${serial}`;
      await store.create(key, r.label, r.description);
      const secret = makeSecret(key);
      created.push({ secret, key, label: r.label });
      return secret;
    },
    subscriptions: () => subscriptions,
  });
  const writer = Far('GatewaySecretWriter', {
    replace: async (
      /** @type {any} */ secret,
      /** @type {string} */ value,
      /** @type {number} */ expected,
    ) => {
      const key = keyOfSecret.get(secret);
      if (key === undefined) throw Error('UNKNOWN_SECRET');
      return harden({ generation: await store.replace(key, value, expected) });
    },
  });
  /** @type {Record<string, unknown>[]} */
  const logs = [];
  /** @type {object[]} */
  const marked = [];
  const service = makeSubscriptionSignIn({
    secretsAdmin: async () => secretsAdmin,
    secretWriter: async () => writer,
    accounts: () => accounts,
    memberAccess: async (backend, member) => {
      const entry = memberEntries.find(e => e.member === member);
      if (backend !== pool || entry === undefined) throw Error('not a member');
      return harden({
        provider: kind === 'claude-pool' ? 'claude' : 'codex',
        label: entry.label,
        access: wrapAccess(
          makeCredentialAccess({ store, key: entry.key }),
          entry.key,
          store,
        ),
      });
    },
    log: event => logs.push(event),
    endpoints: { claude: provider.claude, codex: provider.codex },
    bounds: { waitMs: 200, ...bounds },
    sleep: async () => {},
    markLocal: object => marked.push(object),
  });
  /**
   * Wait until the pending sign-in leaves `states`.
   * @param {any} pending
   * @param {string[]} [states]
   */
  const settle = async (
    pending,
    states = ['starting', 'waiting', 'finishing'],
  ) => {
    let view = await E(pending).describe();
    for (let i = 0; i < 100 && states.includes(view.state); i += 1) {
      // eslint-disable-next-line no-await-in-loop
      view = await E(pending).wait(view.rev);
    }
    return view;
  };
  /** The authorization page's `code#state` (the fake consent page). */
  const pasteOf = async (/** @type {any} */ view) => {
    const answer = await (await fetch(view.authorizeUrl)).json();
    return `${answer.code}#${answer.state}`;
  };
  return {
    store,
    provider,
    pool,
    service,
    added,
    madePools,
    created,
    memberEntries,
    logs,
    marked,
    settle,
    pasteOf,
  };
};

/**
 * No token of the store's values in what the page or the log saw.
 * @param {import('ava').ExecutionContext} t
 * @param {any} s
 * @param {unknown[]} seen
 */
const noTokensSeen = async (t, s, seen) => {
  const shown = JSON.stringify([...seen, s.logs]);
  for (const { key } of [...s.created, ...s.memberEntries]) {
    // eslint-disable-next-line no-await-in-loop
    const { value } = await s.store.read(key).catch(() => ({ value: '' }));
    if (value) {
      const parsed = JSON.parse(value);
      for (const token of [parsed.accessToken, parsed.refreshToken])
        if (token) t.false(shown.includes(token), 'no token shown');
    }
  }
};

test('Claude: a new account into the pool, PKCE and an independent state, nothing but the URL shown', async t => {
  const s = await setup(t);
  t.regex(await E(s.service).help(), /begin\(provider, label, pool\?\)/u);
  const pending = await E(s.service).begin(
    'claude',
    'Claude Account 1',
    s.pool,
  );
  t.true(s.marked.includes(pending), 'the gateway marks it its own');
  const view = await E(pending).describe();
  t.is(view.state, 'waiting');
  t.is(view.provider, 'claude');
  const page = new URL(view.authorizeUrl);
  t.is(page.origin, s.provider.base);
  t.is(page.searchParams.get('code_challenge_method'), 'S256');
  t.truthy(page.searchParams.get('code_challenge'));
  t.truthy(page.searchParams.get('state'));
  t.is(page.searchParams.get('response_type'), 'code');
  const done = await E(pending).complete(await s.pasteOf(view));
  t.is(done.state, 'done');
  t.deepEqual(done.result.created, 'member');
  t.is(s.created.length, 1);
  t.is(s.created[0].label, 'Claude Account 1');
  t.is(s.added.length, 1);
  t.is(s.added[0].backend, s.pool);
  t.is(s.added[0].credential, s.created[0].secret);
  const stored = parseCredential(
    (await s.store.read(s.created[0].key)).value,
    'claude',
  );
  t.true(stored.expiresAtMs > Date.now());
  t.true(/** @type {any} */ (stored).scopes.includes('user:inference'));
  await noTokensSeen(t, s, [view, done]);
  t.deepEqual(
    s.provider.requests().filter(r => r.method === 'POST'),
    [
      {
        method: 'POST',
        path: '/v1/oauth/token',
        grant: 'authorization_code',
        status: 200,
      },
    ],
  );
});

test('Claude: a wrong state or a bad paste is refused before anything is sent; the sign-in can still finish', async t => {
  const s = await setup(t);
  const pending = await E(s.service).begin('claude', 'A', s.pool);
  const view = await E(pending).describe();
  const good = await s.pasteOf(view);
  const [code] = good.split('#');
  await t.throwsAsync(E(pending).complete(`${code}#not-this-state`), {
    message: /belongs to another sign-in/u,
  });
  await t.throwsAsync(E(pending).complete('just some text'), {
    message: /not a sign-in code/u,
  });
  t.is((await E(pending).describe()).state, 'waiting');
  t.is(s.provider.requests().filter(r => r.method === 'POST').length, 0);
  t.is((await E(pending).complete(good)).state, 'done');
});

test('Claude: refused, redirected, oversize and timed-out exchanges fail in plain words and keep nothing', async t => {
  const s = await setup(t, { bounds: { exchangeTimeoutMs: 300 } });
  s.provider.plan('/v1/oauth/token', [
    { status: 400, body: { error: 'invalid_grant' } },
    { redirect: true },
    { oversize: true },
    { hang: true },
  ]);
  /** @type {[string, RegExp][]} */
  const expected = [
    ['REFUSED', /refused the sign-in \(HTTP 400\)/u],
    ['REDIRECTED', /redirect/u],
    ['TOO_LARGE', /more than a sign-in needs/u],
    ['TIMED_OUT', /did not answer in time/u],
  ];
  for (const [code, words] of expected) {
    // eslint-disable-next-line no-await-in-loop
    const pending = await E(s.service).begin('claude', `A ${code}`, s.pool);
    // eslint-disable-next-line no-await-in-loop
    const view = await E(pending).describe();
    // eslint-disable-next-line no-await-in-loop
    const after = await E(pending).complete(await s.pasteOf(view));
    t.is(after.state, 'failed', code);
    t.is(after.error.code, code);
    t.regex(after.error.text, words);
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(E(pending).complete('x#y'), { message: /already/u });
  }
  t.is(s.created.length, 0, 'no Secret made');
  t.is(s.added.length, 0);
});

test('a pending sign-in expires; at most maxPending wait at once; cancel frees a place', async t => {
  const s = await setup(t, { bounds: { pendingMs: 150, maxPending: 2 } });
  const first = await E(s.service).begin('claude', 'A', s.pool);
  const second = await E(s.service).begin('claude', 'B', s.pool);
  await t.throwsAsync(E(s.service).begin('claude', 'C', s.pool), {
    message: /At most 4 sign-ins|At most \d+ sign-ins/u,
  });
  t.is((await E(second).cancel()).state, 'cancelled');
  const third = await E(s.service).begin('claude', 'C', s.pool);
  const expired = await s.settle(first, ['waiting']);
  t.is(expired.state, 'expired');
  t.regex(expired.error.text, /expired/u);
  await t.throwsAsync(E(first).complete('a#b'), { message: /expired/u });
  t.is((await s.settle(third, ['waiting'])).state, 'expired');
  // Both expired: the places are free again.
  await E(s.service).begin('claude', 'D', s.pool);
  await E(s.service).begin('claude', 'E', s.pool);
});

test('begin refuses a label the pool has, a pool of the other provider, an unknown provider', async t => {
  const s = await setup(t, {
    members: [
      {
        label: 'Claude Account 1',
        value: storedCredential({
          accessToken: 'fake-access',
          refreshToken: 'fake-refresh',
          expiresAtMs: Date.now() + 3_600_000,
          scopes: ['user:inference'],
        }),
      },
    ],
  });
  await t.throwsAsync(
    E(s.service).begin('claude', 'Claude Account 1', s.pool),
    {
      message: /already has a subscription with this label/u,
    },
  );
  await t.throwsAsync(E(s.service).begin('codex', 'X', s.pool), {
    message: /another provider/u,
  });
  await t.throwsAsync(E(s.service).begin('gemini', 'X'), {
    message: /Choose Claude or ChatGPT/u,
  });
  await t.throwsAsync(E(s.service).begin('claude', ' \n '), {
    message: /Enter a label/u,
  });
});

test('ChatGPT: the device code flow makes a new pool with the member; the stored form has the account id', async t => {
  const s = await setup(t, { kind: 'codex-pool', pendingPolls: 2 });
  const pending = await E(s.service).begin('codex', 'ChatGPT Account 1');
  const waiting = await s.settle(pending, ['starting']);
  t.is(waiting.state, 'waiting');
  t.is(waiting.verificationUrl, `${s.provider.base}/codex/device`);
  t.regex(waiting.userCode, /^[0-9A-F]{4}-[0-9A-F]{4}$/u);
  t.false('deviceAuthId' in waiting, 'the device id stays in the adapter');
  const done = await s.settle(pending);
  t.is(done.state, 'done', JSON.stringify(done.error));
  t.is(done.result.created, 'pool');
  t.deepEqual(
    s.madePools.map(spec => [spec.kind, spec.label, spec.members.length]),
    [['codex-pool', defaultPoolLabels.codex, 1]],
  );
  t.is(s.added[0].provider, 'codex');
  t.is(s.added[0].credential, s.created[0].secret);
  const stored = parseCredential(
    (await s.store.read(s.created[0].key)).value,
    'codex',
  );
  t.is(stored.accountId, 'acct-1');
  t.true(stored.expiresAtMs > Date.now());
  const posts = s.provider.requests().filter(r => r.method === 'POST');
  t.deepEqual(
    posts.map(r => [r.path, r.status]),
    [
      ['/api/accounts/deviceauth/usercode', 200],
      ['/api/accounts/deviceauth/token', 403],
      ['/api/accounts/deviceauth/token', 403],
      ['/api/accounts/deviceauth/token', 200],
      ['/oauth/token', 200],
    ],
  );
  t.is(posts[4].grant, 'authorization_code');
  await noTokensSeen(t, s, [waiting, done]);
});

test('ChatGPT: no device code (404), a refused poll, a refused exchange', async t => {
  const s = await setup(t, { kind: 'codex-pool' });
  s.provider.plan('/api/accounts/deviceauth/usercode', [{ status: 404 }]);
  const none = await s.settle(await E(s.service).begin('codex', 'A', s.pool));
  t.is(none.state, 'failed');
  t.is(none.error.code, 'DEVICE_NOT_ENABLED');
  t.regex(none.error.text, /security settings/u);
  s.provider.plan('/api/accounts/deviceauth/token', [{ status: 500 }]);
  const poll = await s.settle(await E(s.service).begin('codex', 'B', s.pool));
  t.is(poll.error.code, 'REFUSED');
  t.regex(poll.error.text, /HTTP 500/u);
  s.provider.plan('/oauth/token', [{ status: 401 }]);
  const exchange = await s.settle(
    await E(s.service).begin('codex', 'C', s.pool),
  );
  t.is(exchange.error.code, 'REFUSED');
  t.is(s.created.length, 0);
});

test('ChatGPT: an auth.json pasted instead stops the device poll and is stored in the stored form', async t => {
  const s = await setup(t, { kind: 'codex-pool', pendingPolls: 1000 });
  const pending = await E(s.service).begin('codex', 'From file', s.pool);
  await s.settle(pending, ['starting']);
  await t.throwsAsync(E(pending).useLoginFile('{"OPENAI_API_KEY":"sk-x"}'), {
    message: /not a usable login file/u,
  });
  t.is((await E(pending).describe()).state, 'waiting', 'still waiting');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const auth = { chatgpt_account_id: 'acct-file' };
  const accessToken = fakeJwt({ exp, 'https://api.openai.com/auth': auth });
  const file = JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: fakeJwt({ exp, 'https://api.openai.com/auth': auth }),
      access_token: accessToken,
      refresh_token: 'fake-refresh-file',
      account_id: 'acct-file',
    },
    last_refresh: new Date().toISOString(),
  });
  const done = await E(pending).useLoginFile(file);
  t.is(done.state, 'done');
  const value = (await s.store.read(s.created[0].key)).value;
  t.is(JSON.parse(value).version, 1, 'the stored form, not the file');
  t.false(value.includes('id_token'));
  t.is(parseCredential(value, 'codex').accountId, 'acct-file');
});

test('sign in again: the member Secret is replaced in place at its generation; another account and a moved generation are refused', async t => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const old = storedCredential({
    provider: 'codex',
    accessToken: fakeJwt({
      exp,
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' },
    }),
    refreshToken: 'fake-refresh-old',
    expiresAtMs: exp * 1000,
    accountId: 'acct-1',
    pendingRefresh: { startedAtMs: Date.now() - 1000 },
  });
  const s = await setup(t, {
    kind: 'codex-pool',
    members: [{ label: 'ChatGPT Account 1', value: old }],
  });
  const [{ member, key }] = s.memberEntries;
  const before = await s.store.read(key);
  const pending = await E(s.service).beginAgain(s.pool, member);
  const done = await s.settle(pending);
  t.is(done.state, 'done', JSON.stringify(done.error));
  t.is(done.label, 'ChatGPT Account 1');
  t.true(done.again);
  t.is(done.result.created, 'replaced');
  const after = await s.store.read(key);
  t.is(after.generation, before.generation + 1);
  t.is(done.result.generation, after.generation);
  const renewed = parseCredential(after.value, 'codex');
  t.is(renewed.pendingRefresh, undefined, 'the consumed mark is gone');
  t.is(s.created.length, 0, 'no new Secret');
  t.is(s.added.length, 0, 'no new member');

  s.provider.setAccount('acct-2');
  const other = await s.settle(await E(s.service).beginAgain(s.pool, member));
  t.is(other.error.code, 'OTHER_ACCOUNT');
  t.is((await s.store.read(key)).generation, after.generation, 'unchanged');

  await t.throwsAsync(E(s.service).beginAgain(s.pool, Far('PoolMember', {})), {
    message: /not an active member/u,
  });
});

test('sign in again: a renewal that writes meanwhile wins (CHANGED)', async t => {
  const s = await setup(t, {
    members: [
      {
        label: 'Claude Account 1',
        value: storedCredential({
          accessToken: 'fake-access',
          refreshToken: 'fake-refresh',
          expiresAtMs: Date.now() + 3_600_000,
          scopes: ['user:inference'],
        }),
      },
    ],
    // A renewal writes between the service's read and its write.
    wrapAccess: (access, key, store) =>
      harden({
        read: async () => {
          const read = await access.read();
          await store.replace(key, read.value, read.generation);
          return read;
        },
        replace: access.replace,
      }),
  });
  const [{ member, key }] = s.memberEntries;
  const pending = await E(s.service).beginAgain(s.pool, member);
  const view = await E(pending).describe();
  const before = await s.store.read(key);
  const done = await E(pending).complete(await s.pasteOf(view));
  t.is(done.state, 'failed');
  t.is(done.error.code, 'CHANGED');
  t.regex(done.error.text, /changed meanwhile/u);
  const after = await s.store.read(key);
  t.is(after.value, before.value, 'the renewal’s value stands');
});

test('a failed add removes the new Secret (no live tokens left behind)', async t => {
  const s = await setup(t, { addFails: true });
  const pending = await E(s.service).begin('claude', 'A', s.pool);
  const view = await E(pending).describe();
  const after = await E(pending).complete(await s.pasteOf(view));
  t.is(after.state, 'failed');
  t.is(after.error.code, 'ADD_FAILED');
  t.regex(after.error.text, /the pool refused/u);
  t.is(s.created.length, 1);
  await t.throwsAsync(s.store.read(s.created[0].key));
});

test('the flows: the real endpoints are well-formed; interval strings, login files', async t => {
  const page = new URL(claudeAuthorization().url);
  t.is(page.origin, 'https://claude.com');
  t.is(page.pathname, '/cai/oauth/authorize');
  t.is(page.searchParams.get('client_id'), signInDefaults.claude.clientId);
  t.is(
    page.searchParams.get('redirect_uri'),
    'https://platform.claude.com/oauth/code/callback',
  );
  t.true(page.searchParams.get('scope')?.split(' ').includes('user:inference'));
  t.is(signInDefaults.codex.clientId, 'app_EMoamEEZ73f0CkXaXp7hrann');
  t.is(
    signInDefaults.codex.userCodeUrl,
    'https://auth.openai.com/api/accounts/deviceauth/usercode',
  );
  t.is(
    signInDefaults.codex.redirectUri,
    'https://auth.openai.com/deviceauth/callback',
  );
  const provider = await startFakeSignInProvider();
  t.teardown(provider.close);
  const code = await codexRequestCode({
    fetch: globalThis.fetch,
    endpoints: provider.codex,
  });
  t.is(code.intervalMs, 1000, 'the "1" string is one second');
  t.true(Number(code.expiresAtMs) > Date.now());
  t.throws(() => credentialFromLoginFile('not json', 'codex'), {
    message: /not a usable login file/u,
  });
  t.throws(() => credentialFromLoginFile('x'.repeat(70_000), 'claude'), {
    message: /not a usable login file/u,
  });
  const claude = credentialFromLoginFile(
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fake-access',
        refreshToken: 'fake-refresh',
        expiresAt: Date.now() + 3_600_000,
        scopes: ['user:inference'],
      },
    }),
    'claude',
  );
  t.is(JSON.parse(claude).provider, 'claude');
});
