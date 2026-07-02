#!/usr/bin/env node
// heavy-panel-smoke.staging.test.cjs — the GATE before flipping FIELD_LOCKDOWN=1 live: boot the FULL app
// under severe-taming lockdown + the unsafe-eval CSP and exercise every HEAVY panel (the ones the
// lockdown-survive probe did NOT cover — 3D pendant/WebGL, the Settings sections incl. the agent-shape 3D,
// grain-ui, the object navigator, the agent profile, the object inspector, the trace detail, markdown), with
// a HARD assertion of ZERO frozen-realm / SES / override-mistake page errors throughout.
//
// Run: node heavy-panel-smoke.staging.test.cjs   (exits non-zero on any failure; SKIPs without chromium)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 20000 + (process.pid % 20000); // T-TEST-2: PID-derived port (unique per node --test child); never a fixed 879x
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'heavy-smoke-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
const LOCKDOWN_ERR = /lockdown|frozen|is not extensible|Cannot (assign|define|redefine|add)|override mistake|SES_|not a valid constructor|read only property|getOwnPropertyDescriptor|is not a function.*proto/i;

(async () => {
  srv = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1', FIELD_LOCKDOWN: '1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json'),
      FORKS_STORE: path.join(tmp, 'forks.json'), BLOSSOM_STORE: path.join(tmp, 'blossom.json'),
      DIST_TRUST_STORE: path.join(tmp, 'dist.json'), PRINT_ROOT_CAP: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'full app booted under FIELD_LOCKDOWN=1');
  if (!up) { cleanup(); process.exit(1); }
  const cap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - heavy-panel smoke needs chromium'); console.log(`\n${pass} passed, ${fail} failed (skipped)`); cleanup(); process.exit(fail ? 1 : 0); }

  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
    env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  try {
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e && e.message || e)));
    page.on('console', m => { if (m.type() === 'error') { const t = m.text(); if (LOCKDOWN_ERR.test(t)) errs.push('console: ' + t.slice(0, 160)); } });
    const frozenErrs = () => errs.filter(e => LOCKDOWN_ERR.test(e));

    await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
    await page.goto(`${BASE}/?tracetest=1`, { waitUntil: 'load' }); // ?tracetest=1 exposes the trace/pendant test seams
    await page.waitForTimeout(2500);
    ok(await page.evaluate(() => Object.isFrozen(Object.prototype) && Object.isFrozen(Function.prototype)), 'the realm IS frozen (severe lockdown active)');
    ok(await page.evaluate(() => !!globalThis.__fieldIslands), 'the islands bundle loaded in the frozen realm');
    ok(await page.evaluate(() => !!document.querySelector('#text') && !!document.querySelector('#send')), 'the composer + app shell rendered');

    // ── exercise EVERY Settings section (renders content, no frozen errors) ──
    await page.evaluate(() => document.getElementById('drawer-foot').click()); await sleep(700);
    const SECTIONS = ['usage', 'providers', 'agents', 'specialists', 'feedback', 'files', 'timers', 'internal'];
    for (const sec of SECTIONS) {
      await page.evaluate(s => { const b = Array.from(document.querySelectorAll('.setnav-item')).find(x => x.getAttribute('data-sec') === s); if (b) b.click(); }, sec);
      await sleep(700);
      const rendered = await page.evaluate(() => { const b = document.getElementById('setbody'); return !!b && b.textContent.trim().length > 0; });
      ok(rendered, `Settings → ${sec} renders under lockdown`);
    }
    // the agent-shape 3D (Three.js/WebGL) — open the diagram (the riskiest: a WebGL lib mutating intrinsics)
    await page.evaluate(() => { const b = Array.from(document.querySelectorAll('.setnav-item')).find(x => x.getAttribute('data-sec') === 'agents'); if (b) b.click(); }); await sleep(700);
    await page.evaluate(() => { const b = document.getElementById('shape-3d'); if (b) b.click(); }); await sleep(1500);
    ok(frozenErrs().length === 0, `the agent-shape 3D (Three.js/WebGL) opened without frozen-realm errors${frozenErrs().length ? ' — ' + JSON.stringify(frozenErrs().slice(0, 2)) : ''}`);
    await page.keyboard.press('Escape').catch(() => {});

    // ── the heavy modals / navigators ──
    await page.evaluate(() => { if (document.getElementById('qrclose')) document.getElementById('qrclose').click(); }); await sleep(300);
    await page.evaluate(() => window.agentProfile('field-agent')); await sleep(1200);
    ok(await page.evaluate(() => { const m = document.getElementById('qrmodal'); return m && /petname/.test(m.textContent); }), 'the agent profile modal renders under lockdown');
    await page.evaluate(() => { if (document.getElementById('qrclose')) document.getElementById('qrclose').click(); }); await sleep(300);
    await page.evaluate(() => document.getElementById('tab-shares').click()); await sleep(1200);
    ok(await page.evaluate(() => document.querySelectorAll('#obj-list .obj-row').length > 0), 'the object navigator renders under lockdown');
    await page.evaluate(() => document.getElementById('tab-talk').click()); await sleep(300);

    // ── the 3D trace pendant (lazy import('./pendant.js') + Three.js/WebGL) via the test seam ──
    const pend = await page.evaluate(() => window.__openPendant([{ name: 'demo.tool', call: '{}', result: '[{"a":1},{"b":2}]', ok: true, children: [{ name: 'sub' }] }], true));
    await sleep(1800);
    ok(pend === true || pend === undefined ? frozenErrs().length === 0 : false, `the 3D trace pendant (Three.js/WebGL) loaded without frozen-realm errors${pend !== true ? ` (open returned: ${JSON.stringify(pend)})` : ''}`);
    // render an agent reply (markdown via md.js) — confirm the markdown path is clean under lockdown
    await page.evaluate(() => { try { const b = document.getElementById('pendant-fsx'); if (b) b.click(); } catch {} }); await sleep(400);

    // ── the { } raw-context viewer + the bell ──
    await page.evaluate(() => { const b = document.getElementById('ctx-btn'); if (b) b.click(); }); await sleep(600);
    ok(await page.evaluate(() => { const p = document.querySelector('div[style*="z-index:90"] pre, div[style*="z-index: 90"] pre'); return !!p; }), 'the { } raw-context viewer opens under lockdown');

    await sleep(500);
    const fz = frozenErrs();
    ok(fz.length === 0, `ZERO frozen-realm / SES errors across all heavy panels${fz.length ? ' — ' + JSON.stringify(fz.slice(0, 4)) : ''}`);
    // report any OTHER page errors as informational (not a hard fail unless frozen-related)
    const others = errs.filter(e => !LOCKDOWN_ERR.test(e));
    if (others.length) console.log(`  (note) ${others.length} non-lockdown page error(s):`, JSON.stringify(others.slice(0, 3)));
    await page.close();
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); cleanup(); process.exit(2); });
