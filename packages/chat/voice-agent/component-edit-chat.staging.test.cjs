#!/usr/bin/env node
// component-edit-chat.staging.test.cjs — STAGING proof of Increment 1 of the live-editable refactor
// (designs/live-editable-everything.md): Alt-click ✎ edit on a component opens a CONVERSATIONAL edit chat with
// the component's agent (NOT a one-shot window.prompt). Sending a message edits the component live via its edit
// endpoint and the exchange renders as a chat. Runs against the live service on :8778 with the root cap.
const { startIsolatedServer, loadChromium, launchBrowser } = require('./test-harness.cjs');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
(async () => {
  const chromium = loadChromium();
  if (!chromium) { console.log('  SKIP - no chromium'); console.log(`\n${pass} passed, ${fail} failed (skipped)`); process.exit(0); }
  const srv = await startIsolatedServer();
  const cap = srv.cap;
  const br = await launchBrowser(chromium);
  try {
    const page = await br.newPage();
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    let editBody = null;
    // intercept the real edit so the test never spends an Opus rewrite — capture the payload + return a version.
    // P2: a component edit runs the REAL agent loop via /components/edit-chat (conversational). Capture the
    // payload + return an agent answer + an edited version, so we assert the message/history wiring + render.
    let turns = 0;
    await page.route('**/components/edit-chat', r => {
      try { editBody = JSON.parse(r.request().postData() || '{}'); } catch {}
      turns += 1;
      // first turn: a clarifying question (ask); second turn: the edit is applied (answer + edited version)
      const body = turns === 1
        ? { ok: true, answer: 'Which header — the chat header or the panel header?', asking: true, edited: null, steps: ['readComponentSource'] }
        : { ok: true, answer: 'Recolored the panel header to teal.', asking: false, edited: { version: 3, review: { worst: 'none' } }, steps: ['readComponentSource', 'editComponent'] };
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.route('**/chat/steps**', r => r.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }));
    await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
    await page.goto(`${srv.base}/`, { waitUntil: 'load' }); await page.waitForTimeout(3500);
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
    // turn 1 — the agent asks a clarifying question (the REAL conversational loop, not a one-shot)
    await page.evaluate(() => { document.getElementById('ce-input').value = 'make the header teal'; document.getElementById('ce-send').click(); });
    await page.waitForTimeout(500);
    ok(editBody && editBody.message === 'make the header teal' && editBody.id === 'test-comp', 'a message runs the agent loop (message + id sent to /components/edit-chat)');
    ok(/Which header/.test(await page.evaluate(() => document.getElementById('ce-log').innerText)), 'the agent can ask a clarifying question (conversational, not one-shot)');
    // turn 2 — the answer carries prior history, the edit applies, version shown
    await page.evaluate(() => { document.getElementById('ce-input').value = 'the panel header'; document.getElementById('ce-send').click(); });
    await page.waitForTimeout(500);
    ok(editBody && Array.isArray(editBody.history) && editBody.history.length >= 2, 'the prior exchange is sent as history (a real conversation)');
    ok(/Recolored the panel header to teal\./.test(await page.evaluate(() => document.getElementById('ce-log').innerText)), "the agent's reply renders");
    ok(/v3/.test(await page.evaluate(() => document.getElementById('ce-log').innerText)), 'an applied edit shows the new live version');
    ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join('; ')})`);
    await page.close();
  } finally { await br.close(); srv.close(); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); process.exit(2); });
