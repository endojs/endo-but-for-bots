#!/usr/bin/env node
// object-inspector.staging.test.cjs — STAGING proof of the interactive object inspector (rung 1 of the
// blossom loop): node.cap exposes objectsList/objectCall (objects-power-gated), and the client inspector
// lists a live object's methods, calls one, and renders the result as a collapsible value TREE — not
// [object Object]. (Uses whatever objects are in the real inventory; gracefully no-ops if empty.)
//
// Run: node object-inspector.staging.test.cjs   (exits non-zero on failure; SKIPs render w/o chromium)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 20000 + (process.pid % 20000); // T-TEST-2: PID-derived port (unique per node --test child); never a fixed 879x
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inspector-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
const rpc = (cap, method, args) => fetch(`${BASE}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ swissnum: cap, method, args }) }).then(r => r.json());

(async () => {
  srv = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json'),
      FORKS_STORE: path.join(tmp, 'forks.json'), PRINT_ROOT_CAP: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted');
  if (!up) { cleanup(); process.exit(1); }
  const cap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  // objectsList via /rpc (the introspection surface)
  const list = await rpc(cap, 'objectsList', []);
  ok(list.ok && Array.isArray(list.result), 'objectsList returns the inventory over /rpc');
  const obj = (list.result || [])[0];
  if (!obj) { console.log('  SKIP - inventory empty (no accepted objects to inspect)'); console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(fail ? 1 : 0); }
  ok(obj.name && Array.isArray(obj.methods), `inventory object self-describes: ${obj.name} (${obj.methods.join('/')})`);

  // objectCall describe → a JSON-SAFE structured value (no [object Object], no raw remotable)
  const dm = obj.methods.includes('describe') ? 'describe' : obj.methods[0];
  const called = await rpc(cap, 'objectCall', [obj.name, dm, []]);
  ok(called.ok && called.result && called.result.ok && called.result.value !== undefined, `objectCall ${dm}() returns a structured value`);
  ok(JSON.stringify(called.result.value).indexOf('[object Object]') === -1, 'the value is structured (NOT [object Object])');

  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - browser render (no chromium)'); }
  else {
    const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
    try {
      const page = await browser.newPage();
      await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
      await page.goto(`${BASE}/`, { waitUntil: 'load' }); await sleep(1500);
      await page.evaluate(n => window.objectInspector(n), obj.name); await sleep(900);
      const m = await page.evaluate(() => { const md = document.getElementById('qrmodal'); return { title: !!md && md.textContent.length > 0, methods: md ? md.querySelectorAll('.insp-m').length : 0 }; });
      ok(m.methods > 0, `the inspector modal lists the object's methods (${m.methods})`);
      await page.evaluate(d => { const b = Array.from(document.querySelectorAll('.insp-m')).find(x => x.textContent.includes(d)); if (b) b.click(); }, dm);
      await page.waitForFunction(() => { const o = document.getElementById('insp-result'); return o && o.querySelector('div') && !/^—/.test(o.textContent); }, { timeout: 6000 }).catch(() => {});
      const tree = await page.evaluate(() => { const o = document.getElementById('insp-result'); return { hasTree: !!(o && o.querySelector('div')), noObjObj: o ? o.textContent.indexOf('[object Object]') === -1 : true }; });
      ok(tree.hasTree && tree.noObjObj, 'calling a method renders an interactive value TREE (not [object Object])');
      await page.close();
    } finally { await browser.close(); }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); cleanup(); process.exit(2); });
