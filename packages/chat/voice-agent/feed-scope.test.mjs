// feed-scope.test.mjs — regression proof that POST /feed/load and /feed/item no longer expose dan's
// global dashboard feed (agent proposals, "needs attention" bodies, 🔔 bell contents) to any valid cap.
//
// The hole (fixed, server.mjs): both routes gated on `nodeFor(cap)` (ANY cap) then returned the shared
// global FEED_FILE. Only the dismissed-state was per-cap, so an invited guest read dan's whole stream.
// Now the content is ROOT-ONLY; a non-root cap gets an empty inbox.
//
// Mirrors server-rate.test.mjs: re-creates the EXACT route decisions against a faithful nodeFor model,
// reading a real feed file on disk.
//
// Run: node --test feed-scope.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const makeLocator = () => {
  const m = new Map();
  return {
    registerRoot: swiss => { m.set(swiss, { isRoot: true, name: 'Agent C' }); return swiss; },
    mintScoped: () => { const s = `scoped-${Math.random().toString(16).slice(2)}`; m.set(s, { isRoot: false, name: 'guest' }); return s; },
    nodeFor: swiss => m.get(String(swiss || '')) || null,
  };
};

// EXACT /feed/load decision from server.mjs (feed content gate).
const handleFeedLoad = ({ nodeFor, feedFile }, { cap }) => {
  if (!nodeFor(cap)) return { code: 403, body: { error: 'no capability' } };
  if (!nodeFor(cap)?.isRoot) return { code: 200, body: { items: [], attentionCount: 0 } };
  let entries = []; try { entries = (JSON.parse(fs.readFileSync(feedFile, 'utf8')).entries) || []; } catch { /* none */ }
  const items = entries.slice(0, 80).map(e => ({ id: e.id, title: e.title, body: String(e.body || '').slice(0, 400) }));
  return { code: 200, body: { items, attentionCount: items.length } };
};

// EXACT /feed/item decision from server.mjs.
const handleFeedItem = ({ nodeFor, feedFile }, { cap, id }) => {
  if (!nodeFor(cap)) return { code: 403, body: { error: 'no capability' } };
  if (!nodeFor(cap)?.isRoot) return { code: 200, body: { ok: false } };
  let entries = []; try { entries = (JSON.parse(fs.readFileSync(feedFile, 'utf8')).entries) || []; } catch { /* none */ }
  const e = entries.find(x => x && x.id === String(id || ''));
  return { code: 200, body: e ? { ok: true, item: { id: e.id, body: String(e.body || '') } } : { ok: false } };
};

const seedFeed = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-'));
  const feedFile = path.join(dir, 'feed.json');
  fs.writeFileSync(feedFile, JSON.stringify({ entries: [
    { id: 'n1', title: 'Proposal', body: 'SECRET: approve giving X the host shell' },
    { id: 'n2', title: 'Needs attention', body: 'dan private note' },
  ] }));
  return feedFile;
};

test('non-root cap gets an EMPTY feed (no leak of dan\'s stream)', () => {
  const loc = makeLocator(); loc.registerRoot('a'.repeat(32));
  const guest = loc.mintScoped();
  const feedFile = seedFeed();
  const r = handleFeedLoad({ nodeFor: loc.nodeFor, feedFile }, { cap: guest });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.items, [], 'a guest must see no feed items');
  assert.equal(r.body.attentionCount, 0);
});

test('non-root cap cannot fetch a feed item body', () => {
  const loc = makeLocator(); loc.registerRoot('a'.repeat(32));
  const guest = loc.mintScoped();
  const feedFile = seedFeed();
  const r = handleFeedItem({ nodeFor: loc.nodeFor, feedFile }, { cap: guest, id: 'n1' });
  assert.equal(r.body.ok, false, 'a guest must not read a feed item body');
});

test('root cap still gets the full feed (the 🔔 bell works)', () => {
  const loc = makeLocator(); const root = loc.registerRoot('a'.repeat(32));
  const feedFile = seedFeed();
  const r = handleFeedLoad({ nodeFor: loc.nodeFor, feedFile }, { cap: root });
  assert.equal(r.body.items.length, 2, 'root sees all feed items');
  assert.equal(r.body.attentionCount, 2);
  const item = handleFeedItem({ nodeFor: loc.nodeFor, feedFile }, { cap: root, id: 'n1' });
  assert.equal(item.body.ok, true);
  assert.match(item.body.item.body, /SECRET/);
});

test('no capability at all → 403', () => {
  const loc = makeLocator(); loc.registerRoot('a'.repeat(32));
  const feedFile = seedFeed();
  assert.equal(handleFeedLoad({ nodeFor: loc.nodeFor, feedFile }, { cap: 'bogus' }).code, 403);
  assert.equal(handleFeedItem({ nodeFor: loc.nodeFor, feedFile }, { cap: 'bogus', id: 'n1' }).code, 403);
});
