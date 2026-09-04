// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';

import {
  makeSubagentSpawner,
  provisionFaeAgent,
  releaseFaeAgent,
  subagentAgentName,
} from '../src/subagent-host.js';

/**
 * A host agent that records every namespace operation, so a test can assert on
 * what a half-built agent left behind.
 *
 * @param {object} [options]
 * @param {(step: { op: string, name: string }) => void} [options.onStep] -
 *   Throw from here to fail one provisioning step.
 */
const makeFakeHost = ({ onStep = () => {} } = {}) => {
  /** @type {Map<string, string>} */
  const names = new Map();
  /** @type {string[]} */
  const cancelled = [];
  /** @type {string[]} */
  const removed = [];
  let nextId = 0;

  const bind = name => {
    nextId += 1;
    const id = `${name}-id-${nextId}`;
    names.set(name, id);
    return id;
  };

  const hostAgent = Far('HostAgent', {
    async list() {
      return harden([...names.keys()].sort());
    },
    async has(...petNamePath) {
      return names.has(petNamePath.join('/'));
    },
    async locate(...petNamePath) {
      const id = names.get(petNamePath.join('/'));
      return id === undefined ? undefined : `endo://node/${id}?type=handle`;
    },
    async provideGuest(name, options = {}) {
      onStep({ op: 'provideGuest', name });
      bind(name);
      if (options.agentName) bind(options.agentName);
      return Far('Guest', {
        async storeLocator() {
          return undefined;
        },
      });
    },
    async makeUnconfined(_worker, _specifier, options = {}) {
      onStep({ op: 'makeUnconfined', name: options.resultName });
      bind(options.resultName);
      return Far('Caplet', {});
    },
    async copy(from, to) {
      names.set(
        to.join('/'),
        /** @type {string} */ (names.get(from.join('/'))),
      );
    },
    async cancel(name) {
      cancelled.push(name);
    },
    async remove(...petNamePath) {
      const key = petNamePath.join('/');
      removed.push(key);
      names.delete(key);
    },
  });
  return { hostAgent, names, cancelled, removed };
};

const provisionOptions = {
  providerLocator: 'endo://node/provider?type=readable-blob',
  hostAgentLocator: 'endo://node/host?type=handle',
  driverSpecifier: 'file:///driver.js',
  spawnerSpecifier: 'file:///spawner.js',
};

test('provisioning releases a half-built agent when a later step fails', async t => {
  const { hostAgent, names, cancelled } = makeFakeHost({
    onStep: step => {
      // The driver caplet is the last step; fail it once the spawner caplet is
      // already running.
      if (step.op === 'makeUnconfined' && step.name === 'parent-driver') {
        throw Error('worker refused the driver');
      }
    },
  });

  await t.throwsAsync(
    provisionFaeAgent({
      hostAgent,
      name: 'parent',
      depth: 0,
      maxDepth: 1,
      ...provisionOptions,
    }),
    { message: /worker refused the driver/ },
  );

  t.true(
    cancelled.includes('parent-spawner'),
    'the running spawner caplet must be cancelled, not abandoned',
  );
  t.false(
    names.has('parent-spawner'),
    'no name may still reach the spawner that held host-agent',
  );
  t.false(names.has('parent'), 'the agent guest must be released too');
});

test('releasing an agent cancels its guests, not only its caplets', async t => {
  const { hostAgent, names, cancelled } = makeFakeHost();
  await provisionFaeAgent({
    hostAgent,
    name: 'parent',
    depth: 0,
    maxDepth: 1,
    ...provisionOptions,
  });

  await releaseFaeAgent({ hostAgent, name: 'parent' });

  for (const expected of [
    'parent-driver',
    'parent-spawner',
    'profile-for-parent-driver-handle',
    'profile-for-parent-spawner-handle',
    'profile-for-parent',
  ]) {
    t.true(cancelled.includes(expected), `${expected} should be cancelled`);
  }
  t.deepEqual([...names.keys()], []);
});

test('a subagent may not take a name the enumeration keys on', async t => {
  const { hostAgent } = makeFakeHost();
  const spawner = makeSubagentSpawner({
    provideContext: async () =>
      harden({
        hostAgent,
        providerLocator: provisionOptions.providerLocator,
        hostAgentLocator: provisionOptions.hostAgentLocator,
      }),
    parentName: 'parent',
    driverSpecifier: provisionOptions.driverSpecifier,
    spawnerSpecifier: provisionOptions.spawnerSpecifier,
    depth: 1,
    maxDepth: 1,
  });

  // `parent`'s subagent `a-sub-b` would be the host agent `parent-sub-a-sub-b`,
  // which is also what `parent-sub-a`'s own spawner would mint for `b`. Both
  // enumerations skip an interior infix, so it would count against no bound and
  // no teardown would reach it.
  await t.throwsAsync(spawner.spawn('a-sub-b'), {
    message: /must not contain/,
  });
  // `parent`'s subagent `x-driver` would be the host agent
  // `parent-sub-x-driver` — the name sibling `x`'s driver caplet already holds.
  await t.throwsAsync(spawner.spawn('x-driver'), {
    message: /must not end with/,
  });
  await t.throwsAsync(spawner.spawn('x-spawner'), {
    message: /must not end with/,
  });
  await t.throwsAsync(spawner.spawn('x-handle'), {
    message: /must not end with/,
  });

  t.is(subagentAgentName('parent', 'helper'), 'parent-sub-helper');
});

test('the subagent count bound cannot be evaded by an unenumerable name', async t => {
  const { hostAgent } = makeFakeHost();
  const spawner = makeSubagentSpawner({
    provideContext: async () =>
      harden({
        hostAgent,
        providerLocator: provisionOptions.providerLocator,
        hostAgentLocator: provisionOptions.hostAgentLocator,
      }),
    parentName: 'parent',
    driverSpecifier: provisionOptions.driverSpecifier,
    spawnerSpecifier: provisionOptions.spawnerSpecifier,
    depth: 1,
    maxDepth: 1,
    maxSubagents: 2,
  });

  await spawner.spawn('one');
  await spawner.spawn('two');
  t.deepEqual(await spawner.list(), ['one', 'two']);
  await t.throwsAsync(spawner.spawn('three'), { message: /Subagent limit/ });
});
