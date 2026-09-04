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
