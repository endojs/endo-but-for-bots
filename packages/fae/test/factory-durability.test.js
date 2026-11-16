// @ts-check
/* eslint-disable no-await-in-loop */
import '@endo/init/debug.js';
import test from 'ava';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';
import { makeEndoClient, start, stop } from '@endo/daemon';
import { parseId } from '@endo/daemon/formula-identifier.js';
import { releaseFaeAgent } from '../src/subagent-host.js';
import { setupWhylip } from '../setup-whylip.js';

const prepareDaemon = async t => {
  const root = await mkdtemp('/tmp/endo-fae-factory-');
  const config = {
    statePath: join(root, 'state'),
    ephemeralStatePath: join(root, 'run'),
    cachePath: join(root, 'cache'),
    sockPath: join(root, 'endo.sock'),
    address: '127.0.0.1:0',
    gcEnabled: true,
  };
  const cancelled = makePromiseKit();
  void cancelled.promise.catch(() => undefined);
  t.teardown(async () => {
    await null;
    try {
      await stop(config);
    } finally {
      cancelled.reject(Error('test cleanup'));
      await rm(root, { recursive: true, force: true });
    }
  });
  const connect = async () => {
    const client = await makeEndoClient(
      'factory-test',
      config.sockPath,
      cancelled.promise,
    );
    void client.closed.catch(() => undefined);
    return E(client.getBootstrap()).host();
  };
  await start(config);
  const host = await connect();
  return { config, connect, host };
};

const prepare = async t => {
  const { config, connect, host } = await prepareDaemon(t);
  const pins = await E(host).makeDirectory('private-pins');
  const owner = await E(host).provideHost('private-owner-handle', {
    agentName: 'private-owner',
    pins,
  });
  const subscription = await E(owner).makeUnconfined(
    '@node',
    new URL('./fixtures/subscription.js', import.meta.url).href,
    { resultName: 'shared-subscription' },
  );
  await E(owner).storeValue(
    harden({
      kind: 'subscription-responses',
      subscription,
      model: 'test-luna',
    }),
    'recipe',
  );
  const powers = await E(owner).provideGuest('factory-handle', {
    agentName: 'factory-powers',
    introducedNames: harden({ '@agent': 'host-agent', recipe: 'llm-provider' }),
  });
  const factory = await E(owner).makeUnconfined(
    '@main',
    new URL('../agent.js', import.meta.url).href,
    { powersName: 'factory-powers', resultName: 'factory' },
  );
  return { config, connect, host, owner, pins, powers, factory, subscription };
};

const eventually = async (read, description) => {
  await null;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const result = await read();
    if (result) return result;
    await delay(25);
  }
  throw Error(`Timed out: ${description}`);
};

const sendAndRead = async (host, name, prompt) => {
  await E(host).send(name, [prompt], [], []);
  return eventually(async () => {
    const messages = await E(host).listMessages();
    const sent = messages.find(message => message.strings?.[0] === prompt);
    const replies = messages.filter(
      message =>
        sent &&
        message.replyTo === sent.messageId &&
        message.type === 'package',
    );
    if (!replies.length) return undefined;
    if (replies.length !== 1) throw Error('Duplicate reply');
    return JSON.parse(replies[0].strings.join(''));
  }, `reply to ${prompt}`);
};

const settled = async (owner, name) => {
  const guest = await E(owner).lookup(`profile-for-${name}`);
  await eventually(async () => {
    await null;
    if (!(await E(guest).has('fae-conversation'))) return false;
    return !(await E(guest).lookup('fae-conversation')).turnActive;
  }, 'durable turn settlement');
};

