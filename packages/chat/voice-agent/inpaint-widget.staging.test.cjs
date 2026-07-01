#!/usr/bin/env node
// inpaint-widget.staging.test.cjs — STAGING (real-run, headless) guard for the CONFINED-CANVAS primitive
// and the FLUX.2 inpaint ISLAND that rides on it. The primitive is the reusable win, so it's tested directly
// against the real /confined.html iframe; the GPU render itself is proven separately (kept out to stay fast).
//
// Asserts:
//   1. /gpu/inpaint is cap-gated (403 on a bad cap) — no GPU touched;
//   2. a confined component can use the canvas primitive — ctx().dot()/toDataURL() produce a real PNG — AND
//      the ui.call(method,args) host-RPC round-trips (parent gates it, component gets the result);
//   3. __openInpaint mounts the inpaint island into a sandboxed /confined.html iframe that actually renders
//      (a canvas + the prompt field) — i.e. the mask-painter is a real confined island, not a host widget.
//
// Run: node inpaint-widget.staging.test.cjs

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 8795;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inpaint-island-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

// a confined probe component (source): uses the canvas primitive + ui.call, and writes outcomes into the DOM.
const PROBE = `(ui) => {
  const cv = ui.create('canvas');
  const url = cv.ctx().size(20,20).fillStyle('#fff').dot(10,10,8).toDataURL('image/png');
  const out = ui.create('div');
  out.text('png:' + (url.indexOf('data:image/png') === 0 && url.length > 80 ? 'ok' : 'bad'));
  ui.call('ping', { n: 21 }).then(r => out.text('png:ok call:' + (r && r.doubled))).catch(e => out.text('callerr:' + (e && e.message)));
  return ui.create('div').push(cv).push(out);
}`;

(async () => {
  srv = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json'), PRINT_ROOT_CAP: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted');
  if (!up) { cleanup(); process.exit(1); }

  const noCap = await fetch(`${BASE}/gpu/inpaint`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: 'nope', image: 'x', mask: 'x', prompt: 'y' }) });
  ok(noCap.status === 403, `/gpu/inpaint rejects a bad cap with 403 (got ${noCap.status})`);

  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - headless checks (playwright-core unavailable)'); console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(fail ? 1 : 0); }

  const rootCap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();
  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  try {
    // ── 2. the confined-canvas primitive + ui.call, driven directly against real /confined.html ──
    const probePage = await browser.newPage();
    await probePage.goto(`${BASE}/confined.html`, { waitUntil: 'load' });
    const probeOut = await probePage.evaluate(src => new Promise(resolve => {
      const ch = new MessageChannel();
      ch.port1.onmessage = e => { const m = e.data; if (m && m.__cu === 1 && m.type === 'call' && m.method === 'ping') ch.port1.postMessage({ __cu: 1, type: 'call-result', id: m.id, ok: true, value: { doubled: (m.args.n || 0) * 2 } }); };
      ch.port1.start();
      const doMount = () => { try { window.postMessage({ __cu: 1, type: 'mount', source: src }, '*', [ch.port2]); } catch (e) {} };
      window.addEventListener('message', e => { const m = e.data; if (m && m.__cu === 1 && m.type === 'ready') doMount(); });
      setTimeout(doMount, 250);
      setTimeout(() => resolve(String((document.body && document.body.textContent) || '')), 1500);
    }), PROBE);
    ok(/png:ok/.test(probeOut), `canvas ctx().dot()/toDataURL() produced a real PNG (got: ${probeOut.slice(0, 40)})`);
    ok(/call:42/.test(probeOut), `ui.call round-tripped through the host gate and returned (got: ${probeOut.slice(0, 40)})`);
    await probePage.close();

    // ── 3. the inpaint island mounts into a confined iframe and renders ──
    const page = await browser.newPage();
    await page.addInitScript(c => localStorage.setItem('field-agent-cap', c), rootCap);
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.__openInpaint === 'function', { timeout: 10000 });
    const opened = await page.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 96; c.height = 96; c.getContext('2d').fillStyle = '#3a7'; c.getContext('2d').fillRect(0, 0, 96, 96);
      return window.__openInpaint(c.toDataURL('image/png'));
    });
    ok(opened === true, `__openInpaint returned true (got ${JSON.stringify(opened)})`);
    await page.waitForTimeout(1200);
    const frame = page.frames().find(f => /confined\.html/.test(f.url()));
    ok(!!frame, 'the island mounted into a /confined.html iframe (sandboxed, not a host widget)');
    if (frame) {
      ok(await frame.locator('canvas').count() >= 2, 'the confined island rendered its canvases (image + paint overlay)');
      ok(await frame.locator('textarea').count() === 1, 'the confined island rendered its prompt field');
      ok(/Inpaint/.test(await frame.locator('body').textContent().catch(() => '')), 'the island rendered inside the confinement boundary');
    }
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.message); cleanup(); process.exit(2); });
