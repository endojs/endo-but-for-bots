// stories.test.mjs — the 🪄 Magic Stories store: the MANDATORY sanitizer + the publish GATE.
//   node --test stories.test.mjs
// The load-bearing property (these are SHAREABLE showcase artifacts): a PUBLISHED story is provably free of
// identity shapes — planted caps/emails/handles/swissnums are stripped before persistence, and a story that
// still carries any identity shape CANNOT be published.
import '@endo/init';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
// point the store at a throwaway file BEFORE importing (the module reads the env per call).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stories-test-'));
process.env.STORIES_STORE = path.join(tmp, 'stories.json');
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
const { addCandidate, listStories, listPublished, listCandidates, publishStory, discardStory, sanitizeStory, findIdentityLeaks, storiesFile } = await import('./stories.mjs');
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

// a flow shape (trace snapshot) with identity planted at every level: prompt, a step name, a step's granted
// list, a nested child, and a node label.
const plantedFlow = () => ({
  status: 'done',
  prompt: 'help dan@example.com share their rover — cap #cap=deadbeefdeadbeefdeadbeef1234',
  steps: [
    { name: 'delegate to @alice_operator', ok: true, status: 'done', granted: ['rover'],
      children: [{ name: 'call +1 (415) 555-0199', detail: 'swiss 0123456789abcdef0123456789abcdef' }] },
    { name: 'compose', ok: true, status: 'done', granted: ['agent'] },
  ],
  nodes: [{ key: 'root', state: 'done', label: 'from bob@corp.io' }],
});

test('sanitizeStory launders identity at every level of the flow (title/why/flow)', () => {
  const clean = sanitizeStory({
    title: 'dan@example.com shared a rover',
    why: 'contact @alice_operator at 415-555-0199',
    quality: 'composition',
    flow: plantedFlow(),
  });
  const blob = JSON.stringify(clean);
  assert.ok(!/dan@example\.com/.test(blob), 'email stripped');
  assert.ok(!/bob@corp\.io/.test(blob), 'nested email stripped');
  assert.ok(!/@alice_operator/.test(blob), 'social handle stripped');
  assert.ok(!/#cap=deadbeef/.test(blob), 'cap link stripped');
  assert.ok(!/deadbeefdeadbeefdeadbeef1234/.test(blob), 'cap swissnum stripped');
  assert.ok(!/0123456789abcdef0123456789abcdef/.test(blob), 'hex swissnum stripped');
  assert.ok(!/555-0199/.test(blob), 'phone stripped');
  // structure survives: the ocap SHAPE (granted edges, composition) is preserved.
  assert.equal(clean.flow.steps.length, 2);
  assert.deepEqual(clean.flow.steps[0].granted, ['rover']);
  assert.equal(clean.quality, 'composition');
});

test('findIdentityLeaks: clean of an all-planted flow, and finds every shape in a raw one', () => {
  assert.deepEqual(findIdentityLeaks(sanitizeStory({ title: 'x', flow: plantedFlow() })), []);
  const leaks = findIdentityLeaks({ title: 'dan@example.com', why: 'ping @alice_operator', flow: { s: '#cap=abcdef012345abcdef012345' } });
  const kinds = new Set(leaks.map(l => l.kind));
  assert.ok(kinds.has('email') && kinds.has('handle') && kinds.has('cap-link'), `kinds=${[...kinds]}`);
});

test('addCandidate sanitizes on write; the stored candidate is provably clean', () => {
  const r = addCandidate({ title: 'A person shared their rover with dan@example.com', why: 'composed with @alice_operator', quality: 'multi-hop-delegation', flow: plantedFlow(), by: 'root' });
  assert.ok(r.ok, r.error);
  assert.ok(r.scrubbed >= 3, `expected the sanitizer to have removed several shapes, scrubbed=${r.scrubbed}`);
  const cand = listCandidates().find(c => c.id === r.id);
  assert.ok(cand, 'candidate is listed');
  assert.equal(cand.status, 'candidate');
  assert.deepEqual(findIdentityLeaks(cand), [], 'stored candidate has NO identity leaks');
  assert.ok(!listPublished().some(p => p.id === r.id), 'not published until reviewed');
});

test('publish GATE: a sanitized candidate publishes; a NON-sanitized story CANNOT', () => {
  // happy path: a sanitized candidate → published.
  const ok = addCandidate({ title: 'Composition win', why: 'a device + an agent = something neither had', quality: 'composition', flow: plantedFlow() });
  const pub = publishStory(ok.id);
  assert.ok(pub.ok, `sanitized candidate should publish: ${JSON.stringify(pub)}`);
  assert.ok(listPublished().some(p => p.id === ok.id), 'appears in the gallery (published)');

  // adversarial path: a raw story with a planted cap is written DIRECTLY to the store (bypassing addCandidate's
  // sanitize) — publish must REFUSE it, listing the leak. This is the invariant the gallery relies on.
  const raw = JSON.parse(fs.readFileSync(storiesFile(), 'utf8'));
  raw.items.push({ id: 'story-raw-leak', title: 'leaky', why: 'holds a #cap=cafebabecafebabecafebabe0001 and email evil@x.com', quality: 'other', flow: null, status: 'candidate', addedAt: new Date().toISOString() });
  fs.writeFileSync(storiesFile(), JSON.stringify(raw));
  const refused = publishStory('story-raw-leak');
  assert.equal(refused.ok, false, 'must refuse to publish an un-sanitized story');
  assert.ok(refused.leaks.length >= 1, 'the refusal lists the leaks it caught');
  assert.ok(!listPublished().some(p => p.id === 'story-raw-leak'), 'the leaky story never reaches the gallery');
});

test('discardStory removes a candidate', () => {
  const r = addCandidate({ title: 'to be discarded', flow: null });
  assert.ok(listStories().some(s => s.id === r.id));
  assert.ok(discardStory(r.id).ok);
  assert.ok(!listStories().some(s => s.id === r.id));
});
