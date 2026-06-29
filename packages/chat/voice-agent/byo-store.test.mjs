// byo-store.test.mjs — bring-your-own inference provider: per-cap config, key diverted to the vault (never in
// the store), validation, and the turn-time resolution that the server uses to route a user's turn to their key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeByoStore } from './byo-store.mjs';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const mkVault = () => { const v = new Map(); return { getSecret: n => v.get(n) || '', storeNamedSecret: (n, val) => v.set(n, String(val || '')), _v: v }; };
const mk = () => { const vault = mkVault(); const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'byo-')), 'byo.json'); return { store: makeByoStore({ file, ...vault }), vault, file }; };

test('connect a provider → status reflects it; the KEY is in the vault, NOT the store file', () => {
  const { store, vault, file } = mk();
  assert.equal(store.status('capA').connected, false);
  const r = store.set('capA', { provider: 'anthropic', model: 'claude-sonnet-4-6', key: 'sk-ant-SECRET' });
  assert.deepEqual([r.ok, r.provider], [true, 'anthropic']);
  const st = store.status('capA');
  assert.equal(st.connected, true); assert.equal(st.provider, 'anthropic'); assert.equal(st.hasKey, true);
  assert.equal(JSON.stringify(st).includes('SECRET'), false, 'status never returns the key');
  assert.equal(fs.readFileSync(file, 'utf8').includes('SECRET'), false, 'the key is NOT written to the store file');
  assert.equal([...vault._v.values()].some(v => v.includes('SECRET')), true, 'the key IS in the vault');
});

test('forTurn resolves the callLLM-ready modelId + key for the owning cap only', () => {
  const { store } = mk();
  store.set('capA', { provider: 'openrouter', model: 'openai/gpt-4o', key: 'sk-or-X' });
  const t = store.forTurn('capA');
  assert.equal(t.modelId, 'openrouter:openai/gpt-4o'); assert.equal(t.key, 'sk-or-X');
  assert.equal(store.forTurn('capB'), null, 'a different cap has no BYO config');
});

test('rejects unknown providers; clear() disconnects', () => {
  const { store } = mk();
  assert.equal(store.set('capA', { provider: 'evilcorp', key: 'x' }).ok, false);
  store.set('capA', { provider: 'anthropic', key: 'k' });
  store.clear('capA');
  assert.equal(store.status('capA').connected, false);
  assert.equal(store.forTurn('capA'), null);
});
