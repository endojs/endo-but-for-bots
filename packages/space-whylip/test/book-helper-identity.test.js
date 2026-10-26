// @ts-check

import '@endo/init/debug.js';
import test from 'ava';
import { E } from '@endo/eventual-send';
import { parseLocator } from '@endo/daemon/locator.js';

import { make } from '../src/book-caplet.js';
import { makeFactoryHostAdapter } from '../src/factory-host-caplet.js';

const driverUrl = new URL('../../fae/driver.js', import.meta.url).href;
const node = '0123456789abcdef'.repeat(4);
const formula = 'fedcba9876543210'.repeat(4);

/** @param {string} identity */
const launchHelper = async identity => {
  // Validate fixtures against the real daemon locator format.
  parseLocator(identity);
  const values = new Map();
  /** @type {string[]} */
  const names = [];
  let markLaunched = () => {};
  /** @type {Promise<void>} */
  const launched = new Promise(resolve => {
    markLaunched = () => resolve();
  });
  const adapter = makeFactoryHostAdapter({
    async has() {
      return undefined;
    },
    async provideGuest() {
      return undefined;
    },
    async lookup() {
      return undefined;
    },
    async locate() {
      return undefined;
    },
    async makeUnconfined() {
      return undefined;
    },
    async copy() {
      return undefined;
    },
  });
  const factory = {
    async createAgentCapability(name, options) {
      if (options.maxSubagentDepth !== 0)
        throw Error('Helpers must not spawn generic subagents');
      const profileName = `profile-for-${name}`;
      const driverProfile = `${profileName}-driver-handle`;
      const resultName = `${name}-driver`;
      await E(adapter).has(resultName);
      await E(adapter).provideGuest(name, harden({ agentName: profileName }));
      await E(adapter).provideGuest(
        `${name}-driver-handle`,
        harden({ agentName: driverProfile }),
      );
      await E(adapter).lookup(profileName);
      await E(adapter).locate(profileName);
      await E(adapter).makeUnconfined(
        '@main',
        driverUrl,
        harden({
          powersName: driverProfile,
          resultName,
          env: {
            FAE_SYSTEM_PROMPT: options.systemPrompt,
            FAE_SUBAGENT_PROMPT: '',
          },
        }),
      );
      await E(adapter).copy(
        harden([resultName]),
        harden(['@pins', resultName]),
      );
      names.push(name);
      return harden({
        profileName,
        locator: identity,
        agent: {
          async storeLocator() {
            return undefined;
          },
        },
      });
    },
  };
  const book = await make(
    {
      async list() {
        return harden([...values.keys()]);
      },
      async lookup(name) {
        return name === 'fae-factory' ? factory : values.get(name);
      },
      async storeValue(value, name) {
        values.set(name, value);
      },
      async locate() {
        return identity;
      },
      async has() {
        return true;
      },
      async storeLocator() {
        return undefined;
      },
      async send(destination) {
        if (destination.startsWith('whylip-helper-')) markLaunched();
      },
    },
    undefined,
  );
  const task = await E(book).startTask('Illustration', 'Draw an owl.');
  await launched;
  return { name: names[0], taskId: task.id };
};

test('helper provisioning accepts real locator hints without using them as identity', async t => {
  t.timeout(3000);
  const plain = `endo://${node}/${formula}?type=host`;
  const hinted = `endo://${node}/${formula}@${encodeURIComponent('websocket:wss://gateway.example/@route')}@${encodeURIComponent('tcp:localhost:8080')}?type=host`;
  const [first, second] = await Promise.all([
    launchHelper(plain),
    launchHelper(hinted),
  ]);
  t.regex(first.name, /^whylip-[0-9a-f]{56}$/);
  t.is(first.name.length, 63);
  t.is(second.name, first.name);
});

test('helpers for equal formula and task IDs on different daemons do not collide', async t => {
  t.timeout(3000);
  const otherNode = 'abcdef0123456789'.repeat(4);
  const [first, second] = await Promise.all([
    launchHelper(`endo://${node}/${formula}?type=host`),
    launchHelper(`endo://${otherNode}/${formula}?type=host`),
  ]);
  t.is(first.taskId, second.taskId);
  t.not(first.name, second.name);
  t.regex(second.name, /^whylip-[0-9a-f]{56}$/);
});
