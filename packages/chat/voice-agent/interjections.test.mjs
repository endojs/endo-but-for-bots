// interjections.test.mjs — mid-turn re-steer (the /chat/interject feature). Proves the per-turn queue
// (push / take-DRAINS-once / drop) AND that CodeMode folds a queued interjection into the model's context at
// the NEXT step boundary, exactly once — with a fake llm + a real store, so it's fully deterministic.
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeInterjections } from './interjections.mjs';
import { runAgentCode } from '../../ocapn-noise/codemode.mjs';

test('interjections store: push, take DRAINS once-only, drop clears', () => {
  const q = makeInterjections();
  assert.equal(q.push('s', 'a'), true);
  assert.equal(q.push('s', 'b'), true);
  assert.equal(q.push('s', '   '), false, 'empty text is ignored');
  assert.equal(q.pending('s'), 2);
  assert.deepEqual(q.take('s'), ['a', 'b'], 'take drains everything queued for the turn');
  assert.deepEqual(q.take('s'), [], 'a second take is empty — once-only delivery');
  q.push('s', 'c'); q.drop('s');
  assert.deepEqual(q.take('s'), [], 'drop clears the queue (drop-on-turn-end)');
});

test('CodeMode folds a mid-turn interjection at the next step boundary, exactly once', async () => {
  const q = makeInterjections(); const sid = 's1';
  const snaps = []; let n = 0;
  const llm = async messages => { snaps.push(messages.map(m => `${m.role}:${m.content}`).join('\n')); n += 1; return { text: n === 1 ? '```js\nawait postNow({});\n```' : 'done', usage: null }; };
  // round 1's program simulates the user POSTing /chat/interject DURING round 1
  const toolbox = { postNow: { run: async () => { q.push(sid, 'steer toward X'); return { ok: true }; } } };
  const manifest = [{ name: 'postNow', description: 'queues an interjection (stands in for a POST /chat/interject)', args: {} }];
  const r = await runAgentCode({ toolbox, manifest, userText: 'go', llm, takeInterjections: () => q.take(sid) });
  assert.equal(r.answer, 'done');
  assert.ok(snaps.length >= 2, 'ran at least two rounds');
  assert.ok(!/steer toward X/.test(snaps[0]), 'round 1 did NOT see the interjection (it was posted after round 1)');
  assert.match(snaps[1], /steer toward X/, 'round 2 folded the interjection into context at the step boundary');
  assert.equal(q.pending(sid), 0, 'drained once-only — not re-delivered on later rounds');
});

test('no interjections → CodeMode behaviour is unchanged (default no-op taker)', async () => {
  let n = 0;
  const llm = async () => { n += 1; return { text: 'hi', usage: null }; };
  const r = await runAgentCode({ toolbox: {}, manifest: [], userText: 'hi', llm }); // no takeInterjections → default () => []
  assert.equal(r.answer, 'hi');
});
