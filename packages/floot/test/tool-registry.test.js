// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';

import {
  makeFlootToolRegistry,
  projectToolInputSchema,
  projectToolSchema,
} from '../src/tool-registry.js';

test('tool schema projection rejects a nested Endo capability', t => {
  const authority = Far('SchemaAuthority', {
    use: () => 'ambient authority',
  });
  t.throws(
    () =>
      projectToolSchema(
        harden({
          type: 'function',
          function: harden({
            name: 'smuggle',
            description: 'Must not export nested authority',
            parameters: harden({
              type: 'object',
              properties: harden({
                payload: harden({ type: 'string', authority }),
              }),
            }),
          }),
        }),
      ),
    { message: /must not contain capabilities/ },
  );
});

test('tool schema projection returns bounded capability-free JSON data', t => {
  const source = harden({
    type: 'object',
    properties: harden({
      count: harden({ type: 'number', minimum: 0 }),
      labels: harden({
        type: 'array',
        items: harden({ type: 'string' }),
      }),
    }),
    required: harden(['count']),
  });
  const projected = projectToolInputSchema(source);
  t.deepEqual(projected, source);
  t.not(projected, source);
  t.not(projected.properties, source.properties);
});

test('subagent tools appear only when the session was given a spawner', async t => {
  const powers = Far('SessionPowers', {
    list: async () => harden([]),
    lookup: async () => {
      throw Error('no stored tools');
    },
    locate: async () => undefined,
    listMessages: async () => harden([]),
  });
  const plain = await makeFlootToolRegistry(powers).snapshot();
  t.false(plain.names.includes('askSubagent'));
  t.true(plain.names.includes('describeCapability'));
  t.true(plain.names.includes('readSources'));
  await t.throwsAsync(
    () => plain.execute('list', harden({ path: 'invented' })),
    { message: /Unexpected argument/ },
  );

  const delegated = await makeFlootToolRegistry(powers, {
    spawner: Far('SubagentSpawner', {}),
    delegations: harden({
      claim: () => harden({}),
      ask: async () => harden({}),
    }),
  }).snapshot();
  t.deepEqual(
    ['askSubagent', 'spawnSubagent', 'stopSubagent'].filter(name =>
      delegated.names.includes(name),
    ),
    ['askSubagent', 'spawnSubagent', 'stopSubagent'],
  );
  // The catalog identity must change, so a hosted thread pinned without the
  // delegation tools cannot resume with them.
  t.not(plain.toolSetId, delegated.toolSetId);
});

test('accountStatus appears only when an oracle was endowed, and renders provenance', async t => {
  const powers = Far('SessionPowers', {
    list: async () => harden([]),
    lookup: async () => {
      throw Error('no stored tools');
    },
    locate: async () => undefined,
    listMessages: async () => harden([]),
  });
  const plain = await makeFlootToolRegistry(powers).snapshot();
  t.false(plain.names.includes('accountStatus'));

  const oracle = Far('HostedAccount', {
    getPlan: async () =>
      harden({
        providerId: 'anthropic',
        planId: 'max',
        title: 'Max',
        state: 'active',
        renewsAt: '',
        seats: null,
        observedAt: '2026-09-04T12:00:00.000Z',
        source: 'declared',
      }),
    getRateLimits: async () =>
      harden({
        windows: harden([
          harden({
            windowId: 'weekly',
            title: 'Weekly',
            limit: 1000n,
            used: 250n,
            remaining: 750n,
            usedFraction: 0.25,
            resetsAt: '',
          }),
        ]),
        observedAt: '2026-09-04T12:00:00.000Z',
        source: 'observed',
      }),
    getRateCard: async () =>
      harden({
        rates: harden([]),
        observedAt: '2026-09-04T12:00:00.000Z',
        source: 'unavailable',
      }),
    estimateCost: async () =>
      harden({
        modelId: 'm',
        currency: '',
        microUnits: 0n,
        display: '0.000000',
        missing: harden(['rate']),
        source: 'unavailable',
        observedAt: '2026-09-04T12:00:00.000Z',
      }),
    refresh: async () => undefined,
  });
  const withOracle = await makeFlootToolRegistry(powers, {
    accountOracle: oracle,
    getUsage: async () => harden({ inputTokens: 1200, outputTokens: 340 }),
    getModelId: () => 'm',
  }).snapshot();
  t.true(withOracle.names.includes('accountStatus'));
  t.not(plain.toolSetId, withOracle.toolSetId);

  const report = await withOracle.execute('accountStatus', harden({}));
  t.regex(report, /Plan: Max on anthropic/);
  t.regex(report, /declared by the operator/);
  t.regex(report, /750 of 1000 remaining \(25% used\)/);
  t.regex(report, /1200 input and 340 output tokens/);
  t.regex(report, /No list price is configured/);
});

