#!/usr/bin/env node
// reattach-on-gateway-timeout.staging.test.cjs — REGRESSION for the "long Opus voice-note never comes back"
// stall. A long turn (Opus) outlives the public proxy's request window, so the blocking POST /chat returns the
// proxy's non-JSON error page → the client throws `gateway-timeout`. The turn is STILL running/finished
// server-side. The client MUST re-attach (poll /chat/result) and render the persisted answer — NOT blindly
// re-run the turn (which hits the same timeout again and aborts the in-flight run, so the answer never shows).
//
// We stub the network: /chat → a 504 HTML page (proxy timeout); /chat/result → a finished `done` answer.
// Assert: the persisted answer renders, AND /chat was POSTed exactly once (no wasteful re-run).
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
    let chatPosts = 0, resultPosts = 0;
    // /chat — simulate the public proxy timing out a long turn: a non-JSON 504 HTML page (the ngrok edge error).
    await page.route('**/chat', async route => { if (route.request().method() !== 'POST') return route.continue(); chatPosts += 1; route.fulfill({ status: 504, contentType: 'text/html', body: '<!DOCTYPE html><html><body>upstream timeout</body></html>' }); });
    // /chat/steps — the live trace SSE; keep it empty so the pendant doesn't hang.
    await page.route('**/chat/steps**', route => route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }));
    // /chat/result — the turn FINISHED server-side while the proxy had already given up: a persisted `done` answer.
    await page.route('**/chat/result', route => { resultPosts += 1; route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'done', text: 'a long question', startedAt: 1, result: { answer: 'ReattachedAnswerLanded', steps: [], toolsUsed: [], images: [], imageUrls: [], ui: [], remaining: 1000, allowance: 2000 } }) }); });
    await page.addInitScript(c => {
      try {
        localStorage.setItem('field-agent-cap', c);
        const id = 'chat-reattach-localonly';
        localStorage.setItem('field-agent-chats', JSON.stringify([{ id, title: 'reattach', ts: Date.now(), lastMsgAt: Date.now() }]));
        localStorage.setItem('field-agent-active', id);
        localStorage.setItem('field-agent-tx-' + id, JSON.stringify([]));
      } catch {}
    }, cap);
    await page.goto('http://127.0.0.1:8778/', { waitUntil: 'load' }); await page.waitForTimeout(3500);
    await page.evaluate(() => { const it = [...document.querySelectorAll('.chat-item .ci-title')].find(s => /reattach/.test(s.textContent)); if (it) it.click(); });
    await page.waitForTimeout(500);
    await page.fill('#text', 'a long question that the proxy will time out');
    await page.evaluate(() => { const b = document.getElementById('send'); b && b.click(); });
    // gateway-timeout fires immediately; the re-attach is scheduled ~1.8s later, then renders the done result.
    await page.waitForTimeout(6000);
    const body = await page.evaluate(() => document.body.innerText);
    ok(/ReattachedAnswerLanded/.test(body), 'the persisted server answer is re-attached + rendered after the proxy timeout');
    ok(chatPosts === 1, `the turn is NOT re-run — /chat POSTed exactly once (got ${chatPosts})`);
    ok(resultPosts >= 1, `the client re-attached via /chat/result (got ${resultPosts} call(s))`);
    await page.close();
  } finally { await br.close(); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); process.exit(2); });