test.serial(
  'actual Whylip setup and book services preserve identities and saved views across cold restart',
  async t => {
    const { config, connect, host } = await prepareDaemon(t);
    await E(host).provideDirectory(['floot', 'controller-profile']);
    await E(host).makeUnconfined(
      '@node',
      new URL('./fixtures/broker.js', import.meta.url).href,
      { resultName: ['floot', 'controller'] },
    );
    await E(host).makeUnconfined(
      '@node',
      new URL('../../hosted-agent/src/subscription-module.js', import.meta.url)
        .href,
      {
        powersName: ['floot', 'controller'],
        resultName: ['floot', 'controller-profile', 'codex-inference'],
      },
    );
    const rootNames = await E(host).list();
    const options = { model: 'test-luna', reasoningEffort: 'low' };
    t.deepEqual(await setupWhylip(host, options), { ready: true, restored: 0 });
    t.deepEqual(await E(host).list(), rootNames);
    const installation = ['@pins', 'installations', 'whylip'];
    const books = await E(host).lookup([...installation, 'books-service']);
    const owner = await E(host).lookup([...installation, 'agents']);
    t.deepEqual(await E(books).createBook('physics'), ['whylip', 'physics']);
    const viewConfig = harden({
      name: 'Physics',
      icon: 'P',
      mode: 'whylip',
      profilePath: ['whylip', 'physics'],
      scheme: 'dark',
    });
    const saved = await E(books).provideSpace(viewConfig);
    const { number } = parseId(await E(host).identify('@self'));
    const savedPath = [
      '@pins',
      'installations',
      'chat',
      number,
      'spaces',
      saved.id,
    ];
    const retainedPaths = [
      ...(await E(host).list(...installation)).map(name => [
        ...installation,
        name,
      ]),
      ['whylip', 'physics'],
      [...installation, 'books', 'physics', 'agent'],
      [...installation, 'agents', 'physics-agent'],
      [...installation, 'agents', 'physics-agent-driver'],
      savedPath,
    ];
    const identities = [];
    for (const path of retainedPaths)
      identities.push(await E(host).identify(...path));
    t.deepEqual(await E(books).createBook('physics'), ['whylip', 'physics']);
    t.deepEqual(
      await E(books).provideSpace(harden({ ...viewConfig, scheme: 'light' })),
      saved,
    );
    t.deepEqual(await setupWhylip(host, options), { ready: true, restored: 1 });
    for (const [index, path] of retainedPaths.entries()) {
      t.is(await E(host).identify(...path), identities[index]);
    }
    t.deepEqual(
      [...(await E(host).list())].sort(),
      [...rootNames, 'whylip'].sort(),
    );
    t.false(await E(host).has('spaces'));
    const book = await E(host).lookup(['whylip', 'physics']);
    const first = await sendAndRead(book, 'fae', 'before-book-restart');
    await settled(owner, 'physics-agent');
    await stop(config);
    await start(config);
    const restoredHost = await connect();
    t.deepEqual(await setupWhylip(restoredHost, options), {
      ready: true,
      restored: 1,
    });
    const restoredBooks = await E(restoredHost).lookup([
      ...installation,
      'books-service',
    ]);
    t.deepEqual(await E(restoredBooks).createBook('physics'), [
      'whylip',
      'physics',
    ]);
    t.deepEqual(await E(restoredBooks).provideSpace(viewConfig), saved);
    for (const [index, path] of retainedPaths.entries()) {
      t.is(await E(restoredHost).identify(...path), identities[index]);
    }
    t.deepEqual(
      [...(await E(restoredHost).list())].sort(),
      [...rootNames, 'whylip'].sort(),
    );
    t.false(await E(restoredHost).has('spaces'));
    const restoredBook = await E(restoredHost).lookup(['whylip', 'physics']);
    const second = await sendAndRead(restoredBook, 'fae', 'after-book-restart');
    t.is(second.sessionId, first.sessionId);
    t.is(second.userMessages.length, 2);
    await settled(
      await E(restoredHost).lookup([...installation, 'agents']),
      'physics-agent',
    );
  },
);

test.serial(
  'provideAgentLocator recovers a lost response and the same publication after restart',
  async t => {
    const { config, connect, host, owner, factory } = await prepare(t);
    const options = harden({
      pin: true,
      maxSubagentDepth: 1,
      systemPrompt: 'Test assistant.',
    });
    // Intentionally discard the first result, as a disconnected caller would.
    await E(factory).provideAgentLocator('recoverable', options);
    const names = await E(owner).list();
    const driverId = await E(owner).identify('recoverable-driver');
    const locator = await E(factory).provideAgentLocator(
      'recoverable',
      options,
    );
    t.deepEqual(await E(owner).list(), names);
    t.is(await E(owner).identify('recoverable-driver'), driverId);
    await E(host).storeLocator('recoverable', locator);
    const first = await sendAndRead(host, 'recoverable', 'before-recovery');
    await settled(owner, 'recoverable');
    await stop(config);
    await start(config);
    const restoredHost = await connect();
    const restoredOwner = await E(restoredHost).lookup('private-owner');
    const restoredFactory = await E(restoredOwner).lookup('factory');
    t.is(
      await E(restoredFactory).provideAgentLocator('recoverable', options),
      locator,
    );
    t.is(await E(restoredOwner).identify('recoverable-driver'), driverId);
    t.deepEqual(await E(restoredOwner).list(), names);
    const second = await sendAndRead(
      restoredHost,
      'recoverable',
      'after-recovery',
    );
    t.is(second.sessionId, first.sessionId);
    t.is(second.userMessages.length, 2);
    await settled(restoredOwner, 'recoverable');
  },
);

