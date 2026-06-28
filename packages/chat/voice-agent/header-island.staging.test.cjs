#!/usr/bin/env node
// header-island.staging.test.cjs — P4 (shell→island migration): the app header is now a confined, alt-clickable,
// EDITABLE island that renders the structure (every button/select with its id) while app.js wires behaviour by
// id after mount. Proves the island renders with EVERY expected id, the dynamically-added theme toggle survives,
// the key interactions are still wired (hamburger → drawer, tab switch, theme toggle), and alt-click → the edit
// chat targets island-header-bar. Snapshot→restore fallback means a broken render can never blank the header.
const fs = require('node:fs');
const cap = fs.readFileSync(require('node:os').homedir() + '/.config/field-agent/root.swiss', 'utf8').trim();
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
(async () => {
  let chromium = null; try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - no chromium'); console.log(`\n${pass} passed, ${fail} failed (skipped)`); process.exit(0); }
  const br = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: '/var/lib/obsidian/oldlibs' } });
  try {
    const page = await br.newPage();
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    let editBody = null;
    await page.route('**/components/edit-chat', r => { try { editBody = JSON.parse(r.request().postData() || '{}'); } catch {} r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, answer: 'ok', steps: ['readComponentSource'] }) }); });
    await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
    await page.goto('http://127.0.0.1:8778/', { waitUntil: 'load' }); await page.waitForTimeout(4000);

    const ids = ['hamburger', 'new-chat-top', 'trash-chat-top', 'scope', 'budget', 'agent-sel', 'model-sel', 'tab-talk', 'tab-shares', 'tab-components', 'bell-btn', 'bell-badge', 'info-btn', 'projects-btn', 'chatshare-btn', 'hooks-btn', 'theme-toggle'];
    const r1 = await page.evaluate(idl => ({ isIsland: document.querySelector('header').getAttribute('data-component-id'), missing: idl.filter(i => !document.getElementById(i)), brand: !!document.querySelector('header h1') }), ids);
    ok(r1.isIsland === 'island-header-bar', 'the header IS the island (alt-clickable)');
    ok(r1.missing.length === 0, `every header id present incl. the dynamic theme-toggle (missing: ${r1.missing.join(',') || 'none'})`);
    ok(r1.brand, 'the brand h1 rendered');

    // hamburger → drawer (the real mechanism is body.sidebar-open)
    const beforeDrawer = await page.evaluate(() => document.body.classList.contains('sidebar-open'));
    await page.evaluate(() => document.getElementById('hamburger').click()); await page.waitForTimeout(200);
    ok(await page.evaluate(() => document.body.classList.contains('sidebar-open')) !== beforeDrawer, 'hamburger toggles the drawer (wired by id)');
    // tab switch
    await page.evaluate(() => document.getElementById('tab-shares').click()); await page.waitForTimeout(300);
    ok(await page.evaluate(() => document.getElementById('tab-shares').classList.contains('on')), 'a tab click activates it (wired)');
    // theme toggle (added after the island mount, still functional)
    const tb = await page.evaluate(() => document.documentElement.getAttribute('data-theme') || getComputedStyle(document.documentElement).getPropertyValue('--bg'));
    await page.evaluate(() => document.getElementById('theme-toggle').click()); await page.waitForTimeout(200);
    ok(tb !== await page.evaluate(() => document.documentElement.getAttribute('data-theme') || getComputedStyle(document.documentElement).getPropertyValue('--bg')), 'the theme toggle still works');

    // alt-click the header → edit chat targets the header island
    await page.evaluate(() => document.getElementById('tab-talk').click()); await page.waitForTimeout(150);
    await page.evaluate(() => { const hdr = document.querySelector('header'); const r = hdr.getBoundingClientRect(); hdr.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true, clientX: r.left + 150, clientY: r.top + 10 })); });
    await page.waitForTimeout(180);
    await page.evaluate(() => { const b = document.querySelector('[data-act=edit]'); if (b) b.click(); });
    await page.waitForTimeout(180);
    await page.evaluate(() => { const i = document.getElementById('ce-input'); if (i) { i.value = 'make the title gold'; document.getElementById('ce-send').click(); } });
    await page.waitForTimeout(400);
    ok(editBody && editBody.id === 'island-header-bar', 'alt-click header → the edit chat targets island-header-bar');
    ok(errs.length === 0, `no page errors (${errs.slice(0, 3).join(' | ')})`);
    await page.close();
  } finally { await br.close(); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); process.exit(2); });
