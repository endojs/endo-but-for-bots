// specialists-isolation.test.mjs — INC-2 (per-user isolation): the self-spawned specialist roster is
// partitioned per user. Proves (a) user-0/legacy (root) sees today's data, (b) tenant A's specialists are
// invisible to tenant B and vice-versa, (c) a foreign-owner lookup is refused (fail-closed). No live server.
//
//   node --test packages/chat/voice-agent/specialists-isolation.test.mjs
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-spec-'));
process.env.FIELD_HOME_BASE = path.join(TMP, 'home');
process.env.FIELD_CONFIG_DIR = path.join(TMP, 'config');
process.env.OBJECTS_FILE = path.join(TMP, 'objects.json');
process.env.SCOPED_CAPS_FILE = path.join(TMP, 'scoped.json');

const { makeFieldAgent, ownerKeyForCap } = await import('./agent-caps.mjs');

const SPEC_FILE = path.join(TMP, 'spec.json');
const mk = () => makeFieldAgent({ outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fa-spec-out-')), baseUrl: 'http://test.invalid', autoConfirmFile: path.join(TMP, `ac-${Math.random().toString(16).slice(2)}.json`), specialistsFile: SPEC_FILE });
const tb = (fa, swiss) => fa.nodeFor(swiss).toolbox({ chatId: 'c' }).toolbox;

test('LEGACY specialists.json (no owner field) belongs to user-0 = root (back-compat)', async () => {
  // Seed a pre-INC-2 store: a specialist record with NO owner field.
  fs.writeFileSync(SPEC_FILE, JSON.stringify({ specialists: [{ id: 'spec-legacy', name: 'Legacy', domain: 'old', powers: ['web'], instructions: '', swiss: 'legacyswiss', createdAt: new Date().toISOString(), spawnedFrom: null }] }));
  const fa = mk();
  const rootTb = fa.rootNode.toolbox({ chatId: 'c0' }).toolbox;
  const r = await rootTb.listSpecialists.run();
  const ids = r.specialists.map(s => s.id);
  assert.ok(ids.includes('spec-legacy'), 'root (user-0) sees the legacy, owner-less specialist as its own');
});

test('tenant A and tenant B each see ONLY their own specialists; root sees only legacy', async () => {
  fs.writeFileSync(SPEC_FILE, JSON.stringify({ specialists: [{ id: 'spec-legacy', name: 'Legacy', domain: 'old', powers: ['web'], instructions: '', swiss: 'legacyswiss2', createdAt: new Date().toISOString(), spawnedFrom: null }] }));
  const fa = mk();
  const a = fa.mintScopedCap({ powers: ['specialists', 'web'], label: 'TenantA' });
  const b = fa.mintScopedCap({ powers: ['specialists', 'web'], label: 'TenantB' });

  await tb(fa, a.swiss).spawnSpecialist.run({ name: 'Helper', domain: 'a-domain', powers: ['web'], instructions: 'A helper' });
  await tb(fa, b.swiss).spawnSpecialist.run({ name: 'Helper', domain: 'b-domain', powers: ['web'], instructions: 'B helper' }); // SAME slug — must not collide

  const aList = (await tb(fa, a.swiss).listSpecialists.run()).specialists.filter(s => !s.builtin);
  const bList = (await tb(fa, b.swiss).listSpecialists.run()).specialists.filter(s => !s.builtin);
  const rootList = (await fa.rootNode.toolbox({ chatId: 'c0' }).toolbox.listSpecialists.run()).specialists.filter(s => !s.builtin);

  const aDomains = aList.map(s => s.domain);
  const bDomains = bList.map(s => s.domain);
  assert.ok(aDomains.includes('a-domain') && !aDomains.includes('b-domain'), 'tenant A sees its own Helper, NOT tenant B\'s');
  assert.ok(bDomains.includes('b-domain') && !aDomains.includes('b-domain'), 'tenant B sees its own Helper, NOT tenant A\'s');
  assert.equal(aList.length, 1, 'tenant A sees exactly one non-builtin specialist (its own)');
  assert.equal(bList.length, 1, 'tenant B sees exactly one non-builtin specialist (its own)');
  assert.ok(rootList.some(s => s.id === 'spec-legacy'), 'root still sees the legacy specialist');
  assert.ok(!rootList.some(s => s.domain === 'a-domain' || s.domain === 'b-domain'), 'root does NOT see the tenants\' specialists');
});

test('a foreign-owner specialistFor lookup is REFUSED (fail-closed)', async () => {
  fs.writeFileSync(SPEC_FILE, JSON.stringify({ specialists: [] }));
  const fa = mk();
  const a = fa.mintScopedCap({ powers: ['specialists', 'web'], label: 'TenantA2' });
  const b = fa.mintScopedCap({ powers: ['specialists', 'web'], label: 'TenantB2' });
  const ownerA = ownerKeyForCap(a.swiss);
  const ownerB = ownerKeyForCap(b.swiss);
  await tb(fa, a.swiss).spawnSpecialist.run({ name: 'Secret', domain: 'a-secret', powers: ['web'], instructions: 'A secret' });

  assert.ok(fa.specialistFor('spec-secret', ownerA), 'owner A resolves its own specialist');
  assert.equal(fa.specialistFor('spec-secret', ownerB), null, 'owner B is REFUSED tenant A\'s specialist (fail-closed)');
  assert.equal(fa.specialistFor('spec-secret', 'root'), null, 'root (a different namespace) does not see a tenant specialist by id');
  // tenant B cannot "act as" / consult tenant A's specialist by name
  const bAsk = await tb(fa, b.swiss).askSpecialist.run({ name: 'Secret', request: 'do the thing' });
  assert.equal(bAsk.ok, false, 'tenant B cannot askSpecialist tenant A\'s specialist');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
