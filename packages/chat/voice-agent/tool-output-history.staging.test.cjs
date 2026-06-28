#!/usr/bin/env node
// tool-output-history.staging.test.cjs — STAGING proof that a turn's TOOL OUTPUTS are carried into the
// cross-turn history, so the agent reuses what it already retrieved instead of re-searching/re-reading the
// same source every turn (the "re-reads the diet note every prompt" complaint). Seeds a local chat whose
// prior agent turn read a note, stubs /chat to capture payload.history on the NEXT send, and asserts the
// note's content + the tool name + the reuse hint are present.
//
// Run: node tool-output-history.staging.test.cjs   (exits non-zero on failure; SKIPs without chromium)
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
    await page.addInitScript((c) => {
      try {
        localStorage.setItem('field-agent-cap', c);
        const id = 'chat-toolhist-localonly';
        localStorage.setItem('field-agent-chats', JSON.stringify([{ id, title: 'diet', ts: Date.now(), lastMsgAt: Date.now() }]));
        localStorage.setItem('field-agent-active', id);
        localStorage.setItem('field-agent-tx-' + id, JSON.stringify([
          { who: 'you', text: 'tell me about Alexa diet' },
          { who: 'agent', text: 'Alexa avoids several FODMAPs.', steps: [{ name: 'readDietNote', call: '{"path":"Dietician/Alexa — Diet.md"}', result: '# Alexa Diet\nAvoids corn (high fructans), garlic, onion. Low FODMAP only.' }] },
        ]));
      } catch {}
      window.__hist = null; const orig = window.fetch;
      window.fetch = (u, o) => { u = String(u);
        if (u.endsWith('/chat') && o && o.method === 'POST') { try { window.__hist = JSON.parse(o.body).history; } catch {} return Promise.resolve(new Response(JSON.stringify({ ok: true, answer: 'ok', steps: [], ui: [] }), { status: 200, headers: { 'content-type': 'application/json' } })); }
        if (u.endsWith('/chat/steps')) return Promise.resolve(new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } }));
        return orig(u, o);
      };
    }, cap);
    await page.goto('http://127.0.0.1:8778/', { waitUntil: 'load' }); await page.waitForTimeout(3500);
    await page.evaluate(() => { const it = [...document.querySelectorAll('.chat-item .ci-title')].find(s => /diet/.test(s.textContent)); if (it) it.click(); });
    await page.waitForTimeout(600);
    await page.fill('#text', 'what about corn again?'); await page.evaluate(() => { const b = document.getElementById('send'); b && b.click(); });
    await page.waitForTimeout(1500);
    const r = await page.evaluate(() => { const blob = JSON.stringify(window.__hist || []); return { hasOutput: /high fructans/.test(blob), hasName: /readDietNote/.test(blob), hasHint: /REUSE these/.test(blob) }; });
    ok(r.hasOutput, "the prior turn's tool OUTPUT (the note content) is in the next turn's history");
    ok(r.hasName, 'the tool name is included so the agent knows what it ran');
    ok(r.hasHint, 'a reuse hint tells the agent not to re-fetch the same source');
    await page.close();
  } finally { await br.close(); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); process.exit(2); });
