// Protocol test for the postMessage cap channel. Uses a mock pair of browser-like
// MessagePorts (postMessage + onmessage/ev.data) so the dispatch/correlation/error logic
// is verified without a browser.
import test from 'node:test';
import assert from 'node:assert';
import { makeCapChannel } from './public/cap-channel.js';

const mkPair = () => {
  const a = { onmessage: null, postMessage: m => queueMicrotask(() => a._peer.onmessage && a._peer.onmessage({ data: structuredClone(m) })) };
  const b = { onmessage: null, postMessage: m => queueMicrotask(() => b._peer.onmessage && b._peer.onmessage({ data: structuredClone(m) })) };
  a._peer = b; b._peer = a;
  return [a, b];
};

test('remote method calls resolve across the channel', async () => {
  const [p1, p2] = mkPair();
  makeCapChannel(p2, { getTrace: () => [{ who: 'you', text: 'hi' }], add: (x, y) => x + y });
  const { remote } = makeCapChannel(p1, {});
  assert.deepEqual(await remote.getTrace(), [{ who: 'you', text: 'hi' }]);
  assert.equal(await remote.add(2, 5), 7);
});

test('errors propagate as rejections', async () => {
  const [p1, p2] = mkPair();
  makeCapChannel(p2, { boom: () => { throw new Error('nope'); } });
  const { remote } = makeCapChannel(p1, {});
  await assert.rejects(() => remote.boom(), /nope/);
});

test('unknown method rejects', async () => {
  const [p1, p2] = mkPair();
  makeCapChannel(p2, {});
  const { remote } = makeCapChannel(p1, {});
  await assert.rejects(() => remote.missing(), /no such method/);
});

test('channel is symmetric (both sides expose + call)', async () => {
  const [p1, p2] = mkPair();
  const parent = makeCapChannel(p1, { getTrace: () => ['T'] });      // parent exports chat
  const iframe = makeCapChannel(p2, { refresh: () => 'refreshed' }); // iframe exports refresh
  assert.deepEqual(await iframe.remote.getTrace(), ['T']);           // iframe calls parent's chat
  assert.equal(await parent.remote.refresh(), 'refreshed');          // parent calls iframe's refresh
});
