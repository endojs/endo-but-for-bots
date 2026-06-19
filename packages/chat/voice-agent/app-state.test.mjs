import '@endo/init';
import test from 'node:test'; import assert from 'node:assert/strict';
import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path';
import { makeAppStore } from './app-state.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'appstate-'));
const F = { bundle: path.join(tmp,'bundle.json'), memo: path.join(tmp,'memo.json'), seed: path.join(tmp,'seed.json'), feed: path.join(tmp,'feed.json') };
fs.writeFileSync(F.bundle, JSON.stringify({ chats:[{id:'chat-1',title:'New chat',ts:3000}], tx:{'chat-1':[{who:'you',text:'hello   world'},{who:'agent',text:'hi'}]}, updated:1 }));
fs.writeFileSync(F.memo, JSON.stringify({ runs:[{id:'memo-1',title:'voice memo',transcript:'plan my Berlin trip',date:'2026-06-15T20:00:00Z',versions:[{answer:'ok'}]}] }));
fs.writeFileSync(F.seed, JSON.stringify({ chats:[{id:'seed-1',title:'voice note',transcript:'call mom',ts:2000},{id:'chat-1',title:'voice note dup',transcript:'x',ts:3000}] }));
fs.writeFileSync(F.feed, JSON.stringify({ entries:[{},{}] }));
const store = makeAppStore({
  chatStorePath: () => F.bundle,
  readMemoRuns: async () => JSON.parse(fs.readFileSync(F.memo)).runs,
  writeMemoRuns: async r => fs.writeFileSync(F.memo, JSON.stringify({ runs:r })),
  readSeedChats: async () => JSON.parse(fs.readFileSync(F.seed)).chats,
  writeSeedChats: async c => fs.writeFileSync(F.seed, JSON.stringify({ chats:c })),
  readAsks: () => [{status:'open'},{status:'done'}],
  feedFile: F.feed,
});
const CAP='testcap';

test('listChats: unified, deduped (bundle wins over seed), sorted desc', async () => {
  const l = await store.listChats(CAP);
  assert.equal(l.length, 3, '3 conversations (chat-1, memo-1, seed-1) — chat-1 not duplicated from seeds');
  assert.equal(l.filter(x=>x.id==='chat-1').length, 1, 'chat-1 deduped');
  assert.deepEqual(new Set(l.map(x=>x.kind)), new Set(['chat','voice-memo','voice-note']));
  const ts = l.map(x=>x.ts); assert.deepEqual(ts, [...ts].sort((a,b)=>b-a), 'sorted by ts desc');
  assert.equal(l.find(x=>x.id==='chat-1').preview, 'hello world', 'preview collapses whitespace');
});
test('readChat: each kind + unknown', async () => {
  assert.equal((await store.readChat(CAP,'memo-1')).kind, 'voice-memo');
  assert.equal((await store.readChat(CAP,'chat-1')).kind, 'chat');
  assert.equal((await store.readChat(CAP,'seed-1')).kind, 'voice-note');
  assert.ok((await store.readChat(CAP,'nope')).error);
});
test('retitle: updates the right store(s) + bumps bundle.updated', async () => {
  const r1 = await store.retitle(CAP,'memo-1','Berlin trip planning');
  assert.ok(r1.ok && r1.updated.includes('voice-memo'));
  assert.equal(JSON.parse(fs.readFileSync(F.memo)).runs[0].title, 'Berlin trip planning');
  const before = JSON.parse(fs.readFileSync(F.bundle)).updated;
  const r2 = await store.retitle(CAP,'chat-1','Friendly greeting');
  assert.ok(r2.ok && r2.updated.includes('chat'), 'chat updated');
  const b = JSON.parse(fs.readFileSync(F.bundle));
  assert.equal(b.chats[0].title, 'Friendly greeting');
  assert.ok(b.updated > before, 'bundle.updated bumped so the client adopts');
  assert.ok((await store.retitle(CAP,'nope','x')).ok === false, 'unknown id → not ok');
  assert.ok((await store.retitle(CAP,'memo-1','')).ok === false, 'empty title rejected');
});
test('summary: counts across all stores', async () => {
  const s = await store.summary(CAP);
  assert.equal(s.chats, 1); assert.equal(s.voiceMemos, 1); assert.equal(s.voiceNotes, 2); assert.equal(s.openAsks, 1); assert.equal(s.feedItems, 2);
});
