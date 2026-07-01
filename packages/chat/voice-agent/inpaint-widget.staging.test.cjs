#!/usr/bin/env node
// inpaint-widget.staging.test.cjs — a STAGING (real-run, headless) guard for the FLUX.2 inpaint widget's
// wiring: the mask-paint surface loads an image, paints a mask, and gates Generate on image+mask+prompt;
// and the /gpu/inpaint endpoint is cap-gated. (The real GPU render is proven separately — this stays fast
// + deterministic by NOT calling the GPU.)
//
// Run: node inpaint-widget.staging.test.cjs   (exits non-zero on any failure)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 8795;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inpaint-widget-'));
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

  // ── endpoint is cap-gated (no GPU touched) ──────────────────────────────────
  const noCap = await fetch(`${BASE}/gpu/inpaint`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: 'not-a-real-cap', image: 'x', mask: 'x', prompt: 'y' }) });
  ok(noCap.status === 403, `/gpu/inpaint rejects a bad cap with 403 (got ${noCap.status})`);

  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - headless widget checks (playwright-core unavailable)'); console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(fail ? 1 : 0); }

  const rootCap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();
  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  try {
    const page = await browser.newPage();
    await page.addInitScript(c => localStorage.setItem('field-agent-cap', c), rootCap);
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.__openInpaint === 'function', { timeout: 10000 });

    // a 64x64 test image (data URL) made in-page, opened into the widget
    const opened = await page.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 64; c.height = 64;
      const g = c.getContext('2d'); g.fillStyle = '#3a7'; g.fillRect(0, 0, 64, 64);
      return window.__openInpaint(c.toDataURL('image/png'));
    });
    ok(opened === true, `__openInpaint returned true (got ${JSON.stringify(opened)})`);
    await page.waitForFunction(() => window.__inpaint && window.__inpaint.getState().hasImage, { timeout: 5000 }).catch(() => {});

    const s1 = await page.evaluate(() => window.__inpaint.getState());
    ok(s1 && s1.hasImage && s1.nW === 64 && s1.nH === 64, `widget loaded the image at native size (${s1 && s1.nW}x${s1 && s1.nH})`);
    ok(s1 && !s1.canGenerate, 'Generate is DISABLED before a mask + prompt exist');

    // paint a mask dab (native coords) and set a prompt → Generate must enable
    await page.evaluate(() => window.__inpaint.paintNative(32, 32, 16));
    const s2 = await page.evaluate(() => window.__inpaint.getState());
    ok(s2 && s2.painted, 'painting a mask dab marks the mask painted');
    ok(s2 && !s2.canGenerate, 'Generate still disabled with a mask but no prompt');

    await page.evaluate(() => { const t = document.querySelector('textarea[placeholder^="what should appear"]'); t.value = 'a sunflower'; t.dispatchEvent(new Event('input', { bubbles: true })); });
    const s3 = await page.evaluate(() => window.__inpaint.getState());
    ok(s3 && s3.canGenerate, 'Generate ENABLES once image + mask + prompt are all present');

    const mask = await page.evaluate(() => window.__inpaint.maskDataUrl());
    ok(typeof mask === 'string' && mask.startsWith('data:image/png'), 'the widget exports a PNG mask for the GPU');
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.message); cleanup(); process.exit(2); });
