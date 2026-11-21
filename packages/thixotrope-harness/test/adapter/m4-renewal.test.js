// @ts-check
// M4 W4.4: subscription credentials and their renewal
// (designs/m4-interfaces.md 7 and 10; R7-16, R7-29, R7-30; D-M4-8). A real
// Secrets store over a temporary state directory and the fake OAuth server
// on loopback; no supervisor.
import '../unit/_m1a-prelude.js';

import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import {
  subscriptionCodes,
  subscriptionTexts,
} from '../../guest/lib/subscription-texts.js';
/* eslint-enable import/no-relative-packages */
import { makeCredentialAccess } from '../../resources/agent-host/impl/secrets/credential-access.js';
import {
  formatCredential,
  parseCredential,
} from '../../resources/agent-host/impl/subscriptions/credentials.js';
import { makeMemberCredential } from '../../resources/agent-host/impl/subscriptions/renewal.js';
import { startFakeOAuthServer } from '../fixtures/fake-oauth-server.mjs';
import {
  makeStoreDirs,
  openStore,
  seedCredential,
  storedCredential,
} from './_m4-renewal.js';

/**
 * A token-shaped placeholder; joined at run time.
 * @param {string} tag
 */
const fakeToken = tag =>
  ['tok', tag, Math.random().toString(36).slice(2, 10)].join('-');

/**
 * Assert a rejection with a fixed code, and that its message holds none of
 * the given secrets.
 * @param {import('ava').ExecutionContext} t
 * @param {Promise<unknown>} promise
 * @param {string} code
 * @param {string[]} [secrets]
 */
const rejectsWith = async (t, promise, code, secrets = []) => {
  const error = await t.throwsAsync(promise);
  t.is(/** @type {any} */ (error).code, code, error?.message);
  t.true(
    subscriptionCodes.includes(code) || code === 'INVALID_GENERATION',
    code,
  );
  for (const secret of secrets)
    t.false(String(error?.message).includes(secret), 'no secret in the text');
};

/**
 * A store with one member credential near expiry, the fake OAuth server
 * holding its refresh token, and a member credential over them.
 * @param {import('ava').ExecutionContext} t
 * @param {object} [options]
 * @param {Parameters<typeof startFakeOAuthServer>[0]} [options.server]
 * @param {number} [options.expiresInMs] of the stored access token
 * @param {string} [options.accountId]
 * @param {'claude' | 'codex'} [options.provider]
 */
const setup = async (t, options = {}) => {
  const { expiresInMs = 1000, provider = 'claude', accountId } = options;
  const dirs = makeStoreDirs('w44-renew');
  const server = await startFakeOAuthServer(options.server);
  const store = openStore(dirs.files);
  t.teardown(async () => {
    store.close();
    await server.close();
    dirs.done();
  });
  const issued = server.issue();
  const value = storedCredential({
    provider,
    accessToken: issued.accessToken,
    refreshToken: issued.refreshToken,
    expiresAtMs: Date.now() + expiresInMs,
    ...(accountId === undefined ? {} : { accountId }),
  });
  const generation = await seedCredential(store, value);
  /** @param {Partial<Parameters<typeof makeMemberCredential>[0]>} [more] */
  const member = (more = {}) =>
    makeMemberCredential({
      access: makeCredentialAccess({ store, key: 'k1' }),
      provider,
      tokenUrl: server.tokenUrl,
      now: () => Date.now(),
      ...more,
    });
  const stored = async () => {
    const { value: now, generation: at } = await store.read('k1');
    return { credential: parseCredential(now, provider), generation: at };
  };
  return { dirs, server, store, issued, value, generation, member, stored };
};

