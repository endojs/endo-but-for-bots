// endowments.test.mjs — enforces the field agent's authority model
// (AUTHORITY-MODEL.md): EVERY endowment of the root bot is classified, its
// reversible flag matches its class, and every DESTRUCTIVE verb only proposes
// (it must create a pending confirmation and NOT perform the real action).
//
//   node --test packages/chat/voice-agent/endowments.test.mjs
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { POWERS, ALL_POWERS, makeFieldAgent } from './agent-caps.mjs';

// THE POLICY — every verb the root bot can hold, classified. This map is the
// contract. A power added to agent-caps without an entry here fails the first
// test below — that is the whole point of this suite. (See AUTHORITY-MODEL.md.)
const POLICY = {
  // read — observe only, free
  searchNotes: 'read', readNote: 'read', consult: 'read', fetchUrl: 'read', transcribeYoutube: 'read',
  haFind: 'read', haTree: 'read', haState: 'read',
  agentsList: 'read', agentStatus: 'read',
  fileList: 'read', fileRead: 'read', listTimers: 'read',
  contactsSearch: 'read', contactsGet: 'read',
  listSpecialists: 'read', listNotifications: 'read', kazputerStatus: 'read', search: 'read',
  listRoles: 'read', // the employable-role catalog (read-only menu)
  listConnectors: 'read', listCustomTools: 'read', // the wired/admitted tool menus (read-only)
  listScheduledTasks: 'read', // the recurring-task list (read-only)
  listChats: 'read', readChat: 'read', appState: 'read', // the app's own state (introspection)
  browseWeb: 'read', screenshotWeb: 'read', // headless browser: observe a (JS-rendered) page; SSRF-guarded
  webSearch: 'read', // Brave web search — find pages (read-only)
  research: 'read', // research team: plan → parallel search/read/distill → cited synthesis (read-only)
  componentHistory: 'read', componentReadFile: 'read', // a component's source git: version list + read a file
  systemMap: 'read', // the whole system's shape (powers/roles/specialists) — read-only introspection
  // reversible — speculative, abortable
  generateImage: 'reversible',
  // scoped-write — confined to the agent's own sandboxed storage (home folder, or its own component-source git)
  fileWrite: 'scoped-write', publishSite: 'scoped-write',
  componentWriteFile: 'scoped-write', forkComponent: 'scoped-write', revertComponent: 'scoped-write',
  // add — non-destructive additive write: only ever creates/appends a note, never overwrites or deletes
  // (the self-hosted private notepad; sensitive notes that never leave the network)
  addNote: 'add',
  // render — emit an EPHEMERAL UI widget/spec into the agent's own response. No persistence, no authority,
  // no external effect; the live data a widget shows flows separately + cap-gated. Safe even from a confined cap.
  showEntityStatus: 'render', showCountdowns: 'render', showChoices: 'render', showComponent: 'render',
  showThemePreview: 'render', // propose a global theme (a before/after preview the user accepts) — pure style data, no authority
  // notify — immediate, low blast radius (incl. enqueuing a task to a human-supervised code session)
  pushFeed: 'notify', pushPhone: 'notify', notify: 'notify', routeToDev: 'notify', askOperator: 'notify',
  scheduleWakeup: 'notify', repeatEvery: 'notify', cancelTimer: 'notify',
  messageOwner: 'notify', // back-channel ping to the owner's inbox + phone
  // creating/editing a recurring task is a scheduling action; the task's RUNS are themselves gated by
  // its tool ring (⊆ the creator's powers; each destructive verb in the ring still proposes)
  scheduleTask: 'notify', editScheduledTask: 'notify', cancelScheduledTask: 'notify',
  requestAccess: 'notify', // the escalation primitive: ASK the owner for a power (grants nothing itself)
  // dietician pipeline: scan/evaluate/build mutate only the persona's own contained DB (not published)
  dietScanArea: 'notify', dietEvaluateArea: 'notify', dietBuildMap: 'notify', dietStatus: 'read',
  retitleChat: 'notify', // rename a conversation — the user's own metadata, contained + reversible
  // propose — DESTRUCTIVE → confirmable proposal (agent proposes, human confirms)
  proposeNoteEdit: 'propose', proposeEmail: 'propose', proposeSubAgent: 'propose',
  proposeSystemPrompt: 'propose', haAct: 'propose',
  proposeAddContact: 'propose', proposeEditContact: 'propose',
  proposeSpawnSpecialist: 'propose', proposeGiveKazputer: 'propose',
  proposeKazputerSetting: 'propose', proposeKazputerCoins: 'propose',
  dietRefreshSite: 'propose', // publishing a food guide is outward → confirm-gated
  proposeTool: 'propose', // admitting agent-authored CODE is security-sensitive → owner reviews + admits
  // coarse — the grant IS the authorization, no per-action confirm (by design): root over a
  // kernel-isolated sandbox (vmExec/agentExec), the operator's own host shell (hostExec — you hold
  // `host` ⇒ you ARE the operator), or an owner-wired/owner-admitted external tool (the wiring/review
  // step WAS the authorization; connectors inject keys server-side + are SSRF-guarded; custom tools
  // are SES-sandboxed)
  vmExec: 'coarse', agentExec: 'coarse', hostExec: 'coarse',
  callConnector: 'coarse', callCustomTool: 'coarse',
  // delegate — attenuated sub-bundle to a larger agent / a confined specialist / a role sub-agent
  delegateTask: 'delegate', askSpecialist: 'delegate', employ: 'delegate',
  // share — re-grant ONE held power as a named, revocable invite (monotonic delegation); revoke any time
  createInvite: 'share',
  shareTool: 'share', revokeToolShare: 'share', // share an admitted component as a revocable invite; revoke it
};
const REVERSIBLE_CLASSES = new Set(['reversible', 'delegate']); // manifest.reversible must be true iff in here

