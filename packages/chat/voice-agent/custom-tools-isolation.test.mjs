// custom-tools-isolation.test.mjs — INC-2 (per-user isolation): the authored-tools library is partitioned
// per user. Proves (a) user-0/legacy (no owner field) = root sees today's data, (b) tenant A's admitted tools
// are invisible + UNCALLABLE to tenant B and vice-versa, (c) a foreign-owner call is refused (fail-closed).
//
//   node --test packages/chat/voice-agent/custom-tools-isolation.test.mjs
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-iso-'));
process.env.CUSTOM_TOOLS_STORE = path.join(TMP, 'custom-tools.json');
process.env.CUSTOM_TOOLS_STATE = path.join(TMP, 'tool-state');
process.env.COMPONENT_GRAINS = path.join(TMP, 'grains');
process.env.FIELD_CONFIG_DIR = path.join(TMP, 'config');

const { makeCustomTools } = await import('./custom-tools.mjs');

const TOOL = "return async ({ x }) => ({ doubled: (Number(x)||0) * 2 });";

test('LEGACY tool record (no owner field) belongs to user-0 = root (back-compat)', async () => {
  fs.writeFileSync(process.env.CUSTOM_TOOLS_STORE, JSON.stringify({ tools: [
    { id: 'tool-legacy', name: 'Legacy', description: 'old', args: {}, kind: 'instance', code: TOOL, status: 'admitted', createdAt: '' },
  ] }));
  const ct = makeCustomTools();
  assert.ok(ct.list('root').some(t => t.id === 'tool-legacy'), 'root (user-0) sees the legacy owner-less tool');
  const r = await ct.call('Legacy', { args: { x: 3 }, owner: 'root' });
  assert.equal(r.ok, true); assert.equal(r.value.doubled, 6, 'root can call the legacy tool');
});

test('tenant A and tenant B each see + call ONLY their own admitted tools', async () => {
  fs.writeFileSync(process.env.CUSTOM_TOOLS_STORE, JSON.stringify({ tools: [] }));
  const ct = makeCustomTools();
  const A = 'u:aaaaaaaaaaaaaaaaaaaaaaaa';
  const B = 'u:bbbbbbbbbbbbbbbbbbbbbbbb';
  const pa = ct.propose({ name: 'Doubler', description: 'a', code: TOOL, proposedBy: 'agentA', owner: A }); ct.admit(pa.id);
  const pb = ct.propose({ name: 'Doubler', description: 'b', code: TOOL, proposedBy: 'agentB', owner: B }); ct.admit(pb.id); // SAME name, different owner

  assert.deepEqual(ct.list(A).map(t => t.id), [pa.id], 'tenant A sees only its own tool');
  assert.deepEqual(ct.list(B).map(t => t.id), [pb.id], 'tenant B sees only its own tool');

  // tenant B cannot CALL tenant A's tool (by A's id) — fail-closed "no such tool"
  const cross = await ct.call(pa.id, { args: { x: 5 }, owner: B });
  assert.equal(cross.ok, false, 'tenant B is refused calling tenant A\'s tool by id');
  assert.match(cross.error, /no such tool/);

  // by the shared NAME, each tenant resolves ITS OWN
  const aOwn = await ct.call('Doubler', { args: { x: 5 }, owner: A });
  assert.equal(aOwn.value.doubled, 10, 'tenant A calls its own Doubler');
  const bOwn = await ct.call('Doubler', { args: { x: 7 }, owner: B });
  assert.equal(bOwn.value.doubled, 14, 'tenant B calls its own Doubler');
});

test('root (a distinct namespace) does not see a tenant tool; global listAll (root review) sees all', async () => {
  fs.writeFileSync(process.env.CUSTOM_TOOLS_STORE, JSON.stringify({ tools: [] }));
  const ct = makeCustomTools();
  const A = 'u:cccccccccccccccccccccccc';
  const pa = ct.propose({ name: 'Secret', description: 'a', code: TOOL, proposedBy: 'agentA', owner: A }); ct.admit(pa.id);
  assert.equal(ct.list('root').length, 0, 'root does NOT see the tenant\'s tool');
  assert.equal((await ct.call('Secret', { args: { x: 1 }, owner: 'root' })).ok, false, 'root cannot call the tenant\'s tool');
  // the root-gated server REVIEW surface (undefined owner) still sees every owner's tool for admission
  assert.ok(ct.listAll().some(t => t.id === pa.id), 'global listAll (undefined owner) sees all owners (root review UI)');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
