// cap-channel.test.mjs — the CapTP-over-postMessage channel D3 rests on. node --test cap-channel.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCapChannel } from './cap-channel.js';

// a mock MessagePort pair with the web interface (onmessage / postMessage / start) cap-channel uses.
const mkPair = () => {
  const a = { onmessage: null, start() {}, postMessage: m => queueMicrotask(() => b.onmessage && b.onmessage({ data: m })) };
  const b = { onmessage: null, start() {}, postMessage: m => queueMicrotask(() => a.onmessage && a.onmessage({ data: m })) };
  return [a, b];
};

test('remote method call returns the result across the channel', async () => {
  const [p1, p2] = mkPair();
  makeCapChannel(p1, { add: (x, y) => x + y, hi: () => 'hello' }); // host bootstrap
  const { remote } = makeCapChannel(p2, {});                       // guest proxy
  assert.equal(await remote.add(2, 3), 5);
  assert.equal(await remote.hi(), 'hello');
});

test('errors propagate (rejection), not silent', async () => {
  const [p1, p2] = mkPair();
  makeCapChannel(p1, { boom: () => { throw new Error('kaboom'); } });
  const { remote } = makeCapChannel(p2, {});
  await assert.rejects(() => remote.boom(), /kaboom/);
});

test('unknown method rejects (the iframe can only reach the bootstrap it was handed)', async () => {
  const [p1, p2] = mkPair();
  makeCapChannel(p1, { onlyThis: () => 1 });
  const { remote } = makeCapChannel(p2, {});
  await assert.rejects(() => remote.notGranted(), /no such method/);
});

test('bidirectional — each side can call the other', async () => {
  const [p1, p2] = mkPair();
  const hostRemote = makeCapChannel(p1, { fromHost: () => 'H' }).remote;
  const guestRemote = makeCapChannel(p2, { fromGuest: () => 'G' }).remote;
  assert.equal(await guestRemote.fromHost(), 'H');
  assert.equal(await hostRemote.fromGuest(), 'G');
});
