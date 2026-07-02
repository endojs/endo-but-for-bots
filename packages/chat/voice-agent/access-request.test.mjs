// access-request.test.mjs — a CONFINED agent can request MORE permissions, and the owner can grant them
// to the RIGHT node, capped at the grantor's ceiling (Task #36).
//
// The invariants this pins:
//   1. requestAccess grants NOTHING itself (the escalation primitive is inert) — it only ASKS.
//   2. The accessRequest payload carries a `requester` identity ({ kind, id, owner }), so the Grant card
//      knows WHICH node to widen (a specialist widens ITSELF, not the chat cap).
//   3. grantSpecialistPower widens the SPECIALIST's own bundle by-reference (same slug ⇒ same node re-registered).
//   4. CEILING: a specialist can NEVER exceed its GRANTOR's authority — a power the grantor lacks is REFUSED.
//   5. The top-chat rescope path still works (regression).
//   6. The grant is NEVER auto-confirmable — it carries no proposal type/id, so no auto-rule can ever fire it.
//
//   node --test access-request.test.mjs
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { makeFieldAgent, ownerKeyForCap } from './agent-caps.mjs';

const mkRoot = t => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-access-'));
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

const verbsOf = node => new Set(Object.keys(node.toolbox({ chatId: 'v' }).toolbox));

// ── 1. A confined SPECIALIST asks for a power it lacks → an actionable, correctly-tagged request ──────────
test('a specialist requestAccess SURFACES with requester=specialist and grants nothing itself', async t => {
  const fa = mkRoot(t);
  const rootTb = fa.rootNode.toolbox({ chatId: 'c0' }).toolbox;
  await rootTb.spawnSpecialist.run({ name: 'menu-scout', domain: 'menus', powers: ['web'], instructions: 'find menus' });
  const spec = fa.specialistFor('menu-scout', 'root');
  assert.ok(spec, 'specialist exists');
  assert.ok(!spec.node.powers.has('notes'), 'the specialist does NOT hold notes yet');
  assert.ok(!verbsOf(spec.node).has('searchNotes'), 'and its toolbox has no notes verb');

  // the confined specialist asks for `notes` (a power it lacks)
  const rv = await spec.node.toolbox({ chatId: 'x' }).toolbox.requestAccess.run({ power: 'notes', why: 'read the menu notes' });
  assert.ok(rv.ok && rv.accessRequest, 'requestAccess returned an accessRequest');
  const ar = rv.accessRequest;
  assert.equal(ar.power, 'notes');
  assert.ok(ar.requester, 'the accessRequest carries a requester identity');
  assert.equal(ar.requester.kind, 'specialist', 'requester.kind === specialist (the card widens the specialist)');
  assert.equal(ar.requester.id, spec.id, 'requester.id names the specialist');
  assert.equal(ar.requester.owner, 'root', 'requester.owner is the grantor namespace');

  // INVARIANT: the request granted NOTHING — the specialist still lacks notes.
  const still = fa.specialistFor('menu-scout', 'root');
  assert.ok(!still.node.powers.has('notes'), 'requestAccess is INERT — no self-grant');

  // NEVER-AUTO (structural): the request is not a proposal — no type/id an auto-rule could ever key on.
  assert.equal(ar.type, undefined, 'accessRequest has no proposal type (can never be "don\'t ask again")');
  assert.equal(ar.id, undefined, 'accessRequest has no proposal id');
});

