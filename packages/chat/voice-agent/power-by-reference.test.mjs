// power-by-reference.test.mjs — pins the ARCH-6 designation-BY-REFERENCE contract.
//
// Companion to power-attenuation.test.mjs (which pins the observable attenuation
// behaviour through the Set<string> surface). This suite asserts the STRUCTURAL
// property the refactor introduced: a node's authority is a HELD BUNDLE OF REAL
// REFERENCES, the Set<string> of power names is DERIVED from it, the toolbox is
// wired from the affordance refs the bundle carries, and delegation hands out an
// attenuated SUBSET of the SAME ref identities — never a re-minted "name" a
// sub-agent merely utters. "You cannot name what you do not hold."
//
//   node --test power-by-reference.test.mjs
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { POWERS, ALL_POWERS, makeFieldAgent } from './agent-caps.mjs';

const mkRoot = t => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-byref-'));
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

const verbsOf = node => new Set(Object.keys(node.toolbox().toolbox));

// ── 1. THE BUNDLE IS THE SOURCE OF TRUTH; THE NAME-SET IS DERIVED ────────────────────────────
test('a node holds a capability BUNDLE and its Set<string> of powers is DERIVED from it', t => {
  const fa = mkRoot(t);
  const node = fa.nodeFor(fa.mintScopedCap({ powers: ['web', 'home', 'reference'], label: 'b' }).swiss);
  // the bundle is a real CapabilityBundle (the by-reference core), not display metadata
  for (const m of ['names', 'has', 'get', 'attenuate']) {
    assert.equal(typeof node.bundle[m], 'function', `node.bundle exposes ${m}()`);
  }
  // the Set<string> is EXACTLY the bundle's names — derived, not independently authored
  assert.deepEqual([...node.powers].sort(), [...node.bundle.names()].sort(), 'node.powers === node.bundle.names()');
  assert.deepEqual([...node.bundle.names()].sort(), ['home', 'reference', 'web']);
});

// ── 2. HOLDING THE REF IS HOLDING THE AFFORDANCE — the toolbox is wired FROM the bundle refs ──
test('each held power-reference CARRIES the real verb affordances the toolbox exposes', t => {
  const fa = mkRoot(t);
  const node = fa.nodeFor(fa.mintScopedCap({ powers: ['web', 'reference'], label: 'r' }).swiss);
  const tb = verbsOf(node);
  for (const power of node.bundle.names()) {
    const ref = node.bundle.get(power);
    assert.ok(ref, `bundle holds a ref for ${power}`);
    // the ref names itself and carries concrete verb affordances (name + a real impl)
    assert.equal(ref.name(), power, 'the power-ref knows its own name');
    for (const { name: v, aff } of ref.verbs()) {
      assert.equal(typeof aff.run, 'function', `verb ${v} of ${power} carries a real affordance (run)`);
      assert.ok(tb.has(v), `verb ${v} carried by the ${power} ref is exposed in the toolbox`);
    }
  }
});

// ── 3. YOU CANNOT NAME WHAT YOU DO NOT HOLD — attenuate NEVER fabricates an absent ref ─────────
test('attenuating a held bundle to a SUPERSET yields only held refs — a never-held name is never minted', t => {
  const fa = mkRoot(t);
  const node = fa.nodeFor(fa.mintScopedCap({ powers: ['web', 'reference'], label: 'a' }).swiss);
  // ask for a superset incl. names this node never held (host/email/bogus)
  const attn = node.bundle.attenuate(['web', 'reference', 'host', 'email', 'not-a-real-power']);
  assert.deepEqual([...attn.names()].sort(), ['reference', 'web'], 'attenuate(superset) = held ∩ requested — absent names dropped');
  for (const bad of ['host', 'email', 'not-a-real-power']) {
    assert.equal(attn.get(bad), undefined, `attenuate never mints a ref for the never-held name "${bad}"`);
    assert.equal(node.bundle.has(bad), false, `the node's bundle does not hold "${bad}"`);
  }
});

