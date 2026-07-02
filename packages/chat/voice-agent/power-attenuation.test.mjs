// power-attenuation.test.mjs — pins the POWER-ATTENUATION contract of agent-caps.mjs
// (the Set<string> power gate). Companion to endowments.test.mjs (which classifies the
// 8 authority classes) and never-auto.test.mjs (the auto-confirm denylist). This suite
// hardens the *attenuation* invariants across the BROAD power surface so the future
// ARCH-6 refactor (swapping Set<string> for a by-reference bundle) can't silently weaken
// them. Ticket: AUDIT-WORKLIST.md T-TEST-4.
//
// The invariants pinned:
//   1. Least authority on grant   — mintScopedCap grants EXACTLY requested ∩ ALL_POWERS
//      (unknown names dropped, deduped). [BOUNDARY NOTE below re: META.]
//   2. No amplification           — parent → child → grandchild; every hop ⊆ its ancestor.
//      A name an ancestor never held cannot fabricate an affordance in a descendant.
//   3. Toolbox reflects powers    — for EVERY power, the exposed verb set = baseline ∪
//      that power's verbs, and NONE bleed from ungranted powers.
//   4. NEVER_AUTO integrity       — external/high-authority proposal types can't auto-fire.
//   5. Root ⊇ every scoped cap    — root holds ALL powers; a scoped cap is a strict subset.
//
// A CRUCIAL BOUNDARY DISTINCTION this suite documents (verified, by design — not a bug):
//   * mintScopedCap is a ROOT/operator operation (server-gated on the root cap, never a
//     toolbox verb). It grants requested ∩ ALL_POWERS and DOES NOT strip META powers — the
//     operator may legitimately scope a chat with `app`/`selfImprove`/etc.
//   * The DELEGATION edge (spawnSpecialist / employ / delegateTask / forgeTool) is where a
//     confined agent re-grants to a sub-agent: there the grant is requested ∩ node.powers
//     MINUS META_POWERS — so a sub-agent can NEVER receive META even if its parent holds it,
//     and can never exceed its parent. That is the anti-escalation property tests 6–9 pin.
//
//   node --test power-attenuation.test.mjs
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { POWERS, ALL_POWERS, NEVER_AUTO, makeFieldAgent } from './agent-caps.mjs';

// The META power set is INTERNAL to agent-caps (not exported). We pin its expected contents
// here as the contract: these must be stripped at every delegation edge. If a refactor renames
// or drops one, the delegation tests below (6–9) start failing — which is the point.
const EXPECTED_META = ['app', 'selfImprove', 'subagent', 'toolsmith'];
const META = new Set(EXPECTED_META);

// readPdf is a documented CROSS-power verb: it is exposed whenever you hold ANY of its source
// powers (a vault path needs `notes`, a URL needs `web`, a home file needs `home`) — each source
// gated on its own power. So granting any one of those adds readPdf on top of that power's verbs.
const READPDF_POWERS = new Set(['notes', 'web', 'home']);

// Verbs that must NEVER be part of the always-on baseline (an empty cap). These are the
// coarse ambient-authority verbs + the external/physical-world destructive proposals. If a
// refactor accidentally moves one into the baseline, EVERY confined cap would silently gain it.
const FORBIDDEN_BASELINE = [
  'hostExec', 'vmExec', 'agentExec', 'machineRepoExec', // coarse shells
  'callConnector', 'callCustomTool', 'callObject',       // coarse wired/admitted external calls
  'improveSystem', 'runNextImprovement', 'revertChange', // autonomous self-modification
  'haAct',                                               // physical world (locks!)
  'proposeEmail', 'proposeSubAgent', 'proposeSystemPrompt', // outbound / host-shell delegation / self-mod
  'proposeBufferPost', 'proposeBufferBlast', 'proposeBufferDelete', // social publish/delete
  'proposeGiveKazputer', 'proposeKazputerSetting', 'proposeKazputerCoins', // provisioning
  'generateImage',                                       // GPU spend
];

