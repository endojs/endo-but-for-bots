#!/usr/bin/env node
// confinement.staging.test.cjs — a STAGING (real-run) regression guard for the load-bearing controls that
// confine an agent-authored component (Tier 2). These two controls ARE the entire boundary; a future edit
// that relaxes the /confined.html CSP (adds connect-src / unsafe-eval, drops default-src 'none') or adds
// allow-same-origin to the component iframe would SILENTLY open the escape — only a header/attribute
// assertion catches it (per the Tier-2 adversarial review).
//
// It boots an ISOLATED voice-agent on a throwaway port (temp SEED_FILE/OUT_DIR/stores — never touches the
// live root cap or state), then asserts:
//   1. the SERVED /confined.html response CSP header is locked down (default-src 'none'; no connect-src; no
//      unsafe-eval; has frame-ancestors),
//   2. (headless, if chromium is available) a real broken-out component renders at /c/<id> inside an iframe
//      whose sandbox attribute is EXACTLY "allow-scripts" (no allow-same-origin), and that the framed
//      document is cross-origin OPAQUE (reading window.parent.document from inside throws).
//
// Run: node confinement.staging.test.cjs   (exits non-zero on any failure)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 20000 + (process.pid % 20000); // T-TEST-2: PID-derived port (unique per node --test child); never a fixed 879x
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'confine-staging-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

(async () => {
  // ── boot an isolated instance ─────────────────────────────────────────────
  srv = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json'),
      PRINT_ROOT_CAP: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  // wait for listen (up to ~30s)
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted');
  if (!up) { cleanup(); process.exit(1); }

  // ── 1. the SERVED CSP header on /confined.html ────────────────────────────
  const res = await fetch(`${BASE}/confined.html`);
  const csp = res.headers.get('content-security-policy') || '';
  ok(/default-src\s+'none'/.test(csp), `CSP has default-src 'none' (network backstop) — got: ${csp.slice(0, 90)}`);
  ok(!/connect-src/.test(csp), 'CSP does NOT grant connect-src (no fetch/XHR/WS/EventSource egress)');
  ok(!/unsafe-eval/.test(csp), 'CSP does NOT grant unsafe-eval');
  ok(/frame-ancestors/.test(csp), 'CSP pins frame-ancestors');
  ok(!/img-src[^;]*https?:/.test(csp), 'CSP img-src is not an external exfil channel (data: only)');

  // ── 2. the rendered iframe sandbox attribute + cross-origin opacity ───────
  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) {
    console.log('  SKIP - headless sandbox-attr check (playwright-core unavailable); CSP header asserted above');
  } else {
    const rootCap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();
    // break out a tiny component, then render it via the real standalone /c/<id> path
    const bo = await (await fetch(`${BASE}/components/break-out`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cap: rootCap, name: 'Confinement Probe', source: "(ui) => ui.create('div').push([ui.create('h2').text('PROBE-OK')])", cells: [] }) })).json();
    ok(bo && bo.ok && bo.id, 'broke out a probe component');
    const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
    try {
      const page = await browser.newPage();
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      await page.evaluate(c => localStorage.setItem('field-agent-cap', c), rootCap);
      await page.goto(`${BASE}/c/${bo.id}`, { waitUntil: 'load' });
      await page.waitForTimeout(1500);
      const sandbox = await page.locator('.gw-component iframe').getAttribute('sandbox');
      ok(sandbox === 'allow-scripts', `component iframe sandbox is EXACTLY "allow-scripts" — got: ${JSON.stringify(sandbox)}`);
      ok(!(sandbox || '').includes('allow-same-origin'), 'component iframe does NOT grant allow-same-origin (stays opaque-origin)');
      const frame = page.frames().find(f => f !== page.mainFrame());
      const probe = frame ? await frame.evaluate(() => { try { void window.parent.document; return 'READABLE'; } catch (e) { return 'blocked:' + e.name; } }) : 'no-frame';
      ok(/^blocked:/.test(probe), `framed doc cannot read window.parent.document (cross-origin opaque) — got: ${probe}`);
      const body = frame ? await frame.locator('body').textContent() : '';
      ok(/PROBE-OK/.test(body) && !/use strict/.test(body), 'the confined component actually rendered (boundary does not break the feature)');
    } finally { await browser.close(); }
    // Clean up the probe so it never pollutes the gallery (with COMPONENT_GIT_DIR isolation this is belt-and-suspenders).
    try { await fetch(`${BASE}/components/delete-ui`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: rootCap, id: bo.id }) }); } catch { /* best-effort */ }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.message); cleanup(); process.exit(2); });
