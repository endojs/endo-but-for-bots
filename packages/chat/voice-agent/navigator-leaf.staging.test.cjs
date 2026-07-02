#!/usr/bin/env node
// navigator-leaf.staging.test.cjs — STAGING proof that the blossom/custom-view affordance is GENERALIZED to
// ANY navigator leaf (not just inventory objects). A leaf with no methods is keyed by its KIND — all contacts
// share one 'contact' renderer, all agents one 'agent' renderer — via sigOf([], kind). This test:
//   1. seeds a READY 'contact'-kind renderer (keyed by sigOf([], 'contact')) + its fork,
//   2. drives window.appendLeafBlossom('contact', 'Alice', {…}) → the inline custom view renders the leaf's
//      REAL data (props.value) confined (no iframe) + a 🎨 Revise button,
//   3. checks a leaf KIND with NO seeded renderer ('agent') → a 🎨 Generate button (no inline view),
//   4. checks blossomKindFor maps namespaces → kinds (contacts→contact, agents→agent, ha→ha:<domain>).
//
// Run: node navigator-leaf.staging.test.cjs   (exits non-zero on failure; SKIPs without chromium)

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 20000 + (process.pid % 20000); // T-TEST-2: PID-derived port (unique per node --test child); never a fixed 879x
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navleaf-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

// a methodLESS leaf keyed PURELY by its kind — all contacts share this signature
const sig = `sig-${crypto.createHash('sha256').update('iface:contact|').digest('hex').slice(0, 16)}`;
// the renderer reads props.value (the contact's data) → proves the inline view is fed the leaf's REAL data
const RENDERER = "(endowments, props) => endowments.h('div', { class: 'cv' }, 'CONTACT: ' + ((props.value && props.value.name) || 'EMPTY') + ' @ ' + ((props.value && props.value.org) || '?'))";

(async () => {
  const forksFile = path.join(tmp, 'forks.json');
  const blossomFile = path.join(tmp, 'blossom.json');
  const stamp = new Date().toISOString();
  fs.writeFileSync(forksFile, JSON.stringify({ forks: { 'fork-cv': { id: 'fork-cv', name: 'contact renderer', baseId: `blossom:${sig}`, owner: 'root', source: RENDERER, createdAt: stamp, updatedAt: stamp, history: [{ source: RENDERER, at: stamp, note: 'blossom' }] } }, shares: {} }));
  fs.writeFileSync(blossomFile, JSON.stringify({ renderers: { [sig]: { sig, status: 'ready', forkId: 'fork-cv', name: 'Alice', kind: 'contact', methods: [], at: stamp, completedAt: stamp } }, count: 1 }));

  srv = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1', FIELD_LOCKDOWN: '1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json'),
      FORKS_STORE: forksFile, BLOSSOM_STORE: blossomFile, PRINT_ROOT_CAP: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted (seeded contact-kind renderer, FIELD_LOCKDOWN=1)');
  if (!up) { cleanup(); process.exit(1); }
  const cap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  // server-side: a methodLESS contact leaf resolves to the kind-keyed renderer
  const forR = await (await fetch(`${BASE}/blossom/for`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, methods: [], kind: 'contact' }) })).json();
  ok(forR.ok && forR.entry && forR.entry.status === 'ready' && forR.entry.sig === sig, 'a methodless contact leaf maps to the kind-keyed renderer (all contacts share it)');
  const forA = await (await fetch(`${BASE}/blossom/for`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, methods: [], kind: 'agent' }) })).json();
  ok(forA.ok && (!forA.entry || forA.entry.status !== 'ready'), 'a different leaf kind (agent) does NOT share the contact renderer');

  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - browser render-through (no chromium)'); console.log(`\n${pass} passed, ${fail} failed (skipped browser)`); cleanup(); process.exit(fail ? 1 : 0); }

  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  try {
    const page = await browser.newPage();
    await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
    await page.goto(`${BASE}/`, { waitUntil: 'load' }); await sleep(2200);

    // blossomKindFor maps navigator namespaces → leaf kinds
    const kinds = await page.evaluate(() => ({
      contact: window.blossomKindFor('contacts', { name: 'Alice' }),
      agent: window.blossomKindFor('agents', { name: 'scoped-x' }),
      ha: window.blossomKindFor('ha', { entity_id: 'light.kitchen' }),
    }));
    ok(kinds.contact === 'contact' && kinds.agent === 'agent' && kinds.ha === 'ha:light', `blossomKindFor maps ns→kind (got ${JSON.stringify(kinds)})`);

    // a CONTACT leaf with a ready renderer → inline custom view fed the leaf's real data + a Revise button
    await page.evaluate(() => { document.getElementById('obj-node').innerHTML = ''; return window.appendLeafBlossom('contact', 'Alice', { name: 'Alice', org: 'Acme' }); });
    await page.waitForFunction(() => /CONTACT: Alice/.test(document.getElementById('obj-node')?.textContent || ''), { timeout: 8000 }).catch(() => {});
    const c = await page.evaluate(() => { const n = document.getElementById('obj-node'); return { text: n ? n.textContent : '', noIframe: n ? !n.querySelector('iframe') : true, revise: !!Array.from((n || document).querySelectorAll('button')).find(b => /Revise/.test(b.textContent)) }; });
    ok(/CONTACT: Alice @ Acme/.test(c.text), `the contact leaf renders THROUGH the kind-keyed confined renderer fed its REAL data — got: ${JSON.stringify((c.text.match(/CONTACT:[^<]*/) || [c.text.slice(0, 40)])[0])}`);
    ok(c.noIframe, 'rendered confined inline (no iframe)');
    ok(c.revise, 'a 🎨 Revise button is offered (a renderer already exists for this kind)');

    // a leaf KIND with NO seeded renderer (agent) → a 🎨 Generate button, no inline view
    await page.evaluate(() => { document.getElementById('obj-node').innerHTML = ''; return window.appendLeafBlossom('agent', 'scoped-x', { name: 'scoped-x' }); });
    await page.waitForFunction(() => /Generate a custom view/.test(document.getElementById('obj-node')?.textContent || ''), { timeout: 6000 }).catch(() => {});
    const a = await page.evaluate(() => { const n = document.getElementById('obj-node'); return { gen: /Generate a custom view/.test(n?.textContent || ''), noView: !/CONTACT:/.test(n?.textContent || '') }; });
    ok(a.gen && a.noView, 'an unseen leaf kind offers a 🎨 Generate button (no inline view yet)');
    await page.close();
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); cleanup(); process.exit(2); });
