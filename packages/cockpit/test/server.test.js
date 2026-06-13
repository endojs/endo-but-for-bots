// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeCockpit, buildMockCaps } from '../src/index.js';
import { makeCockpitServer } from '../src/backend/server.js';

test('end-to-end: ws hello + steer streams the branch back', async () => {
  const cockpit = makeCockpit();
  const tracer = cockpit.registry.create({
    templateName: 'tracer',
    caps: buildMockCaps([{ name: 'git', kind: 'git', mode: 'readOnly' }]),
  });
  const server = makeCockpitServer(cockpit);
  await new Promise(resolve => server.listen(0, () => resolve(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());

  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const toolResult = new Promise((resolve, reject) => {
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.type === 'thread-event' && m.event.kind === 'tool-result') resolve(m);
    });
    ws.addEventListener('error', () => reject(new Error('ws error')));
  });
  await new Promise(resolve => ws.addEventListener('open', () => resolve(undefined)));
  ws.send(JSON.stringify({ type: 'hello' }));
  ws.send(JSON.stringify({ type: 'steer', threadId: tracer.id, text: 'what branch?' }));

  const result = /** @type {any} */ (await toolResult);
  assert.equal(result.event.data, 'current branch: main');

  ws.close();
  await /** @type {any} */ (server).shutdown();
});