test.serial(
  'provideAgentLocator refuses changed requests, provider authority and workload configuration',
  async t => {
    const { owner, factory, powers, subscription } = await prepare(t);
    const options = harden({ pin: true, maxSubagentDepth: 0 });
    const locator = await E(factory).provideAgentLocator('checked', options);
    const names = await E(owner).list();
    const driverId = await E(owner).identify('checked-driver');
    for (const changed of [
      { ...options, pin: false },
      { ...options, systemPrompt: 'Different prompt' },
      { ...options, maxSubagentDepth: 1 },
    ]) {
      await t.throwsAsync(
        () => E(factory).provideAgentLocator('checked', changed),
        {
          message: /conflicts/,
        },
      );
    }
    const recipeId = await E(powers).identify('llm-provider');
    await E(powers).storeValue(
      harden({
        kind: 'subscription-responses',
        subscription,
        model: 'test-luna',
      }),
      'llm-provider',
    );
    await t.throwsAsync(
      () => E(factory).provideAgentLocator('checked', options),
      {
        message: /conflicts/,
      },
    );
    await E(powers).storeIdentifier('llm-provider', recipeId);
    const changedFactory = await E(owner).makeUnconfined(
      '@main',
      new URL('../agent.js', import.meta.url).href,
      {
        powersName: 'factory-powers',
        resultName: 'changed-factory',
        env: { FAE_MAX_TOOL_ROUNDS: '5' },
      },
    );
    await t.throwsAsync(
      () => E(changedFactory).provideAgentLocator('checked', options),
      {
        message: /configuration changed/,
      },
    );
    t.is(await E(owner).identify('checked-driver'), driverId);
    t.deepEqual(
      (await E(owner).list()).filter(name => name !== 'changed-factory'),
      names,
    );
    t.is(await E(factory).provideAgentLocator('checked', options), locator);
  },
);

test.serial(
  'provideAgentLocator does not adopt an unrelated existing agent or a same-name replacement',
  async t => {
    const { owner, factory, powers } = await prepare(t);
    const options = harden({ pin: true, maxSubagentDepth: 0 });
    await E(factory).createAgentLocator('unrelated', options);
    await t.throwsAsync(
      () => E(factory).provideAgentLocator('unrelated', options),
      {
        message: /already in use/,
      },
    );
    t.false(await E(powers).has('creation-requests'));
    const original = await E(factory).provideAgentLocator('replaced', options);
    const replacement = await E(factory).createAgentLocator(
      'replacement',
      options,
    );
    t.not(original, replacement);
    // Rebind a complete, internally consistent same-configuration agent.
    // Structural validation alone would accept it as the original request.
    for (const [source, target] of [
      ['replacement', 'replaced'],
      ['profile-for-replacement', 'profile-for-replaced'],
      ['replacement-driver', 'replaced-driver'],
      ['replacement-driver-handle', 'replaced-driver-handle'],
      [
        'profile-for-replacement-driver-handle',
        'profile-for-replaced-driver-handle',
      ],
    ]) {
      await E(owner).copy([source], [target]);
    }
    await E(owner).copy(['replacement-driver'], ['@pins', 'replaced-driver']);
    await E(owner).copy(
      ['replacement-driver'],
      ['profile-for-replaced', '@pins', 'replaced-driver'],
    );
    const names = await E(owner).list();
    await t.throwsAsync(
      () => E(factory).provideAgentLocator('replaced', options),
      {
        message: /changed|conflicts|incomplete|replacement/,
      },
    );
    t.is(await E(owner).locate('replaced'), replacement);
    t.deepEqual(await E(owner).list(), names);
  },
);