test('parseCredential: stored form, provider logins, refusals', t => {
  const accessToken = fakeToken('a');
  const refreshToken = fakeToken('r');
  const stored = parseCredential(
    storedCredential({ accessToken, refreshToken, expiresAtMs: 5 }),
    'claude',
  );
  t.deepEqual(stored, {
    provider: 'claude',
    accessToken,
    refreshToken,
    expiresAtMs: 5,
  });
  t.deepEqual(parseCredential(formatCredential(stored), 'claude'), stored);
  // Claude's credentials export, inner object or wrapped.
  const login = {
    accessToken,
    refreshToken,
    expiresAt: 7,
    scopes: ['user:inference', 'user:profile'],
  };
  const fromLogin = parseCredential(
    JSON.stringify({ claudeAiOauth: login }),
    'claude',
  );
  t.is(fromLogin.expiresAtMs, 7);
  t.deepEqual(fromLogin.scopes, ['user:inference', 'user:profile']);
  t.deepEqual(parseCredential(JSON.stringify(login), 'claude'), fromLogin);
  // Codex's login cache: expiry and account from the access token's claims.
  const part = (/** @type {unknown} */ v) =>
    Buffer.from(JSON.stringify(v)).toString('base64url');
  const jwt = [
    part({ alg: 'none' }),
    part({ exp: 1000, auth: { chatgpt_account_id: 'acct-9' } }),
    'x',
  ].join('.');
  const codex = parseCredential(
    JSON.stringify({
      tokens: {
        access_token: jwt,
        refresh_token: refreshToken,
        account_id: 'acct-9',
      },
    }),
    'codex',
  );
  t.is(codex.expiresAtMs, 1_000_000);
  t.is(codex.accountId, 'acct-9');

  const refusals = [
    ['not json', 'claude'],
    [JSON.stringify([1]), 'claude'],
    [storedCredential({ accessToken, expiresAtMs: 1 }), 'codex'],
    [JSON.stringify({ claudeAiOauth: login }), 'codex'],
    [
      JSON.stringify({
        tokens: {
          access_token: jwt,
          refresh_token: refreshToken,
          account_id: 'acct-9',
        },
      }),
      'claude',
    ],
    [
      JSON.stringify({
        tokens: {
          access_token: jwt,
          refresh_token: refreshToken,
          account_id: 'other',
        },
      }),
      'codex',
    ],
    [JSON.stringify({ ...login, scopes: ['user:profile'] }), 'claude'],
    [
      storedCredential({ accessToken: `${accessToken} x`, expiresAtMs: 1 }),
      'claude',
    ],
    [
      storedCredential({
        accessToken,
        expiresAtMs: 1,
        refreshToken: 'r'.repeat(8200),
      }),
      'claude',
    ],
    [storedCredential({ accessToken, expiresAtMs: -1 }), 'claude'],
  ];
  for (const [text, provider] of refusals) {
    const error = t.throws(() =>
      parseCredential(text, /** @type {any} */ (provider)),
    );
    t.is(/** @type {any} */ (error).code, 'INVALID');
    t.is(error?.message, subscriptionTexts.credentialInvalid);
  }
  // Exactly 8,192 bytes is read; one byte more is refused (R7-25).
  const base = storedCredential({ accessToken: '', expiresAtMs: 1 });
  const fill = 'a'.repeat(8192 - base.length);
  t.is(
    parseCredential(
      storedCredential({ accessToken: fill, expiresAtMs: 1 }),
      'claude',
    ).accessToken,
    fill,
  );
  t.throws(() =>
    parseCredential(
      storedCredential({ accessToken: `${fill}a`, expiresAtMs: 1 }),
      'claude',
    ),
  );
});

test('a fresh credential is served as stored, no renewal', async t => {
  const { member, server, issued } = await setup(t, {
    expiresInMs: 3_600_000,
  });
  const credential = member();
  const { credential: got } = await credential.current();
  t.is(got.accessToken, issued.accessToken);
  t.is(server.requests().length, 0);
});

test('near expiry: 16 concurrent rounds renew once, write-ahead then write-back', async t => {
  const { member, server, issued, generation, stored } = await setup(t);
  const credential = member();
  const held = server.hold();
  const rounds = Array.from({ length: 16 }, () => credential.current());
  await held.arrived;
  // The intent is durable before the refresh token is presented.
  const during = await stored();
  t.deepEqual(Object.keys(during.credential.pendingRefresh ?? {}), [
    'startedAtMs',
  ]);
  t.is(during.generation, generation + 1);
  t.is(during.credential.refreshToken, issued.refreshToken);
  held.release();
  const results = await Promise.all(rounds);
  const tokens = new Set(results.map(r => r.credential.accessToken));
  t.is(tokens.size, 1);
  t.false(tokens.has(issued.accessToken));
  t.is(server.requests().filter(r => r.grant === 'refresh_token').length, 1);
  t.is(server.presented(issued.serial), 1);
  const after = await stored();
  t.is(after.generation, generation + 2);
  t.is(after.credential.pendingRefresh, undefined);
  t.not(after.credential.refreshToken, issued.refreshToken, 'rotated');
  t.true(after.credential.expiresAtMs > Date.now() + 3_000_000);
  t.is(results[0].generation, generation + 2);
  // A later round reads the renewed credential: no second refresh.
  await credential.current();
  t.is(server.requests().length, 1);
});

