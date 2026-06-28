#!/usr/bin/env node
// bubble-island.staging.test.cjs — P4: the per-message bubble SHELL renders via an editable island, so
// alt-clicking ANY message edits the bubble TEMPLATE. The chat still displays (the .body slot is filled
// imperatively). Seeds a chat with messages + verifies the bubbles are tagged island-message-bubble, show
// their text, and alt-click → edit chat targets island-message-bubble.
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
    await page.route('**/chat/steps**', r => r.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }));
    await page.addInitScript(c => { localStorage.setItem('field-agent-cap', c); const id = 'c-bub'; localStorage.setItem('field-agent-chats', JSON.stringify([{ id, title: 'bubbletest', ts: Date.now(), lastMsgAt: Date.now() }])); localStorage.setItem('field-agent-active', id); localStorage.setItem('field-agent-tx-' + id, JSON.stringify([{ who: 'you', text: 'UNIQUEUSERMSG' }, { who: 'agent', text: 'UNIQUEAGENTMSG' }])); }, cap);
    await page.goto('http://127.0.0.1:8778/', { waitUntil: 'load' }); await page.waitForTimeout(4000);
    await page.evaluate(() => { const it = [...document.querySelectorAll('.chat-item .ci-title')].find(s => /bubbletest/.test(s.textContent)); if (it) it.click(); }); await page.waitForTimeout(700);
    const r = await page.evaluate(() => {
      const msgs = [...document.querySelectorAll('.msg')];
      const tagged = msgs.filter(m => m.getAttribute('data-component-id') === 'island-message-bubble').length;
      const body = document.body.innerText;
      return { msgCount: msgs.length, tagged, hasUser: /UNIQUEUSERMSG/.test(body), hasAgent: /UNIQUEAGENTMSG/.test(body) };
    });
    ok(r.msgCount >= 2, `the seeded messages rendered as bubbles (${r.msgCount})`);
    ok(r.tagged >= 2, `every bubble is the island (tagged island-message-bubble: ${r.tagged}/${r.msgCount})`);
    ok(r.hasUser && r.hasAgent, 'the bubble TEXT still renders (the .body slot is filled imperatively)');
    // alt-click a bubble → edit chat targets the bubble template
    await page.evaluate(() => { const m = document.querySelector('.msg[data-component-id=island-message-bubble]'); const r = m.getBoundingClientRect(); m.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true, clientX: r.left + 5, clientY: r.top + 5 })); }); await page.waitForTimeout(180);
    await page.evaluate(() => { const b = document.querySelector('[data-act=edit]'); if (b) b.click(); }); await page.waitForTimeout(180);
    await page.evaluate(() => { const i = document.getElementById('ce-input'); if (i) { i.value = 'round the corners more'; document.getElementById('ce-send').click(); } }); await page.waitForTimeout(400);
    ok(editBody && editBody.id === 'island-message-bubble', 'alt-click a message → edit chat targets island-message-bubble (the template)');
    ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(' | ')})`);
    await page.close();
  } finally { await br.close(); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); process.exit(2); });