test.serial(
  'private Fae factory agents share a subscription and revive through mail after restart',
  async t => {
    const { config, connect, host, owner, factory, subscription } =
      await prepare(t);
    const identities = {};
    const handleIdentities = {};
    const replies = {};
    for (const name of ['alice', 'bob']) {
      const locator = await E(factory).createAgentLocator(name, {
        pin: true,
        maxSubagentDepth: 0,
      });
      await E(host).storeLocator(name, locator);
      t.false(await E(host).has(`profile-for-${name}`));
      identities[name] = await E(owner).identify(`${name}-driver`);
      handleIdentities[name] = await E(host).identify(name);
      t.is(
        await E(owner).identify('@pins', `${name}-driver`),
        identities[name],
      );
      replies[name] = await sendAndRead(host, name, `first-${name}`);
      await settled(owner, name);
    }
    t.not(replies.alice.sessionId, replies.bob.sessionId);
    t.deepEqual(await E(subscription).counts(), { opened: 2, revoked: 2 });
    await stop(config);
    await start(config);
    const restoredHost = await connect();
    // Do not look up owner/factory/driver/profile here: that could revive the
    // driver and conceal a broken private host mailbox pin relationship.
    for (const name of ['alice', 'bob']) {
      const reply = await sendAndRead(restoredHost, name, `second-${name}`);
      t.is(reply.sessionId, replies[name].sessionId);
      t.is(reply.userMessages.length, 2);
      t.true(reply.userMessages[0].includes(`first-${name}`));
      t.true(reply.userMessages[1].includes(`second-${name}`));
    }
    const restoredOwner = await E(restoredHost).lookup('private-owner');
    for (const name of ['alice', 'bob']) {
      t.is(await E(restoredHost).identify(name), handleIdentities[name]);
      t.is(await E(restoredOwner).identify(`${name}-driver`), identities[name]);
      await settled(restoredOwner, name);
    }
    const restoredSubscription = await E(restoredOwner).lookup(
      'shared-subscription',
    );
    t.deepEqual(await E(restoredSubscription).counts(), {
      opened: 2,
      revoked: 2,
    });
    const messages = await E(restoredHost).listMessages();
    t.is(messages.filter(message => message.replyTo !== undefined).length, 4);
  },
);

for (const failure of ['none', 'before-remove', 'lost-acknowledgment']) {
  test.serial(
    `release removes mailbox pins and retries without reviving a removed driver: ${failure}`,
    async t => {
      const { config, connect, host, owner, factory, pins } = await prepare(t);
      const before = await E(owner).list();
      const locator = await E(factory).createAgentLocator('retired', {
        pin: true,
        maxSubagentDepth: 0,
      });
      await E(host).storeLocator('retired', locator);
      await sendAndRead(host, 'retired', 'before-release');
      await settled(owner, 'retired');
      const mailPins = await E(owner).lookup(['profile-for-retired', '@pins']);
      t.deepEqual(await E(mailPins).list(), ['retired-driver']);
      const cancellations = [];
      let injected = false;
      const guardedOwner = Far('ReleaseFaultHost', {
        has: (...path) => E(owner).has(...path),
        list: () => E(owner).list(),
        cancel: name => {
          cancellations.push(name);
          return E(owner).cancel(name);
        },
        remove: async (...path) => {
          await null;
          const target =
            path.join('/') === 'profile-for-retired/@pins/retired-driver';
          if (target && !injected && failure !== 'none') {
            injected = true;
            if (failure === 'lost-acknowledgment')
              await E(owner).remove(...path);
            throw Error('Injected mailbox pin removal failure');
          }
          return E(owner).remove(...path);
        },
      });
      if (failure !== 'none') {
        await t.throwsAsync(
          () => releaseFaeAgent({ hostAgent: guardedOwner, name: 'retired' }),
          {
            message: /retry once the cause is cleared/,
          },
        );
        t.true(injected);
        t.true(
          await E(owner).has('retired'),
          'incomplete release remains discoverable',
        );
        t.false(await E(owner).has('profile-for-retired-driver-handle'));
        t.deepEqual(
          await E(mailPins).list(),
          failure === 'before-remove' ? ['retired-driver'] : [],
        );
      }
      await releaseFaeAgent({ hostAgent: guardedOwner, name: 'retired' });
      await releaseFaeAgent({ hostAgent: guardedOwner, name: 'retired' });
      t.deepEqual(await E(mailPins).list(), []);
      t.deepEqual(await E(pins).list(), []);
      t.deepEqual(await E(owner).list(), before);
      t.deepEqual(cancellations, [
        'profile-for-retired-driver-handle',
        'profile-for-retired',
      ]);

      // Keep the external mail handle alive intentionally. Even this stale
      // address must not bring the released driver back after a cold restart.
      await stop(config);
      await start(config);
      const restoredHost = await connect();
      await E(restoredHost).send('retired', ['after-release'], [], []);
      const restoredOwner = await E(restoredHost).lookup('private-owner');
      const restoredSubscription = await E(restoredOwner).lookup(
        'shared-subscription',
      );
      t.deepEqual(await E(restoredSubscription).counts(), {
        opened: 0,
        revoked: 0,
      });
      t.deepEqual(await E(restoredOwner).list(), before);
      t.deepEqual(await E(await E(restoredOwner).lookup('@pins')).list(), []);
    },
  );
}