// every verb declared across all powers, plus the always-bound delegateTask + createInvite
const declaredVerbs = () => {
  const s = new Set(['delegateTask', 'createInvite', 'search']); // always-bound (not tied to a power)
  for (const p of ALL_POWERS) for (const v of POWERS[p].verbs) s.add(v);
  return [...s];
};

const mkRoot = () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-endow-'));
  // isolate auto-confirm: a fresh empty rules file, so destructive verbs ALWAYS
  // propose during the test regardless of any "don't ask again" rules on the host.
  return makeFieldAgent({ outDir, baseUrl: 'http://test.invalid', autoConfirmFile: path.join(outDir, 'auto-confirm.json'), specialistsFile: path.join(outDir, 'specialists.json') });
};
const OUTBOX = '/home/dan/obsidian/vault/the field/TADA/outbox';
const outboxSnapshot = () => { try { return fs.readdirSync(OUTBOX).sort().join('\n'); } catch { return ''; } };

test('every declared endowment verb is classified by the authority policy', () => {
  for (const v of declaredVerbs()) {
    assert.ok(POLICY[v], `verb "${v}" has no POLICY classification — add it to endowments.test.mjs + AUTHORITY-MODEL.md`);
  }
});

test('POWERS shape: each power has a label + non-empty verbs; ALL_POWERS matches', () => {
  for (const p of ALL_POWERS) {
    assert.equal(typeof POWERS[p].label, 'string', `${p} label`);
    assert.ok(Array.isArray(POWERS[p].verbs) && POWERS[p].verbs.length, `${p} verbs`);
  }
  assert.deepEqual([...ALL_POWERS].sort(), Object.keys(POWERS).sort());
});

test('root bot holds ALL powers; every manifest verb is classified + flagged consistently', () => {
  const fa = mkRoot();
  assert.ok(fa.rootNode, 'rootNode exists');
  for (const p of ALL_POWERS) assert.ok(fa.rootNode.powers.has(p), `root is missing power "${p}"`);
  const { manifest } = fa.rootNode.toolbox();
  for (const m of manifest) {
    const cls = POLICY[m.name];
    assert.ok(cls, `manifest verb "${m.name}" is unclassified`);
    assert.equal(!!m.reversible, REVERSIBLE_CLASSES.has(cls),
      `verb "${m.name}" (class ${cls}) reversible flag mismatch (manifest says ${!!m.reversible})`);
  }
});

