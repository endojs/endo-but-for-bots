#!/usr/bin/env node
// component-select.staging.test.cjs — a STAGING (real-run) regression guard for ⌥ Alt-click component
// selection on IN-CHAT confined components. This feature silently broke because confined components render
// inside a sandboxed iframe (which swallows the parent's pointer events) and their wrapper carried no
// component identity — so Alt-hover highlighted nothing and Alt-click did nothing. This test boots an
// ISOLATED voice-agent (throwaway SEED_FILE/OUT_DIR — never touches the live root cap or state), renders a
// real in-chat confined component, then drives a REAL Alt+hover/click via headless chromium and asserts:
//   1. holding Alt adds the `comp-select` mode AND drops the component iframe's pointer-events to none
//      (so the OWNER's pointer reaches the wrapper — the actual fix),
//   2. Alt-hover paints the 1px highlight, themed via --bad (NOT the old hard-coded red),
//   3. Alt-click on an id-less inline component surfaces the "edit (break out)" chip.
//
// Run: node component-select.staging.test.cjs   (exits non-zero on any failure; SKIPs cleanly w/o chromium)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compselect-staging-'));
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
  if (!chromium) {
    console.log('  SKIP - headless Alt-select check (playwright-core unavailable)');
    console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(fail ? 1 : 0);
  }

  const rootCap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();
  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(c => localStorage.setItem('field-agent-cap', c), rootCap);
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    // booted AS root → the owner-only Components tab is revealed; that's our "isRoot is true" signal.
    await page.waitForSelector('#tab-components:not(.hide)', { timeout: 15000 });
    ok(true, 'app booted as owner (root cap)');

    // Render a REAL in-chat confined component (id-less, inline) via the production renderWidgets path.
    await page.evaluate(async (cap) => {
      const mod = await import('/grain-ui.js');
      const box = document.createElement('div'); box.id = '__test_box'; box.style.cssText = 'position:fixed;left:80px;top:300px;width:360px;z-index:1';
      document.body.appendChild(box);
      mod.renderWidgets(box, [{ type: 'component', name: 'TestComp', height: 120, cells: [],
        source: "(ui)=>ui.create('div').push([ui.create('h3').text('HELLO-COMP')])" }], { cap });
    }, rootCap);
    await page.waitForSelector('#__test_box .gw-component iframe', { timeout: 8000 });
    await page.waitForTimeout(900); // let the confined handshake + layout settle
    ok(true, 'in-chat confined component rendered');

    const wrap = await page.locator('#__test_box .gw-component').boundingBox();
    const cx = wrap.x + wrap.width / 2, cy = wrap.y + wrap.height / 2;

    // ── hold Alt + hover the component ────────────────────────────────────────
    await page.keyboard.down('Alt');
    await page.mouse.move(cx, cy, { steps: 3 });
    await page.waitForTimeout(150);

    const hov = await page.evaluate(() => {
      const root = document.documentElement;
      const iframe = document.querySelector('#__test_box .gw-component iframe');
      // the highlight's label carries the bare component name; its parent is the outline div.
      const label = [...document.querySelectorAll('div')].find(d => d.textContent === 'TestComp' && getComputedStyle(d).position === 'absolute');
      const outline = label && label.parentElement;
      const badVar = getComputedStyle(root).getPropertyValue('--bad').trim();
      // resolve --bad to an rgb() to compare against the outline's computed border colour.
      const probe = document.createElement('span'); probe.style.color = 'var(--bad)'; document.body.appendChild(probe);
      const badRgb = getComputedStyle(probe).color; probe.remove();
      return {
        compSelect: root.classList.contains('comp-select'),
        framePE: getComputedStyle(iframe).pointerEvents,
        outlineShown: !!outline && getComputedStyle(outline).display !== 'none',
        outlineBorder: outline ? getComputedStyle(outline).borderTopColor : '',
        labelColor: label ? getComputedStyle(label).color : '',
        badVar, badRgb,
      };
    });
    ok(hov.compSelect, 'holding Alt enters comp-select mode (documentElement.comp-select)');
    ok(hov.framePE === 'none', `component iframe goes pointer-transparent while Alt held — got: ${hov.framePE}`);
    ok(hov.outlineShown, 'Alt-hover paints the highlight outline over the component');
    ok(hov.badVar.length > 0, `the impact colour --bad is themed — got: ${hov.badVar}`);
    ok(hov.outlineBorder === hov.badRgb && hov.outlineBorder !== 'rgb(255, 45, 45)', `highlight uses --bad (${hov.badRgb}), not the old hard-coded red — got: ${hov.outlineBorder}`);

    // ── Alt-click an id-less inline component → "edit (break out)" chip ────────
    await page.mouse.click(cx, cy);
    await page.waitForTimeout(150);
    const chipTxt = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /break out/i.test(b.textContent || ''));
      const chip = btn && btn.closest('div');
      return { hasBreakOut: !!btn, chipShown: chip ? getComputedStyle(chip).display !== 'none' : false };
    });
    ok(chipTxt.hasBreakOut && chipTxt.chipShown, 'Alt-click an inline component surfaces the “edit (break out)” chip');
    await page.keyboard.up('Alt');

    // releasing Alt restores normal interaction (iframe pointer-events back to auto)
    await page.waitForTimeout(120);
    const restored = await page.evaluate(() => getComputedStyle(document.querySelector('#__test_box .gw-component iframe')).pointerEvents);
    ok(restored === 'auto', `releasing Alt restores the iframe's pointer-events — got: ${restored}`);
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.message); cleanup(); process.exit(2); });
