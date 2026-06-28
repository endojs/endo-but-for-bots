#!/usr/bin/env node
// settings-island.staging.test.cjs — P4: the settings modal SHELL is an editable island, built ON-DEMAND by
// openSettings. Verifies the shell is the island, the section nav + body fill (imperative slots), switching a
// section works, and alt-click → edit chat targets island-settings-modal.
const fs = require('node:fs');
const cap = fs.readFileSync(require('node:os').homedir() + '/.config/field-agent/root.swiss', 'utf8').trim();
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
(async () => {
  let chromium = null; try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - no chromium'); console.log(`\n${pass} passed, ${fail} failed (skipped)`); process.exit(0); }
  const br = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: '/var/lib/obsidian/oldlibs' } });
  try {
    const page = await br.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
    let editBody = null;
    await page.route('**/components/edit-chat', r => { try { editBody = JSON.parse(r.request().postData() || '{}'); } catch {} r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, answer: 'ok', steps: ['readComponentSource'] }) }); });
    await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
    await page.goto('http://127.0.0.1:8778/', { waitUntil: 'load' }); await page.waitForTimeout(4000);
    // open settings via the drawer footer
    await page.evaluate(() => document.getElementById('hamburger').click()); await page.waitForTimeout(300);
    await page.evaluate(() => document.getElementById('drawer-foot').click()); await page.waitForTimeout(600);
    const r = await page.evaluate(() => {
      const shell = document.getElementById('settings-shell');
      return { isIsland: shell && shell.getAttribute('data-component-id'), navItems: document.querySelectorAll('.setnav-item').length, hasBody: !!document.getElementById('setbody'), bodyContent: (document.getElementById('setbody')?.textContent || '').length > 0 };
    });
    ok(r.isIsland === 'island-settings-modal', 'the settings shell IS the island');
    ok(r.navItems >= 3, `the section nav filled (${r.navItems} sections)`);
    ok(r.hasBody && r.bodyContent, 'the settings body filled (default section rendered)');
    // switch a section
    await page.evaluate(() => { const b = [...document.querySelectorAll('.setnav-item')].find(x => /Agents|Specialists|Checks|Files/.test(x.textContent)); if (b) b.click(); }); await page.waitForTimeout(400);
    ok(await page.evaluate(() => [...document.querySelectorAll('.setnav-item')].some(b => b.classList.contains('on'))), 'switching a section works (nav wired)');
    // alt-click the settings shell → edit chat targets it
    await page.evaluate(() => { const s = document.getElementById('settings-shell'); const b = s.getBoundingClientRect(); s.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true, clientX: b.left + 5, clientY: b.top + 5 })); }); await page.waitForTimeout(180);
    await page.evaluate(() => { const b = document.querySelector('[data-act=edit]'); if (b) b.click(); }); await page.waitForTimeout(180);
    await page.evaluate(() => { const i = document.getElementById('ce-input'); if (i) { i.value = 'put the nav on the right'; document.getElementById('ce-send').click(); } }); await page.waitForTimeout(400);
    ok(editBody && editBody.id === 'island-settings-modal', 'alt-click → edit chat targets island-settings-modal');
    ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(' | ')})`);
    await page.close();
  } finally { await br.close(); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); process.exit(2); });
