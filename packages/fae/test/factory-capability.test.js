// @ts-check

import '@endo/init/debug.js';
import test from 'ava';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import { make } from '../agent.js';

const makeFactory = async () => {
  const profiles = new Map();
  /** @type {any[]} */
  const launches = [];
  /** @type {any[]} */
  const grants = [];
  /** @type {any[]} */
  const pins = [];
  /** @type {string[]} */
  const created = [];
  let failLaunch = false;
  const host = Far('FactoryTestHost', {
    has: (...names) => profiles.has(names.join('/')),
    list: () => [...profiles.keys()],
    cancel: () => undefined,
    remove: (...names) => {
      profiles.delete(names.join('/'));
    },
    lookup: name => profiles.get(name),
    locate: name => `locator:${name}`,
    provideGuest: (name, { agentName }) => {
      if (profiles.has(agentName)) throw Error('Must reuse existing guests');
      const guest = Far(`Guest ${name}`, {
        storeLocator: (petname, locator) => {
          grants.push({ name, petname, locator });
        },
      });
      created.push(name);
      profiles.set(agentName, guest);
      profiles.set(name, guest);
      return guest;
    },
    makeUnconfined: async (worker, moduleUrl, options) => {
      launches.push({ worker, moduleUrl, options });
      if (failLaunch) throw Error('launch interrupted');
      profiles.set(options.resultName, Far('Driver', {}));
    },
    copy: (from, to) => {
      pins.push({ from, to });
    },
  });
  /** @type {any} */
  const powers = Far('FactoryTestPowers', {
    has: () => false,
    lookup: name => {
      if (name !== 'host-agent') throw Error(`Unexpected lookup ${name}`);
      return host;
    },
    locate: name => {
      if (!['llm-provider', 'host-agent'].includes(name))
        throw Error(`Unexpected locator ${name}`);
      return `${name}-locator`;
    },
  });
  const factory = await make(powers, undefined, {
    env: { FAE_MAX_SUBAGENT_DEPTH: '0' },
  });
  return {
    factory,
    powers,
    profiles,
    launches,
    grants,
    pins,
    created,
    interruptLaunch: () => {
      failLaunch = true;
    },
    recoverLaunch: () => {
      failLaunch = false;
    },
  };
};

test('createAgent retains its string return and duplicate-name contract', async t => {
  const context = await makeFactory();
  const profile = await E(context.factory).createAgent(
    'reader',
    harden({ systemPrompt: 'Tell a story', pin: true }),
  );
  t.is(profile, 'profile-for-reader');
  t.is(context.launches.length, 1);
  t.is(context.launches[0].options.env.FAE_SYSTEM_PROMPT, 'Tell a story');
  t.deepEqual(context.pins, [
    { from: ['reader-driver'], to: ['@pins', 'reader-driver'] },
  ]);
  await t.throwsAsync(E(context.factory).createAgent('reader'), {
    message: /already exists/,
  });
});

test('createAgentCapability returns a scoped guest and coalesces concurrent requests', async t => {
  const context = await makeFactory();
  const [first, second] = await Promise.all([
    E(context.factory).createAgentCapability(
      'illustrator',
      harden({ systemPrompt: 'Draw a forest', pin: true }),
    ),
    E(context.factory).createAgentCapability(
      'illustrator',
      harden({ systemPrompt: 'Must not replace' }),
    ),
  ]);
  t.deepEqual(Object.keys(first).sort(), ['agent', 'locator', 'profileName']);
  t.is(first.profileName, 'profile-for-illustrator');
  t.is(first.locator, 'locator:profile-for-illustrator');
  t.is(first.agent, context.profiles.get('profile-for-illustrator'));
  t.is(second.agent, first.agent);
  t.is(context.launches.length, 1);
  t.is(context.launches[0].options.env.FAE_SYSTEM_PROMPT, 'Draw a forest');
  await E(first.agent).storeLocator('task', 'restricted-task-locator');
  t.deepEqual(
    context.grants.filter(grant => grant.name === 'illustrator'),
    [
      {
        name: 'illustrator',
        petname: 'task',
        locator: 'restricted-task-locator',
      },
    ],
  );
  t.true(Object.isFrozen(first));
  t.regex(
    await E(context.factory).help('createAgentCapability'),
    /trusted host/,
  );
});

test('a new factory incarnation reconnects to the same named helper without relaunching', async t => {
  const context = await makeFactory();
  const first = await E(context.factory).createAgentCapability('illustrator');
  const reincarnated = await make(context.powers, undefined);
  const restored = await E(reincarnated).createAgentCapability(
    'illustrator',
    harden({ systemPrompt: 'Ignore on reconnect' }),
  );
  t.is(restored.agent, first.agent);
  t.is(restored.locator, first.locator);
  t.is(context.launches.length, 1);
  t.deepEqual(context.created, ['illustrator', 'illustrator-driver-handle']);
});

test('interrupted driver launch rolls back owned names before a clean retry', async t => {
  const context = await makeFactory();
  context.interruptLaunch();
  await t.throwsAsync(E(context.factory).createAgentCapability('illustrator'), {
    message: 'launch interrupted',
  });
  t.is(
    context.profiles.size,
    0,
    'upstream rollback releases incomplete guests',
  );
  context.recoverLaunch();
  const restored = await E(context.factory).createAgentCapability(
    'illustrator',
  );
  t.is(restored.agent, context.profiles.get('profile-for-illustrator'));
  t.is(context.launches.length, 2);
  t.deepEqual(context.created, [
    'illustrator',
    'illustrator-driver-handle',
    'illustrator',
    'illustrator-driver-handle',
  ]);
});
