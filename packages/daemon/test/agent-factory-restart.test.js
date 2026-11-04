// @ts-check
/* eslint-disable no-underscore-dangle */
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
  'an agent factory guest is confined, keeps mail wake-off, and revives across restart',
  async t => {
    t.timeout(120_000);
    // Keep the daemon socket below the Unix-domain path limit in deep
    // worktrees; the random suffix still isolates parallel runs.
    const base = await mkdtemp('/tmp/agent-factory-');
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
        'agent-factory-test',
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
    await E(host).storeValue(null, 'responder-launcher-powers');
    await E(host).makeUnconfined(
      '@node',
      new URL('./_agent-responder-launcher.js', import.meta.url).href,
      {
        powersName: 'responder-launcher-powers',
        resultName: 'responder-launcher',
      },
    );
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
    await E(host).makeUnconfined(
      '@node',
      specifier('hosted-agent/src/agent-factory-module.js'),
      {
        powersName: '@agent',
        resultName: 'agent-factory',
        env: {
          AGENT_FACTORY_PROVIDER_REGISTRY: 'inference-provider-registry',
          AGENT_FACTORY_RESPONDER_LAUNCHER: 'responder-launcher',
          AGENT_FACTORY_RECONCILE_MS: '3600000',
        },
      },
    );

    const ownerKey = 'g-00000000000000000000000000000001';
    const ownerGuest = await E(host).provideGuest(ownerKey, {
      agentName: `${ownerKey}-agent`,
    });
    await E(ownerGuest).storeValue(harden({ private: true }), 'owner-private');

    const registry = await E(host).lookup('inference-provider-registry');
    const providers = await E(registry).directoryFor(ownerKey);
    await E(providers).setOwnerLimits(
      harden({ dailyTokens: 10_000 }),
      'owner-token-budget-1',
      true,
    );
    const provider = await E(providers).create(
      harden({
        idempotencyKey: 'create-0000000001',
        displayName: 'Claude',
        kind: 'anthropic',
        defaultModel: 'claude-test',
        limits: harden({ concurrentTurns: 1, dailyTokens: 10_000 }),
        keyBase64: encodeBase64(encodeUtf8('agent-factory-canary')),
      }),
    );

    let factory = await E(host).lookup('agent-factory');
    let agents = await E(factory).directoryFor(ownerKey);
    const created = await E(agents).create(
      harden({
        idempotencyKey: 'create-agent-1',
        providerId: provider.providerId,
        harness: 'lal',
        name: 'helper',
        model: 'claude-test',
        limits: harden({ dailyTokens: 10_000 }),
        wake: false,
        endowments: harden([]),
      }),
    );
    t.is(created.status, 'asleep');

    // Retrying the same key finds the same guest.
    const retried = await E(agents).create(
      harden({
        idempotencyKey: 'create-agent-1',
        providerId: provider.providerId,
        harness: 'lal',
        name: 'helper',
        model: 'claude-test',
        limits: harden({ dailyTokens: 10_000 }),
        wake: false,
        endowments: harden([]),
      }),
    );
    t.is(retried.agentId, created.agentId);

    // The owner's inventory entry is the agent's handle, which addresses mail
    // and carries none of the guest's powers.
    t.true((await E(ownerGuest).list()).includes('helper'));
    const entry = await E(ownerGuest).lookup('helper');
    t.false(
      (await E(entry).__getMethodNames__()).includes('lookup'),
      'the entry is a mail handle, not guest powers',
    );

    await E(ownerGuest).send('helper', ['hello'], [], []);
    const queued = await E(agents).get(created.agentId);
    t.is(queued.unreadCount, 1, 'mail sent while wake is off stays unread');
    t.is(queued.unread[0].text, 'hello');

    await t.throwsAsync(
      E(agents).setWake(
        created.agentId,
        harden({ idempotencyKey: 'wake-unconfirmed', wake: true }),
      ),
      { message: /wake-confirmation-required/ },
    );
    const launcher = await E(host).lookup('responder-launcher');
    t.deepEqual(await E(launcher).describe(), [], 'nothing runs unconfirmed');

    // The agent guest has no edge to its owner.
    const { powers, inference } = await E(factory).endowmentFor(
      created.agentId,
    );
    const names = await E(powers).list();
    t.false(names.includes('owner-private'));
    t.false(names.includes(ownerKey));
    for (const name of [
      '@host',
      '@endo',
      '@secrets',
      ownerKey,
      'owner-private',
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(E(powers).lookup(name));
    }
    const methods = await E(powers).__getMethodNames__();
    for (const method of [
      'lookupById',
      'provideGuest',
      'evaluate',
      'storeIdentifier',
    ]) {
      t.false(methods.includes(method), method);
    }

    const requestOne = harden({
      method: 'POST',
      path: '/v1/messages',
      body: JSON.stringify({
        model: 'claude-test',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    const before = JSON.parse((await E(inference).request(requestOne)).body);
    t.is(before.providerId, provider.providerId);

    await restart(config);
    host = await connect();

    factory = await E(host).lookup('agent-factory');
    agents = await E(factory).directoryFor(ownerKey);
    const revived = await E(agents).get(created.agentId);
    t.is(revived.name, 'helper');
    t.is(revived.unreadCount, 1, 'mail survives the restart');

    const revivedEndowment = await E(factory).endowmentFor(created.agentId);
    const after = JSON.parse(
      (await E(revivedEndowment.inference).request(requestOne)).body,
    );
    t.is(after.providerId, provider.providerId, 'inference rebinds on restart');

    const woken = await E(agents).setWake(
      created.agentId,
      harden({
        idempotencyKey: 'wake-skip',
        wake: true,
        queuedMail: 'skip',
        confirmedCursor: revived.lastMessage,
      }),
    );
    t.is(woken.status, 'awake');
    t.is(woken.unreadCount, 0);
    const revivedLauncher = await E(host).lookup('responder-launcher');
    t.like((await E(revivedLauncher).describe())[0], {
      paused: false,
      startAfter: revived.lastMessage,
    });

    const revivedOwner = await E(host).lookup(`${ownerKey}-agent`);
    await E(agents).delete(
      created.agentId,
      harden({ idempotencyKey: 'delete-1' }),
    );
    t.false((await E(revivedOwner).list()).includes('helper'));
    t.deepEqual(await E(revivedLauncher).describe(), []);
    await t.throwsAsync(E(agents).get(created.agentId), {
      message: /agent-deleted/,
    });
    t.false(await E(host).has(created.agentId), 'the guest is released');
    await t.throwsAsync(E(revivedEndowment.inference).request(requestOne), {
      message: /agent-deleted/,
    });
    const usage = await E(
      await E(await E(host).lookup('inference-provider-registry')).directoryFor(
        ownerKey,
      ),
    ).getUsage();
    t.true(
      usage.turns.some(turn => turn.agentId === created.agentId),
      'usage rows remain after deletion',
    );
  },
);
