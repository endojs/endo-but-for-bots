// @ts-check
// M4: the adapter's credential check (`CredentialOps.checkCredential`,
// designs/m4-interfaces.md 3.2): a real Secrets store over a temporary
// state directory holding fake credentials of each accepted form, a
// malformed one, one of the other provider, an expired one, one consumed
// by an interrupted renewal, a revoked and an unknown Secret. The answer is
// `{ ok: true }` or `{ ok: false, code }`; it never holds the value.
import '../unit/_m1a-prelude.js';

import { Buffer } from 'node:buffer';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { credentialCheckCodes } from '../../guest/lib/subscription-texts.js';
/* eslint-enable import/no-relative-packages */
import { makeCredentialOps } from '../../resources/agent-host/impl/subscriptions/credential-ops.js';
import { checkCredentialValue } from '../../resources/agent-host/impl/subscriptions/credentials.js';
import {
  makeStoreDirs,
  openStore,
  seedCredential,
  storedCredential,
} from './_m4-renewal.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far } = /** @type {GuestGlobals} */ (globalThis);

const NOW = 1_700_000_000_000;

/**
 * A token-shaped placeholder; joined at run time.
 * @param {string} tag
 */
const fakeToken = tag =>
  ['tok', tag, Math.random().toString(36).slice(2, 10)].join('-');

/** A fake Codex access token (unsigned JWT) with an expiry and account. */
const codexJwt = () => {
  const part = (/** @type {unknown} */ v) =>
    Buffer.from(JSON.stringify(v)).toString('base64url');
  return [
    part({ alg: 'none' }),
    part({ exp: NOW / 1000 + 3600, auth: { chatgpt_account_id: 'acct-9' } }),
    'x',
  ].join('.');
};

/**
 * The fixtures: each accepted form for its provider, and the refusals.
 * @returns {{ name: string, provider: 'claude' | 'codex', value: string, ok?: true, code?: string }[]}
 */
const fixtures = () => {
  const accessToken = fakeToken('a');
  const refreshToken = fakeToken('r');
  const login = {
    accessToken,
    refreshToken,
    expiresAt: NOW + 3_600_000,
    scopes: ['user:inference', 'user:profile'],
  };
  const codexLogin = JSON.stringify({
    tokens: {
      access_token: codexJwt(),
      refresh_token: refreshToken,
      account_id: 'acct-9',
    },
  });
  return [
    {
      name: 'stored form (claude)',
      provider: 'claude',
      value: storedCredential({
        accessToken,
        refreshToken,
        expiresAtMs: NOW + 1000,
      }),
      ok: true,
    },
    {
      name: 'stored form (codex)',
      provider: 'codex',
      value: storedCredential({
        provider: 'codex',
        accessToken,
        refreshToken,
        expiresAtMs: NOW + 1000,
        accountId: 'acct-9',
      }),
      ok: true,
    },
    {
      name: 'stored form past expiry, renewable',
      provider: 'claude',
      value: storedCredential({ accessToken, refreshToken, expiresAtMs: 1 }),
      ok: true,
    },
    {
      name: 'Claude login, wrapped',
      provider: 'claude',
      value: JSON.stringify({ claudeAiOauth: login }),
      ok: true,
    },
    {
      name: 'Claude login, inner object',
      provider: 'claude',
      value: JSON.stringify(login),
      ok: true,
    },
    {
      name: 'Codex login cache',
      provider: 'codex',
      value: codexLogin,
      ok: true,
    },
    {
      name: 'activated Claude refresh-only grant',
      provider: 'claude',
      value: JSON.stringify({
        version: 'LocalClaudeRefreshV1',
        refreshToken,
        scopes: ['user:inference'],
      }),
      ok: true,
    },
    {
      name: 'malformed',
      provider: 'claude',
      value: 'not json',
      code: 'INVALID',
    },
    {
      name: 'JSON of no credential',
      provider: 'codex',
      value: JSON.stringify({ hello: 'world' }),
      code: 'INVALID',
    },
    {
      name: 'staged (not activated) import',
      provider: 'claude',
      value: JSON.stringify({
        version: 'StagedClaudeSubscriptionV1',
        refreshToken,
        scopes: ['user:inference'],
      }),
      code: 'INVALID',
    },
    {
      name: 'Claude login for a codex pool',
      provider: 'codex',
      value: JSON.stringify({ claudeAiOauth: login }),
      code: 'WRONG_PROVIDER',
    },
    {
      name: 'Codex login for a claude pool',
      provider: 'claude',
      value: codexLogin,
      code: 'WRONG_PROVIDER',
    },
    {
      name: 'stored claude form for a codex pool',
      provider: 'codex',
      value: storedCredential({ accessToken, refreshToken, expiresAtMs: 5 }),
      code: 'WRONG_PROVIDER',
    },
    {
      name: 'expired, no refresh token',
      provider: 'claude',
      value: storedCredential({ accessToken, expiresAtMs: NOW - 1 }),
      code: 'EXPIRED',
    },
    {
      name: 'consumed by an interrupted renewal',
      provider: 'claude',
      value: storedCredential({
        accessToken,
        refreshToken,
        expiresAtMs: NOW + 1000,
        pendingRefresh: { startedAtMs: NOW - 10 },
      }),
      code: 'CONSUMED',
    },
  ];
};

