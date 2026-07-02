#!/usr/bin/env node
// blossom-loop.staging.test.cjs — STAGING proof of the EAGER blossom loop end-to-end on the client: spotting
// an object eagerly ensures a renderer for its interface, and once ready the inspector renders the object
// THROUGH the bespoke confined renderer (inline, under lockdown). Pre-seeds a renderer (a fork + a blossom
// registry entry keyed by the object's interface signature) so the test is deterministic — no LLM. The
// authoring path itself is covered by blossom.test.mjs (unit) + the live smoke.
//
// Run: node blossom-loop.staging.test.cjs   (exits non-zero on failure; SKIPs render w/o chromium)

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 20000 + (process.pid % 20000); // T-TEST-2: PID-derived port (unique per node --test child); never a fixed 879x
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blossom-loop-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

const METHODS = ['ping', 'status', 'describe'];
const sig = `sig-${crypto.createHash('sha256').update(`iface:object|${[...METHODS].sort().join(',')}`).digest('hex').slice(0, 16)}`;
const RENDERER = "(endowments, props) => endowments.h('div', { class: 'bespoke' }, 'BESPOKE-VIEW ' + (props.name || ''))";

(async () => {
  // seed the inventory object, a renderer FORK, and the blossom registry entry (ready) BEFORE boot
  const objectsFile = path.join(tmp, 'objects.json');
  const forksFile = path.join(tmp, 'forks.json');
  const blossomFile = path.join(tmp, 'blossom.json');
  fs.writeFileSync(objectsFile, JSON.stringify({ objects: [{ name: 'Widget', transport: 'http', origin: 'http://x.local', methods: METHODS, description: 'a seeded test object', addedAt: 'now' }] }));
  const stamp = new Date().toISOString();
  fs.writeFileSync(forksFile, JSON.stringify({ forks: { 'fork-rndr': { id: 'fork-rndr', name: 'Widget renderer', baseId: `blossom:${sig}`, owner: 'root', source: RENDERER, createdAt: stamp, updatedAt: stamp, history: [{ source: RENDERER, at: stamp, note: 'blossom' }] } }, shares: {} }));
  fs.writeFileSync(blossomFile, JSON.stringify({ renderers: { [sig]: { sig, status: 'ready', forkId: 'fork-rndr', name: 'Widget', methods: METHODS, at: stamp, completedAt: stamp } }, count: 1 }));

  srv = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1', FIELD_LOCKDOWN: '1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json'),
      OBJECTS_FILE: objectsFile, FORKS_STORE: forksFile, BLOSSOM_STORE: blossomFile, PRINT_ROOT_CAP: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted (seeded object + renderer, FIELD_LOCKDOWN=1)');
  if (!up) { cleanup(); process.exit(1); }
  const cap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  // /blossom/for finds the pre-seeded renderer for the object's interface signature
  const forR = await (await fetch(`${BASE}/blossom/for`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, methods: METHODS, kind: 'object' }) })).json();
  ok(forR.ok && forR.entry.status === 'ready' && forR.entry.sig === sig, 'the registry maps the object’s interface signature → a ready renderer');
  const ens = await (await fetch(`${BASE}/blossom/ensure`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, name: 'Widget', methods: METHODS, sample: {}, kind: 'object' }) })).json();
  ok(ens.ok && ens.entry.status === 'ready', 'ensure on an already-known interface returns the existing renderer (does NOT re-blossom)');

  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - browser render-through (no chromium)'); }
  else {
    const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
    try {
      const page = await browser.newPage();
      await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
      await page.goto(`${BASE}/`, { waitUntil: 'load' }); await sleep(2200);
      await page.evaluate(() => window.objectInspector('Widget'));
      // the inspector fires blossom → ready → renderSource the bespoke view inline (lockdown on)
      await page.waitForFunction(() => { const b = document.getElementById('insp-bloom'); return b && /BESPOKE-VIEW/.test(b.textContent || ''); }, { timeout: 8000 }).catch(() => {});
      const r = await page.evaluate(() => { const sec = document.getElementById('insp-bloom-sec'); const b = document.getElementById('insp-bloom'); return { sectionShown: sec && sec.style.display !== 'none', bespoke: b ? b.textContent : '', noIframe: b ? !b.querySelector('iframe') : true }; });
      ok(r.sectionShown, 'the 🌱 Custom view section appears on the inspector');
      ok(/BESPOKE-VIEW Widget/.test(r.bespoke), `the object renders THROUGH the bespoke confined renderer inline — got: ${JSON.stringify(r.bespoke.slice(0, 40))}`);
      ok(r.noIframe, 'rendered confined WITHOUT an iframe (in-tree renderSource)');
      await page.close();
    } finally { await browser.close(); }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); cleanup(); process.exit(2); });