test('a credential carrying pendingRefresh fails CONSUMED, nothing sent', async t => {
  const { store, server, member, issued } = await setup(t);
  const { generation } = await store.read('k1');
  await store.replace(
    'k1',
    storedCredential({
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      expiresAtMs: Date.now() + 1000,
      pendingRefresh: { startedAtMs: 1 },
    }),
    generation,
  );
  const credential = member();
  await rejectsWith(t, credential.current(), 'CONSUMED', [issued.refreshToken]);
  t.is(server.requests().length, 0);
});

test('two holders renewing one credential: one GENERATION_CONFLICT, re-read', async t => {
  const { store, server, issued, stored } = await setup(t);
  // Gate the two holders so both read generation g before either writes.
  /** @type {() => void} */
  let bothRead = () => {};
  const readsDone = new Promise(resolve => {
    bothRead = () => resolve(undefined);
  });
  let reads = 0;
  /** @type {() => void} */
  let aWrote = () => {};
  const aIntent = new Promise(resolve => {
    aWrote = () => resolve(undefined);
  });
  const base = makeCredentialAccess({ store, key: 'k1' });
  const gated = (/** @type {'a' | 'b'} */ who) =>
    harden({
      read: async () => {
        const got = await base.read();
        reads += 1;
        if (reads === 4) bothRead();
        return got;
      },
      /**
       * @param {string} value
       * @param {number} at
       */
      replace: async (value, at) => {
        if (who === 'a') await readsDone;
        else await aIntent;
        const out = await base.replace(value, at);
        if (who === 'a') aWrote();
        return out;
      },
    });
  const held = server.hold();
  /** @param {'a' | 'b'} who */
  const holder = who =>
    makeMemberCredential({
      access: gated(who),
      provider: 'claude',
      tokenUrl: server.tokenUrl,
      now: () => Date.now(),
    });
  const a = holder('a');
  const b = holder('b');
  const aRound = a.current();
  const bRound = b.current();
  // B lost the intent race; it re-read and found A mid-renewal.
  await rejectsWith(t, bRound, 'GENERATION_CONFLICT');
  await held.arrived;
  held.release();
  const aGot = await aRound;
  // B's next round reads A's renewed credential.
  const bGot = await b.current();
  t.is(bGot.credential.accessToken, aGot.credential.accessToken);
  t.is(server.requests().length, 1);
  t.is(server.presented(issued.serial), 1);
  t.is((await stored()).credential.pendingRefresh, undefined);
});

test('after a 401: one renewal for that exact token; none for another', async t => {
  const { member, server, issued } = await setup(t, {
    expiresInMs: 3_600_000,
  });
  const credential = member();
  const { credential: first } = await credential.current();
  const renewed = await credential.renewAfterRejection(first);
  t.not(renewed.accessToken, issued.accessToken);
  t.is(server.requests().length, 1);
  // A rejection of the old token again: the stored one is newer, adopted.
  const again = await credential.renewAfterRejection(first);
  t.is(again.accessToken, renewed.accessToken);
  t.is(server.requests().length, 1);
});

test('no refresh token: served until expiry, then EXPIRED; a 401 is REJECTED', async t => {
  const { store, server, member } = await setup(t);
  const { generation } = await store.read('k1');
  const accessToken = fakeToken('only');
  await store.replace(
    'k1',
    storedCredential({ accessToken, expiresAtMs: Date.now() + 1000 }),
    generation,
  );
  const credential = member();
  const { credential: got } = await credential.current();
  t.is(got.accessToken, accessToken, 'within the skew, still valid');
  await rejectsWith(t, credential.renewAfterRejection(got), 'REJECTED');
  await store.replace(
    'k1',
    storedCredential({ accessToken, expiresAtMs: Date.now() - 1 }),
    generation + 1,
  );
  await rejectsWith(t, credential.current(), 'EXPIRED');
  t.is(server.requests().length, 0);
});

