#!/usr/bin/env node
// input-clear.staging.test.cjs — STAGING guard: once a message is SENT (its bubble is committed), the
// composer must stay CLEARED — even if the turn then errors, gateway-times-out (long turns via the public
// proxy), or resumes. Regression for "after sending, the text gets re-inserted into the input box": the old
// code restored the typed text whenever sendChat returned false, including for post-commit failures.
// Stubs /chat with three responder modes and asserts the input is empty after each send.
//
// Run: node input-clear.staging.test.cjs   (exits non-zero on failure; SKIPs without chromium)
const { startIsolatedServer, loadChromium, launchBrowser } = require('./test-harness.cjs');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
(async () => {
  const chromium = loadChromium();
  if (!chromium) { console.log('  SKIP - no chromium'); console.log(`\n${pass} passed, ${fail} failed (skipped)`); process.exit(0); }
  const srv = await startIsolatedServer();
  const cap = srv.cap;
  const br = await launchBrowser(chromium);
  const test = async (label, mode) => {
    const page = await br.newPage();
    await page.addInitScript((m) => { const orig = window.fetch; window.fetch = (u, o) => { u = String(u);
      if (u.endsWith('/chat') && o && o.method === 'POST') {
        if (m === 'timeout') return Promise.resolve(new Response('<!DOCTYPE html><html>gateway timeout</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
        if (m === 'error') return Promise.resolve(new Response(JSON.stringify({ error: 'model overloaded' }), { status: 200, headers: { 'content-type': 'application/json' } }));
        return Promise.resolve(new Response(JSON.stringify({ ok: true, answer: 'hi', steps: [], ui: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      if (u.endsWith('/chat/steps')) return Promise.resolve(new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } }));
      return orig(u, o);
    }; }, mode);
    await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
    await page.goto(`${srv.base}/`, { waitUntil: 'load' }); await page.waitForTimeout(2500);
    await page.fill('#text', 'my important message');
    await page.evaluate(() => { const b = document.getElementById('send'); b && b.click(); });
    await page.waitForTimeout(2500);
    const v = await page.evaluate(() => document.getElementById('text').value);
    ok(v === '', `${label}: composer is CLEARED after send (got ${JSON.stringify(v)})`);
    await page.close();
  };
  try { await test('gateway-timeout', 'timeout'); await test('provider-error', 'error'); await test('success', 'success'); }
  finally { await br.close(); srv.close(); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); process.exit(2); });
