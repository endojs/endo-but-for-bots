// live-progress: a long turn shows a live "working…" bubble (thinking heartbeat + updateProgress pings + tool
// starts) instead of a silent/stalled page, and the bubble is replaced by the real answer when the turn lands.
const fs = require('node:fs');
const cap = fs.readFileSync(require('node:os').homedir() + '/.config/field-agent/root.swiss', 'utf8').trim();
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
(async () => {
  let chromium = null; try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - no chromium'); console.log(`\n${pass} passed, ${fail} failed (skipped)`); process.exit(0); }
  const br = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox','--disable-gpu','--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: '/var/lib/obsidian/oldlibs' } });
  try {
    const page = await br.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
    // steps SSE: heartbeat → progress ping → a tool start (no end yet, so the turn stays "live" while we inspect)
    await page.route('**/chat/steps**', r => r.fulfill({ status: 200, contentType: 'text/event-stream', body:
      'data: {"t":"thinking","round":1}\n\n' +
      'data: {"t":"progress","text":"Reading the bulletin…"}\n\n' +
      'data: {"t":"start","name":"research","detail":"endo upstream"}\n\n' }));
    // /chat: hold the answer ~1.6s so the progress bubble is observable, then resolve → it must be cleared.
    await page.route('**/chat', async r => { if (r.request().method() === 'POST') { await new Promise(s => setTimeout(s, 1600)); return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, answer: 'All done — folded the bulletin in.', steps: [], ui: [] }) }); } r.continue(); });
    await page.addInitScript(c => {
      try { localStorage.setItem('field-agent-cap', c); const id = 'chat-lp-localonly';
        localStorage.setItem('field-agent-chats', JSON.stringify([{ id, title: 'lp', ts: Date.now(), lastMsgAt: Date.now() }]));
        localStorage.setItem('field-agent-active', id);
        localStorage.setItem('field-agent-tx-' + id, JSON.stringify([{ who: 'you', text: 'hi' }, { who: 'agent', text: 'hello' }])); } catch {}
    }, cap);
    await page.goto('http://127.0.0.1:8778/', { waitUntil: 'load' }); await page.waitForTimeout(3500);
    await page.evaluate(() => { const it = [...document.querySelectorAll('.chat-item .ci-title')].find(s => /lp/.test(s.textContent)); if (it) it.click(); }); await page.waitForTimeout(400);
    await page.fill('#text', 'fold the bulletin in'); await page.evaluate(() => document.getElementById('send').click());
    // while the turn is in flight, the live-progress bubble should be present + reflect the latest ping/tool
    await page.waitForTimeout(700);
    const mid = await page.evaluate(() => { const el = document.querySelector('.live-progress'); return el ? (el.querySelector('.lp-text') || {}).textContent : null; });
    ok(mid !== null, `live-progress bubble is present mid-turn (text: ${JSON.stringify(mid)})`);
    ok(mid === 'Researching: endo upstream' || /Reading the bulletin|Thinking/.test(mid || ''), `bubble shows live activity (${JSON.stringify(mid)})`);
    // after the answer lands, the ephemeral bubble is gone + the real answer rendered
    await page.waitForTimeout(1600);
    const end = await page.evaluate(() => ({ lp: !!document.querySelector('.live-progress'), answered: /folded the bulletin in/.test(document.body.innerText) }));
    ok(end.lp === false, 'live-progress bubble cleared once the answer arrived');
    ok(end.answered, 'the real answer bubble rendered');
    ok(errs.length === 0, `no page errors (${errs.slice(0,2).join(' | ')})`);
    await page.close();
  } finally { await br.close(); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); process.exit(2); });
