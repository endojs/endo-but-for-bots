#!/usr/bin/env node
// pendant-fill.staging.test.cjs — STAGING guard + visual capture for the 3D trace "hyper-octahedron" body.
// Boots an isolated voice-agent, opens it headless as root with ?tracetest=1, drives window.__openPendant on
// synthetic steps (no LLM turn), lets the body spin for a couple seconds, and asserts NO pageerror fires —
// which catches a throw in the per-frame fill update (skin position write / computeVertexNormals). Also saves
// a PNG of the pendant so the fill + edge-colour consistency can be eyeballed.
//
// Run: node pendant-fill.staging.test.cjs   (exits non-zero on any failure; writes /tmp/pendant-fill.png)
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 20000 + (process.pid % 20000); // T-TEST-2: PID-derived port (unique per node --test child); never a fixed 879x
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.PENDANT_SHOT || '/tmp/pendant-fill.png';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pendantfill-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

const STEPS = [
  { name: 'haGet', ok: true, detail: 'living room', call: 'haGet("living room")', result: 'on' },
  { name: 'searchNotes', ok: true, detail: 'diet', call: 'searchNotes("diet")', result: '3 hits' },
  { name: 'webSearch', ok: true, detail: 'copenhagen', call: 'webSearch("copenhagen")', result: 'ok' },
  { name: 'delegate', ok: true, detail: 'opus', call: 'delegate("plan")', result: 'done', children: [{ name: 'readNote', ok: true }] },
];

(async () => {
  srv = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json'),
      SPECIALISTS_FILE: path.join(tmp, 'specialists.json'), PRINT_ROOT_CAP: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted');
  if (!up) { cleanup(); process.exit(1); }
  const rootCap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - headless (playwright-core unavailable)'); console.log(`\n✓ pendant-fill: ${pass} passed, ${fail} failed`); cleanup(); process.exit(fail ? 1 : 0); }

  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
    env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  const errs = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    page.on('pageerror', e => errs.push(e.message));
    // cap-hygiene: inject the cap via localStorage BEFORE navigation, never in the URL fragment.
    await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, rootCap);
    await page.goto(`${BASE}/?tracetest=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.__openPendant === 'function', { timeout: 15000 });
    const opened = await page.evaluate(steps => window.__openPendant(steps, true), STEPS); // fullscreen for a clean capture
    ok(opened === true, `__openPendant rendered the body (returned ${JSON.stringify(opened)})`);
    await sleep(2200); // let THREE render + spin several frames → the per-frame skin update runs many times
    ok(errs.length === 0, `no page errors while the hyper-octahedron animated (${errs.slice(0, 2).join(' | ') || 'none'})`);
    const wrap = await page.$('#pendant-wrap');
    await (wrap || page).screenshot({ path: OUT });
    ok(fs.existsSync(OUT) && fs.statSync(OUT).size > 2000, `screenshot written to ${OUT} (${fs.existsSync(OUT) ? fs.statSync(OUT).size : 0} bytes)`);
  } finally { await browser.close(); }

  console.log(`\n${fail ? '✗' : '✓'} pendant-fill staging: ${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); cleanup(); process.exit(1); });
