// @ts-check
/* eslint-disable import/no-relative-packages -- Exercise production installers against the daemon. */
import '@endo/init/debug.js';
import test from 'ava';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';
import { makeEndoClient, start, stop } from '../index.js';
import { main as setupFloot } from '../../floot/floot-factory-setup.js';
import { main as setupOpenAI } from '../../codex-sandbox/setup-direct.js';
import { main as setupAnthropic } from '../../claude-sandbox/setup-direct.js';

test.serial(
  'a fresh daemon provisions and reuses both direct subscription pools without a CLI or its images',
  async t => {
    t.timeout(120_000);
    const root = await mkdtemp(
      join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'fpool-'),
    );
    const config = {
      statePath: join(root, 'state'),
      ephemeralStatePath: join(root, 'run'),
      cachePath: join(root, 'cache'),
      sockPath: join(root, 'endo.sock'),
      address: '127.0.0.1:0',
      gcEnabled: true,
    };
    const { promise: cancelled, reject: cancel } = makePromiseKit();
    void cancelled.catch(() => {});
    t.teardown(async () => {
      try {
        await stop(config);
      } finally {
        cancel(Error('disposed'));
        await rm(root, { recursive: true, force: true });
      }
    });
    await start(config).catch(async error => {
      t.log(await readFile(join(config.statePath, 'endo.log'), 'utf8'));
      throw error;
    });
    const client = await makeEndoClient(
      'subscription-test',
      config.sockPath,
      cancelled,
    );
    void client.closed.catch(() => {});
    const host = await E(client.getBootstrap()).host();
    const importer = await E(host).lookup(['@secrets', 'create']);
    // The daemon starts the three setups in this order on a new installation.
    // Clear any operator bootstrap configuration inherited by the test worker.
    for (const key of Object.keys(process.env)) {
      if (
        /^(?:ENDO_)?(?:FLOOT_|OPENROUTER_API_KEY|ANTHROPIC_API_KEY)/.test(key)
      )
        delete process.env[key];
    }
    process.env.FLOOT_PROVIDER = 'none';
    await setupFloot(host);
    for (const [id, setup] of Object.entries({
      codex: setupOpenAI,
      claude: setupAnthropic,
    })) {
      const member = { id: 'one', credsName: `${id}-test-account` };
      const accountRef = id === 'claude' ? 'claude-one' : 'openai-one';
      const inert = {
        version: 'BrokerOAuthStateV1',
        accountId: accountRef,
        accessToken: 'inert',
        refreshToken: 'inert',
        expiresAt: Date.now() + 60_000,
      };
      // eslint-disable-next-line no-await-in-loop
      await E(importer).createBase64(
        member.credsName,
        'Test',
        btoa(JSON.stringify(inert)),
      );
      const options = {
        env: {
          [`ENDO_${id.toUpperCase()}_SUBSCRIPTIONS`]: JSON.stringify([member]),
          [`ENDO_${id.toUpperCase()}_ACCOUNT_AUTHORITY`]: `${id}-pool`,
        },
      };
      // eslint-disable-next-line no-await-in-loop
      await setup(host, options);
      const brokerPath = [
        '@pins',
        'installations',
        `${id}-sandbox`,
        'broker-service',
      ];
      // eslint-disable-next-line no-await-in-loop
      const ownerId = await E(host).identify(...brokerPath);
      // eslint-disable-next-line no-await-in-loop
      await setup(host, options);
      // eslint-disable-next-line no-await-in-loop
      t.is(await E(host).identify(...brokerPath), ownerId);
      // eslint-disable-next-line no-await-in-loop
      const profile = await E(host).lookup(['floot', 'controller-profile']);
      // eslint-disable-next-line no-await-in-loop
      t.false(await E(profile).has(`${id}-backend`));
      // eslint-disable-next-line no-await-in-loop
      t.true(await E(profile).has(`${id}-model-catalog`));
      // eslint-disable-next-line no-await-in-loop
      const subscription = await E(profile).lookup(`${id}-inference`);
      // eslint-disable-next-line no-await-in-loop
      const endpoint = await E(subscription).openEndpoint({
        sessionId: 'setup-test',
      });
      // eslint-disable-next-line no-await-in-loop
      t.like(await E(endpoint).attestation(), { subscription: 'auto' });
      // eslint-disable-next-line no-await-in-loop
      await E(endpoint).revoke();
    }
    // Install an Anthropic API credential and a second, distinct OpenRouter
    // credential without changing the pool or the existing session route.
    process.env.FLOOT_PROVIDER = 'anthropic';
    process.env.FLOOT_MODEL = 'old-model';
    process.env.FLOOT_AUTH_SECRET_NAME = 'custom-anthropic-api';
    process.env.FLOOT_OPENROUTER_SECRET_NAME = 'router-api-key';
    process.env.FLOOT_OPENROUTER_MODEL = 'vendor/router-model';
    await E(importer).createBase64(
      'custom-anthropic-api',
      'Test',
      btoa('anthropic-key'),
    );
    process.env.OPENROUTER_API_KEY = 'router-key';
    await setupFloot(host);
    const profile = await E(host).lookup(['floot', 'controller-profile']);
    const bound = async name => E(await E(profile).lookup(name)).readBase64();
    t.is(await bound('llm-auth-secret'), btoa('anthropic-key'));
    t.is(await bound('openrouter-auth'), btoa('router-key'));
    const stableRouter = await E(profile).identify('openrouter-provider');
    // Old generic provider records omitted 'provider' for Anthropic.
    await E(host).storeValue(harden({ model: 'old-model' }), [
      'floot',
      'llm-provider',
    ]);
    process.env.FLOOT_PROVIDER = 'openrouter';
    await t.throwsAsync(setupFloot(host), { message: /Existing sessions use/ });
    for (const key of [
      'FLOOT_PROVIDER',
      'FLOOT_MODEL',
      'FLOOT_AUTH_SECRET_NAME',
      'FLOOT_OPENROUTER_SECRET_NAME',
      'FLOOT_OPENROUTER_MODEL',
      'OPENROUTER_API_KEY',
    ])
      delete process.env[key];
    await setupFloot(host);
    t.deepEqual(await E(profile).lookup('llm-provider'), {
      provider: 'anthropic',
      model: 'old-model',
    });
    t.is(await bound('llm-auth-secret'), btoa('anthropic-key'));
    t.is(await bound('openrouter-auth'), btoa('router-key'));
    t.is(await E(profile).identify('openrouter-provider'), stableRouter);
  },
);