// ── 2. The owner grants it → the SPECIALIST's OWN bundle widens (not a chat cap) ──────────────────────────
test('grantSpecialistPower widens the specialist by-reference; it now holds the power\'s verbs', async t => {
  const fa = mkRoot(t);
  const rootTb = fa.rootNode.toolbox({ chatId: 'c0' }).toolbox;
  await rootTb.spawnSpecialist.run({ name: 'menu-scout', domain: 'menus', powers: ['web'], instructions: 'find menus' });
  const before = fa.specialistFor('menu-scout', 'root');
  assert.ok(!before.node.powers.has('notes'));

  const g = fa.grantSpecialistPower('menu-scout', 'root', 'notes');
  assert.ok(g.ok, 'grant succeeded');
  assert.ok(g.powers.includes('notes') && g.powers.includes('web'), 'the specialist now holds notes + keeps web');

  // Re-fetch the (re-registered, same-slug) node — its authority actually changed.
  const after = fa.specialistFor('menu-scout', 'root');
  assert.ok(after.node.powers.has('notes'), 'node.powers now includes notes');
  assert.deepEqual([...after.node.powers].sort(), [...after.node.bundle.names()].sort(), 'name-set is still DERIVED from the held bundle (by-reference)');
  const verbs = verbsOf(after.node);
  assert.ok(verbs.has('searchNotes') && verbs.has('readNote'), 'the notes VERBS are now in its toolbox');
  assert.ok(verbs.has('fetchUrl'), 'web verbs are retained');
});

// ── 3. CEILING: a specialist can NEVER exceed its GRANTOR's authority ─────────────────────────────────────
test('a tenant specialist cannot be widened past its owner\'s (grantor\'s) ring', async t => {
  const fa = mkRoot(t);
  // A tenant cap that holds web + specialists + notes — but NOT host.
  const tcap = fa.mintScopedCap({ powers: ['web', 'specialists', 'notes'], label: 'Tenant' });
  const tenantOwner = ownerKeyForCap(tcap.swiss);
  // The tenant spawns a specialist confined to just web.
  await fa.nodeFor(tcap.swiss).toolbox({ chatId: 't' }).toolbox.spawnSpecialist.run({ name: 'tenant-helper', domain: 'help', powers: ['web'], instructions: 'help' });
  const spec = fa.specialistFor('tenant-helper', tenantOwner);
  assert.ok(spec, 'tenant specialist exists in the tenant namespace');

  // Grant a power the GRANTOR HOLDS (notes) → allowed.
  const ok = fa.grantSpecialistPower(spec.id, tenantOwner, 'notes');
  assert.ok(ok.ok && ok.powers.includes('notes'), 'granting a power the tenant HOLDS widens the specialist');

  // Grant a power the GRANTOR LACKS (host) → REFUSED, fail-closed.
  const bad = fa.grantSpecialistPower(spec.id, tenantOwner, 'host');
  assert.ok(!bad.ok, 'granting a power the tenant does NOT hold is refused');
  assert.ok(bad.ceilingExceeded, 'the refusal is a ceiling violation');
  const after = fa.specialistFor('tenant-helper', tenantOwner);
  assert.ok(!after.node.powers.has('host'), 'the specialist never gained host — it cannot exceed its grantor');
});

// ── 4. Regression: the TOP-CHAT rescope path still widens a chat cap in place ─────────────────────────────
test('the top-chat rescope path still works (a chat requester widens the chat cap)', async t => {
  const fa = mkRoot(t);
  const scoped = fa.mintScopedCap({ powers: ['web'], label: 'a chat' });
  assert.ok(!fa.nodeFor(scoped.swiss).powers.has('notes'));
  const rc = fa.rescopeCap(scoped.swiss, ['web', 'notes']);
  assert.ok(rc.ok && rc.powers.includes('notes'), 'rescopeCap widened the chat cap');
  assert.ok(fa.nodeFor(scoped.swiss).powers.has('notes'), 'the SAME-swiss chat node now holds notes');
});

// ── 5. A chat (non-specialist) requestAccess is tagged kind=chat (routes to rescope, not a specialist widen) ─
test('a scoped-cap chat requestAccess is tagged requester.kind=chat', async t => {
  const fa = mkRoot(t);
  const scoped = fa.mintScopedCap({ powers: ['web'], label: 'plain chat' });
  const rv = await fa.nodeFor(scoped.swiss).toolbox({ chatId: 'c' }).toolbox.requestAccess.run({ power: 'notes', why: 'need notes' });
  assert.equal(rv.accessRequest.requester.kind, 'chat', 'a scoped chat cap is a chat requester');
});