test('a request that never left undoes the intent exactly', async t => {
  const { member, value, generation, stored, server } = await setup(t);
  // A port that refuses connections: listen, note it, close.
  const closed = createServer();
  await new Promise(resolve =>
    closed.listen(0, '127.0.0.1', () => resolve(undefined)),
  );
  const { port } = /** @type {import('node:net').AddressInfo} */ (
    closed.address()
  );
  await new Promise(resolve => closed.close(() => resolve(undefined)));
  const credential = member({ tokenUrl: `http://127.0.0.1:${port}/token` });
  await rejectsWith(t, credential.current(), 'RENEWAL_FAILED');
  const after = await stored();
  t.is(after.generation, generation + 2, 'intent, then undo');
  t.is(after.credential.pendingRefresh, undefined);
  t.deepEqual(after.credential, parseCredential(value, 'claude'));
  t.is(credential.stats().undone, 1);
  // The member still renews once the endpoint answers.
  const good = member();
  await good.current();
  t.is(server.requests().length, 1);
});

test('a request that may have left keeps the intent: CONSUMED next', async t => {
  const { member, server, issued, stored, generation } = await setup(t);
  server.setPlan([{ disconnect: true }]);
  const credential = member();
  await rejectsWith(t, credential.current(), 'RENEWAL_FAILED', [
    issued.refreshToken,
  ]);
  const after = await stored();
  t.is(after.generation, generation + 1);
  t.truthy(after.credential.pendingRefresh);
  await rejectsWith(t, credential.current(), 'CONSUMED');
  t.is(server.presented(issued.serial), 1, 'never presented twice');
});

test('a refusing token endpoint: REJECTED, intent kept', async t => {
  const { member, server, stored } = await setup(t);
  server.setPlan([{ status: 400, body: { error: 'invalid_grant' } }]);
  const credential = member();
  await rejectsWith(t, credential.current(), 'REJECTED');
  t.truthy((await stored()).credential.pendingRefresh);
});

test('an answer naming another account is refused INVALID', async t => {
  const { member, server, stored } = await setup(t, {
    server: { answerAccount: true, accountId: 'acct-2' },
    accountId: 'acct-1',
  });
  await rejectsWith(t, member().current(), 'INVALID');
  t.truthy((await stored()).credential.pendingRefresh, 'fail closed');
  t.is(server.requests().length, 1);
});

test('M4-FIX: a lifetime within the skew is written back and served', async t => {
  // 90 s: above the 60 s floor, inside the 120 s skew. The rotated refresh
  // token must reach the store (it used to be dropped: CONSUMED next).
  const { member, server, issued, stored } = await setup(t, {
    server: { expiresIn: 90 },
  });
  const credential = member();
  const { credential: renewed } = await credential.current();
  t.not(renewed.refreshToken, issued.refreshToken);
  const after = await stored();
  t.is(after.credential.pendingRefresh, undefined);
  t.is(after.credential.refreshToken, renewed.refreshToken);
  // The next round renews again with the rotated token, never the old one.
  await credential.current();
  t.is(server.presented(issued.serial), 1, 'old token presented once');
  t.is(server.requests().length, 2);
  t.is((await stored()).credential.pendingRefresh, undefined);
});

test('M4-FIX: an answer refused after the POST keeps its refresh token', async t => {
  const { member, server, issued, stored } = await setup(t, {
    accountId: 'acct-1',
  });
  const rotated = fakeToken('rot');
  const answers = [
    { token_type: 'mac', expires_in: 3600 },
    { token_type: 'Bearer', expires_in: 30 },
    { token_type: 'Bearer' },
  ];
  let previous = issued.refreshToken;
  for (const [index, extra] of answers.entries()) {
    const next = `${rotated}-${index}`;
    server.setPlan([
      {
        status: 200,
        body: {
          access_token: fakeToken('acc'),
          refresh_token: next,
          ...extra,
        },
      },
    ]);
    // eslint-disable-next-line no-await-in-loop
    await rejectsWith(t, member().current(), 'INVALID', [previous, next]);
    // eslint-disable-next-line no-await-in-loop
    const after = await stored();
    t.is(after.credential.pendingRefresh, undefined, 'no intent left');
    t.is(after.credential.refreshToken, next, 'rotated token kept');
    t.true(after.credential.expiresAtMs <= Date.now(), 'access spent');
    t.is(after.credential.accountId, 'acct-1');
    previous = next;
  }
  // An answer naming another account keeps nothing (fail closed).
  server.setPlan([
    {
      status: 200,
      body: {
        access_token: fakeToken('acc'),
        refresh_token: fakeToken('other'),
        token_type: 'Bearer',
        expires_in: 3600,
        account_id: 'acct-2',
      },
    },
  ]);
  await rejectsWith(t, member().current(), 'INVALID');
  t.truthy((await stored()).credential.pendingRefresh);
});

