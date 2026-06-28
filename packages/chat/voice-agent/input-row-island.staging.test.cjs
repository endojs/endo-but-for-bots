#!/usr/bin/env node
// input-row-island.staging.test.cjs — P4: the composer input row is now a confined, alt-clickable, editable
// island, and the composer STILL SENDS (the critical regression). Renders structure with every id + form attrs;
// app.js wires #text/#send by id after mount. Snapshot→restore fallback can never blank the composer.
const fs = require('node:fs');
const cap = fs.readFileSync(require('node:os').homedir() + '/.config/field-agent/root.swiss', 'utf8').trim();
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
(async () => {
  let chromium = null; try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - no chromium'); console.log(`\n${pass} passed, ${fail} failed (skipped)`); process.exit(0); }
  const br = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: '/var/lib/obsidian/oldlibs' } });
  try {
    const page = await br.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
    let chatText = null, editBody = null;
    await page.route('**/chat', r => { if (r.request().method() === 'POST') { try { chatText = JSON.parse(r.request().postData() || '{}').text; } catch {} return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, answer: 'ok', steps: [], ui: [] }) }); } r.continue(); });
    await page.route('**/chat/steps**', r => r.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }));
    await page.route('**/components/edit-chat', r => { try { editBody = JSON.parse(r.request().postData() || '{}'); } catch {} r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, answer: 'ok', steps: ['readComponentSource'] }) }); });
    // seed an existing chat so the send is a FOLLOW-UP (the landing first-send takes a different path that is
    // flaky to drive headlessly — the authoritative tool-output-history test seeds a chat the same way).
    await page.addInitScript(c => {
      try {
        localStorage.setItem('field-agent-cap', c);
        const id = 'chat-inputrow-localonly';
        localStorage.setItem('field-agent-chats', JSON.stringify([{ id, title: 'inputrow', ts: Date.now(), lastMsgAt: Date.now() }]));
        localStorage.setItem('field-agent-active', id);
        localStorage.setItem('field-agent-tx-' + id, JSON.stringify([{ who: 'you', text: 'hi' }, { who: 'agent', text: 'hello' }]));
      } catch {}
    }, cap);
    await page.goto('http://127.0.0.1:8778/', { waitUntil: 'load' }); await page.waitForTimeout(4000);
    await page.evaluate(() => { const it = [...document.querySelectorAll('.chat-item .ci-title')].find(s => /inputrow/.test(s.textContent)); if (it) it.click(); }); await page.waitForTimeout(500);
    const r1 = await page.evaluate(() => { const f = document.getElementById('file'); return { isIsland: document.querySelector('.inputrow').getAttribute('data-component-id'), missing: ['attach', 'file', 'text', 'send', 'mic', 'meeting-btn'].filter(i => !document.getElementById(i)), accept: f && f.getAttribute('accept'), multiple: f && f.hasAttribute('multiple'), ph: document.getElementById('text').getAttribute('placeholder') }; });
    ok(r1.isIsland === 'island-input-row', 'the input row IS the island');
    ok(r1.missing.length === 0, `every id present (missing: ${r1.missing.join(',') || 'none'})`);
    ok(/image/.test(r1.accept || '') && r1.multiple, 'file input keeps accept + multiple');
    ok(r1.ph === 'Message Agent C…', 'textarea placeholder preserved');
    // CRITICAL: the composer still SENDS (synthetic click on #send → /chat, the authoritative method)
    await page.fill('#text', 'send still works via the island'); await page.evaluate(() => { const b = document.getElementById('send'); b && b.click(); }); await page.waitForTimeout(700);
    ok(chatText && /send still works via the island/.test(chatText), `send works — message reached /chat (${chatText ? 'ok' : 'NONE'})`);
    // alt-click → edit chat targets the island
    await page.evaluate(() => { const row = document.querySelector('.inputrow'); const r = row.getBoundingClientRect(); row.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true, clientX: r.left + 5, clientY: r.top + 5 })); }); await page.waitForTimeout(180);
    await page.evaluate(() => { const b = document.querySelector('[data-act=edit]'); if (b) b.click(); }); await page.waitForTimeout(180);
    await page.evaluate(() => { const i = document.getElementById('ce-input'); if (i) { i.value = 'widen it'; document.getElementById('ce-send').click(); } }); await page.waitForTimeout(400);
    ok(editBody && editBody.id === 'island-input-row', 'alt-click → edit chat targets island-input-row');
    ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(' | ')})`);
    await page.close();
  } finally { await br.close(); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); process.exit(2); });