test('a stored caplet tool is located with the path as separate name arguments', async t => {
  const stored = Far('FaeTool', {
    schema: () =>
      harden({
        type: 'function',
        function: {
          name: 'weather',
          description: 'Report the weather',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      }),
    execute: async () => 'sunny',
    help: () => 'weather',
  });
  const powers = Far('SessionPowers', {
    list: async directory => harden(directory === 'tools' ? ['weather'] : []),
    lookup: async path => {
      t.deepEqual(path, ['tools', 'weather'], 'lookup accepts a path array');
      return stored;
    },
    // The daemon's guard is `M.call().rest(NamePathShape)`, so an array
    // argument is rejected outright — unlike `lookup`. Enforce that here, or
    // the only session shape that exercises it (one with a caplet tool) goes
    // untested and every turn in such a session fails in production.
    locate: async (...path) => {
      t.deepEqual(path, ['tools', 'weather']);
      return 'endo://node/formula?type=lookup';
    },
    listMessages: async () => harden([]),
  });
  const snapshot = await makeFlootToolRegistry(powers).snapshot();
  t.true(snapshot.names.includes('weather'));
  t.true(snapshot.toolSetId.includes('endo://node/formula'));
  t.is(await snapshot.execute('weather', harden({})), 'sunny');
});

test('extra tools join the pinned catalog and cannot shadow a built-in', async t => {
  const powers = Far('Powers', {
    list: () => harden([]),
    locate: () => 'test-locator',
  });
  const extra = harden({
    schema: () =>
      harden({
        type: 'function',
        function: {
          name: 'attachContainerMount',
          description: 'bind a held capability under /mnt/',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      }),
    execute: async () => 'attached',
    help: () => 'attach',
  });
  const registry = makeFlootToolRegistry(powers, {
    extraTools: new Map([['attachContainerMount', extra]]),
  });
  const snapshot = await registry.snapshot();
  t.true(snapshot.names.includes('attachContainerMount'));
  t.is(await snapshot.execute('attachContainerMount', {}), 'attached');
  // The tool-set id pins the extras too: a hosted thread that resumed
  // without them would be resuming with different powers.
  const bare = await makeFlootToolRegistry(powers).snapshot();
  t.not(snapshot.toolSetId, bare.toolSetId);

  t.throws(
    () =>
      makeFlootToolRegistry(powers, {
        extraTools: new Map([['exec', extra]]),
      }),
    { message: /"exec" is already defined/ },
  );
});

test('all built-in argument envelopes are closed and validated before effects', async t => {
  const effects = [];
  const powers = Far('Powers', {
    list: () => harden([]),
    storeValue: (...args) => {
      effects.push(['storeValue', args]);
    },
    remove: (...args) => {
      effects.push(['remove', args]);
    },
    listMessages: () => {
      effects.push(['listMessages']);
      return harden([]);
    },
  });
  const snapshot = await makeFlootToolRegistry(powers).snapshot();
  for (const name of ['store', 'remove', 'listMessages']) {
    const descriptor = snapshot.dynamicTools.find(tool => tool.name === name);
    if (!descriptor) throw Error(`Missing tool ${name}`);
    t.is(descriptor.inputSchema.additionalProperties, false);
  }
  await t.throwsAsync(
    () =>
      snapshot.execute(
        'store',
        harden({ petName: 'note', value: 1, method: 'ignored' }),
      ),
    { message: /Unexpected argument "method"/ },
  );
  await t.throwsAsync(
    () =>
      snapshot.execute('remove', harden({ petName: 'note', path: 'ignored' })),
    { message: /Unexpected argument "path"/ },
  );
  await t.throwsAsync(
    () => snapshot.execute('listMessages', harden({ limit: 1 })),
    { message: /Unexpected argument "limit"/ },
  );
  t.deepEqual(effects, []);
  await snapshot.execute(
    'store',
    harden({ petName: 'note', value: { arbitraryValueKey: 1 } }),
  );
  t.deepEqual(effects, [['storeValue', [{ arbitraryValueKey: 1 }, 'note']]]);
});

test('open stored tool and factory-extra schemas remain open without re-reading schemas at dispatch', async t => {
  let schemaReads = 0;
  const makeOpenTool = name =>
    harden({
      schema: () => {
        schemaReads += 1;
        return harden({
          type: 'function',
          function: {
            name,
            description: 'Accept arbitrary JSON keys',
            parameters: {
              type: 'object',
              properties: {},
              additionalProperties: true,
            },
          },
        });
      },
      execute: async args => JSON.stringify(args),
      help: () => 'open',
    });
  const stored = makeOpenTool('stored');
  const powers = Far('Powers', {
    list: directory => harden(directory === 'tools' ? ['stored'] : []),
    lookup: () => stored,
    locate: () => 'stored-locator',
  });
  const snapshot = await makeFlootToolRegistry(powers, {
    extraTools: new Map([['extra', makeOpenTool('extra')]]),
  }).snapshot();
  const readsAtSnapshot = schemaReads;
  for (const name of ['stored', 'extra']) {
    const descriptor = snapshot.dynamicTools.find(tool => tool.name === name);
    if (!descriptor) throw Error(`Missing tool ${name}`);
    t.is(descriptor.inputSchema.additionalProperties, true);
    t.is(
      // eslint-disable-next-line no-await-in-loop
      await snapshot.execute(name, harden({ arbitrary: 'accepted' })),
      '{"arbitrary":"accepted"}',
    );
  }
  t.is(schemaReads, readsAtSnapshot);
});
