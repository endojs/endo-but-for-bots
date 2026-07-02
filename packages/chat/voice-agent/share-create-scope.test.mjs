// share-create-scope.test.mjs — regression proof that POST /share/create can no longer mint a WRITE
// share driven by the caller's ROOT capability.
//
// The hole (fixed, server.mjs): the share record set `scopedCap: nodeFor(scopedCap) ? scopedCap : cap`.
// A write share DRIVES the agent under `rec.scopedCap` (see /share/post → AGENT_RUNNER). Omitting or
// mistyping `scopedCap` on a `mode:'write'` share silently fell back to the caller's cap — which for dan
// is ROOT (HA, host shell, email, payments) — so the share-token holder drove the FULL root agent.
//
// Mirrors server-rate.test.mjs: re-creates the EXACT handler decision against a faithful nodeFor model
// (root → isRoot:true; scoped chat cap → a real node with isRoot:false; unknown swiss → null), and writes
// the rec to disk exactly as the route does, then resolves the stored token back through nodeFor to prove
// a write token NEVER maps to a root node.
//
// Run: node --test share-create-scope.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const makeLocator = () => {
  const m = new Map();
  return {
    registerRoot: swiss => { m.set(swiss, { isRoot: true, name: 'Agent C', powers: [], toolbox: () => ({ manifest: [] }) }); return swiss; },
    mintScopedCap: ({ powers = [], label = '' } = {}) => {
      const swiss = `scoped-${Math.random().toString(16).slice(2)}`;
      m.set(swiss, { isRoot: false, name: label || 'chat', powers, toolbox: () => ({ manifest: [] }) });
      return swiss;
    },
    nodeFor: swiss => m.get(String(swiss || '')) || null,
  };
};

// The EXACT decision logic of POST /share/create's scopedCap handling from server.mjs.
const handleShareCreate = ({ nodeFor, dir }, { cap, scopedCap, mode }) => {
  if (!nodeFor(cap)?.isRoot) return { code: 403, body: { error: 'sharing needs your root capability' } };
  const wantWrite = mode === 'write';
  const scopedNode = nodeFor(scopedCap);
  if (wantWrite && !scopedNode) return { code: 400, body: { error: 'a write share needs an explicit, valid scoped capability' } };
  if (wantWrite && scopedNode.isRoot) return { code: 400, body: { error: 'refusing to create a write share driven by your ROOT capability' } };
  const storedScopedCap = (scopedNode && !scopedNode.isRoot) ? scopedCap : '';
  const token = crypto.randomBytes(16).toString('hex');
  const rec = { token, scopedCap: storedScopedCap, mode: wantWrite ? 'write' : 'read' };
  fs.writeFileSync(path.join(dir, `${token}.json`), JSON.stringify(rec));
  return { code: 200, body: { token, mode: rec.mode } };
};

test('write share WITHOUT scopedCap is REFUSED (no root fallback)', () => {
  const loc = makeLocator();
  const root = loc.registerRoot('a'.repeat(32));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-'));
  const r = handleShareCreate({ nodeFor: loc.nodeFor, dir }, { cap: root, mode: 'write' });
  assert.equal(r.code, 400, `write share w/o scopedCap must be refused — got ${JSON.stringify(r.body)}`);
});

test('write share with a ROOT scopedCap is REFUSED', () => {
  const loc = makeLocator();
  const root = loc.registerRoot('a'.repeat(32));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-'));
  const r = handleShareCreate({ nodeFor: loc.nodeFor, dir }, { cap: root, scopedCap: root, mode: 'write' });
  assert.equal(r.code, 400, 'passing root as scopedCap must be refused');
});

test('write share with a valid NON-ROOT scoped cap works AND the token never resolves to root', () => {
  const loc = makeLocator();
  const root = loc.registerRoot('a'.repeat(32));
  const scoped = loc.mintScopedCap({ powers: ['notes'], label: 'chat' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-'));
  const r = handleShareCreate({ nodeFor: loc.nodeFor, dir }, { cap: root, scopedCap: scoped, mode: 'write' });
  assert.equal(r.code, 200, `valid scoped write share must succeed — got ${JSON.stringify(r.body)}`);
  // resolve the stored token exactly as /share/post does → nodeFor(rec.scopedCap) must be NON-ROOT.
  const rec = JSON.parse(fs.readFileSync(path.join(dir, `${r.body.token}.json`), 'utf8'));
  const node = loc.nodeFor(rec.scopedCap);
  assert.ok(node, 'the write share resolves to a live cap');
  assert.equal(node.isRoot, false, 'the write-share token must NEVER resolve to the root cap');
});

test('read share never stores the root cap (no ALL_POWERS leak via /share/open)', () => {
  const loc = makeLocator();
  const root = loc.registerRoot('a'.repeat(32));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-'));
  // even if a client passes scopedCap:root on a read share, it must not be stored.
  const r = handleShareCreate({ nodeFor: loc.nodeFor, dir }, { cap: root, scopedCap: root, mode: 'read' });
  assert.equal(r.code, 200);
  const rec = JSON.parse(fs.readFileSync(path.join(dir, `${r.body.token}.json`), 'utf8'));
  assert.equal(rec.scopedCap, '', 'a read share must not persist any (root) scoped cap');
  assert.equal(loc.nodeFor(rec.scopedCap), null, 'the read share resolves to no cap');
});
