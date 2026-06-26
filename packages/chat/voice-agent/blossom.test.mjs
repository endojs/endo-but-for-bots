// blossom.test.mjs — unit coverage for the eager blossom engine (blossom.mjs).
import '@endo/init';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBlossom, sigOf } from './blossom.mjs';
import { makeForks } from './forks.mjs';
import { makePurse } from './purse.mjs';
import { makePurseStore } from './purse-store.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const setup = (opts = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blossom-'));
  const forks = makeForks({ file: path.join(dir, 'forks.json'), makePurse, purseStore: makePurseStore({ file: path.join(dir, 'purses.json'), debounceMs: 0 }) });
  const calls = [];
  const author = opts.author || (async a => { calls.push(a); return `(endowments, props) => endowments.h('div', null, 'rendered ' + (props.name||''))`; });
  const blossom = makeBlossom({ file: path.join(dir, 'blossom.json'), forks, authorRenderer: author, ...opts });
  return { dir, forks, blossom, calls };
};
const SEND_INBOX = ['inbox', 'send', 'describe'];

test('sigOf is order-independent + stable; different method-sets differ', () => {
  assert.equal(sigOf(['send', 'inbox', 'describe']), sigOf(['describe', 'inbox', 'send']), 'order-independent');
  assert.equal(sigOf([{ name: 'a' }, 'b']), sigOf(['b', 'a']), 'accepts string or {name}');
  assert.notEqual(sigOf(['a', 'b']), sigOf(['a', 'b', 'c']), 'a different interface → a different signature');
  assert.equal(sigOf([]), 'sig-empty');
});

test('sigOf incorporates the KIND so methodless leaves get distinct, shared renderers', () => {
  assert.equal(sigOf([], 'contact'), sigOf([], 'contact'), 'same kind → same sig (all contacts share a renderer)');
  assert.notEqual(sigOf([], 'contact'), sigOf([], 'agent'), 'different kinds differ');
  assert.notEqual(sigOf([], 'contact'), 'sig-empty', 'a kind ALONE (no methods) keys a renderer');
  assert.equal(sigOf([], ''), 'sig-empty', 'no kind + no methods = empty');
  assert.notEqual(sigOf(['send'], 'object'), sigOf(['send'], 'peer'), 'kind also distinguishes method-bearing objects');
});

test('ensure blossoms a NEW interface once → ready, with a renderer fork', async () => {
  const { blossom, calls, forks } = setup();
  const e = await blossom.ensure({ methods: SEND_INBOX, objectName: 'Kumavis', sample: { kind: 'peer' }, owner: 'root' });
  assert.equal(e.status, 'blossoming', 'returns immediately as blossoming (fire-and-forget)');
  await sleep(60);
  const r = blossom.rendererFor(SEND_INBOX);
  assert.equal(r.status, 'ready', 'becomes ready after authoring');
  assert.ok(r.forkId, 'has a renderer fork id');
  assert.equal(calls.length, 1, 'the author ran exactly once');
  assert.ok(forks.read(r.forkId, 'root').source.includes('endowments.h'), 'the fork holds the authored renderer source');
});

test('a SECOND sighting of the same interface re-uses the renderer — never re-fires', async () => {
  const { blossom, calls } = setup();
  await blossom.ensure({ methods: SEND_INBOX, objectName: 'Kumavis' }); await sleep(60);
  const again = await blossom.ensure({ methods: ['describe', 'send', 'inbox'], objectName: 'AnotherPeer' });
  assert.equal(again.status, 'ready', 'same signature → the existing renderer');
  assert.equal(calls.length, 1, 'the author did NOT run again (de-dup by interface)');
});

test('concurrent sightings of the same NEW interface blossom ONCE (the in-flight lock)', async () => {
  let resolveAuthor; let authorCalls = 0; const author = () => { authorCalls += 1; return new Promise(res => { resolveAuthor = res; }); };
  const { blossom } = setup({ author });
  const [a, b, c] = await Promise.all([
    blossom.ensure({ methods: SEND_INBOX, objectName: 'X' }),
    blossom.ensure({ methods: SEND_INBOX, objectName: 'X' }),
    blossom.ensure({ methods: SEND_INBOX, objectName: 'X' }),
  ]);
  assert.equal(authorCalls, 1, 'only ONE author call despite 3 concurrent sightings');
  assert.ok([a, b, c].every(x => x.status === 'blossoming'), 'all three see blossoming');
  resolveAuthor('(e,p)=>e.h("div",null,"ok")'); await sleep(40);
  assert.equal(blossom.rendererFor(SEND_INBOX).status, 'ready', 'resolves to ready once');
});

test('MAX_CONCURRENT caps simultaneous blossoms; MAX_TOTAL caps lifetime', async () => {
  let resolvers = []; const author = () => new Promise(res => resolvers.push(res));
  const { blossom } = setup({ author, maxConcurrent: 1 });
  const a = await blossom.ensure({ methods: ['m1'], objectName: 'A' });
  const b = await blossom.ensure({ methods: ['m2'], objectName: 'B' });
  assert.equal(a.status, 'blossoming');
  assert.equal(b.status, 'queued', 'a second DIFFERENT interface is queued while one is in flight (maxConcurrent=1)');
  resolvers.forEach(r => r('(e,p)=>e.h("div")')); await sleep(40);

  const tiny = setup({ maxTotal: 1 });
  await tiny.blossom.ensure({ methods: ['x'], objectName: 'X' }); await sleep(40);
  const over = await tiny.blossom.ensure({ methods: ['y'], objectName: 'Y' });
  assert.equal(over.status, 'budget-exhausted', 'the lifetime budget caps total blossoms');
});

test('a failing author records failed (not stuck blossoming) + can be forgotten to retry', async () => {
  const { blossom } = setup({ author: async () => { throw new Error('llm down'); } });
  await blossom.ensure({ methods: ['z'], objectName: 'Z' }); await sleep(50);
  const r = blossom.rendererFor(['z']);
  assert.equal(r.status, 'failed', 'records failed');
  assert.match(r.error, /llm down/);
  assert.ok(blossom.forget(r.sig), 'a failed renderer can be forgotten so it re-blossoms');
  assert.equal(blossom.rendererFor(['z']), null, 'gone after forget');
});

test('an object with NO methods cannot be keyed (no-interface)', async () => {
  const { blossom } = setup();
  const e = await blossom.ensure({ methods: [], objectName: 'opaque' });
  assert.equal(e.status, 'no-interface');
});