// ── 4. THE BUNDLE-DERIVED TOOLBOX == THE NAME-MINTED TOOLBOX (behaviour parity) ────────────────
test('minting by name and holding the equivalent sub-bundle expose the IDENTICAL verb surface', t => {
  const fa = mkRoot(t);
  // a broad scoped cap; a narrower name-set DERIVED by attenuating its held bundle
  const broad = fa.nodeFor(fa.mintScopedCap({ powers: ['web', 'home', 'reference', 'images', 'email'], label: 'broad' }).swiss);
  const narrowNames = broad.bundle.attenuate(['web', 'home']).names();
  const narrow = fa.nodeFor(fa.mintScopedCap({ powers: narrowNames, label: 'narrow' }).swiss);
  // a cap minted straight from the same names must expose exactly the same verbs
  const reference = fa.nodeFor(fa.mintScopedCap({ powers: ['web', 'home'], label: 'ref' }).swiss);
  assert.deepEqual([...verbsOf(narrow)].sort(), [...verbsOf(reference)].sort(),
    'the bundle-derived narrow cap exposes the same verb surface as a directly name-minted {web,home} cap');
  // web+home verbs are present, and it is a subset of the broad cap it was attenuated from
  for (const v of [...POWERS.web.verbs, ...POWERS.home.verbs]) assert.ok(verbsOf(narrow).has(v), `narrow exposes ${v}`);
  for (const v of verbsOf(narrow)) assert.ok(verbsOf(broad).has(v), `narrow verb ${v} ⊆ broad`);
});

// ── 5. DELEGATION FLOWS THE SAME REF IDENTITY — not a re-minted string ─────────────────────────
test('a delegated child holds the SAME ref identities as its parent (by reference, attenuated), never re-minted', async t => {
  const fa = mkRoot(t);
  const parent = fa.nodeFor(fa.mintScopedCap({ powers: ['web', 'home', 'reference', 'specialists'], label: 'par' }).swiss);
  // spawn a confined sub-agent (the delegation edge) requesting a subset + a power the parent lacks
  await parent.toolbox().toolbox.spawnSpecialist.run({ name: 'byref-kid', powers: ['web', 'reference', 'email', 'specialists'] });
  const kid = fa.specialistFor('byref-kid').node;

  // subset by name
  for (const p of kid.bundle.names()) assert.ok(parent.bundle.has(p), `child power ${p} ⊆ parent`);
  assert.ok(!kid.bundle.has('email'), 'a power the parent never held cannot reach the child');
  // THE KEY BY-REFERENCE PROPERTY: the child holds the *same object identity* for each shared
  // power that the parent (and the root) holds — the ref flowed, it was not re-created from a name.
  for (const p of kid.bundle.names()) {
    assert.ok(Object.is(kid.bundle.get(p), parent.bundle.get(p)),
      `child's "${p}" ref is the SAME identity the parent holds (designation by reference)`);
    assert.ok(Object.is(kid.bundle.get(p), fa.rootNode.bundle.get(p)),
      `and the same identity the root holds — one ref, attenuated down the chain, never re-minted`);
  }
  // the affordances the child can actually call are those carried by the held refs
  const kidVerbs = verbsOf(kid);
  for (const p of kid.bundle.names()) for (const { name: v } of kid.bundle.get(p).verbs()) {
    assert.ok(kidVerbs.has(v), `child exposes verb ${v} because it HOLDS the ${p} ref`);
  }
});

// ── 6. ROOT HOLDS THE FULL REGISTRY OF REFS; every ref identity is stable ──────────────────────
test('root holds one ref per power (the full registry) and get() is identity-stable across calls', t => {
  const fa = mkRoot(t);
  const root = fa.rootNode.bundle;
  assert.deepEqual([...root.names()].sort(), [...ALL_POWERS].sort(), 'root bundle holds exactly ALL_POWERS refs');
  for (const p of ALL_POWERS) {
    const a = root.get(p);
    const b = root.get(p);
    assert.ok(a && Object.is(a, b), `root.get("${p}") is a stable held reference`);
  }
});
