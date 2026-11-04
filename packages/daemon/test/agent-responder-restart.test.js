// @ts-check
/* eslint-disable no-await-in-loop, @endo/restrict-comparison-operands */
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

const OWNER = 'g-00000000000000000000000000000001';
const specifier = relative =>
  new URL(`../../${relative}`, import.meta.url).href;

/**
 * A real daemon holding the real registry, factory, and launcher, with only the
 * upstream faked.
 *
 * @param {any} t
 */
const startGarden = async t => {
  // Keep the daemon socket below the Unix-domain path limit in deep worktrees.
  const base = await mkdtemp('/tmp/agent-responder-');
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
      'agent-responder-test',
      config.sockPath,
      cancelled,
    );
    client.closed.catch(() => {});
    return /** @type {any} */ (E(client.getBootstrap()).host());
  };
  await start(config);
  const host = await connect();
  await E(host).makeUnconfined(
    '@node',
    new URL('./_agent-fake-anthropic-issuer.js', import.meta.url).href,
    { powersName: '@none', resultName: 'fake-issuer' },
  );
  await E(host).makeUnconfined(
    '@node',
    specifier('hosted-agent/src/inference-provider-registry-module.js'),
    {
      powersName: '@agent',
      resultName: 'inference-provider-registry',
      env: { INFERENCE_PROVIDER_ISSUER_FACTORY: 'fake-issuer' },
    },
  );
  await E(host).makeUnconfined(
    '@node',
    specifier('hosted-agent/src/agent-responder-launcher-module.js'),
    {
      powersName: '@agent',
      resultName: 'responder-launcher',
      env: {
        AGENT_RESPONDER_FACTORY: 'agent-factory',
        AGENT_RESPONDER_SELF: 'responder-launcher',
        AGENT_RESPONDER_SPECIFIER_LAL: specifier('lal/agent-responder.js'),
        AGENT_RESPONDER_SPECIFIER_FAE: specifier('fae/agent-responder.js'),
        AGENT_RESPONDER_INITIAL_BACKOFF_MS: '500',
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
  const owner = await E(host).provideGuest(OWNER, {
    agentName: `${OWNER}-agent`,
  });
  const registry = await E(host).lookup('inference-provider-registry');
  const providers = await E(registry).directoryFor(OWNER);
  await E(providers).setOwnerLimits(
    harden({ dailyTokens: 1_000_000, concurrentTurns: 4 }),
    'owner-limits-1',
    true,
  );
  const provider = await E(providers).create(
    harden({
      idempotencyKey: 'create-0000000001',
      displayName: 'Claude',
      kind: 'anthropic',
      defaultModel: 'claude-test',
      limits: harden({ concurrentTurns: 2, dailyTokens: 1_000_000 }),
      keyBase64: encodeBase64(encodeUtf8('agent-responder-canary')),
    }),
  );
  return { config, connect, host, owner, provider, providers };
};

/**
 * @param {() => Promise<any>} read
 * @param {(value: any) => boolean} done
 * @param {string} label
 */
const until = async (read, done, label) => {
  const deadline = Date.now() + 45_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) {
      throw Error(`timed out on ${label}: ${JSON.stringify(value, (_key, item) =>
        typeof item === 'bigint' ? `${item}n` : item,
      )}`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};

const repliesIn = async guest =>
  (await E(guest).listMessages())
    .filter(message => message.replyTo !== undefined)
    .map(message => message.strings.join(''));

const createAgent = (agents, provider, harness, name, limits = {}) =>
  E(agents).create(
    harden({
      idempotencyKey: `create-${name}`,
      providerId: provider.providerId,
      harness,
      name,
      model: 'claude-test',
      limits: harden({ dailyTokens: 100_000, concurrentTurns: 1, ...limits }),
      wake: true,
      endowments: harden([]),
    }),
  );

for (const harness of ['lal', 'fae']) {
  testNode(`a ${harness} agent wakes on mail and replies through the broker`, async t => {
    t.timeout(180_000);
    const { host, owner, provider, providers } = await startGarden(t);
    const factory = await E(host).lookup('agent-factory');
    const agents = await E(factory).directoryFor(OWNER);
    const created = await createAgent(agents, provider, harness, 'helper');
    t.is(created.status, 'awake');
    const issuer = await E(host).lookup('fake-issuer');
    await E(issuer).setReply(`answer from ${harness}`);

    await E(owner).send('helper', ['please answer'], [], []);
    const replies = await until(
      () => repliesIn(owner),
      found => found.length > 0,
      'the reply',
    );
    t.deepEqual(replies, [`answer from ${harness}`]);
    const summary = await until(
      () => E(agents).get(created.agentId),
      found => found.unreadCount === 0,
      'the dismissal',
    );
    t.is(summary.deferredCount, 0);
    t.is((await E(issuer).observed()).requests, 1);

    const { turns } = await E(providers).getUsage();
    t.true(turns.some(turn => turn.agentId === created.agentId));
  });
}

testNode('deferral, retry, restart, retirement, and deletion on a real daemon', async t => {
  t.timeout(240_000);
  const { config, connect, host, owner, provider } = await startGarden(t);
  let factory = await E(host).lookup('agent-factory');
  let agents = await E(factory).directoryFor(OWNER);
  const issuer = await E(host).lookup('fake-issuer');
  const created = await createAgent(agents, provider, 'lal', 'helper');

  // A held turn on the agent's own grant occupies its one concurrency slot, so
  // the message's admission is really refused by the registry.
  await E(issuer).hold();
  const { inference } = await E(factory).endowmentFor(created.agentId);
  const holder = E(inference).requestByteStream(
    harden({
      method: 'POST',
      path: '/v1/messages',
      body: JSON.stringify({
        model: 'claude-test',
        max_tokens: 1,
        stream: true,
        messages: [{ role: 'user', content: 'hold the slot' }],
      }),
    }),
  );
  await until(
    () => E(issuer).observed(),
    seen => seen.requests === 1,
    'the holder reaching upstream',
  );

  await E(owner).send('helper', ['refused at first'], [], []);
  const deferred = await until(
    () => E(agents).get(created.agentId),
    found => found.deferredCount === 1,
    'the deferral',
  );
  t.is(deferred.deferred[0].code, 'agent-concurrency-exhausted');
  t.is(deferred.unreadCount, 1, 'the message stays unread');
  t.true(Date.parse(deferred.deferred[0].retryAt) > 0);
  t.deepEqual(await repliesIn(owner), [], 'a refusal sends the sender nothing');

  // Retry now is one fresh admission: still busy, so it defers again from a
  // reset count rather than adding to the attempts.
  await until(
    () => E(agents).get(created.agentId),
    found => found.deferred[0]?.attempts >= 2,
    'an automatic retry',
  );
  const retried = await E(agents).retryMail(
    created.agentId,
    deferred.deferred[0].number,
  );
  t.is(retried.deferredCount, 1);
  const reset = await until(
    () => E(agents).get(created.agentId),
    found => found.deferred[0]?.attempts <= 2,
    'the reset count',
  );
  t.is(reset.deferred[0].code, 'agent-concurrency-exhausted');

  // Later retries, freed slot: the deferred message is processed.
  await E(issuer).release();
  const { reader } = await holder;
  await E(reader).close();
  const answered = await until(
    () => repliesIn(owner),
    found => found.length === 1,
    'the retried reply',
  );
  t.deepEqual(answered, ['fake answer']);
  await until(
    () => E(agents).get(created.agentId),
    found => found.deferredCount === 0 && found.unreadCount === 0,
    'the queue draining',
  );

  // Restart: the pinned responder revives without another turn for old mail,
  // and answers new mail.
  await restart(config);
  let revivedHost = await connect();
  const revivedOwner = await E(revivedHost).lookup(`${OWNER}-agent`);
  factory = await E(revivedHost).lookup('agent-factory');
  agents = await E(factory).directoryFor(OWNER);
  await E(factory).reconcile();
  await E(revivedOwner).send('helper', ['after restart'], [], []);
  const afterRestart = await until(
    () => repliesIn(revivedOwner),
    found => found.length === 2,
    'the post-restart reply',
  );
  t.is(afterRestart.length, 2);
  const revivedIssuer = await E(revivedHost).lookup('fake-issuer');
  t.is(
    (await E(revivedIssuer).observed()).requests,
    1,
    'one turn for the one new message; the fake restarts its count with the daemon',
  );

  // A deferred message survives a restart. Hold the slot again, then restart.
  await E(revivedIssuer).hold();
  const second = await E(factory).endowmentFor(created.agentId);
  const secondHolder = E(second.inference).requestByteStream(
    harden({
      method: 'POST',
      path: '/v1/messages',
      body: JSON.stringify({
        model: 'claude-test',
        max_tokens: 1,
        stream: true,
        messages: [{ role: 'user', content: 'hold again' }],
      }),
    }),
  );
  void secondHolder.catch(() => {});
  await until(
    () => E(revivedIssuer).observed(),
    seen => seen.prompts.at(-1)?.includes('hold again'),
    'the second holder',
  );
  await E(revivedOwner).send('helper', ['survives restart'], [], []);
  await until(
    () => E(agents).get(created.agentId),
    found => found.deferredCount === 1,
    'the second deferral',
  );
  // Retire the provider while deferred, then restart: the next retry is
  // terminal. The in-flight holder dies with the daemon, freeing the slot.
  const revivedRegistry = await E(revivedHost).lookup(
    'inference-provider-registry',
  );
  const revivedProviders = await E(revivedRegistry).directoryFor(OWNER);
  const admin = await E(revivedProviders).adminFor(provider.providerId);
  await E(admin).retire('retire-0000000001');
  await restart(config);
  revivedHost = await connect();
  const thirdOwner = await E(revivedHost).lookup(`${OWNER}-agent`);
  factory = await E(revivedHost).lookup('agent-factory');
  agents = await E(factory).directoryFor(OWNER);
  await E(factory).reconcile();
  const refused = await until(
    () => E(agents).get(created.agentId),
    found => found.refusedCount === 1,
    'the terminal refusal',
  );
  t.is(refused.refused[0].code, 'provider-retired');
  t.is(refused.deferredCount, 0);
  t.is(refused.unreadCount, 1);

  // Dismiss clears it from the owner's view.
  const dismissed = await E(agents).dismissMail(
    created.agentId,
    refused.refused[0].number,
  );
  t.is(dismissed.refusedCount, 0);
  t.is(dismissed.unreadCount, 0);

  // Deletion leaves nothing pinned or named, and usage rows remain.
  await E(agents).delete(created.agentId, harden({ idempotencyKey: 'delete-1' }));
  t.false((await E(thirdOwner).list()).includes('helper'));
  for (const directory of ['agent-responders', 'agent-responder-workers']) {
    t.deepEqual(await E(revivedHost).list(directory), [], directory);
  }
  const registry = await E(revivedHost).lookup('inference-provider-registry');
  const usage = await E(await E(registry).directoryFor(OWNER)).getUsage();
  t.true(usage.turns.some(turn => turn.agentId === created.agentId));
});

testNode('deleting an agent cancels its in-flight turn', async t => {
  t.timeout(180_000);
  const { host, owner, provider } = await startGarden(t);
  const factory = await E(host).lookup('agent-factory');
  const agents = await E(factory).directoryFor(OWNER);
  const issuer = await E(host).lookup('fake-issuer');
  const created = await createAgent(agents, provider, 'lal', 'helper');
  await E(issuer).hold();
  await E(owner).send('helper', ['never finishes'], [], []);
  await until(
    () => E(issuer).observed(),
    seen => seen.requests === 1,
    'the turn reaching upstream',
  );
  await E(agents).delete(created.agentId, harden({ idempotencyKey: 'delete-1' }));
  const seen = await until(
    () => E(issuer).observed(),
    found => found.aborted === 1,
    'the upstream abort',
  );
  t.is(seen.requests, 1);
  t.deepEqual(await repliesIn(owner), []);
  // The slot is released: another agent's turn on this provider is admitted.
  await E(issuer).release();
  await E(issuer).setReply('from the second agent');
  await createAgent(agents, provider, 'lal', 'second');
  await E(owner).send('second', ['hello'], [], []);
  t.deepEqual(
    await until(
      () => repliesIn(owner),
      found => found.length === 1,
      'the second agent',
    ),
    ['from the second agent'],
  );

  // An agent that never received mail has a collectable guest. Deleting it must
  // leave the factory's worker running.
  const silent = await createAgent(agents, provider, 'fae', 'silent');
  await E(agents).get(silent.agentId);
  await E(agents).delete(silent.agentId, harden({ idempotencyKey: 'delete-2' }));
  await new Promise(resolve => setTimeout(resolve, 1000));
  t.true((await E(agents).list()).some(agent => agent.name === 'second'));
});
