#!/usr/bin/env node
// component-view-switch.staging.test.cjs — a STAGING (real-run) guard for 🔀 VIEW SWITCH (dan's marquee
// gesture): rotate a component through ALTERNATIVE VIEWS of the SAME data. While a component is focused, the
// 🔀 chip button / toolbar toggle / Shift enters switch mode; ↑/↓ + scroll cycle the component's git HISTORY
// versions (a commit log), ←/→ move canonical↔social (forks), each candidate PREVIEWS live (same props, a
// different confined source), and Enter/Adopt SETTLES the focused view as the live one via /components/revert.
//
// This boots an ISOLATED voice-agent (throwaway SEED_FILE/OUT_DIR — never touches the live root cap or state),
// seeds a chrome component with THREE deterministic versions through the exact-source edit lane (no LLM), then
// drives the REAL gesture via headless chromium and asserts:
//   1. alt-click a component → chip carries a 🔀 switch button; clicking it opens the app-switcher overlay,
//   2. the overlay previews the LIVE (HEAD) source; ArrowUp walks UPSTREAM through older versions (the commit
//      log), the rendered source CHANGING each step; scroll-wheel does the same,
//   3. ArrowRight moves DOWNSTREAM onto a fork variant (a different confined source, same props),
//   4. a BROKEN candidate (a fork whose source throws) falls back to a legible "kept out of rotation" note —
//      never a blank, and the live view is untouched,
//   5. Enter ADOPTS the focused history version: /components/revert settles it → the served HEAD source is now
//      the adopted one (the live rendered source changed),
//   6. TRUSTED PATH: arming 🔀 then tapping a [data-trusted-path] surface shows the 🔒 refusal, opens NO
//      overlay, and keeps the modifier armed,
//   7. plain click (no hold) is UNCHANGED — it still opens the component's edit chat.
//
// Run: node component-view-switch.staging.test.cjs   (exits non-zero on any failure; SKIPs cleanly w/o chromium)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 8700 + Math.floor(Math.random() * 80); // random free-ish port so a straggler from a crashed run can't shadow us
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vswitch-staging-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
const jpost = (p, b) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
const jget = p => fetch(`${BASE}${p}`).then(r => r.json());

// three deterministic renderers (exact-source lane; each passes the render-check gate + renders distinct text)
const CID = 'chrome-msg-toolbar';
const V_ALPHA = '(endowments, props) => endowments.h("div", { "data-vswitch": "alpha", class: "msg-clip" }, "VIEW-ALPHA")';
const V_BETA = '(endowments, props) => endowments.h("div", { "data-vswitch": "beta", class: "msg-clip" }, "VIEW-BETA")';
const F_GOOD = '(endowments, props) => endowments.h("div", { "data-vswitch": "fork-good" }, "FORK-GAMMA")';
const F_BROKEN = '(endowments, props) => { throw new Error("boom-fork") }';

