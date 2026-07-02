#!/usr/bin/env node
// pendant-subagents.staging.test.cjs — a STAGING (real-run, headless) guard that every SUB-AGENT
// (research / delegate / specialist / employed role) is promoted to its OWN stretched-octahedron tower
// in the 3D trace pendant — the parallel-lifeline "sequence diagram" the main agent already has.
//
// Regression this pins: `research` used to be EXCLUDED from tower promotion (it rendered as a fanned
// subtree), and sub-agents without child tools never promoted. This asserts the fix via the real
// pendant renderer (WebGL, ./pendant.js) opened on synthetic steps through the ?tracetest=1 seam.
//
// Run: node pendant-subagents.staging.test.cjs   (exits non-zero on any failure)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 20000 + (process.pid % 20000); // T-TEST-2: PID-derived port (unique per node --test child); never a fixed 879x
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pendant-sub-staging-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

(async () => {
  srv = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json'),
      PRINT_ROOT_CAP: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted');
  if (!up) { cleanup(); process.exit(1); }

  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - headless pendant checks (playwright-core unavailable)'); console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(fail ? 1 : 0); }

  const rootCap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();
  // one plain tool + the three sub-agent kinds (research / askSpecialist / employ). research carries its
  // subtree as children (as the saved trace does); each sub-agent must become its own tower.
  const steps = [
    { name: 'searchNotes', ok: true, detail: 'looked up notes' },
    { name: 'research', ok: true, detail: 'camera policy', children: [
        { name: '❓ adopted vs promised', ok: true, children: [{ name: 'fetchUrl', ok: true }] },
        { name: 'synthesize', ok: true }] },
    { name: 'askSpecialist', ok: true, detail: 'legal specialist', children: [{ name: 'fetchUrl', ok: true }, { name: 'web', ok: true }] },
    { name: 'employ', ok: true, detail: 'Research agent role', children: [{ name: 'web', ok: true }] },
  ];

  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
    env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  try {
    const page = await browser.newPage();
    await page.addInitScript(c => localStorage.setItem('field-agent-cap', c), rootCap);
    await page.goto(`${BASE}/?tracetest=1`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.__openPendant === 'function', { timeout: 12000 }).catch(() => {});
    const opened = await page.evaluate(s => window.__openPendant(s, true), steps);
    ok(opened === true, `pendant opened on synthetic steps (got: ${JSON.stringify(opened)})`);
    await page.waitForTimeout(1500); // let promotions + tweens settle
    const stats = await page.evaluate(() => window.__pendantStats());
    ok(stats && stats.subAgents === 3, `THREE sub-agents promoted to their own tower — got ${stats && stats.subAgents}: ${JSON.stringify(stats && stats.subAgentNames)}`);
    for (const n of ['research', 'askSpecialist', 'employ']) {
      ok(stats && Array.isArray(stats.subAgentNames) && stats.subAgentNames.includes(n), `"${n}" became its own stretched-octahedron tower`);
    }
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.message); cleanup(); process.exit(2); });
