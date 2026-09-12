// @ts-check
import '@endo/init';

import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Far } from '@endo/far';
import test from 'ava';

import {
  assertSubscriptionAccount,
  installHostedSubscription,
  withSubscriptionSetupLock,
} from '../src/subscription-setup.js';

const token = () =>
  `e30.${btoa(
    JSON.stringify({
      exp: 2_000_000_000,
      'https://api.openai.com/auth': { chatgpt_account_id: 'account-a' },
    }),
  )}.signature`;
const fixture = () => {
  let exists = false;
  let reads = 0;
  let writes = 0;
  let made;
  let copies = 0;
  const secret = Far('Secret', {
    readBase64WithGeneration: async () => {
      reads += 1;
      return harden({
        generation: 4n,
        base64: btoa(
          JSON.stringify({
            tokens: {
              access_token: token(),
              refresh_token: 'renewal-secret',
              account_id: 'account-a',
            },
          }),
        ),
      });
    },
  });
  const admin = Far('Secret admin', {
    replaceBase64: async (_base64, options) => {
      if (options.ifGeneration !== 4n) throw Error('wrong generation');
      writes += 1;
      return 5n;
    },
  });
  const catalog = Far('Catalog', {
    list: async () =>
      harden([
        { petNamePaths: [['secrets', 'codex-subscription-auth']], admin },
      ]),
  });
  const backend = Far('Backend', { describe: () => harden({ id: 'codex' }) });
  const host = Far('Host', {
    has: async () => exists,
    lookup: async path => {
      if (path[0] === '@secrets') return catalog;
      if (path[0] === 'secrets') return secret;
      return backend;
    },
    makeUnconfined: async (_worker, _module, options) => {
      made = options;
      exists = true;
    },
    copy: async () => {
      copies += 1;
    },
  });
  return {
    host,
    existing: () => {
      exists = true;
    },
    state: () => ({ reads, writes, made, copies }),
  };
};

test('one-shot setup pins account into formula configuration, never tokens', async t => {
  const f = fixture();
  await installHostedSubscription(f.host, {
    config: { models: [] },
    moduleURL: 'file:///operator/module.js',
  });
  const { made, writes, copies } = f.state();
  t.is(JSON.parse(made.env.CODEX_HOST_CONFIG).accountRef, 'account-a');
  t.false(made.env.CODEX_HOST_CONFIG.includes('renewal-secret'));
  t.is(writes, 1);
  t.is(copies, 1);
  await t.throwsAsync(
    () =>
      installHostedSubscription(f.host, {
        config: { secretPath: ['different'], accountRef: 'account-b' },
        moduleURL: 'file:///changed/module.js',
      }),
    { message: /already exists/ },
  );
  t.is(f.state().reads, 1);
  t.is(f.state().writes, 1);
});

test('existing backend refuses drift before any credential access', async t => {
  const f = fixture();
  f.existing();
  await t.throwsAsync(
    () =>
      installHostedSubscription(f.host, {
        config: {},
        moduleURL: 'file:///operator/module.js',
      }),
    { message: /already exists/ },
  );
  t.is(f.state().reads, 0);
  t.is(f.state().writes, 0);
});

test('explicit account mismatch refuses before secret normalization', async t => {
  const f = fixture();
  await t.throwsAsync(
    () =>
      installHostedSubscription(f.host, {
        config: { accountRef: 'account-b' },
        moduleURL: 'file:///operator/module.js',
      }),
    { message: /account changed/ },
  );
  t.is(f.state().writes, 0);
  t.is(f.state().made, undefined);
});

test('revival requires formula-pinned account, not replacement secret account', t => {
  t.is(
    assertSubscriptionAccount('account-a', { accountId: 'account-a' }),
    'account-a',
  );
  t.throws(
    () => assertSubscriptionAccount('account-a', { accountId: 'account-b' }),
    { message: /account changed/ },
  );
  t.throws(
    () => assertSubscriptionAccount(undefined, { accountId: 'account-b' }),
    { message: /pinned account/ },
  );
});

test('filesystem setup exclusion prevents concurrent installation and releases on settlement', async t => {
  t.timeout(2000);
  const directory = await mkdtemp(
    join(await realpath(tmpdir()), 'codex-setup-lock-'),
  );
  t.teardown(() => rm(directory, { recursive: true, force: true }));
  const lock = { directory, hostId: 'host-identity' };
  let entered = () => {};
  const enteredP = new Promise(resolve => {
    entered = () => resolve(undefined);
  });
  let finish = () => {};
  const finishP = new Promise(resolve => {
    finish = () => resolve(undefined);
  });
  const first = withSubscriptionSetupLock(lock, async () => {
    entered();
    await finishP;
  });
  try {
    await Promise.race([enteredP, first]);
    await t.throwsAsync(
      () => withSubscriptionSetupLock(lock, async () => t.fail()),
      { message: /setup is locked/ },
    );
  } finally {
    finish();
    await first;
  }
  await withSubscriptionSetupLock(lock, async () => t.pass());
});

test('private lock root is required, and failed operation releases lock', async t => {
  const directory = await mkdtemp(
    join(await realpath(tmpdir()), 'codex-setup-lock-'),
  );
  t.teardown(() => rm(directory, { recursive: true, force: true }));
  const bad = join(directory, 'public');
  await mkdir(bad, { mode: 0o755 });
  await t.throwsAsync(
    () =>
      withSubscriptionSetupLock({ directory: bad, hostId: 'host' }, async () =>
        t.fail(),
      ),
    { message: /private and canonical/ },
  );
  const lock = { directory, hostId: 'host' };
  await t.throwsAsync(
    () =>
      withSubscriptionSetupLock(lock, async () => {
        throw Error('setup failed');
      }),
    { message: 'setup failed' },
  );
  await withSubscriptionSetupLock(lock, async () => t.pass());
});