/**
 * The answer holds no part of the value: only `ok` and a known code.
 * @param {import('ava').ExecutionContext} t
 * @param {any} answer
 * @param {string} value
 */
const holdsNoValue = (t, answer, value) => {
  const text = JSON.stringify(answer);
  t.true(text.length < 64, text);
  for (const piece of value.match(/tok-[a-z]+-[a-z0-9]+/g) ?? [])
    t.false(text.includes(piece), 'no token in the answer');
  if (answer.ok === false) t.true(credentialCheckCodes.includes(answer.code));
};

test('checkCredentialValue: each accepted form, malformed, wrong provider, expired, consumed', t => {
  for (const { name, provider, value, ok, code } of fixtures()) {
    const answer = checkCredentialValue(value, provider, NOW);
    t.deepEqual(answer, ok ? { ok: true } : { ok: false, code }, name);
    holdsNoValue(t, answer, value);
  }
});

test('CredentialOps.checkCredential reads the Secret from the store, resolved by presence', async t => {
  const dirs = makeStoreDirs('m4-check');
  t.teardown(dirs.done);
  const store = await openStore(dirs.files);
  const cases = fixtures();
  /** @type {Map<any, string | null>} */
  const keys = new Map();
  const secrets = cases.map((entry, index) => {
    const secret = Far('Secret', {});
    keys.set(secret, `k${index}`);
    return secret;
  });
  for (const [index, { value }] of cases.entries()) {
    // eslint-disable-next-line no-await-in-loop
    await seedCredential(store, value, `k${index}`);
  }
  const revoked = Far('Secret', {});
  keys.set(revoked, 'revoked');
  await seedCredential(store, cases[0].value, 'revoked');
  await store.revoke('revoked');
  const vanished = Far('Secret', {});
  keys.set(vanished, 'vanished');
  const unknown = Far('Secret', {});
  const ops = makeCredentialOps({
    secrets: { store },
    accounts: Far('Accounts', {}),
    resolveSecret: async secret => keys.get(secret) ?? null,
    now: () => NOW,
  });
  for (const [index, { name, provider, value, ok, code }] of cases.entries()) {
    // eslint-disable-next-line no-await-in-loop
    const answer = await ops.checkCredential(secrets[index], provider);
    t.deepEqual(answer, ok ? { ok: true } : { ok: false, code }, name);
    holdsNoValue(t, answer, value);
  }
  t.deepEqual(await ops.checkCredential(revoked, 'claude'), {
    ok: false,
    code: 'REVOKED',
  });
  t.deepEqual(await ops.checkCredential(vanished, 'claude'), {
    ok: false,
    code: 'UNKNOWN_SECRET',
  });
  t.deepEqual(await ops.checkCredential(unknown, 'codex'), {
    ok: false,
    code: 'UNKNOWN_SECRET',
  });
  // The guard refuses a provider that is not one.
  await t.throwsAsync(async () =>
    ops.checkCredential(secrets[0], /** @type {any} */ ('gemini')),
  );
  // Any other store failure is READ_FAILED (no message passes through).
  const failing = makeCredentialOps({
    secrets: {
      store: {
        read: async () => {
          throw Error('disk says no: tok-x-y');
        },
      },
    },
    accounts: Far('Accounts', {}),
    resolveSecret: async () => 'k0',
  });
  t.deepEqual(await failing.checkCredential(secrets[0], 'claude'), {
    ok: false,
    code: 'READ_FAILED',
  });
});
