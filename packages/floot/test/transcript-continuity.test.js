// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';

import { makeFlootToolRegistry } from '../src/tool-registry.js';

test('extra tools join the session catalog beside the built-ins', async t => {
  const powers = Far('SessionPowers', {
    has: () => false,
    list: async () => harden([]),
    lookup: async () => {
      throw Error('no stored tools');
    },
  });
  const publish = harden({
    schema: () =>
      harden({
        type: 'function',
        function: {
          name: 'publishWorkspace',
          description: 'publish',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      }),
    execute: async () => 'http://host/token/',
    help: () => 'publish',
  });
  const registry = makeFlootToolRegistry(powers, {
    extraTools: new Map([['publishWorkspace', publish]]),
  });
  const snapshot = await registry.snapshot();
  t.true(snapshot.names.includes('publishWorkspace'));
  t.true(snapshot.names.includes('exec'));
  t.is(await snapshot.execute('publishWorkspace', {}), 'http://host/token/');
  const without = await makeFlootToolRegistry(powers).snapshot();
  t.false(without.names.includes('publishWorkspace'));
});