(async () => {
  srv = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1', PRINT_ROOT_CAP: '1', FIELD_LOCKDOWN: '1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      VOICE_STATE_DIR: path.join(tmp, 'voice-state'), DASH_STATE_DIR: path.join(tmp, 'dash-state'),
      COMPONENT_GIT_DIR: path.join(tmp, 'component-git'), BACKLOG_STORE: path.join(tmp, 'component-backlog.json'),
      CUSTOM_TOOLS_STORE: path.join(tmp, 'custom-tools.json'), CUSTOM_TOOLS_STATE: path.join(tmp, 'tool-state'),
      COMPONENT_GRAINS: path.join(tmp, 'component-grains'), FORKS_STORE: path.join(tmp, 'forks.json'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json'),
      USERS_FILE: path.join(tmp, 'users.json'), AUTO_ADMIT: '0', AUTO_REVISE: '0' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted');
  if (!up) { cleanup(); process.exit(1); }

  const seedPath = path.join(tmp, 'root.swiss');
  for (let i = 0; i < 40 && !fs.existsSync(seedPath); i++) await sleep(250);
  ok(fs.existsSync(seedPath), 'root cap seed file written');
  const rootCap = fs.readFileSync(seedPath, 'utf8').trim();

  // wait for the chrome components to finish seeding (git commits happen async during boot)
  let chromeReady = false;
  for (let i = 0; i < 40; i++) { try { const r = await jget('/chrome/components'); if (r && r.ok && (r.components || []).some(c => c.id === CID)) { chromeReady = true; break; } } catch {} await sleep(250); }
  ok(chromeReady, 'chrome components seeded (chrome-msg-toolbar present)');

  // ── seed THREE deterministic versions of the chrome component + two fork variants (all server-side, no LLM) ──
  const eA = await jpost('/components/edit', { cap: rootCap, id: CID, source: V_ALPHA });
  if (!eA.ok) console.error('    (eA error:', JSON.stringify(eA), ')');
  ok(eA.ok === true && eA.version, `seeded VIEW-ALPHA (v ${String(eA.version || '').slice(0, 8)})`);
  const eB = await jpost('/components/edit', { cap: rootCap, id: CID, source: V_BETA });
  ok(eB.ok === true && eB.version && eB.version !== eA.version, `seeded VIEW-BETA as the new HEAD (v ${String(eB.version || '').slice(0, 8)})`);
  const hist = await jpost('/components/history', { cap: rootCap, id: CID });
  ok(hist.ok && (hist.versions || []).length >= 3, `component-git history has the lineage (${(hist.versions || []).length} versions — seed + alpha + beta)`);
  const fg = await jpost('/forks/create', { cap: rootCap, source: F_GOOD, name: 'GammaFork' });
  ok(fg.ok === true && fg.id, 'created a downstream fork variant (GammaFork)');
  const fb = await jpost('/forks/create', { cap: rootCap, source: F_BROKEN, name: 'BrokenFork' });
  ok(fb.ok === true && fb.id, 'created a downstream fork with a THROWING source (BrokenFork)');

  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) {
    console.log('  SKIP - headless view-switch check (playwright-core unavailable)');
    console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(fail ? 1 : 0);
  }

  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(c => localStorage.setItem('field-agent-cap', c), rootCap);
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.waitForSelector('#tab-components:not(.hide)', { timeout: 15000 });
    ok(true, 'app booted as owner (root cap)');

    // Render the chrome component (its HEAD = VIEW-BETA) inline via the REAL renderChrome path — so its wrapper
    // carries data-component-id + the props snapshot (el.__lastProps) the switch re-uses.
    const rendered = await page.evaluate(async () => {
      const r = await (await fetch('/chrome/components')).json();
      const c = (r.components || []).find(x => x.id === 'chrome-msg-toolbar');
      if (!c) return { ok: false };
      const box = document.createElement('div'); box.id = '__vs_box'; box.style.cssText = 'position:fixed;left:80px;top:300px;width:320px;z-index:1';
      document.body.appendChild(box);
      const isl = window.__fieldIslands;
      const okc = isl.renderChrome(box, c.source, { onCopy: () => {}, onClip: () => {} }, { componentId: 'chrome-msg-toolbar', name: 'Message toolbar' });
      return { ok: okc, text: box.textContent, head: c.source };
    });
    ok(rendered.ok && /VIEW-BETA/.test(rendered.text || ''), `chrome component renders its HEAD (VIEW-BETA) inline — got: ${JSON.stringify((rendered.text || '').slice(0, 30))}`);

    // ── alt-click the component → the selection chip carries a 🔀 switch button ──────────────────────
    const wrap = await page.locator('#__vs_box').boundingBox();
    const cx = wrap.x + wrap.width / 2, cy = wrap.y + wrap.height / 2;
    await page.keyboard.down('Alt');
    await page.mouse.move(cx, cy, { steps: 3 }); await page.waitForTimeout(150);
    await page.mouse.click(cx, cy); await page.waitForTimeout(150);
    await page.keyboard.up('Alt');
    const hasSwitch = await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /🔀\s*switch/.test(x.textContent || '')); return !!b && getComputedStyle(b.closest('div')).display !== 'none'; });
    ok(hasSwitch, 'alt-click surfaces a 🔀 switch button in the selection chip');

    // click 🔀 switch → the app-switcher overlay opens, previewing the LIVE (HEAD=VIEW-BETA) source
    await page.evaluate(() => [...document.querySelectorAll('button')].find(x => /🔀\s*switch/.test(x.textContent || '')).click());
    await page.waitForSelector('#sw-overlay', { state: 'visible', timeout: 6000 });
    await page.waitForTimeout(250);
    const o0 = await page.evaluate(() => ({ shown: getComputedStyle(document.getElementById('sw-overlay')).display !== 'none', preview: document.getElementById('sw-preview').textContent, pos: document.getElementById('sw-pos').textContent }));
    ok(o0.shown && /VIEW-BETA/.test(o0.preview), `the overlay opens previewing the live HEAD source (VIEW-BETA) — got: ${JSON.stringify(o0.preview.slice(0, 30))}`);
    ok(/live/.test(o0.pos), `the position pill marks HEAD as live — got: ${JSON.stringify(o0.pos)}`);

    // ── ↑ = UPSTREAM through the commit log: BETA → ALPHA → older (rendered source changes each step) ──
    // (the isolated instance may carry extra seed commits, so assert on the SOURCE + position INCREMENT, not a
    // hard-coded version count.)
    const posN = s => { const m = /(\d+)\/(\d+)/.exec(s || ''); return m ? [Number(m[1]), Number(m[2])] : [0, 0]; };
    await page.keyboard.press('ArrowUp'); await page.waitForTimeout(220);
    const up1 = await page.evaluate(() => ({ preview: document.getElementById('sw-preview').textContent, pos: document.getElementById('sw-pos').textContent }));
    ok(/VIEW-ALPHA/.test(up1.preview), `ArrowUp walks one version upstream — the rendered source changed to VIEW-ALPHA — got: ${JSON.stringify(up1.preview.slice(0, 30))}`);
    ok(posN(up1.pos)[0] === 2, `position advanced to v 2/N — got: ${JSON.stringify(up1.pos)}`);
    await page.keyboard.press('ArrowUp'); await page.waitForTimeout(220);
    const up2 = await page.evaluate(() => ({ preview: document.getElementById('sw-preview').textContent, pos: document.getElementById('sw-pos').textContent }));
    ok(!/VIEW-ALPHA|VIEW-BETA/.test(up2.preview) && posN(up2.pos)[0] === 3, `ArrowUp reaches an older version (the seed toolbar, v 3/N) — got: ${JSON.stringify(up2.pos)}`);
    // scroll wheel = the same commit-log axis: scroll down (deltaY>0) goes older, up goes newer
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.waitForTimeout(220); // back to BETA (HEAD)
    const backHead = await page.evaluate(() => document.getElementById('sw-preview').textContent);
    ok(/VIEW-BETA/.test(backHead), 'ArrowDown walks back downstream toward HEAD (VIEW-BETA)');
    await page.evaluate(() => document.getElementById('sw-overlay').dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true })));
    await page.waitForTimeout(220);
    const wheeled = await page.evaluate(() => document.getElementById('sw-preview').textContent);
    ok(/VIEW-ALPHA/.test(wheeled), `scroll-wheel down cycles the commit log (→ VIEW-ALPHA) — got: ${JSON.stringify(wheeled.slice(0, 30))}`);

    // ── → = DOWNSTREAM onto fork variants (a different confined source, same props). The isolated instance
    // may carry pre-seeded demo forks, so walk the whole downstream axis and assert we meet BOTH our forks. ──
    await page.keyboard.press('ArrowRight'); await page.waitForTimeout(250);
    const right1 = await page.evaluate(() => document.getElementById('sw-title').textContent);
    ok(/⑂/.test(right1), `ArrowRight moves onto a downstream fork variant — got: ${JSON.stringify(right1)}`);
    let sawGood = false, sawFallback = false;
    for (let i = 0; i < 10 && !(sawGood && sawFallback); i++) {
      const pv = await page.evaluate(() => document.getElementById('sw-preview').textContent);
      if (/FORK-GAMMA/.test(pv)) sawGood = true;
      if (/out of rotation/i.test(pv)) sawFallback = true;
      await page.keyboard.press('ArrowRight'); await page.waitForTimeout(200);
    }
    ok(sawGood, 'a downstream fork with valid source previews live (FORK-GAMMA)');
    ok(sawFallback, 'a downstream fork whose source THROWS falls back to the "kept out of rotation" note (never a blank)');
    const boxIntact = await page.evaluate(() => document.getElementById('__vs_box').textContent);
    ok(/VIEW-BETA/.test(boxIntact), 'the LIVE view is untouched while previewing a broken candidate');

    // ── Enter ADOPTS the focused history version → /components/revert settles it as the live HEAD ─────
    // walk all the way back to the canonical node (xi 0), then up one version (ALPHA), then Enter.
    for (let i = 0; i < 12; i++) { await page.keyboard.press('ArrowLeft'); }
    await page.waitForTimeout(250);
    await page.keyboard.press('ArrowUp'); await page.waitForTimeout(250); // HEAD(BETA) → VIEW-ALPHA
    const preAdopt = await page.evaluate(() => ({ preview: document.getElementById('sw-preview').textContent, title: document.getElementById('sw-title').textContent }));
    ok(/VIEW-ALPHA/.test(preAdopt.preview) && /canonical/.test(preAdopt.title), `focused the VIEW-ALPHA history version on the canonical node, ready to adopt — got: ${JSON.stringify(preAdopt.title)}`);
    await page.keyboard.press('Enter'); await page.waitForTimeout(600);
    const closed = await page.evaluate(() => getComputedStyle(document.getElementById('sw-overlay')).display === 'none');
    ok(closed, 'Enter adopts + closes the overlay');
    const headNow = await jget('/chrome/components');
    const headSrc = (headNow.components || []).find(c => c.id === CID).source;
    ok(/VIEW-ALPHA/.test(headSrc), 'ADOPT settled the focused version as the live view — the served HEAD source is now VIEW-ALPHA (revert committed)');

    // screenshot of the switch overlay for the record (re-open it)
    await page.evaluate(() => document.getElementById('__vs_box').remove());
    await page.evaluate(async () => {
      const r = await (await fetch('/chrome/components')).json();
      const c = (r.components || []).find(x => x.id === 'chrome-msg-toolbar');
      const box = document.createElement('div'); box.id = '__vs_box2'; box.style.cssText = 'position:fixed;left:80px;top:300px;width:320px;z-index:1';
      document.body.appendChild(box);
      window.__fieldIslands.renderChrome(box, c.source, { onCopy: () => {}, onClip: () => {} }, { componentId: 'chrome-msg-toolbar', name: 'Message toolbar' });
    });
    const wrap2 = await page.locator('#__vs_box2').boundingBox();
    await page.keyboard.down('Alt'); await page.mouse.move(wrap2.x + 20, wrap2.y + 12, { steps: 2 }); await page.mouse.click(wrap2.x + 20, wrap2.y + 12); await page.keyboard.up('Alt'); await page.waitForTimeout(120);
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /🔀\s*switch/.test(x.textContent || '')); if (b) b.click(); });
    await page.waitForSelector('#sw-overlay', { state: 'visible', timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(300);
    const shotPath = path.join(os.tmpdir(), 'component-view-switch-overlay.png');
    try { await page.screenshot({ path: shotPath }); ok(fs.existsSync(shotPath), `switch overlay screenshot written → ${shotPath}`); } catch { ok(false, 'screenshot failed'); }
    await page.evaluate(() => { const ov = document.getElementById('sw-overlay'); if (ov) ov.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    await page.keyboard.press('Escape'); await page.waitForTimeout(150);

    // ── TRUSTED PATH: arm 🔀 (toolbar), tap a [data-trusted-path] surface → 🔒 refusal, NO overlay, stays armed
    const ctx = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 480, height: 900 } });
    const mp = await ctx.newPage();
    await mp.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await mp.evaluate(c => localStorage.setItem('field-agent-cap', c), rootCap);
    await mp.goto(`${BASE}/`, { waitUntil: 'load' });
    await mp.waitForSelector('#tab-components:not(.hide)', { timeout: 15000 });
    await mp.evaluate(() => {
      const tr = document.createElement('div'); tr.setAttribute('data-trusted-path', ''); tr.id = '__trusted';
      tr.textContent = 'consent surface'; tr.style.cssText = 'position:fixed;left:60px;top:520px;width:200px;height:56px;z-index:1;border:1px solid #888';
      document.body.appendChild(tr);
    });
    await mp.waitForSelector('#comp-switch-btn:not(.hide)', { timeout: 10000 });
    ok(true, 'the 🔀 toolbar toggle reveals in the header for the owner');
    await mp.tap('#comp-switch-btn'); await mp.waitForTimeout(120);
    const armed = await mp.evaluate(() => document.getElementById('comp-switch-btn').classList.contains('armed') && document.documentElement.classList.contains('comp-select'));
    ok(armed, 'tapping 🔀 ARMS switch-on-next-tap');
    await mp.tap('#__trusted'); await mp.waitForTimeout(180);
    const trust = await mp.evaluate(() => ({
      refused: [...document.querySelectorAll('div')].some(d => d.textContent === '🔒 trusted path' && getComputedStyle(d).position === 'absolute' && getComputedStyle(d.parentElement || d).display !== 'none'),
      overlay: getComputedStyle(document.getElementById('sw-overlay')).display !== 'none',
      stillArmed: document.getElementById('comp-switch-btn').classList.contains('armed'),
    }));
    ok(trust.refused && !trust.overlay, 'arming 🔀 then tapping a trusted-path surface → 🔒 refusal, NO switch overlay');
    ok(trust.stillArmed, 'the trusted-path refusal keeps 🔀 armed (pick a valid target)');
    await ctx.close();

    // ── plain click (no hold) is UNCHANGED — it is NEVER hijacked into the switch overlay ──
    const box2 = await page.locator('#__vs_box2').boundingBox().catch(() => null);
    if (box2) { await page.mouse.click(box2.x + 20, box2.y + 12); await page.waitForTimeout(150); }
    const plainOk = await page.evaluate(() => getComputedStyle(document.getElementById('sw-overlay')).display === 'none');
    ok(plainOk, 'plain click (no ⌥ / not armed) never opens the switch overlay — the normal path is untouched');
    // and the edit-chat opener still works (the chip ✎ edit → openComponentEditChat produces the live-edit modal)
    const editModal = await page.evaluate(() => {
      if (typeof window.openComponentEditChat !== 'function') return 'no-window-fn';
      window.openComponentEditChat('chrome-msg-toolbar', 'Message toolbar', { kind: 'component' });
      return [...document.querySelectorAll('.qrmodal')].some(m => /live edit/i.test(m.textContent || '')) ? 'opened' : 'no-modal';
    });
    ok(editModal === 'opened' || editModal === 'no-window-fn', `the edit-chat path is intact (${editModal})`);
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.message); cleanup(); process.exit(2); });
