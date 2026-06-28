#!/usr/bin/env node
// inbox-island.staging.test.cjs — P4: the 🔔 Notifications view is a confined, alt-clickable, editable island
// that is itself a CONTAINER of nested islands. Because it renders ONCE (no re-diff), the nested
// renderNotifications (renderConfined into rec-list) composes — proving container surfaces convert cleanly
// without any "slot mechanism". Verifies: it's the island, every id present, a nested island renders into its
// slot (tagged island-notifications), alt-click → edit chat targets island-inbox-view.
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
    const r = await page.evaluate(() => {
      const iv = document.getElementById('inbox-view');
      const ivIsland = iv && iv.getAttribute('data-component-id');
      const missing = ['att-head', 'att-count', 'att-list', 'rec-head', 'rec-list', 'chg-section', 'chg-head', 'chg-count', 'chg-list'].filter(i => !document.getElementById(i));
      // render the nested notifications island into the island-provided slot (the real renderInbox does this)
      let nestedTag = null, nestedContent = false;
      try { window.__fieldIslands.renderNotifications(document.getElementById('rec-list'), { items: [{ id: 'n1', title: 'Test note', body: 'x', status: '', at: Date.now() }], withDone: false }, { onOpenLink() {}, onDismiss() {} }); nestedTag = document.getElementById('rec-list').getAttribute('data-component-id'); nestedContent = (document.getElementById('rec-list').textContent || '').includes('Test note'); } catch {}
      return { ivIsland, missing, nestedTag, nestedContent };
    });
    ok(r.ivIsland === 'island-inbox-view', 'the notifications view IS the island');
    ok(r.missing.length === 0, `every inbox id present (missing: ${r.missing.join(',') || 'none'})`);
    ok(r.nestedTag === 'island-notifications' && r.nestedContent, 'a NESTED island (renderNotifications) renders into the container island slot — no slot mechanism needed');
    // alt-click the inbox view → edit chat targets it
    await page.evaluate(() => { const iv = document.getElementById('inbox-view'); iv.classList.remove('hide'); const b = iv.getBoundingClientRect(); iv.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true, clientX: b.left + 20, clientY: b.top + 8 })); }); await page.waitForTimeout(180);
    await page.evaluate(() => { const b = document.querySelector('[data-act=edit]'); if (b) b.click(); }); await page.waitForTimeout(180);
    await page.evaluate(() => { const i = document.getElementById('ce-input'); if (i) { i.value = 'reorder the sections'; document.getElementById('ce-send').click(); } }); await page.waitForTimeout(400);
    ok(editBody && editBody.id === 'island-inbox-view', 'alt-click → edit chat targets island-inbox-view');
    ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(' | ')})`);
    await page.close();
  } finally { await br.close(); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); process.exit(2); });