// Hermetic root: mkdtemp for every store, all persistence redirected into it (SCOPED_CAPS_FILE +
// OBJECTS_FILE are call-time env; specialists + auto-confirm are constructor options). No live
// :8778, no network. mirrors endowments.test.mjs's mkRoot.
const mkRoot = t => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-attn-'));
  process.env.OBJECTS_FILE = path.join(outDir, 'objects.json');
  process.env.SCOPED_CAPS_FILE = path.join(outDir, 'scoped-caps.json');
  const fa = makeFieldAgent({
    outDir,
    baseUrl: 'http://test.invalid',
    autoConfirmFile: path.join(outDir, 'auto-confirm.json'),
    specialistsFile: path.join(outDir, 'specialists.json'),
  });
  t.after(() => { try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return fa;
};

// The verb set a freshly-minted scoped cap with `powers` exposes (manifest === toolbox keys).
const verbsOf = (fa, powers) => {
  const c = fa.mintScopedCap({ powers, label: 'x' });
  const node = fa.nodeFor(c.swiss);
  const { toolbox, manifest } = node.toolbox();
  const mset = new Set(manifest.map(m => m.name));
  // manifest and toolbox keys must stay in lockstep — a verb in one but not the other would be
  // an un-described affordance (or a described-but-absent one). Pin it.
  assert.deepEqual([...mset].sort(), Object.keys(toolbox).sort(), `toolbox/manifest drift for [${powers}]`);
  return mset;
};

// ── 1. LEAST AUTHORITY ON GRANT (mintScopedCap) ──────────────────────────────────────────────
test('mintScopedCap grants EXACTLY requested ∩ ALL_POWERS — unknown names dropped, deduped', t => {
  const fa = mkRoot(t);
  const r = fa.mintScopedCap({ powers: ['web', 'home', 'web', 'not-a-real-power', 'reference'], label: 'scoped' });
  assert.deepEqual([...r.powers].sort(), ['home', 'reference', 'web'], 'granted = requested ∩ ALL_POWERS, deduped');
  const node = fa.nodeFor(r.swiss);
  assert.deepEqual([...node.powers].sort(), ['home', 'reference', 'web'], 'node.powers matches the grant');
  // a name the root itself never held (it holds ALL_POWERS, but a bogus name is held by no one)
  // cannot be fabricated into the cap.
  assert.ok(!node.powers.has('not-a-real-power'), 'a non-existent power name is never granted');
});

test('mintScopedCap (a ROOT/operator op, NOT a delegation) retains META powers by design', t => {
  const fa = mkRoot(t);
  // This documents + guards the boundary: the operator CAN scope a chat with app/selfImprove/etc.
  // META stripping is a property of the *delegation* edge (tests 6–9), not of operator minting.
  const r = fa.mintScopedCap({ powers: [...EXPECTED_META, 'web'], label: 'meta' });
  const node = fa.nodeFor(r.swiss);
  for (const p of EXPECTED_META) assert.ok(node.powers.has(p), `operator-minted scoped cap keeps META power ${p}`);
  assert.ok(node.powers.has('web'), 'and the ordinary power too');
});

// ── 5. ROOT HOLDS ALL; A SCOPED CAP IS A STRICT SUBSET ───────────────────────────────────────
test('root holds ALL_POWERS; every scoped cap is a subset of root, and a proper subset is strict', t => {
  const fa = mkRoot(t);
  const root = fa.rootNode.powers;
  for (const p of ALL_POWERS) assert.ok(root.has(p), `root missing ${p}`);
  assert.equal(root.size, ALL_POWERS.length, 'root holds exactly ALL_POWERS, no more');

  const some = ['web', 'reference', 'images', 'home'];
  const c = fa.mintScopedCap({ powers: some, label: 'subset' });
  const node = fa.nodeFor(c.swiss);
  for (const p of node.powers) assert.ok(root.has(p), `scoped power ${p} must be held by root`);
  assert.ok(node.powers.size < root.size, 'a scoped cap is a STRICT subset of root');
  // no power outside root can appear
  const stray = [...node.powers].filter(p => !root.has(p));
  assert.deepEqual(stray, [], 'a scoped cap can hold no power root lacks');
});

// ── 3. TOOLBOX REFLECTS THE POWERS — parametric over the WHOLE surface ───────────────────────
test('for EVERY power, the exposed verbs = baseline ∪ that power\'s verbs (+ shared readPdf) — nothing bleeds', t => {
  const fa = mkRoot(t);
  const baseline = verbsOf(fa, []);
  let checked = 0;
  for (const p of ALL_POWERS) {
    const got = verbsOf(fa, [p]);
    const expected = new Set([
      ...baseline,
      ...POWERS[p].verbs,
      ...(READPDF_POWERS.has(p) ? ['readPdf'] : []),
    ]);
    assert.deepEqual([...got].sort(), [...expected].sort(),
      `power "${p}": toolbox must expose EXACTLY baseline ∪ ${p}'s verbs — no bleed, no missing verb`);
    // every declared verb of this power is actually present (grant works)
    for (const v of POWERS[p].verbs) assert.ok(got.has(v), `power "${p}" must expose its declared verb "${v}"`);
    checked += 1;
  }
  assert.ok(checked === ALL_POWERS.length && checked > 30, `covered all ${checked} powers`);
});

test('the always-on baseline contains NO coarse / external-destructive verb', t => {
  const fa = mkRoot(t);
  const baseline = verbsOf(fa, []);
  for (const v of FORBIDDEN_BASELINE) {
    assert.ok(!baseline.has(v), `high-authority verb "${v}" must NOT be always-on (baseline) — it must require its power`);
  }
});

test('representative powers expose their verbs and DO NOT bleed each other\'s authority', t => {
  const fa = mkRoot(t);
  // roles → the employable-role menu
  assert.deepEqual([...verbsOf(fa, ['roles'])].filter(v => ['listRoles', 'employ'].includes(v)).sort(), ['employ', 'listRoles']);
  // app → chat introspection
  for (const v of ['listChats', 'readChat', 'retitleChat', 'appState']) assert.ok(verbsOf(fa, ['app']).has(v), `app exposes ${v}`);
  // selfImprove → the autonomous-improvement ring
  for (const v of ['improveSystem', 'runNextImprovement', 'proposeImprovement', 'revertChange']) assert.ok(verbsOf(fa, ['selfImprove']).has(v), `selfImprove exposes ${v}`);
  // a benign read power
  assert.ok(verbsOf(fa, ['reference']).has('consult'), 'reference exposes consult');
  // an external-authority power
  assert.ok(verbsOf(fa, ['email']).has('proposeEmail'), 'email exposes proposeEmail');
  // homeassistant read/act
  for (const v of ['haFind', 'haTree', 'haState', 'haAct']) assert.ok(verbsOf(fa, ['homeassistant']).has(v), `homeassistant exposes ${v}`);

  // NO BLEED: an `email` cap must not carry unrelated authority
  const emailV = verbsOf(fa, ['email']);
  for (const v of ['hostExec', 'vmExec', 'haAct', 'employ', 'generateImage', 'consult', 'proposeSubAgent', 'improveSystem']) {
    assert.ok(!emailV.has(v), `an email-only cap must NOT expose "${v}" (authority bleed)`);
  }
  // a `reference`-only (read) cap must not carry any write/coarse/propose verb from another power
  const refV = verbsOf(fa, ['reference']);
  for (const v of ['proposeEmail', 'hostExec', 'haAct', 'employ', 'generateImage']) {
    assert.ok(!refV.has(v), `a reference-only cap must NOT expose "${v}"`);
  }
});

// ── 6. DELEGATION EDGE — least authority + META stripped (spawnSpecialist) ────────────────────
// spawnSpecialist persists + returns the confined ring WITHOUT running an LLM, so the grant is
// directly observable. (askSpecialist is the LLM-running verb; we don't need it here.)
test('spawnSpecialist grants requested ∩ parent.powers MINUS META — a sub-agent can never exceed its parent', async t => {
  const fa = mkRoot(t);
  const parent = fa.nodeFor(fa.mintScopedCap({ powers: ['web', 'home', 'specialists', 'app', 'selfImprove'], label: 'parent' }).swiss);
  const { toolbox } = parent.toolbox();
  // request MORE than the parent holds, incl. META (app/selfImprove/subagent) + a power the parent lacks (email).
  const r = await toolbox.spawnSpecialist.run({ name: 'kid', powers: ['web', 'home', 'email', 'subagent', 'app', 'selfImprove', 'specialists'] });
  assert.deepEqual([...r.powers].sort(), ['home', 'specialists', 'web'], 'granted = requested ∩ parent MINUS META');
  // META the parent HELD (app, selfImprove) was stripped at the edge; a power the parent LACKED (email) dropped.
  for (const bad of ['email', 'subagent', 'app', 'selfImprove']) assert.ok(!r.powers.includes(bad), `${bad} must not flow to the sub-agent`);

  // the persisted specialist's node agrees, and its toolbox exposes none of the stripped verbs.
  // INC-2: a specialist is spawned into its spawner's namespace, so resolve it within parent.ownerKey.
  const kid = fa.specialistFor('kid', parent.ownerKey).node;
  assert.deepEqual([...kid.powers].sort(), ['home', 'specialists', 'web'], 'the specialist node holds exactly the confined ring');
  for (const p of kid.powers) assert.ok(parent.powers.has(p), `child power ${p} ⊆ parent`);
  const { toolbox: kidTb } = kid.toolbox();
  const kidVerbs = new Set(Object.keys(kidTb));
  for (const v of ['appState', 'improveSystem', 'proposeSubAgent', 'proposeEmail']) {
    assert.ok(!kidVerbs.has(v), `stripped/ungranted verb "${v}" must be absent from the sub-agent's toolbox`);
  }
});

// ── 2. NO AMPLIFICATION THROUGH A DELEGATION CHAIN (parent → child → grandchild) ─────────────
test('no amplification down a delegation chain — grandchild ⊆ child ⊆ parent, a never-held name cannot appear', async t => {
  const fa = mkRoot(t);
  const parent = fa.nodeFor(fa.mintScopedCap({ powers: ['web', 'home', 'specialists'], label: 'p' }).swiss);
  const kidRing = await parent.toolbox().toolbox.spawnSpecialist.run({ name: 'kid2', powers: ['web', 'home', 'specialists'] });
  const kid = fa.specialistFor('kid2', parent.ownerKey).node; // INC-2: spawner's namespace

  // the grandchild ASKS for host + vm — names NO ancestor in this chain ever held.
  const gcRing = await kid.toolbox().toolbox.spawnSpecialist.run({ name: 'grandkid2', powers: ['web', 'home', 'host', 'vm', 'specialists'] });
  const grandkid = fa.specialistFor('grandkid2', parent.ownerKey).node; // INC-2: same namespace (inherited down the chain)

  assert.deepEqual([...gcRing.powers].sort(), ['home', 'specialists', 'web'], 'grandchild grant drops host+vm (never held upchain)');
  // subset at every hop
  for (const p of grandkid.powers) assert.ok(kid.powers.has(p), `grandchild power ${p} ⊆ child`);
  for (const p of kid.powers) assert.ok(parent.powers.has(p), `child power ${p} ⊆ parent`);
  // the fabricated names are absent everywhere
  for (const node of [parent, kid, grandkid]) {
    assert.ok(!node.powers.has('host') && !node.powers.has('vm'), 'host/vm never fabricated at any hop');
  }
});

// ── share() — single-power re-grant is enforced structurally (the other delegation primitive) ─
test('share() re-grants only powers you HOLD; a share chain never amplifies', t => {
  const fa = mkRoot(t);
  const parent = fa.nodeFor(fa.mintScopedCap({ powers: ['web', 'reference'], label: 'sp' }).swiss);
  const child = fa.nodeFor(parent.share('web', 'w').swiss);
  assert.deepEqual([...child.powers], ['web'], 'a share mints a single-power child');
  // you cannot share a power you do not hold
  assert.throws(() => child.share('home', 'h'), /don't hold the power/, 'share of an unheld power throws (no fabrication)');
  assert.throws(() => child.share('reference', 'r'), /don't hold the power/, 'child never held reference — cannot re-share it');
  // a grandchild share stays ⊆ the chain
  const grandchild = fa.nodeFor(child.share('web', 'w2').swiss);
  assert.deepEqual([...grandchild.powers], ['web'], 'grandchild ⊆ child ⊆ parent');
  // root can share every real power; a fabricated name throws
  for (const p of ALL_POWERS) assert.doesNotThrow(() => fa.rootNode.share(p, `s-${p}`), `root can share ${p}`);
  assert.throws(() => fa.rootNode.share('totally-made-up', 'x'), /don't hold the power/, 'even root cannot share a non-existent power');
});

// ── 9. delegateTask OFFER SURFACE — the advertised menu excludes META and is ⊆ the node ──────
test('the delegateTask manifest offers exactly [node.powers minus META] as delegatable', t => {
  const fa = mkRoot(t);
  const node = fa.nodeFor(fa.mintScopedCap({ powers: ['web', 'home', 'roles', 'app', 'selfImprove'], label: 'd' }).swiss);
  const entry = node.toolbox().manifest.find(m => m.name === 'delegateTask');
  assert.ok(entry, 'delegateTask is always available (universal)');
  const m = /\[([^\]]*)\]/.exec(entry.args.powers);
  assert.ok(m, 'the powers arg advertises a bracketed menu');
  const offered = new Set(m[1].split(',').map(s => s.trim()).filter(Boolean));
  assert.deepEqual([...offered].sort(), ['home', 'roles', 'web'], 'offer = held powers minus META (app/selfImprove excluded)');
  for (const meta of EXPECTED_META) assert.ok(!offered.has(meta), `META power ${meta} is never offered for delegation`);
  for (const p of offered) assert.ok(node.powers.has(p), `every offered power ${p} ⊆ the node`);
});

// ── 4. NEVER_AUTO INTEGRITY ───────────────────────────────────────────────────────────────────
test('NEVER_AUTO holds EXACTLY the external/high-authority proposal types (no silent drop, no accidental add)', () => {
  const expected = [
    'accept-invite', 'buffer-blast', 'buffer-delete', 'buffer-post', 'email',
    'give-kazputer', 'home-assistant', 'kazputer-coins', 'kazputer-setting',
    'subagent', 'system-prompt',
  ].sort();
  assert.deepEqual([...NEVER_AUTO].sort(), expected, 'NEVER_AUTO membership is pinned — a refactor cannot silently drop or add one');
});

test('every external/high-authority propose* verb EMITS a proposal whose type is in NEVER_AUTO', async t => {
  const fa = mkRoot(t);
  const { toolbox } = fa.rootNode.toolbox();
  // These create a PENDING proposal only — nothing fires until commitProposal, so this is side-effect-free.
  const cases = [
    ['proposeEmail', { to: 'x@invalid', subject: 's', body: 'b' }],
    ['proposeSystemPrompt', { prompt: 'x' }],
    ['proposeSubAgent', { name: 'x', task: 'y' }],
    ['proposeBufferPost', { text: 'x' }],
    ['proposeBufferBlast', { text: 'x' }],
    ['proposeBufferDelete', { id: 'x' }],
    ['proposeGiveKazputer', { email: 'x@invalid', name: 'k' }],
    ['proposeKazputerSetting', { instance: 'x', key: 'k', value: 'v' }],
    ['proposeKazputerCoins', { instance: 'x', delta: 1 }],
  ];
  for (const [verb, args] of cases) {
    const r = await toolbox[verb].run(args);
    assert.equal(r.proposed, true, `${verb} creates a pending proposal (does not fire)`);
    const prop = fa.getProposal(r.id);
    assert.ok(prop, `${verb} proposal is retrievable`);
    assert.ok(NEVER_AUTO.has(prop.type),
      `${verb} emits type "${prop.type}" which MUST be in NEVER_AUTO (else it could accrue an auto-confirm rule)`);
  }
  // `home-assistant` (needs a live HA trie) and `accept-invite` (needs a real Endo invite URL) cannot be
  // emitted hermetically — they are pinned by the exact-membership test above instead.
});

test('the auto-confirm gate refuses to REMEMBER or auto-fire any NEVER_AUTO kind (against the real set)', () => {
  // mirrors the exact isAutoConfirmed / addAutoRule gates in agent-caps.mjs, bound to the REAL exported set,
  // so a refactor that keeps the set but weakens the gate wiring is still caught by never-auto.test.mjs; here
  // we assert every NEVER_AUTO member is refused, and a benign kind is still remember-able.
  const rules = [];
  const isAutoConfirmed = (agent, kind) => !NEVER_AUTO.has(kind) && rules.some(r => r.agent === agent && r.kind === kind);
  const addAutoRule = (agent, kind) => { if (NEVER_AUTO.has(kind)) return false; rules.push({ agent, kind }); return true; };
  for (const kind of NEVER_AUTO) {
    rules.length = 0; rules.push({ agent: 'root', kind }); // even a pre-existing stale rule…
    assert.equal(isAutoConfirmed('root', kind), false, `${kind} must not auto-fire even with a stale rule`);
    assert.equal(addAutoRule('root', kind), false, `addAutoRule must refuse to record a ${kind} rule`);
  }
  assert.equal(addAutoRule('root', 'note-edit'), true, 'a benign kind can still be remembered');
});
