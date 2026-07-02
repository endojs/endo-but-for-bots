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
// Plus the ⌥ STICKY one-shot modifier (mobile: no Alt key, no hover) — driven from a REAL touch context:
//   4. the header ⌥ button reveals for the owner; tapping it ARMS select mode (active ring, hint, iframe
//      pointer-events dropped), a touch previews the outline, the next tap on a component runs the normal
//      chip flow then AUTO-DISARMS (one-shot), a tap on a trusted-path surface 🔒-refuses and STAYS armed,
//      a tap on empty space cancels, Escape cancels.
//
// Run: node component-select.staging.test.cjs   (exits non-zero on any failure; SKIPs cleanly w/o chromium)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 20000 + (process.pid % 20000); // T-TEST-2: PID-derived port (unique per node --test child); never a fixed 879x
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

    // ── ⌥ STICKY one-shot modifier — a REAL TOUCH context (mobile: no Alt key, no hover) ──────────────
    const ctx = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 480, height: 900 } });
    const mp = await ctx.newPage();
    await mp.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await mp.evaluate(c => localStorage.setItem('field-agent-cap', c), rootCap);
    await mp.goto(`${BASE}/`, { waitUntil: 'load' });
    await mp.waitForSelector('#tab-components:not(.hide)', { timeout: 15000 });
    // same in-chat confined component + a trusted-path surface (the consent-sheet class of chrome)
    await mp.evaluate(async (cap) => {
      const mod = await import('/grain-ui.js');
      const box = document.createElement('div'); box.id = '__test_box'; box.style.cssText = 'position:fixed;left:60px;top:300px;width:360px;z-index:1';
      document.body.appendChild(box);
      mod.renderWidgets(box, [{ type: 'component', name: 'TestComp', height: 120, cells: [],
        source: "(ui)=>ui.create('div').push([ui.create('h3').text('HELLO-COMP')])" }], { cap });
      const tr = document.createElement('div'); tr.setAttribute('data-trusted-path', ''); tr.id = '__trusted';
      tr.textContent = 'consent surface'; tr.style.cssText = 'position:fixed;left:60px;top:520px;width:200px;height:56px;z-index:1;border:1px solid #888';
      document.body.appendChild(tr);
    }, rootCap);
    await mp.waitForSelector('#__test_box .gw-component iframe', { timeout: 8000 });
    await mp.waitForTimeout(900);
    // the header ⌥ button reveals for the owner (visibility syncs on a 3s tick after isRoot lands)
    await mp.waitForSelector('#comp-select-btn:not(.hide)', { timeout: 10000 });
    ok(true, 'sticky ⌥ button revealed in the header for the owner');
    // ARM: tap the button once
    await mp.tap('#comp-select-btn');
    await mp.waitForTimeout(120);
    const STICKY_HINT = 'Tap a component to edit it — tap the ⌥ button again to cancel';
    const armed = await mp.evaluate(hintTxt => ({
      armed: document.getElementById('comp-select-btn').classList.contains('armed'),
      mode: document.documentElement.classList.contains('comp-select'),
      framePE: getComputedStyle(document.querySelector('#__test_box .gw-component iframe')).pointerEvents,
      hint: [...document.querySelectorAll('div')].some(d => d.textContent === hintTxt && getComputedStyle(d).position === 'fixed' && getComputedStyle(d).display !== 'none'),
    }), STICKY_HINT);
    ok(armed.armed && armed.mode, 'tapping ⌥ ARMS select mode (active button state + comp-select mode)');
    ok(armed.framePE === 'none', `armed mode drops the confined iframe's pointer-events — got: ${armed.framePE}`);
    ok(armed.hint, 'the armed hint reads "Tap a component to edit it — tap the ⌥ button again to cancel"');
    // touch PREVIEW: a synthetic touchstart over the component paints the same outline hover would
    const wrap2 = await mp.locator('#__test_box .gw-component').boundingBox();
    const tcx = wrap2.x + wrap2.width / 2, tcy = wrap2.y + wrap2.height / 2;
    const preview = await mp.evaluate(({ x, y }) => {
      const t = new Touch({ identifier: 1, target: document.body, clientX: x, clientY: y });
      window.dispatchEvent(new TouchEvent('touchstart', { touches: [t], bubbles: true }));
      const label = [...document.querySelectorAll('div')].find(d => d.textContent === 'TestComp' && getComputedStyle(d).position === 'absolute');
      const outline = label && label.parentElement;
      return !!outline && getComputedStyle(outline).display !== 'none';
    }, { x: tcx, y: tcy });
    ok(preview, 'while armed, touching the component previews the highlight outline');
    // SELECT: tap the component → normal chip flow + AUTO-DISARM (one-shot)
    await mp.touchscreen.tap(tcx, tcy);
    await mp.waitForTimeout(200);
    const sel = await mp.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /break out/i.test(b.textContent || ''));
      const chipEl = btn && btn.closest('div');
      return {
        chip: !!btn && !!chipEl && getComputedStyle(chipEl).display !== 'none',
        armed: document.getElementById('comp-select-btn').classList.contains('armed'),
        mode: document.documentElement.classList.contains('comp-select'),
        framePE: getComputedStyle(document.querySelector('#__test_box .gw-component iframe')).pointerEvents,
      };
    });
    ok(sel.chip, 'armed tap on the confined component surfaces the “edit (break out)” chip');
    ok(!sel.armed && !sel.mode, 'selection AUTO-DISARMS the sticky modifier (one-shot)');
    ok(sel.framePE === 'auto', `auto-disarm restores the iframe's pointer-events — got: ${sel.framePE}`);
    await mp.evaluate(() => document.querySelector('[data-act="x"]').click()); // close the chip
    // TRUSTED PATH: re-arm, tap the consent surface → dashed 🔒 refusal, modifier STAYS armed
    await mp.tap('#comp-select-btn');
    await mp.waitForTimeout(120);
    await mp.tap('#__trusted');
    await mp.waitForTimeout(150);
    const tr = await mp.evaluate(() => {
      const label = [...document.querySelectorAll('div')].find(d => d.textContent === '🔒 trusted path' && getComputedStyle(d).position === 'absolute');
      const outline = label && label.parentElement;
      const xBtn = document.querySelector('[data-act="x"]');
      return {
        refused: !!outline && getComputedStyle(outline).display !== 'none' && getComputedStyle(outline).borderTopStyle === 'dashed',
        armed: document.getElementById('comp-select-btn').classList.contains('armed'),
        chipShown: xBtn ? getComputedStyle(xBtn.closest('div')).display !== 'none' : false,
      };
    });
    ok(tr.refused && !tr.chipShown, 'armed tap on a trusted-path surface shows the dashed 🔒 refusal (no chip)');
    ok(tr.armed, 'trusted-path refusal keeps the modifier ARMED (pick a valid target)');
    // CANCEL: a tap on empty space disarms
    await mp.touchscreen.tap(240, 200);
    await mp.waitForTimeout(150);
    const cancelled = await mp.evaluate(() => document.getElementById('comp-select-btn').classList.contains('armed') || document.documentElement.classList.contains('comp-select'));
    ok(!cancelled, 'armed tap on empty space CANCELS (disarms)');
    // CANCEL: Escape disarms too
    await mp.tap('#comp-select-btn');
    await mp.waitForTimeout(120);
    await mp.keyboard.press('Escape');
    await mp.waitForTimeout(120);
    const esc = await mp.evaluate(() => document.getElementById('comp-select-btn').classList.contains('armed') || document.documentElement.classList.contains('comp-select'));
    ok(!esc, 'Escape disarms the sticky modifier');
    // ── hygiene: #qrmodal (cap hand-offs, add-a-power, billing secrets, agent profiles) is a TRUSTED-PATH
    // HOST — a component rendered INSIDE it inherits the 🔒 refusal (closest('[data-trusted-path]')).
    // Arm FIRST (the modal overlays the header button), then unhide the modal with a component in it.
    await mp.tap('#comp-select-btn');
    await mp.waitForTimeout(120);
    await mp.evaluate(async (cap) => {
      const mod = await import('/grain-ui.js');
      const m = document.getElementById('qrmodal'); m.classList.remove('hide');
      const box = document.createElement('div'); box.id = '__modal_box'; box.style.cssText = 'width:360px';
      m.appendChild(box);
      mod.renderWidgets(box, [{ type: 'component', name: 'ModalComp', height: 100, cells: [],
        source: "(ui)=>ui.create('div').push([ui.create('h3').text('IN-MODAL')])" }], { cap });
    }, rootCap);
    await mp.waitForSelector('#__modal_box .gw-component iframe', { timeout: 8000 });
    await mp.waitForTimeout(600);
    const mb = await mp.locator('#__modal_box .gw-component').boundingBox();
    await mp.touchscreen.tap(mb.x + mb.width / 2, mb.y + mb.height / 2);
    await mp.waitForTimeout(150);
    const modal = await mp.evaluate(() => {
      const label = [...document.querySelectorAll('div')].find(d => d.textContent === '🔒 trusted path' && getComputedStyle(d).position === 'absolute');
      const outline = label && label.parentElement;
      const xBtn = document.querySelector('[data-act="x"]');
      return {
        refused: !!outline && getComputedStyle(outline).display !== 'none' && getComputedStyle(outline).borderTopStyle === 'dashed',
        armed: document.getElementById('comp-select-btn').classList.contains('armed'),
        chipShown: xBtn ? getComputedStyle(xBtn.closest('div')).display !== 'none' : false,
      };
    });
    ok(modal.refused && !modal.chipShown, 'a component rendered INSIDE #qrmodal is 🔒-refused (trusted-path host seals the cap hand-off surface)');
    await ctx.close();
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.message); cleanup(); process.exit(2); });
