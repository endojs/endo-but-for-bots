// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';

import {
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
