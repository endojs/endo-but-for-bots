// @ts-check
import '@endo/init';
import test from 'ava';
import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
// This integration fixture must not make the daemon depend on hosted-agent.
// eslint-disable-next-line import/no-relative-packages
import {
  makeAccountId,
  publishAccountBindings,
} from '../../hosted-agent/src/account-bindings.js';
import { makeEndoClient, start, stop } from '../index.js';

test.serial(
  'account binding publication retains exact capabilities across daemon restart',
  async t => {
    t.timeout(60_000);
    const root = await mkdtemp(
      path.join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'endo-ac-'),
    );
    const config = {
      statePath: path.join(root, 'state'),
      ephemeralStatePath: path.join(root, 'run'),
      cachePath: path.join(root, 'cache'),
      sockPath: path.join(root, 'endo.sock'),
      address: '127.0.0.1:0',
      pets: new Map(),
      values: new Map(),
      gcEnabled: true,
    };
    const cancelled = makePromiseKit();
    void cancelled.promise.catch(() => {});
    t.teardown(async () => {
      try {
        await stop(config);
      } finally {
        cancelled.reject(Error('Test finished'));
        await rm(root, { recursive: true, force: true });
      }
    });
    const connect = async () => {
      const client = await makeEndoClient(
        'account-binding-test',
        config.sockPath,
        cancelled.promise,
      );
      void client.closed.catch(() => {});
      return E(client.getBootstrap()).host();
    };
    await start(config);
    let host = await connect();
    const specifier = new URL(
      './_account-binding-capability.js',
      import.meta.url,
    ).href;
    const oracle = await E(host).makeUnconfined('@node', specifier, {
      powersName: '@none',
      resultName: 'account-oracle',
      env: { ROLE: 'original-account' },
    });
    const admin = await E(host).makeUnconfined('@node', specifier, {
      powersName: '@none',
      resultName: 'account-admin',
      env: { ROLE: 'original-admin' },
    });
    const accountId = makeAccountId({
      providerId: 'test-provider',
      accountAuthority: 'shared-account',
    });
    const adminId = await E(host).identify('account-admin');
    const uses = [
      { backendId: 'arbitrary-runtime', subscriptionId: 'primary' },
      { backendId: 'other-runtime' },
    ];
    await publishAccountBindings(host, {
      source: 'operator-source',
      accounts: [
        {
          accountId,
          providerId: 'test-provider',
          title: 'Shared account',
          oracle,
          adminId,
          admin,
          uses,
        },
      ],
    });
    const publicationId = await E(host).identify(
      'account-bindings',
      'operator-source',
    );
    // Pet-name replacements must not retarget the immutable publication.
    await E(host).makeUnconfined('@node', specifier, {
      powersName: '@none',
      resultName: 'replacement-account',
      env: { ROLE: 'replacement-account' },
    });
    await E(host).copy(['replacement-account'], ['account-oracle']);
    await E(host).remove('account-admin');
    await stop(config);
    await start(config);
    host = await connect();
    t.is(
      await E(host).identify('account-bindings', 'operator-source'),
      publicationId,
    );
    const stored = await E(host).lookup([
      'account-bindings',
      'operator-source',
    ]);
    t.is(stored.version, 1);
    t.is(stored.accounts.length, 1);
    const [account] = stored.accounts;
    t.is(account.accountId, accountId);
    t.is(account.adminId, adminId);
    t.deepEqual(account.uses, uses);
    t.is(await E(account.oracle).role(), 'original-account');
    t.is(await E(account.admin).role(), 'original-admin');
    t.is(
      await E(await E(host).lookup('account-oracle')).role(),
      'replacement-account',
    );
  },
);
