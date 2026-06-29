// buffer-caps.test.mjs — the Buffer cap against a fake GraphQL endpoint: the affordances map to Buffer ops, and
// attenuation (channels × publish/delete/write) only ever REMOVES authority. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBuffer } from './buffer-caps.mjs';

const CH = [
  { id: 'ch_bsky', service: 'bluesky', name: 'Dan', displayName: 'Dan', isDisconnected: false },
  { id: 'ch_tw', service: 'twitter', name: 'danfinlay', displayName: 'danfinlay', isDisconnected: false },
];
// a fake api.buffer.com: routes by the operation name in the query string
const fakeFetch = (calls = []) => async (url, init) => {
  const body = JSON.parse(init.body); const q = body.query; calls.push({ q, vars: body.variables, auth: init.headers.authorization });
  const data = q.includes('organizations') ? { account: { organizations: [{ id: 'org1', name: 'My Org' }] } }
    : q.includes('channels(') ? { channels: CH }
    : q.includes('posts(') ? { posts: { edges: [{ node: { id: 'p1', text: 'hi', status: 'scheduled', channelId: 'ch_tw' } }], pageInfo: {} } }
    : q.includes('post(') ? { post: { id: body.variables.input.id, channelId: 'ch_tw', status: 'scheduled' } }
    : q.includes('createPost') ? { createPost: { post: { id: 'new1', text: body.variables.input.text, status: body.variables.input.saveToDraft ? 'draft' : 'scheduled', channelId: body.variables.input.channelId } } }
    : q.includes('deletePost') ? { deletePost: { id: body.variables.input.id } }
    : {};
  return { ok: true, status: 200, json: async () => ({ data }) };
};

const mk = (bound, calls) => makeBuffer({ getToken: () => 'TKN', fetchImpl: fakeFetch(calls), bound });

test('token rides the Authorization header, never argv/return', async () => {
  const calls = []; const b = mk(undefined, calls);
  await b.channels();
  assert.ok(calls.every(c => c.auth === 'Bearer TKN'));
  assert.ok(!JSON.stringify(b.rights()).includes('TKN'), 'token not exposed in rights()');
});

test('channels: full cap sees all; bound cap sees only its channels', async () => {
  assert.equal((await mk().channels()).length, 2);
  const bound = mk({ channels: ['ch_tw'] });
  const seen = await bound.channels();
  assert.deepEqual(seen.map(c => c.id), ['ch_tw'], 'bound cap only sees its channel');
});

test('createPost: full cap publishes; modes pass through', async () => {
  const calls = []; const b = mk(undefined, calls);
  const p = await b.createPost({ channelId: 'ch_tw', text: 'hello', mode: 'shareNow' });
  assert.equal(p.status, 'scheduled');
  assert.equal(calls.at(-1).vars.input.mode, 'shareNow');
});

test('draft cap: may saveToDraft, may NOT publish', async () => {
  const b = mk({ publish: false });
  const d = await b.createPost({ channelId: 'ch_tw', text: 'x', draft: true });
  assert.equal(d.status, 'draft');
  await assert.rejects(() => b.createPost({ channelId: 'ch_tw', text: 'x' }), /draft-only/);
});

test('read-only cap: every write refuses', async () => {
  const b = mk({ write: false });
  await assert.doesNotReject(() => b.channels());
  await assert.rejects(() => b.createPost({ channelId: 'ch_tw', text: 'x', draft: true }), /read-only/);
  await assert.rejects(() => b.deletePost('p1'), /read-only/);
});

test('channel-bound cap: cannot touch another channel', async () => {
  const b = mk({ channels: ['ch_tw'] });
  await assert.doesNotReject(() => b.createPost({ channelId: 'ch_tw', text: 'ok' }));
  await assert.rejects(() => b.createPost({ channelId: 'ch_bsky', text: 'no' }), /not authorized for channel/);
});

test('no-delete cap: delete refuses, write still works', async () => {
  const b = mk({ del: false });
  await assert.rejects(() => b.deletePost('p1'), /may not delete/);
  await assert.doesNotReject(() => b.createPost({ channelId: 'ch_tw', text: 'ok' }));
});

test('attenuation is monotonic: restrict only removes authority', async () => {
  const b = mk();
  const sub = b.restrict({ channels: ['ch_tw'], publish: false });
  assert.deepEqual(sub.rights(), { channels: ['ch_tw'], publish: false, del: true, write: true });
  // a sub-cap cannot re-grant publish, nor widen channels
  assert.equal(sub.restrict({ publish: true }).rights().publish, false);
  assert.deepEqual(sub.restrict({ channels: ['ch_bsky'] }).rights().channels, []);
});
