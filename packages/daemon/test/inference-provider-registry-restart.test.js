// @ts-check
import '@endo/init/debug.js';

import test from 'ava';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { encodeBase64 } from '@endo/base64';
import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';
import { encodeUtf8 } from '@endo/utf8/encode.js';

import { makeEndoClient, restart, start, stop } from '../index.js';

const testNode = process.env.ENDO_BIN ? test.serial.skip : test.serial;

testNode(
  'provider registry and AgentInference grants revive across daemon restart',
  async t => {
    t.timeout(120_000);
    // Keep the daemon socket below the Unix-domain path limit in deep
    // worktrees; the random suffix still isolates parallel runs.
    const base = await mkdtemp('/tmp/provider-registry-');
    const config = {
      statePath: join(base, 'state'),
      ephemeralStatePath: join(base, 'run'),
      cachePath: join(base, 'cache'),
      sockPath: join(base, 'endo.sock'),
      address: '127.0.0.1:0',
      gcEnabled: true,
    };
    /** @type {Array<(reason: Error) => void>} */
    const connections = [];
    t.teardown(async () => {
      await stop(config);
      for (const cancel of connections) cancel(Error('test teardown'));
      await rm(base, { recursive: true, force: true });
    });
    const connect = async () => {
      const { promise: cancelled, reject: cancel } = makePromiseKit();
      cancelled.catch(() => {});
      connections.push(cancel);
      const client = await makeEndoClient(
        'provider-registry-test',
        config.sockPath,
        cancelled,
      );
      client.closed.catch(() => {});
      return /** @type {any} */ (E(client.getBootstrap()).host());
    };
    const specifier = relative =>
      new URL(`../../${relative}`, import.meta.url).href;

    await start(config);
    let host = await connect();
    await E(host).storeValue(null, 'provider-issuer-powers');
    await E(host).makeUnconfined(
      '@node',
      new URL('./_inference-provider-issuer-factory.js', import.meta.url).href,
      {
        powersName: 'provider-issuer-powers',
        resultName: 'provider-issuer-factory',
      },
    );
    await E(host).remove('provider-issuer-powers');
    await E(host).makeUnconfined(
      '@node',
      specifier('hosted-agent/src/inference-provider-registry-module.js'),
      {
        powersName: '@agent',
        resultName: 'inference-provider-registry',
        env: {
          INFERENCE_PROVIDER_ISSUER_FACTORY: 'provider-issuer-factory',
        },
      },
    );
    let registry = await E(host).lookup('inference-provider-registry');
    const directory = await E(registry).directoryFor('owner-alice');
    // The test model is unpriced, so the owner needs a token budget rather
    // than the default dollar budget for admission to succeed.
    await E(directory).setOwnerLimits(
      harden({ dailyTokens: 1000 }),
      'owner-token-budget-1',
      true,
    );
    const provider = await E(directory).create(
      harden({
        idempotencyKey: 'create-0000000001',
        displayName: 'Claude',
        kind: 'anthropic',
        defaultModel: 'claude-test',
        limits: { concurrentTurns: 1, dailyTokens: 1000 },
        keyBase64: encodeBase64(encodeUtf8('restart-canary-secret')),
      }),
    );
    const use = await E(registry).useFor('owner-alice', provider.providerId);
    const inference = await E(use).grant(
      harden({
        grantId: 'grant-000000001',
        ownerId: 'owner-alice',
        agentId: 'agent-alice',
        model: 'claude-test',
      }),
    );
    const request = harden({
      method: 'POST',
      path: '/v1/messages',
      body: '{"model":"claude-test","max_tokens":1,"messages":[]}',
    });
    const before = JSON.parse((await E(inference).request(request)).body);
    t.true(before.keyWasPresented);
    t.is(before.sessionId, 'grant-000000001');

    await restart(config);
    host = await connect();
    registry = await E(host).lookup('inference-provider-registry');
    const revived = await E(registry).inferenceFor('grant-000000001');
    const after = JSON.parse((await E(revived).request(request)).body);
    t.true(after.keyWasPresented);
    t.is(after.sessionId, 'grant-000000001');
    t.not(
      after.instance,
      before.instance,
      'the first call rebound a new issuer',
    );

    await E(registry).revokeGrant('grant-000000001');
    await restart(config);
    host = await connect();
    registry = await E(host).lookup('inference-provider-registry');
    const revoked = await E(registry).inferenceFor('grant-000000001');
    await t.throwsAsync(() => E(revoked).request(request), {
      message: /agent-deleted/,
    });
  },
);
