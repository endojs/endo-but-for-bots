// chat-corpus.test.mjs — the sanitizer (hex/eth-address/email/phone), the size clamp, and
// the corpus reader (cross-store listing + sanitized reads). Run: node --test chat-corpus.test.mjs
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { makeSanitizer, clampMiddle, listAllChats, readChatSanitized } from './chat-corpus.mjs';

test('sanitizer launders emails to stable placeholders', () => {
  const s = makeSanitizer();
  const out = s('mail dan@example.com and again dan@example.com plus other@foo.org');
  assert.ok(!out.includes('dan@example.com'));
  assert.ok(!out.includes('other@foo.org'));
  assert.ok(out.includes('<email-1>'));
  assert.ok(out.includes('<email-2>'));
  // stability: the SAME address maps to the SAME placeholder
  assert.equal((out.match(/<email-1>/g) || []).length, 2);
});

test('sanitizer launders 16+ char hex runs (swissnums) and eth addresses', () => {
  const s = makeSanitizer();
  const swiss = 'a4f54167deadbeefcafe4848a4f54167';
  const eth = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
  const out = s(`cap #${swiss} pays to ${eth}, short hex abc123 stays`);
  assert.ok(!out.includes(swiss), 'swissnum must not survive');
  assert.ok(!out.toLowerCase().includes(eth.toLowerCase().slice(2)), 'eth address must not survive');
  assert.ok(out.includes('abc123'), 'short hex (<16) is left alone');
  // cap-hygiene invariant: NO raw hex run of 16+ chars in the output
  assert.equal(/[0-9a-fA-F]{16,}/.test(out), false);
});

test('sanitizer launders phone numbers', () => {
  const s = makeSanitizer();
  const out = s('call me at +1 555-867-5309 or (415) 555-2671');
  assert.ok(!out.includes('867-5309'));
  assert.ok(!out.includes('555-2671'));
  assert.ok(/<(phone|hex)-\d+>/.test(out));
});

test('clampMiddle keeps head+tail and cuts the middle', () => {
  const text = `GOAL:${'x'.repeat(20000)}OUTCOME`;
  const out = clampMiddle(text, 8000);
  assert.ok(out.length <= 8000 + 64, `clamped length ${out.length}`);
  assert.ok(out.startsWith('GOAL:'), 'head (the goal) survives');
  assert.ok(out.endsWith('OUTCOME'), 'tail (the outcome) survives');
  assert.ok(out.includes('chars truncated'), 'truncation is marked');
  // under the limit → untouched
  assert.equal(clampMiddle('short', 8000), 'short');
});

// ── the corpus reader against a fake CHATS_DIR of two store files ──
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-corpus-'));
fs.writeFileSync(path.join(dir, 'store-a.json'), JSON.stringify({
  chats: [{ id: 'chat-1', title: 'Trip email dan@example.com', ts: 3000 }, { id: 'chat-gone', title: 'deleted', ts: 2500 }],
  deleted: ['chat-gone'],
  tx: { 'chat-1': [{ who: 'you', text: 'plan a trip, mail dan@example.com, cap deadbeefdeadbeefdeadbeef' }, { who: 'agent', text: 'done' }] },
}));
fs.writeFileSync(path.join(dir, 'store-b.json'), JSON.stringify({
  chats: [{ id: 'chat-2', title: 'other cap store', ts: 4000 }],
  tx: { 'chat-2': [{ who: 'you', text: 'hi' }] },
}));
fs.writeFileSync(path.join(dir, 'broken.json'), '{not json');

test('listAllChats spans ALL store files, skips deleted, newest first', () => {
  const all = listAllChats({ dir });
  assert.deepEqual(all.map(c => c.id), ['chat-2', 'chat-1']);
  assert.equal(all.find(c => c.id === 'chat-1').msgCount, 2);
  assert.ok(!all.some(c => c.id === 'chat-gone'));
});

test('readChatSanitized launders the transcript + title and clamps', () => {
  const r = readChatSanitized({ id: 'chat-1', dir });
  assert.equal(r.ok, true);
  assert.equal(r.msgCount, 2);
  assert.ok(!r.transcript.includes('dan@example.com'));
  assert.ok(!r.transcript.includes('deadbeefdeadbeefdeadbeef'));
  assert.ok(!r.title.includes('dan@example.com'));
  assert.ok(r.transcript.includes('you:'), 'transcript keeps speaker labels');
  assert.equal(/[0-9a-fA-F]{16,}/.test(r.transcript), false, 'no raw 16+ hex leaves the reader');
  // clamp is enforced by the reader itself
  const clamped = readChatSanitized({ id: 'chat-1', dir, maxChars: 200 });
  assert.ok(clamped.transcript.length <= 264);
  assert.equal(clamped.truncated, false); // this transcript is short — not truncated at 200? verify below
});

test('readChatSanitized truncated flag + unknown id', () => {
  const big = { chats: [{ id: 'chat-big', title: 'big', ts: 1 }], tx: { 'chat-big': [{ who: 'you', text: 'y'.repeat(20000) }] } };
  fs.writeFileSync(path.join(dir, 'store-c.json'), JSON.stringify(big));
  const r = readChatSanitized({ id: 'chat-big', dir, maxChars: 1000 });
  assert.equal(r.truncated, true);
  assert.ok(r.transcript.length <= 1064);
  const miss = readChatSanitized({ id: 'nope', dir });
  assert.equal(miss.ok, false);
});
