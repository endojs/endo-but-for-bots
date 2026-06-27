#!/usr/bin/env node
// subagent-lifeline.staging.test.cjs — STAGING guard for the 3D SEQUENCE DIAGRAM: each sub-agent (a
// delegateTask / askSpecialist / employ with children) becomes its OWN hyper-octahedron lifeline in its OWN
// column, with its tools descending on its own spine. Drives window.__openPendant on a synthetic trace that
// contains TWO sub-agents (each with children) and asserts NO pageerror fires across ~2.5s of animation —
// which catches a throw in the new per-frame updateBody (sub-agent skin/strut update) or promotion path.
// Writes a PNG so the parallel-lifeline layout can be eyeballed.
//
// Run: node subagent-lifeline.staging.test.cjs   (exits non-zero on failure; writes /tmp/subagent-lifeline.png)
const { spawn } = require('node:child_process');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const PORT = 8846; const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.PENDANT_SHOT || '/tmp/subagent-lifeline.png';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sublife-'));
let srv = null; let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

// a trace with TWO sub-agents (each its own lifeline + column) plus a normal root tool
const STEPS = [
  { name: 'searchNotes', ok: true, detail: 'the field', call: 'searchNotes("the field")', result: '4 hits' },
  { name: 'askSpecialist', ok: true, detail: 'researcher', call: 'askSpecialist("researcher","dig in")', result: 'done', children: [
    { name: 'searchNotes', ok: true, detail: 'q1', call: 'searchNotes("q1")', result: 'a' },
    { name: 'readNote', ok: true, detail: 'n1', call: 'readNote("n1")', result: 'b' },
    { name: 'fetchUrl', ok: true, detail: 'http://x', call: 'fetchUrl("http://x")', result: 'c' },
  ] },
  { name: 'delegateTask', ok: true, detail: 'builder', call: 'delegateTask("build it")', result: 'done', granted: ['home', 'web'], children: [
    { name: 'writeFile', ok: true, detail: 'index.html', call: 'writeFile("index.html")', result: 'ok' },
    { name: 'publishSite', ok: true, detail: 'publish', call: 'publishSite()', result: '/sites/x' },
  ] },
];

(async () => {
  srv = spawn('node', ['server.mjs'], { cwd: __dirname, env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1',
    SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'), PROJECTS_STORE: path.join(tmp, 'projects.json'),
    MEMO_RUNS_FILE: path.join(tmp, 'memo.json'), SPECIALISTS_FILE: path.join(tmp, 'specialists.json'), PRINT_ROOT_CAP: '1' }, stdio: ['ignore', 'ignore', 'ignore'] });
  let up = false; for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted'); if (!up) { cleanup(); process.exit(1); }
  const rootCap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  let chromium = null; try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - no chromium'); console.log(`\n${pass} passed, ${fail} failed (skipped)`); cleanup(); process.exit(fail ? 1 : 0); }
  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
    env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  const errs = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    page.on('pageerror', e => errs.push(e.message));
    await page.goto(`${BASE}/?tracetest=1#cap=${rootCap}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.__openPendant === 'function', { timeout: 15000 });
    const opened = await page.evaluate(steps => window.__openPendant(steps, true), STEPS);
    ok(opened === true, `__openPendant rendered the trace with two sub-agents (returned ${JSON.stringify(opened)})`);
    await sleep(2500); // many frames of per-frame updateBody for root + 2 sub-agent lifelines
    ok(errs.length === 0, `no page errors while the parallel sub-agent lifelines animated (${errs.slice(0, 2).join(' | ') || 'none'})`);
    const wrap = await page.$('#pendant-wrap');
    await (wrap || page).screenshot({ path: OUT });
    ok(fs.existsSync(OUT) && fs.statSync(OUT).size > 2000, `screenshot written to ${OUT} (${fs.existsSync(OUT) ? fs.statSync(OUT).size : 0} bytes)`);
  } finally { await browser.close(); }

  console.log(`\n${fail ? '✗' : '✓'} subagent-lifeline: ${pass} passed, ${fail} failed`);
  cleanup(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); cleanup(); process.exit(1); });
