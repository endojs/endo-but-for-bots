#!/usr/bin/env node
// component-edit-chat.staging.test.cjs — STAGING proof of Increment 1 of the live-editable refactor
// (designs/live-editable-everything.md): Alt-click ✎ edit on a component opens a CONVERSATIONAL edit chat with
// the component's agent (NOT a one-shot window.prompt). Sending a message edits the component live via its edit
// endpoint and the exchange renders as a chat. Runs against the live service on :8778 with the root cap.
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
    // intercept the real edit so the test never spends an Opus rewrite — capture the payload + return a version.
    await page.route('**/components/edit', r => { try { editBody = JSON.parse(r.request().postData() || '{}'); } catch {} r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, version: 3, review: { worst: 'none' } }) }); });
    await page.route('**/chat/steps**', r => r.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }));
    await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
    await page.goto('http://127.0.0.1:8778/', { waitUntil: 'load' }); await page.waitForTimeout(3500);
    // an owner (root) holds component-edit rights; inject a tagged component (any [data-component-id] / .gw-component
    // element is alt-selectable — the trie tags them at render; we inject one to isolate the alt-click → edit-chat wiring).
    await page.evaluate(() => { const d = document.createElement('div'); d.className = 'gw-component'; d.setAttribute('data-component-id', 'test-comp'); d.setAttribute('data-component-name', 'Test Panel'); d.style.cssText = 'width:220px;height:60px'; d.textContent = 'test'; document.body.appendChild(d); });
    const found = await page.evaluate(() => { const el = document.querySelector('[data-component-id=test-comp]'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true, clientX: r.left + 5, clientY: r.top + 5 })); return el.getAttribute('data-component-name'); });
    ok(found === 'Test Panel', `alt-click resolves the component under the cursor (${found})`);
    await page.waitForTimeout(250);
    const chipEdit = await page.evaluate(() => { const b = document.querySelector('[data-act=edit]'); if (b) { b.click(); return true; } return false; });
    ok(chipEdit, 'the alt-click chip offers an ✎ edit action');
    await page.waitForTimeout(250);
    ok(await page.evaluate(() => !!document.getElementById('ce-input') && !!document.getElementById('ce-log')), 'edit opens a CONVERSATIONAL edit chat (not a window.prompt)');
    await page.evaluate(() => { document.getElementById('ce-input').value = 'make the header teal'; document.getElementById('ce-send').click(); });
    await page.waitForTimeout(600);
    ok(editBody && editBody.prompt === 'make the header teal' && editBody.id === 'test-comp', 'a chat message edits the component live (prompt + id sent to /components/edit)');
    ok(/✓ updated — v3/.test(await page.evaluate(() => document.getElementById('ce-log').innerText)), 'the agent reply shows the new live version');
    ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join('; ')})`);
    await page.close();
  } finally { await br.close(); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); process.exit(2); });