test('DESTRUCTIVE verbs only PROPOSE — they create a pending proposal and do NOT fire the real action', async () => {
  const fa = mkRoot();
  const { toolbox } = fa.rootNode.toolbox();

  // proposeEmail must NOT send/draft until confirmed
  const before = outboxSnapshot();
  const r = await toolbox.proposeEmail.run({ to: 'nobody@example.invalid', subject: 'gate test', body: 'must not send' });
  assert.equal(r.proposed, true, 'proposeEmail returns a pending proposal');
  assert.ok(r.id, 'proposal carries an id');
  assert.ok(!r.sent && !r.drafted && !r.savedTo, 'proposeEmail did NOT perform the real action');
  const prop = fa.getProposal(r.id);
  assert.equal(prop.status, 'pending');
  assert.equal(prop.power, 'email');
  assert.equal(outboxSnapshot(), before, 'no email artifact was written before confirmation');

  // proposeSystemPrompt must NOT change the persona until confirmed
  const persona0 = fa.getPersona();
  const r2 = await toolbox.proposeSystemPrompt.run({ prompt: 'TEST — must not apply while unconfirmed' });
  assert.equal(r2.proposed, true, 'proposeSystemPrompt returns a pending proposal');
  assert.equal(fa.getPersona(), persona0, 'persona is unchanged by an unconfirmed proposal');

  // proposeNoteEdit must produce a proposal, not write the note
  const r3 = await toolbox.proposeNoteEdit.run({ path: 'the field/__endowment_test__.md', content: 'x', mode: 'overwrite' });
  assert.equal(r3.proposed, true, 'proposeNoteEdit returns a pending proposal');
  assert.equal(fs.existsSync('/home/dan/obsidian/vault/the field/__endowment_test__.md'), false, 'no note was written');

  // proposeAddContact must never write a contact without confirmation. With a live address book it
  // PROPOSES (gate); in an env with no NextCloud creds the book isn't built, so it REFUSES. Either way
  // the invariant holds — NO contact is written unconfirmed. (The test must not depend on host creds.)
  const r4 = await toolbox.proposeAddContact.run({ name: 'Gate Test', email: 'gate@example.invalid' });
  assert.ok(!r4.handle, 'proposeAddContact never directly writes a contact');
  if (r4.proposed) {
    assert.ok(r4.id && fa.getProposal(r4.id).power === 'contacts', 'a live book gates the add via a contacts proposal');
    assert.ok(!r4.ok, 'the proposal itself performed no write');
  } else {
    assert.equal(r4.ok, false, 'with no address book built, proposeAddContact refuses (writing nothing)');
  }
});

test('addNote is ADDITIVE — it CREATES immediately (no proposal) and NEVER overwrites an existing note', async () => {
  const fa = mkRoot();
  const { toolbox } = fa.rootNode.toolbox();
  const folder = 'the field/TADA/__addnote_test__';
  const dir = `/home/dan/obsidian/vault/${folder}`;
  try {
    // (1) creates immediately — no proposal, the file is on disk with our content
    const r1 = await toolbox.addNote.run({ title: 'Gate Note', content: 'first body', folder });
    assert.equal(r1.created, true, 'addNote creates immediately (no confirmation step)');
    assert.ok(!r1.proposed, 'addNote did NOT mint a proposal — it is non-destructive');
    assert.ok(fs.existsSync(r1.path), 'the note file exists on disk');
    const c1 = fs.readFileSync(r1.path, 'utf8');
    assert.match(c1, /# Gate Note/, 'note carries its title as H1');
    assert.match(c1, /first body/, 'note carries its body');

    // (2) same title again must NOT clobber the first note — it uniquifies the filename
    const r2 = await toolbox.addNote.run({ title: 'Gate Note', content: 'second body', folder });
    assert.equal(r2.created, true, 'second create also succeeds');
    assert.notEqual(r2.path, r1.path, 'a same-titled note gets a NEW unique path, never the same file');
    assert.match(fs.readFileSync(r1.path, 'utf8'), /first body/, 'the FIRST note is untouched (never overwritten)');

    // (3) append:true adds to the end of the named note — still never removes the original content
    const r3 = await toolbox.addNote.run({ title: 'Gate Note', content: 'appended body', folder, append: true });
    assert.equal(r3.appended, true, 'append mode appends');
    const c3 = fs.readFileSync(r3.path, 'utf8');
    assert.match(c3, /first body/, 'append preserved the original content');
    assert.match(c3, /appended body/, 'append added the new content');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
