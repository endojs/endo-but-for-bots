// platform-personal-powers.test.mjs — pins the Packing-up-for-Dweb P2 platform/personal power split.
//
// The machine runs in two authority regimes keyed to FIELD_MODE:
//   • PERSONAL — dan is the privileged user-0; the ROOT node holds ALL_POWERS (incl. host/vault/creds).
//   • PLATFORM — a clean multi-tenant Agent C; the ROOT node holds ONLY PLATFORM_POWERS. No personal/admin
//     authority is reachable: the personal power-REFERENCE never exists in the graph, so no verb appears in
//     the toolbox and NO mint / rescope / delegation can fabricate it (attenuate hands out only held refs).
//
// This is a SECURITY BOUNDARY — the tests below assert absence AND unreachability, not just a smaller list.
// Isolated per Joshua: every makeFieldAgent runs against a fresh mkdtemp store; no live :8778 is touched.
//
//   node --test platform-personal-powers.test.mjs
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  POWERS, ALL_POWERS, PLATFORM_POWERS, PERSONAL_POWERS, PLATFORM_ADMIN_POWERS, makeFieldAgent,
} from './agent-caps.mjs';

const META = ['subagent', 'app', 'selfImprove', 'toolsmith'];

const mk = (t, fieldMode) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `fa-mode-${fieldMode}-`));
  // point every persisted store at the temp dir so a platform-mode instance can't read/write real config
  process.env.OBJECTS_FILE = path.join(outDir, 'objects.json');
  process.env.SCOPED_CAPS_FILE = path.join(outDir, 'scoped-caps.json');
  const fa = makeFieldAgent({
    outDir,
    baseUrl: 'http://test.invalid',
    autoConfirmFile: path.join(outDir, 'auto-confirm.json'),
    specialistsFile: path.join(outDir, 'specialists.json'),
    fieldMode,
  });
  t.after(() => { try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return fa;
};

// every toolbox verb a set of powers contributes (per the POWERS metadata)
const verbsFor = names => new Set(names.flatMap(p => (POWERS[p] ? POWERS[p].verbs : [])));
const toolboxVerbs = node => new Set(Object.keys(node.toolbox().toolbox));

// ── 0. THE CLASSIFICATION IS A CLEAN, FAIL-CLOSED PARTITION ─────────────────────────────────────
test('PLATFORM ⊎ PERSONAL == ALL_POWERS, disjoint, and no META power is PLATFORM', () => {
  const union = new Set([...PLATFORM_POWERS, ...PERSONAL_POWERS]);
  assert.equal(union.size, ALL_POWERS.length, 'no overlap and nothing missing');
  for (const p of ALL_POWERS) assert.ok(union.has(p), `${p} classified`);
  assert.deepEqual(PLATFORM_POWERS.filter(p => PERSONAL_POWERS.includes(p)), [], 'sets are disjoint');
  for (const m of META) assert.ok(!PLATFORM_POWERS.includes(m), `META power ${m} is NOT platform`);
  // the load-bearing personal reds are personal
  for (const p of ['host', 'vm', 'agents', 'homeassistant', 'email', 'contacts', 'notes', 'kazputer', 'dietician', 'connectors', 'selfImprove']) {
    assert.ok(PERSONAL_POWERS.includes(p), `${p} is PERSONAL`);
  }
  // and the safe multi-tenant set is platform
  for (const p of ['web', 'research', 'images', 'roles', 'specialists']) {
    assert.ok(PLATFORM_POWERS.includes(p), `${p} is PLATFORM`);
  }
});

// ── 1. PERSONAL MODE: root holds EVERYTHING (unchanged behaviour) ────────────────────────────────
test('PERSONAL mode: the root node holds ALL_POWERS, including every personal power', t => {
  const fa = mk(t, 'personal');
  assert.equal(fa.mode, 'personal');
  assert.deepEqual([...fa.rootNode.bundle.names()].sort(), [...ALL_POWERS].sort(), 'root bundle == ALL_POWERS');
  for (const p of ALL_POWERS) assert.ok(fa.rootNode.powers.has(p), `root holds ${p}`);
  // personal verbs are present in the toolbox (host shell, HA, email, notes)
  const tb = toolboxVerbs(fa.rootNode);
  for (const v of ['hostExec', 'haFind', 'proposeEmail', 'searchNotes']) assert.ok(tb.has(v), `personal verb ${v} present in personal mode`);
});

// ── 2. PLATFORM MODE: root holds ONLY PLATFORM_POWERS; every personal power ABSENT + UNREACHABLE ──
test('PLATFORM mode: the root node holds ONLY PLATFORM_POWERS — personal powers are absent', t => {
  const fa = mk(t, 'platform');
  assert.equal(fa.mode, 'platform');
  assert.deepEqual([...fa.rootNode.bundle.names()].sort(), [...PLATFORM_POWERS].sort(), 'root bundle == PLATFORM_POWERS');
  assert.deepEqual([...fa.rootNode.powers].sort(), [...PLATFORM_POWERS].sort(), 'root.powers == PLATFORM_POWERS');
  for (const p of PERSONAL_POWERS) {
    assert.ok(!fa.rootNode.powers.has(p), `root does NOT hold personal power ${p}`);
    assert.equal(fa.rootNode.bundle.has(p), false, `no reference for personal power ${p} exists in the root bundle`);
    assert.equal(fa.rootNode.bundle.get(p), undefined, `bundle.get(${p}) yields no ref`);
  }
});

test('PLATFORM mode: every personal VERB is absent from the toolbox (holding the ref is the only way in)', t => {
  const fa = mk(t, 'platform');
  const tb = toolboxVerbs(fa.rootNode);
  const personalVerbs = verbsFor([...PERSONAL_POWERS]);
  const platformVerbs = verbsFor([...PLATFORM_POWERS]);
  for (const v of personalVerbs) {
    // a verb is only "unreachable via a personal power" if it isn't ALSO contributed by a platform power
    if (platformVerbs.has(v)) continue;
    assert.ok(!tb.has(v), `personal verb ${v} is NOT exposed in a platform-mode root toolbox`);
  }
  // spot-check the highest-authority ones explicitly
  for (const v of ['hostExec', 'vmExec', 'haFind', 'haAct', 'proposeEmail', 'searchNotes', 'addNote', 'agentExec', 'messageOwner', 'proposeGiveKazputer', 'improveSystem']) {
    assert.ok(!tb.has(v), `dangerous personal verb ${v} is unreachable in platform mode`);
  }
});

// ── 3. UNREACHABLE BY DELEGATION: platform root cannot MINT / RESCOPE / DELEGATE a personal power ─
test('PLATFORM mode: mintScopedCap requesting personal powers cannot fabricate them', t => {
  const fa = mk(t, 'platform');
  const minted = fa.mintScopedCap({ powers: ['web', 'host', 'email', 'notes', 'homeassistant'], label: 'sneaky' });
  const node = fa.nodeFor(minted.swiss);
  assert.deepEqual([...node.powers].sort(), ['web'], 'only the platform power survives — personal names dropped by the bundle');
  for (const p of ['host', 'email', 'notes', 'homeassistant']) assert.equal(node.bundle.has(p), false, `${p} never reached the minted cap`);
});

test('PLATFORM mode: a delegated specialist cannot receive a personal power its parent never held', async t => {
  const fa = mk(t, 'platform');
  const parent = fa.nodeFor(fa.mintScopedCap({ powers: ['web', 'research', 'specialists'], label: 'par' }).swiss);
  await parent.toolbox().toolbox.spawnSpecialist.run({ name: 'plat-kid', powers: ['web', 'host', 'email', 'research'] });
  const kid = fa.specialistFor('plat-kid').node;
  for (const p of kid.bundle.names()) assert.ok(!PERSONAL_POWERS.includes(p), `child power ${p} is platform-only`);
  for (const p of ['host', 'email']) assert.ok(!kid.bundle.has(p), `child cannot hold personal power ${p}`);
  // and only same-identity refs the root actually holds flowed down
  for (const p of kid.bundle.names()) assert.ok(Object.is(kid.bundle.get(p), fa.rootNode.bundle.get(p)), `${p} is the root's ref, attenuated`);
});

// ── 4. THE PLATFORM-ADMIN CAP HOLDS NO PERSONAL POWER (in EITHER mode) ───────────────────────────
for (const fieldMode of ['personal', 'platform']) {
  test(`platform-admin cap (${fieldMode} mode) holds only platform powers — no personal authority`, t => {
    const fa = mk(t, fieldMode);
    const admin = fa.mintPlatformAdmin({ label: 'ops' });
    const node = fa.nodeFor(admin.swiss);
    assert.deepEqual([...node.powers].sort(), [...PLATFORM_ADMIN_POWERS].sort(), 'admin ring == PLATFORM_ADMIN_POWERS');
    for (const p of PERSONAL_POWERS) assert.ok(!node.powers.has(p), `platform-admin does NOT hold ${p}`);
    // even asking for personal powers explicitly cannot smuggle them in (fail-closed: intersected away)
    const sneaky = fa.nodeFor(fa.mintPlatformAdmin({ label: 'x', powers: ['web', 'host', 'email', 'notes'] }).swiss);
    assert.deepEqual([...sneaky.powers].sort(), ['web'], 'a personal power requested for a platform-admin cap is dropped');
    for (const p of ['host', 'email', 'notes']) assert.ok(!sneaky.powers.has(p), `platform-admin never gains ${p}`);
    // the admin cap's toolbox has no dangerous personal verb
    const tb = toolboxVerbs(node);
    for (const v of ['hostExec', 'haFind', 'proposeEmail', 'searchNotes', 'improveSystem']) assert.ok(!tb.has(v), `admin toolbox has no ${v}`);
  });
}
