// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { makeCockpit } from '../src/index.js';
import { makeMessageHandler } from '../src/backend/server.js';

const setup = () => {
  const cockpit = makeCockpit();
  const sent = [];
  const bcast = [];
  const handler = makeMessageHandler(
    cockpit,
    o => sent.push(o),
    o => bcast.push(o),
  );
  return { cockpit, sent, bcast, handler };
};

test('new-thread then spawn builds a tree over the wire', async t => {
  const { cockpit, handler } = setup();
  await handler(
    JSON.stringify({
      type: 'new-thread',
      caps: [{ name: 'git', kind: 'git', mode: 'readWrite' }],
      prompt: 'what branch?',
    }),
  );
  const root = cockpit.registry.ids()[0];
  await handler(
    JSON.stringify({
      type: 'spawn',
      parentId: root,
      caps: [{ name: 'git', kind: 'git', mode: 'readOnly' }],
      prompt: 'inspect',
    }),
  );
  const tree = cockpit.registry.tree();
  t.is(tree.length, 1);
  t.is(tree[0].children.length, 1);
});

test('a spawn that upgrades authority is rejected over the wire', async t => {
  const { cockpit, sent, handler } = setup();
  await handler(
    JSON.stringify({
      type: 'new-thread',
      caps: [{ name: 'git', kind: 'git', mode: 'readOnly' }],
    }),
  );
  const root = cockpit.registry.ids()[0];
  await handler(
    JSON.stringify({
      type: 'spawn',
      parentId: root,
      caps: [{ name: 'git', kind: 'git', mode: 'readWrite' }],
    }),
  );
  t.true(
    sent.some(m => m.type === 'error' && /cannot upgrade/.test(m.message)),
  );
});

test('invalid json yields an error reply, not a crash', async t => {
  const { sent, handler } = setup();
  await handler('{not json');
  t.true(sent.some(m => m.type === 'error'));
});