test.serial(
  'createAgent and createAgentLocator serialize competing names without orphaning the winner',
  async t => {
    const { host, owner, factory, pins } = await prepare(t);
    const before = await E(owner).list();
    const outcomes = await Promise.allSettled([
      E(factory).createAgent('racer', { pin: true, maxSubagentDepth: 0 }),
      E(factory).createAgentLocator('racer', {
        pin: true,
        maxSubagentDepth: 0,
      }),
    ]);
    t.is(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = outcomes.find(result => result.status === 'rejected');
    t.regex(rejected.reason.message, /already taken/);
    const added = (await E(owner).list())
      .filter(name => !before.includes(name))
      .sort();
    t.deepEqual(added, [
      'profile-for-racer',
      'profile-for-racer-driver-handle',
      'racer',
      'racer-driver',
      'racer-driver-handle',
    ]);
    t.deepEqual(await E(pins).list(), ['racer-driver']);
    await E(host).storeLocator('racer', await E(owner).locate('racer'));
    const reply = await sendAndRead(host, 'racer', 'race-winner');
    t.true(reply.userMessages[0].includes('race-winner'));
    await settled(owner, 'racer');
  },
);

test.serial(
  'real daemon settles reply-dismiss-empty and revives the same driver after cold restart',
  async t => {
    const { config, connect, host, owner, factory, subscription } =
      await prepare(t);
    const locator = await E(factory).createAgentLocator('terminal-agent', {
      pin: true,
      maxSubagentDepth: 0,
    });
    await E(host).storeLocator('terminal-contact', locator);
    const originalDriver = await E(owner).identify('terminal-agent-driver');
    const first = await sendAndRead(
      host,
      'terminal-contact',
      'terminal-fixture before worker restart',
    );
    await settled(owner, 'terminal-agent');
    t.deepEqual(await E(subscription).counts(), { opened: 3, revoked: 3 });
    const second = await sendAndRead(
      host,
      'terminal-contact',
      'terminal-fixture second turn',
    );
    await settled(owner, 'terminal-agent');
    t.is(second.sessionId, first.sessionId);
    t.is(second.userMessages.length, 2);
    t.deepEqual(await E(subscription).counts(), { opened: 6, revoked: 6 });
    await stop(config);
    await start(config);
    const restored = await connect();
    const third = await sendAndRead(
      restored,
      'terminal-contact',
      'terminal-fixture after daemon restart',
    );
    const restoredOwner = await E(restored).lookup('private-owner');
    await settled(restoredOwner, 'terminal-agent');
    t.is(
      await E(restoredOwner).identify('terminal-agent-driver'),
      originalDriver,
    );
    t.is(third.sessionId, first.sessionId);
    t.is(third.userMessages.length, 3);
  },
);

test.serial(
  'actual Whylip archived installation preserves evidence while fresh setup uses new private workers',
  async t => {
    const { host } = await prepareDaemon(t);
    await E(host).provideDirectory(['floot', 'controller-profile']);
    await E(host).makeUnconfined(
      '@node',
      new URL('./fixtures/broker.js', import.meta.url).href,
      { resultName: ['floot', 'controller'] },
    );
    await E(host).makeUnconfined(
      '@node',
      new URL('../../hosted-agent/src/subscription-module.js', import.meta.url)
        .href,
      {
        powersName: ['floot', 'controller'],
        resultName: ['floot', 'controller-profile', 'codex-inference'],
      },
    );
    // In-memory root state proves recovery never restarts unrelated workers.
    const sentinel = await E(host).makeUnconfined(
      '@main',
      new URL('./fixtures/subscription.js', import.meta.url).href,
      { resultName: 'unrelated-root-service' },
    );
    const endpoint = await E(sentinel).openEndpoint({ sessionId: 'unrelated' });
    await E(endpoint).revoke();
    const rootWorkerId = await E(host).identify('@main');
    const installation = ['@pins', 'installations', 'whylip'];
    const options = { model: 'test-luna', reasoningEffort: 'low' };
    await setupWhylip(host, options);
    const books = await E(host).lookup([...installation, 'books-service']);
    await E(books).createBook('physics');
    const owner = await E(host).lookup([...installation, 'agents']);
    const book = await E(host).lookup(['whylip', 'physics']);
    const first = await sendAndRead(
      book,
      'fae',
      'terminal-fixture before archive',
    );
    await settled(owner, 'physics-agent');
    const guest = await E(owner).lookup('profile-for-physics-agent');
    const selection = await E(guest).lookup('fae-conversation');
    // Retain a failed-turn admission marker in this synthetic old fixture.
    // Recovery must preserve it, never clear it or reuse that conversation.
    await E(guest).storeValue(
      harden({ ...selection, turnActive: true }),
      'fae-conversation',
    );
    const retainedSelection = await E(guest).lookup('fae-conversation');
    const treeNames = (await E(guest).list()).filter(name =>
      name.startsWith('ct-'),
    );
    const tree = await Promise.all(
      treeNames.map(name => E(guest).lookup(name)),
    );
    const oldMessages = await E(book).listMessages();
    const oldBookId = await E(host).identify('whylip', 'physics');
    const runtimeNames = (await E(host).list(...installation)).filter(
      name => name !== 'recipe',
    );
    const identities = await Promise.all(
      runtimeNames.map(name => E(host).identify(...installation, name)),
    );
    const recipeId = await E(host).identify(...installation, 'recipe');
    const sourceId = await E(host).identify(
      'floot',
      'controller-profile',
      'codex-inference',
    );
    const archive = [...installation, 'retired-fixtures', 'terminal-v1'];
    await E(host).provideDirectory(archive);
    await E(host).copy(['whylip', 'physics'], [...archive, 'book']);
    await E(host).remove('whylip', 'physics');
    await E(owner).remove('@pins', 'physics-agent-driver');
    await E(guest).remove('@pins', 'physics-agent-driver');
    // Archive exact formulas. No worker cancellation, conversation rewrite,
    // or driver disposal is needed to isolate the failed installation.
    for (const name of runtimeNames) {
      await E(host).copy([...installation, name], [...archive, name]);
      await E(host).remove(...installation, name);
    }
    t.deepEqual(await setupWhylip(host, options), { ready: true, restored: 0 });
    const freshBooks = await E(host).lookup([...installation, 'books-service']);
    await E(freshBooks).createBook('physics');
    const freshBook = await E(host).lookup(['whylip', 'physics']);
    const freshOwner = await E(host).lookup([...installation, 'agents']);
    for (const [index, name] of runtimeNames.entries()) {
      t.is(await E(host).identify(...archive, name), identities[index]);
      t.not(await E(host).identify(...installation, name), identities[index]);
    }
    t.is(await E(host).identify(...installation, 'recipe'), recipeId);
    t.is(
      await E(host).identify('floot', 'controller-profile', 'codex-inference'),
      sourceId,
    );
    t.is(await E(host).identify(...archive, 'book'), oldBookId);
    t.not(await E(host).identify('whylip', 'physics'), oldBookId);
    const second = await sendAndRead(
      freshBook,
      'fae',
      'terminal-fixture fresh installation first turn',
    );
    await settled(freshOwner, 'physics-agent');
    const third = await sendAndRead(
      freshBook,
      'fae',
      'terminal-fixture fresh installation second turn',
    );
    await settled(freshOwner, 'physics-agent');
    t.not(second.sessionId, first.sessionId);
    t.is(third.sessionId, second.sessionId);
    t.is(third.userMessages.length, 2);
    t.deepEqual(await E(guest).lookup('fae-conversation'), retainedSelection);
    t.deepEqual(
      await Promise.all(treeNames.map(name => E(guest).lookup(name))),
      tree,
    );
    t.deepEqual(await E(book).listMessages(), oldMessages);
    t.false(await E(owner).has('@pins', 'physics-agent-driver'));
    t.false(await E(guest).has('@pins', 'physics-agent-driver'));
    t.is(await E(host).identify('@main'), rootWorkerId);
    t.deepEqual(await E(sentinel).counts(), { opened: 1, revoked: 1 });
  },
);
