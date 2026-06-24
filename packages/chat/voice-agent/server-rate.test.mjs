// server-rate.test.mjs — proves the contract of POST /eval/rate (server.mjs):
//   • a ROOT cap → a rating record LANDS ON DISK at <dir>/<chatId>.json, written mode 0600;
//   • a NON-ROOT (attenuated/scoped) cap is REFUSED (the gate nodeFor(cap)?.isRoot is false) → nothing written;
//   • an unknown cap is refused; a traversal chatId / out-of-range rating is rejected by the helper.
//
// The route delegates its on-disk write to the shared ./eval-ratings.mjs helper, which this test drives
// directly, and re-creates the route's cap-gating against a faithful nodeFor model (root → isRoot:true,
// scoped cap → a real node with isRoot:false, unknown swiss → null) — exactly the locator semantics in
// agent-caps.mjs (makeAgentNode sets isRoot; nodeFor returns the node or null). We model nodeFor here
// rather than importing makeFieldAgent so the suite stays self-contained and isn't coupled to that
// module's unrelated optional deps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeRating, readRating, ratingsDir } from './eval-ratings.mjs';

// A faithful stand-in for the field agent's cap locator: a swiss → node (or null). Root nodes carry
// isRoot:true; scoped chat caps carry isRoot:false — the exact shape the route's gate reads.
const makeLocator = () => {
  const m = new Map();
  return {
    registerRoot: swiss => { m.set(swiss, { isRoot: true, name: 'Agent C' }); return swiss; },
    mintScopedCap: ({ powers = [], label = '' } = {}) => {
      const swiss = `scoped-${Math.random().toString(16).slice(2)}`;
      m.set(swiss, { isRoot: false, name: label || `${powers.join(' + ')} agent`, powers });
      return { ok: true, swiss };
    },
    nodeFor: swiss => m.get(String(swiss || '')) || null,
  };
};

// The EXACT handler logic of POST /eval/rate from server.mjs (cap-gate, then delegate to writeRating).
const handleRate = ({ nodeFor, dir }, { cap, chatId, rating, comment, by }) => {
  if (!nodeFor(cap)) return { code: 403, body: { error: 'no capability' } };
  if (!nodeFor(cap)?.isRoot) return { code: 403, body: { error: 'rating an eval run is the owner\'s call — root capability required' } };
  try {
    const r = writeRating({ chatId, rating, comment, by: by || nodeFor(cap)?.name || '', dir });
    return { code: 200, body: { ok: true, chatId: r.rating.chatId, rating: r.rating.rating, at: r.rating.at } };
  } catch (e) { return { code: 400, body: { error: String(e && e.message || e) } }; }
};

test('ROOT cap → a rating LANDS ON DISK at <dir>/<chatId>.json, mode 0600', () => {
  const loc = makeLocator();
  const root = loc.registerRoot('a'.repeat(32));
  assert.ok(loc.nodeFor(root)?.isRoot, 'the registered root cap resolves to an isRoot node');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratings-'));
  const r = handleRate({ nodeFor: loc.nodeFor, dir }, { cap: root, chatId: 'chat-42', rating: 5, comment: 'great answer' });
  assert.equal(r.code, 200, `root rating accepted — got ${JSON.stringify(r.body)}`);

  const file = path.join(dir, 'chat-42.json');
  assert.ok(fs.existsSync(file), 'the rating file landed on disk');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.chatId, 'chat-42');
  assert.equal(onDisk.rating, 5);
  assert.equal(onDisk.comment, 'great answer');
  assert.equal(onDisk.by, 'Agent C', 'attributes the rating to the (root) operator node');

  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, `file is mode 0600 (owner rw only) — got 0${mode.toString(8)}`);

  assert.equal(readRating({ chatId: 'chat-42', dir }).rating, 5, 'the helper reads it back');
});

test('a 0600 file PRE-EXISTING as world-readable is re-restricted on overwrite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratings-'));
  const file = path.join(dir, 'c.json');
  fs.writeFileSync(file, '{}'); fs.chmodSync(file, 0o644); // pretend a prior loose write
  writeRating({ chatId: 'c', rating: 3, dir });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 're-written file is forced back to 0600');
});

test('NON-ROOT (scoped) cap is REFUSED — no file written', () => {
  const loc = makeLocator();
  const scoped = loc.mintScopedCap({ powers: ['web'], label: 'web agent' });
  assert.ok(scoped.ok && scoped.swiss, 'minted a scoped cap');
  const node = loc.nodeFor(scoped.swiss);
  assert.ok(node, 'the scoped cap resolves to a real node');
  assert.equal(node.isRoot, false, 'but it is NOT root');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratings-'));
  const r = handleRate({ nodeFor: loc.nodeFor, dir }, { cap: scoped.swiss, chatId: 'chat-99', rating: 1 });
  assert.equal(r.code, 403, 'a non-root cap is refused');
  assert.match(r.body.error, /root/i);
  assert.ok(!fs.existsSync(path.join(dir, 'chat-99.json')), 'no rating file was written for the refused cap');
});

test('unknown cap is refused (no capability)', () => {
  const loc = makeLocator();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratings-'));
  const r = handleRate({ nodeFor: loc.nodeFor, dir }, { cap: 'deadbeef'.repeat(4), chatId: 'x', rating: 1 });
  assert.equal(r.code, 403);
  assert.ok(!fs.existsSync(path.join(dir, 'x.json')));
});

test('helper rejects a traversal chatId / bad rating (can\'t escape the ratings dir)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratings-'));
  assert.throws(() => writeRating({ chatId: '../escape', rating: 5, dir }), /invalid chatId/);
  assert.throws(() => writeRating({ chatId: 'a/b', rating: 5, dir }), /invalid chatId/);
  assert.throws(() => writeRating({ chatId: 'ok', rating: 9, dir }), /invalid rating/);
});

test('ratingsDir resolves under the voice-agent eval/results tree', () => {
  const d = ratingsDir();
  assert.ok(d.endsWith(path.join('eval', 'results', 'ratings')), `got ${d}`);
});
