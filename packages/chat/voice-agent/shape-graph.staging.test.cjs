#!/usr/bin/env node
// shape-graph.staging.test.cjs — a STAGING (real-run) guard for the Settings → 🕸️ Agents "agent shape"
// graph: the static structural diagram of what an agent HOLDS (powers→verbs, specialists, employable roles).
// Distinct from the per-message trace (what it DID). Boots an ISOLATED voice-agent on a throwaway port (temp
// SEED_FILE/OUT_DIR — never touches the live root cap or state), then asserts:
//   1. POST /agent/shape with the root cap returns kind:'root' + powers[] (each with verbs[]) + roles[];
//      and is OWNER-ONLY (403 without a cap).
//   2. (headless, if chromium is available) opening Settings → Agents renders the power breakdown (the
//      power count matches the endpoint) and the 3D affordance opens the pendant — and CRUCIALLY the
//      rendered settings DOM leaks NO capability link / swissnum (cap-hygiene).
//
// Run: node shape-graph.staging.test.cjs   (exits non-zero on any failure)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 20000 + (process.pid % 20000); // T-TEST-2: PID-derived port (unique per node --test child); never a fixed 879x
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shape-staging-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
const CAP_LINK = /#(?:cap|k|agent)=[0-9a-f]{16,}/i; // a real authority link value
const SWISS = /\b[0-9a-f]{32}\b/i;                  // a bare swissnum (this stack's 32-hex form)

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
  const rootCap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  // ── 1. the endpoint: owner-only + the structural payload ──────────────────
  const noCap = await fetch(`${BASE}/agent/shape`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  ok(noCap.status === 403, `/agent/shape is owner-only — no cap → ${noCap.status} (want 403)`);

  const shape = await (await fetch(`${BASE}/agent/shape`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: rootCap }) })).json();
  ok(shape && shape.ok && shape.kind === 'root', `root cap → ok shape, kind:'root' (got ${shape && shape.kind})`);
  const powers = (shape && shape.powers) || [];
  ok(powers.length > 10, `shape carries the held powers (${powers.length})`);
  ok(powers.every(p => Array.isArray(p.verbs)), 'every power carries its verb leaves (verbs[] — the edges to tool nodes)');
  ok(powers.some(p => p.verbs.length > 0), 'at least one power has verbs (the fan-out has leaves)');
  ok(Array.isArray(shape.roles) && shape.roles.length > 0, `employable roles present (${(shape.roles || []).length})`);
  ok(!CAP_LINK.test(JSON.stringify(shape)) && !SWISS.test(JSON.stringify(shape)), 'shape payload leaks NO capability link / swissnum');

  // ── 2. the rendered Settings → Agents view (headless) ─────────────────────
  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) {
    console.log('  SKIP - headless render check (playwright-core unavailable); endpoint asserted above');
  } else {
    const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
    try {
      const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
      page.on('pageerror', e => console.error('  [pageerror]', e.message));
      // cap-hygiene: inject the cap via localStorage BEFORE navigation, never in the URL fragment.
      await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, rootCap);
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      // wait for boot to set isRoot (settings is owner-gated)
      await page.waitForFunction(() => document.getElementById('drawer-foot'), { timeout: 15000 });
      await sleep(1500);
      // open Settings → click the 🕸️ Agents nav item → wait for the shape body to populate
      await page.evaluate(() => document.getElementById('drawer-foot').click());
      await page.waitForSelector('.setwrap', { timeout: 8000 });
      await page.evaluate(() => { const b = document.querySelector('.setnav-item[data-sec="agents"]'); if (b) b.click(); });
      await page.waitForFunction(() => { const h = document.getElementById('shape-body'); return h && /Powers/.test(h.textContent || '') && h.querySelectorAll('.share').length > 0; }, { timeout: 8000 });

      const rendered = await page.evaluate(() => {
        const host = document.getElementById('shape-body');
        const secs = [...host.querySelectorAll('.set-sec')];
        const powerSec = secs[0];
        return {
          powerRows: powerSec ? powerSec.querySelectorAll('.share').length : 0,
          headerCount: (host.textContent.match(/Powers\s*·\s*(\d+)/) || [])[1],
          chips: host.querySelectorAll('.pill').length,
          rolesShown: host.textContent.includes('Employable roles'),
          settingsHtml: document.querySelector('.setwrap').innerHTML,
        };
      });
      ok(rendered.powerRows >= Math.min(powers.length, 30), `Settings → Agents renders the power rows (${rendered.powerRows}; endpoint had ${powers.length})`);
      ok(String(rendered.headerCount) === String(powers.length), `the "Powers · N" header matches the endpoint (${rendered.headerCount} === ${powers.length})`);
      ok(rendered.chips > 0, `verb/role chips render (${rendered.chips})`);
      ok(rendered.rolesShown, 'the employable-roles section renders');
      ok(!CAP_LINK.test(rendered.settingsHtml) && !SWISS.test(rendered.settingsHtml), 'the rendered Settings DOM leaks NO capability link / swissnum (cap-hygiene)');

      // the 🧊 3D affordance opens the pendant with the held-authority graph
      await page.evaluate(() => document.getElementById('shape-3d').click());
      await sleep(1200);
      const threeD = await page.evaluate(() => {
        const w = document.getElementById('pendant-wrap');
        return { shown: !!w && !w.classList.contains('hide'), fs: !!w && w.classList.contains('fs'), canvas: !!document.getElementById('pendant-canvas') };
      });
      ok(threeD.shown && threeD.canvas, 'the 🧊 3D diagram opens the pendant (visible canvas)');
      ok(threeD.fs, 'the 3D diagram opens fullscreen');
    } finally { await browser.close(); }
  }

  console.log(`\n${fail ? '✗' : '✓'} shape-graph staging: ${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); cleanup(); process.exit(1); });