test('a non-rotating provider: the old refresh token is kept (RFC 6749 6)', async t => {
  const { member, issued, stored } = await setup(t, {
    server: { rotate: false },
  });
  const { credential } = await member().current();
  t.not(credential.accessToken, issued.accessToken);
  t.is(credential.refreshToken, issued.refreshToken);
  t.is((await stored()).credential.refreshToken, issued.refreshToken);
});

test('an operator replace during the flight wins at write-back', async t => {
  const { member, server, store, stored } = await setup(t);
  const credential = member();
  const held = server.hold();
  const round = credential.current();
  await held.arrived;
  const operatorToken = fakeToken('operator');
  await store.replace(
    'k1',
    storedCredential({
      accessToken: operatorToken,
      refreshToken: fakeToken('operator-refresh'),
      expiresAtMs: Date.now() + 3_600_000,
    }),
  );
  held.release();
  const { credential: got } = await round;
  t.is(got.accessToken, operatorToken, 'adopted, not overwritten');
  t.is((await stored()).credential.accessToken, operatorToken);
  t.is(credential.stats().adopted, 1);
});

test('no token endpoint: RENEWAL_FAILED before any write', async t => {
  const { member, generation, stored } = await setup(t);
  await rejectsWith(
    t,
    member({ tokenUrl: undefined }).current(),
    'RENEWAL_FAILED',
  );
  t.is((await stored()).generation, generation);
});

test('codex: JWT answers give the expiry and the bound account', async t => {
  const { member, server } = await setup(t, {
    provider: 'codex',
    server: { jwt: true, accountId: 'acct-7' },
    accountId: 'acct-7',
  });
  const { credential } = await member().current();
  t.is(credential.accountId, 'acct-7');
  t.true(credential.expiresAtMs > Date.now() + 3_000_000);
  server.setAccount('acct-8');
  const other = await member()
    .renewAfterRejection(credential)
    .catch(e => e);
  t.is(other.code, 'INVALID');
});

test('store failures keep their codes: revoked member is REVOKED', async t => {
  const { member, store } = await setup(t);
  await store.revoke('k1');
  await rejectsWith(t, member().current(), 'REVOKED');
});

test('activated Claude refresh-only grant writes intent and renews once across concurrent readers', async t => {
  const { member, server, issued, store, stored } = await setup(t);
  const activation = {
    version: 'LocalClaudeRefreshV1',
    refreshToken: issued.refreshToken,
    scopes: ['user:inference'],
  };
  const generation = await store.replace('k1', JSON.stringify(activation));
  const held = server.hold();
  const manager = member();
  const rounds = Array.from({ length: 16 }, () => manager.current());
  await held.arrived;
  const during = await store.read('k1');
  held.release();
  const results = await Promise.all(rounds);
  const { pendingRefresh, ...rest } = JSON.parse(during.value);
  t.deepEqual(rest, activation);
  t.is(typeof pendingRefresh.startedAtMs, 'number');
  t.is(during.generation, generation + 1);
  t.is(server.presented(issued.serial), 1);
  const after = await stored();
  t.is(after.generation, generation + 2);
  t.not(after.credential.refreshToken, issued.refreshToken);
  for (const result of results) t.deepEqual(result, after);
});

test('uncertain first Claude exchange retains its intent across a restart', async t => {
  const { member, server, issued, store } = await setup(t);
  const activation = {
    refreshToken: issued.refreshToken,
    scopes: ['user:inference'],
  };
  await store.replace(
    'k1',
    JSON.stringify({ version: 'StagedClaudeSubscriptionV1', ...activation }),
  );
  await rejectsWith(t, member().current(), 'INVALID');
  t.is(server.requests().length, 0);
  await store.replace(
    'k1',
    JSON.stringify({ version: 'LocalClaudeRefreshV1', ...activation }),
  );
  server.setPlan([{ disconnect: true }]);
  await rejectsWith(t, member().current(), 'RENEWAL_FAILED');
  await rejectsWith(t, member().current(), 'CONSUMED');
  t.is(server.presented(issued.serial), 1);
});
