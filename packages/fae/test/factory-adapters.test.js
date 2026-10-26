// @ts-check
// prefer-endo-primitives-exempt: Far instances are explicit remotable test doubles.

import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import { makeFaeAgentDriverMaker } from '../src/agent-driver-maker.js';
import { makeSubagentSpawnerAdapter } from '../src/subagent-factory-adapter.js';

/**
 * @typedef {object} FactoryNode
 * @property {string} name
 * @property {Map<string, FactoryNode>} children
 * @property {Record<string, any>} [options]
 */

/** @param {number} maxChildren */
const makeFactoryTree = maxChildren => {
  const handles = new Map();
  /** @type {FactoryNode} */
  const root = { name: 'root', children: new Map() };
  /**
   * @param {FactoryNode} node
   * @returns {number}
   */
  const retainedChildren = node =>
    (node.options ? 1 : 0) +
    [...node.children.values()].reduce(
      (total, child) => total + retainedChildren(child),
      0,
    );
  /** @param {FactoryNode} node */
  const makeFactory = node =>
    Far('BoundChildAgentFactory', {
      attenuate(name) {
        if (node.children.has(name)) throw Error(`duplicate ${name}`);
        const child = { name, children: new Map() };
        node.children.set(name, child);
        return makeFactory(child);
      },
      create(_name, options = {}) {
        if (retainedChildren(root) >= maxChildren) throw Error('quota');
        node.options = options;
        const handle = Far('Handle', {});
        handles.set(handle, `endo://node/${handles.size + 1}?type=handle`);
        return harden({ summary: harden({}), handle });
      },
      revokeDerived(name) {
        node.children.delete(name);
      },
      listDerived() {
        return harden(
          [...node.children.values()].map(child =>
            harden({
              name: child.name,
              phase: 'Active',
              retainedChildren: retainedChildren(child),
            }),
          ),
        );
      },
    });
  return { root, factory: makeFactory(root), handles };
};

test('SubagentSpawner adapter preserves quota, attachment, stop, and recursive cleanup', async t => {
  const { root, factory, handles } = makeFactoryTree(2);
  const direct = makeSubagentSpawnerAdapter({
    factory,
    locateHandle: handle => handles.get(handle),
  });
  const project = Far('Project', {});
  t.deepEqual(
    await E(direct).spawn('helper', {
      systemPrompt: 'Inspect.',
      capabilities: [{ name: 'project', value: project }],
    }),
    { name: 'helper', locator: 'endo://node/1?type=handle' },
  );
  t.deepEqual(await E(direct).list(), ['helper']);
  const helper = root.children.get('helper');
  t.is(helper.options.instructions, 'Inspect.');
  t.is(helper.options.endowments.project, project);

  const nested = helper.options.endowments['subagent-spawner'];
  await E(nested).spawn('grandchild');
  await t.throwsAsync(E(direct).spawn('overflow'), { message: /quota/ });
  t.deepEqual(await E(nested).list(), ['grandchild']);

  await E(direct).stop('helper');
  t.deepEqual(await E(direct).list(), []);
  t.is(root.children.size, 0, 'the descendant tree was revoked with its root');
});

test('Fae maker installs only driver capabilities and returns the landed driver', async t => {
  const provider = Far('Provider', {});
  const nestedSpawner = Far('SubagentSpawner', {});
  const agent = Far('Agent', {
    has: name => name === 'subagent-spawner',
    lookup: () => nestedSpawner,
  });
  const stored = new Map();
  const driverGuest = Far('DriverGuest', {
    storeValue: (value, name) => stored.set(name, value),
  });
  const maker = makeFaeAgentDriverMaker({
    provider,
    driverSpecifier: 'file:///fae-driver.js',
    systemPrompt: 'Stay confined.',
  });
  const descriptor = await E(maker).installDriver(
    harden({
      agent,
      driverGuest,
      lifecycle: Far('Lifecycle', {}),
      instructions: 'Research one question.',
    }),
  );
  t.deepEqual(descriptor, {
    specifier: 'file:///fae-driver.js',
    env: {
      FAE_SYSTEM_PROMPT: 'Stay confined.',
      FAE_SUBAGENT_PROMPT: 'Research one question.',
    },
  });
  t.deepEqual([...stored.keys()].sort(), [
    'agent',
    'llm-provider',
    'subagent-spawner',
  ]);
  t.is(stored.get('subagent-spawner'), nestedSpawner);
});

test('SubagentSpawner adapter describes each method', async t => {
  const { factory, handles } = makeFactoryTree(1);
  const spawner = makeSubagentSpawnerAdapter({
    factory,
    locateHandle: handle => handles.get(handle),
  });
  const [spawnHelp, stopHelp, listHelp, overview] = await Promise.all([
    E(spawner).help('spawn'),
    E(spawner).help('stop'),
    E(spawner).help('list'),
    E(spawner).help(),
  ]);
  t.regex(spawnHelp, /^spawn\(name/);
  t.regex(stopHelp, /^stop\(name\)/);
  t.regex(listHelp, /^list\(\)/);
  t.regex(overview, /^Subagent spawner:/);
});

test('SubagentSpawner adapter reserves the nested spawner capability name', async t => {
  const { root, factory, handles } = makeFactoryTree(1);
  const spawner = makeSubagentSpawnerAdapter({
    factory,
    locateHandle: handle => handles.get(handle),
  });
  await t.throwsAsync(
    E(spawner).spawn('helper', {
      capabilities: [{ name: 'subagent-spawner', value: Far('Forged', {}) }],
    }),
    { message: /is reserved/ },
  );
  t.is(root.children.size, 0);
});

test('Fae maker installs an auth secret and omits an empty environment', async t => {
  const provider = Far('Provider', {});
  const authSecret = Far('AuthSecret', {});
  const agent = Far('Agent', { has: () => false });
  const stored = new Map();
  const driverGuest = Far('DriverGuest', {
    storeValue: (value, name) => stored.set(name, value),
  });
  const maker = makeFaeAgentDriverMaker({ provider, authSecret });
  const descriptor = await E(maker).installDriver(
    harden({ agent, driverGuest, lifecycle: Far('Lifecycle', {}) }),
  );
  t.regex(descriptor.specifier, /\/fae\/driver\.js$/);
  t.false('env' in descriptor);
  t.deepEqual([...stored.keys()].sort(), [
    'agent',
    'llm-auth-secret',
    'llm-provider',
  ]);
  t.is(stored.get('llm-auth-secret'), authSecret);
});
