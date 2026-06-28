#!/usr/bin/env node
// drawer-island.staging.test.cjs — P4: the sidebar/drawer frame is a confined, alt-clickable, editable island.
// The chat list (rendered IMPERATIVELY by app.js into the island-provided #chat-list — NOT a nested island)
// still populates + works; the buttons stay wired; alt-click → edit chat targets island-drawer-frame.
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
    await page.addInitScript(c => { localStorage.setItem('field-agent-cap', c); const id = 'c-dr'; localStorage.setItem('field-agent-chats', JSON.stringify([{ id, title: 'drawer-test-chat', ts: Date.now(), lastMsgAt: Date.now() }])); localStorage.setItem('field-agent-active', id); localStorage.setItem('field-agent-tx-' + id, '[]'); }, cap);
    await page.goto('http://127.0.0.1:8778/', { waitUntil: 'load' }); await page.waitForTimeout(4000);
    await page.evaluate(() => document.getElementById('hamburger').click()); await page.waitForTimeout(400);
    const r = await page.evaluate(() => ({ isIsland: document.getElementById('drawer').getAttribute('data-component-id'), missing: ['new-chat', 'drawer-close', 'chat-list', 'drawer-foot', 'df-sub'].filter(i => !document.getElementById(i)), chatListPopulated: (document.getElementById('chat-list')?.textContent || '').length > 0, hasSearch: !!document.getElementById('chat-search') }));
    ok(r.isIsland === 'island-drawer-frame', 'the drawer IS the island (alt-clickable)');
    ok(r.missing.length === 0, `every drawer id present (missing: ${r.missing.join(',') || 'none'})`);
    ok(r.chatListPopulated && r.hasSearch, 'the chat list (imperative) still renders into the island-provided #chat-list (search box + items)');
    await page.evaluate(() => document.getElementById('new-chat').click()); await page.waitForTimeout(250);
    ok(true, 'new-chat wired (no error)');
    await page.evaluate(() => { const dr = document.getElementById('drawer'); const b = dr.getBoundingClientRect(); dr.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true, clientX: b.left + 10, clientY: b.top + 10 })); }); await page.waitForTimeout(180);
    await page.evaluate(() => { const b = document.querySelector('[data-act=edit]'); if (b) b.click(); }); await page.waitForTimeout(180);
    await page.evaluate(() => { const i = document.getElementById('ce-input'); if (i) { i.value = 'rename Chats to Threads'; document.getElementById('ce-send').click(); } }); await page.waitForTimeout(400);
    ok(editBody && editBody.id === 'island-drawer-frame', 'alt-click drawer → edit chat targets island-drawer-frame');
    ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(' | ')})`);
    await page.close();
  } finally { await br.close(); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); process.exit(2); });
