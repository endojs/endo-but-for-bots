#!/usr/bin/env node
// notes-folder-scope.staging.test.cjs — STAGING proof of LEAST-AUTHORITY notes: a chat granted notes scoped
// to ONE vault folder can read/list ONLY that subtree; everything else in the vault is invisible. The vault
// is an endo file/folder structure (noteFolders maps it), and a grant carries a `notesFolder` so the minimal
// folder — not the whole vault — is what's handed over.
//
// Run: node notes-folder-scope.staging.test.cjs   (exits non-zero on failure)

const { spawn } = require('node:child_process');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const PORT = 8845; const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notesfs-'));
const vault = path.join(tmp, 'vault');
let srv = null; let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
const post = (p, b) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
const rpc = (cap, method, args) => post('/rpc', { swissnum: cap, method, args });

// seed a vault: two sibling folders + a secret one — the grant will be scoped to ONLY "Projects/Alpha"
fs.mkdirSync(path.join(vault, 'Projects', 'Alpha'), { recursive: true });
fs.mkdirSync(path.join(vault, 'Projects', 'Beta'), { recursive: true });
fs.mkdirSync(path.join(vault, 'Private', 'Medical'), { recursive: true });
fs.writeFileSync(path.join(vault, 'Projects', 'Alpha', 'plan.md'), '# Alpha plan\nship the thing');
fs.writeFileSync(path.join(vault, 'Projects', 'Beta', 'plan.md'), '# Beta plan\nsecret beta');
fs.writeFileSync(path.join(vault, 'Private', 'Medical', 'notes.md'), '# Medical\nprivate');

(async () => {
  srv = spawn('node', ['server.mjs'], { cwd: __dirname, env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1', FIELD_LOCKDOWN: '1',
    OBSIDIAN_VAULT: vault, SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
    PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json'),
    SCOPED_CAPS_FILE: path.join(tmp, "scoped.json"), FORKS_STORE: path.join(tmp, 'forks.json'), BLOSSOM_STORE: path.join(tmp, 'blossom.json'), PRINT_ROOT_CAP: '1' }, stdio: ['ignore', 'ignore', 'ignore'] });
  let up = false; for (let i = 0; i < 90; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted with a temp vault'); if (!up) { cleanup(); process.exit(1); }
  const root = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  // GRANT: mint a chat cap with notes scoped to JUST "Projects/Alpha" (least authority) via /chat/rescope (empty swiss → fresh mint)
  const sc = await post('/chat/rescope', { cap: root, swiss: '', powers: ['notes'], label: 'alpha agent', notesFolder: 'Projects/Alpha' });
  ok(sc.scopedCap && Array.isArray(sc.powers) && sc.powers.includes('notes') && sc.notesFolder === 'Projects/Alpha', `minted a notes cap scoped to Projects/Alpha — got: ${JSON.stringify({ powers: sc.powers, notesFolder: sc.notesFolder })}`);
  const scoped = sc.scopedCap;

  // READ inside the granted folder (noteContent enforces the binding) → allowed
  const inA = await rpc(scoped, 'noteContent', ['Projects/Alpha/plan.md']);
  ok(inA.ok && /Alpha plan/.test(JSON.stringify(inA.result || inA)), 'the scoped agent CAN read its own folder (Projects/Alpha/plan.md)');
  // READ a sibling folder → REJECTED (escapes the share); the secret folder → REJECTED
  const inB = await rpc(scoped, 'noteContent', ['Projects/Beta/plan.md']);
  ok(!inB.ok && !/secret beta/.test(JSON.stringify(inB)), `a sibling folder (Projects/Beta) is REJECTED — got: ${JSON.stringify(inB).slice(0, 90)}`);
  const inPriv = await rpc(scoped, 'noteContent', ['Private/Medical/notes.md']);
  ok(!inPriv.ok && !/private/.test(JSON.stringify(inPriv.result || '')), 'an unrelated folder (Private/Medical) is REJECTED for the scoped agent');

  // notesTree for the scoped agent → can list ONLY its subtree; listing a sibling throws
  const treeA = await rpc(scoped, 'notesTree', ['Projects/Alpha']);
  ok(treeA.ok && /plan/.test(JSON.stringify(treeA.result || '')), 'notesTree lists the granted subtree (Projects/Alpha → plan)');
  const treeB = await rpc(scoped, 'notesTree', ['Projects/Beta']);
  ok(!treeB.ok, 'notesTree REFUSES to list a folder outside the granted subtree (Projects/Beta)');

  // the ROOT cap (whole vault) sees everything — sanity that scoping is the difference, not a broken vault
  const rootTree = await rpc(root, 'notesTree', ['']);
  const rf = JSON.stringify((rootTree.result && rootTree.result.children) || rootTree.result || rootTree);
  ok(rootTree.ok && /Projects/.test(rf) && /Private/.test(rf), 'the root cap (whole vault) still sees every top-level folder');

  console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); cleanup(); process.exit(2); });
