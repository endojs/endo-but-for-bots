// per-user-namespace.test.mjs — an INVITED user gets their own basic namespace, isolated from the owner's.
// Proves: the starter ring gives an invitee a usable HOME folder (their entry agent's home) but NOT the
// owner's notes; an invitee's home is a separate dir (cap-<label>) from the owner's; an invitee can read/write
// its OWN home and CANNOT read or traverse into the owner's home. (Notes are out of scope by design.)
//
//   node --test packages/chat/voice-agent/per-user-namespace.test.mjs
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// point the home base + config at a throwaway dir BEFORE the modules resolve their paths (field-config reads
// env at load), so the test never touches the real ~/.local/state.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-ns-'));
process.env.FIELD_HOME_BASE = path.join(TMP, 'home');
process.env.FIELD_CONFIG_DIR = path.join(TMP, 'config');
process.env.OBJECTS_FILE = path.join(TMP, 'objects.json');
process.env.SCOPED_CAPS_FILE = path.join(TMP, 'scoped.json');
process.env.PROJECTS_STORE = path.join(TMP, 'projects.json');

const { makeFieldAgent } = await import('./agent-caps.mjs');
const { STARTER_RING } = await import('./system-map.mjs');
const projects = await import('./projects.mjs');

const mk = () => makeFieldAgent({ outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fa-ns-out-')), baseUrl: 'http://test.invalid', autoConfirmFile: path.join(TMP, 'ac.json'), specialistsFile: path.join(TMP, 'spec.json') });
const verbNames = tb => Object.keys(tb || {});

test('the starter ring gives an invitee a HOME but never the owner\'s notes', () => {
  assert.ok(STARTER_RING.includes('home'), 'starter ring includes `home` (the entry agent\'s own folder)');
  assert.ok(!STARTER_RING.includes('notes'), 'starter ring excludes `notes` (the owner\'s vault stays the owner\'s)');
});

test('an invitee cap is non-root, holds home, and cannot reach notes verbs', () => {
  const fa = mk();
  const out = fa.mintScopedCap({ powers: STARTER_RING, label: 'Alice' });
  const node = fa.nodeFor(out.swiss);
  assert.ok(node && !node.isRoot, 'invitee node exists + is NOT root');
  assert.ok(node.powers.has('home'), 'invitee holds the home power');
  assert.ok(!node.powers.has('notes'), 'invitee does NOT hold notes');
  const { toolbox } = node.toolbox({ chatId: 'c1' });
  const verbs = verbNames(toolbox);
  assert.ok(verbs.includes('fileWrite') && verbs.includes('fileRead'), 'invitee has home file verbs');
  assert.ok(!verbs.includes('searchNotes') && !verbs.includes('readNote'), 'invitee has NO notes verbs');
});

test('an invitee writes to its OWN home (cap-<label>), disjoint from the owner root home', async () => {
  const fa = mk();
  const out = fa.mintScopedCap({ powers: STARTER_RING, label: 'Alice' });
  const inv = fa.nodeFor(out.swiss).toolbox({ chatId: 'c1' }).toolbox;
  const root = fa.rootNode.toolbox({ chatId: 'c0' }).toolbox;

  await root.fileWrite.run({ path: 'secret.txt', content: 'owner-only' });
  await inv.fileWrite.run({ path: 'mine.txt', content: 'alice-only' });

  const HOME = process.env.FIELD_HOME_BASE;
  const aliceDir = fs.readdirSync(HOME).find(d => d.startsWith('cap-') && /alice/i.test(d));
  assert.ok(aliceDir, `a per-invitee home dir (cap-…Alice) exists under ${HOME}, separate from root (got: ${fs.readdirSync(HOME).join(',')})`);
  assert.ok(fs.existsSync(path.join(HOME, aliceDir, 'mine.txt')), 'invitee file landed in ITS OWN home');
  assert.ok(fs.existsSync(path.join(HOME, 'root', 'secret.txt')), 'owner file landed in the ROOT home');
  assert.ok(!fs.existsSync(path.join(HOME, aliceDir, 'secret.txt')), 'owner file is NOT in the invitee home');
  assert.ok(!fs.existsSync(path.join(HOME, 'root', 'mine.txt')), 'invitee file is NOT in the owner home');
});

test('an invitee CANNOT read the owner\'s home (path traversal is jailed)', async () => {
  const fa = mk();
  const out = fa.mintScopedCap({ powers: STARTER_RING, label: 'Bob' });
  const inv = fa.nodeFor(out.swiss).toolbox({ chatId: 'c1' }).toolbox;
  const root = fa.rootNode.toolbox({ chatId: 'c0' }).toolbox;
  await root.fileWrite.run({ path: 'owner-secret.txt', content: 'top secret' });

  // every escape attempt must NOT yield the owner's content
  for (const p of ['../root/owner-secret.txt', '../../home/root/owner-secret.txt', '/home/dan/.config/field-agent/root.swiss']) {
    const r = await inv.fileRead.run({ path: p }).catch(e => ({ error: String(e && e.message || e) }));
    const leaked = r && typeof r === 'object' && JSON.stringify(r).includes('top secret');
    assert.ok(!leaked, `invitee read of "${p}" must NOT leak the owner's content (got: ${JSON.stringify(r).slice(0, 120)})`);
  }
});

test('projects are partitioned by OWNER — each owner sees only their own (legacy → root)', () => {
  const a = projects.createProject('Owner project', 'root');
  const b = projects.createProject('Guest project', 'u:alice');
  const c = projects.createProject('Bob project', 'u:bob');
  const rootIds = projects.listProjects('root').map(p => p.id);
  const aliceIds = projects.listProjects('u:alice').map(p => p.id);
  assert.ok(rootIds.includes(a.id) && !rootIds.includes(b.id) && !rootIds.includes(c.id), 'root sees only its own project');
  assert.ok(aliceIds.includes(b.id) && !aliceIds.includes(a.id) && !aliceIds.includes(c.id), 'alice sees only her own project');
  assert.equal(projects.projectOwner(b.id), 'u:alice', 'project records its owner');
  assert.equal(projects.listProjects().length >= 3, true, 'the unscoped list (scheduler) still sees ALL projects');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
