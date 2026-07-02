#!/usr/bin/env node
// empty-and-resume-reattach.staging.test.cjs — REGRESSION for two error-hygiene fixes in app.js:
//
//   P1-3 (empty turn-ender → empty bubble): a program that ends with answer("")/answer() sends { answer:'' }
//   with no flag. The client must render a clear "ended its turn without a message" affordance — NOT a bare
//   '…' (indistinguishable from a still-thinking bubble). When the turn DID produce other content (a widget,
//   object, image, card) an empty text bubble is correct (the content is the reply). Driven via the exposed
//   window.renderAgentResponse hook.
//
//   P1-2 (resume path can't parse a non-JSON proxy error page): a RESUMED turn (after a top-up) that outlives
//   the public proxy window returns an ngrok HTML 502/504 page. retryTurn used to .json() it → a parse
//   "Unexpected token '<'" dead-end. It must now detect the non-JSON/!ok response and RE-ATTACH (poll
//   /chat/result) — delivering the answer, not a stuck "error:" status. Driven end-to-end: send → exhausted
//   card → owner top-up → resumed /chat returns a 504 HTML page → the client re-attaches + renders the answer.
//
// Boots an ISOLATED voice-agent (throwaway SEED_FILE/OUT_DIR — never touches the live root cap or state).
// Run: node empty-and-resume-reattach.staging.test.cjs   (SKIPs cleanly without chromium)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const net = require('node:net');
// Pick a free ephemeral port (fixed ports 8795-8799 collide with sibling staging servers — T-TEST-2).
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
let PORT = 0, BASE = '';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-resume-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

(async () => {
  PORT = await freePort(); BASE = `http://127.0.0.1:${PORT}`;
  srv = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json'),
      PRINT_ROOT_CAP: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted');
  if (!up) { cleanup(); process.exit(1); }
  let rootCap = '';
  for (let i = 0; i < 40; i++) { try { rootCap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim(); if (rootCap) break; } catch {} await sleep(250); }
  ok(!!rootCap, 'root cap seed written');
  if (!rootCap) { cleanup(); process.exit(1); }

  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - no chromium'); console.log(`\n${pass} passed, ${fail} failed (skipped)`); cleanup(); process.exit(fail ? 1 : 0); }

  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  try {
    // ── P1-3: empty turn-ender → a legible affordance, not a bare '…' ──────────────────────────────────
    {
      const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      await page.evaluate(c => localStorage.setItem('field-agent-cap', c), rootCap);
      await page.goto(`${BASE}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.renderAgentResponse === 'function', { timeout: 15000 });

      // Render + read the NEW bubble atomically in one evaluate (by pre-count index) so async welcome/seed
      // bubbles rendering in the background can't be mistaken for our answer bubble.
      const renderAndGet = payload => page.evaluate(p => {
        const before = document.querySelectorAll('.msg').length;
        window.renderAgentResponse(p);
        const nu = document.querySelectorAll('.msg')[before];
        const b = nu && nu.querySelector('.body');
        return b ? b.innerText : (nu ? nu.innerText : '__no-bubble__');
      }, payload);

      const emptyOut = await renderAndGet({ answer: '' });
      ok(/ended its turn without a message/i.test(emptyOut), `empty answer("") renders the affordance (got: ${JSON.stringify(emptyOut).slice(0, 80)})`);
      ok(emptyOut.trim() !== '…', 'empty answer does NOT render a bare "…" thinking bubble');

      ok(/RealAnswerText/.test(await renderAndGet({ answer: 'RealAnswerText' })), 'a non-empty answer still renders its text');

      // aux content present (an image) but empty text → the affordance is SUPPRESSED (the content is the reply)
      const auxOut = await renderAndGet({ answer: '', images: ['data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA='] });
      ok(!/ended its turn without a message/i.test(auxOut), 'empty answer WITH aux content suppresses the affordance');
      await page.close();
    }

    // ── P1-2 (resume path): a resumed turn hitting a non-JSON 504 page RE-ATTACHES, not a parse dead-end ──
    {
      const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
      let chatPosts = 0, resultPosts = 0;
      // Force the scoper's fast path so send() runs without a consent-sheet click.
      await page.route('**/scope', route => route.request().method() === 'POST'
        ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ autoApprove: true, proposed: ['app'], catalog: [{ power: 'app', label: 'app' }] }) })
        : route.continue());
      await page.route('**/scope/mint', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ scopedCap: rootCap }) }));
      await page.route('**/chat/steps**', route => route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }));
      // 1st /chat POST → exhausted (server refused w/o a model call). 2nd /chat POST (the RESUME) → a 504 HTML
      // proxy page (the non-JSON error that used to throw a parse dead-end in retryTurn).
      await page.route('**/chat', async route => {
        if (route.request().method() !== 'POST') return route.continue();
        chatPosts += 1;
        if (chatPosts === 1) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ exhausted: true, remaining: 0, allowance: 1000 }) });
        return route.fulfill({ status: 504, contentType: 'text/html', body: '<!DOCTYPE html><html><body>upstream request timeout</body></html>' });
      });
      await page.route('**/budget/topup', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ remaining: 500000, allowance: 1000000 }) }));
      // the resumed turn FINISHED server-side while the proxy gave up → a persisted `done` answer to re-attach.
      await page.route('**/chat/result', route => { resultPosts += 1; route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'done', text: 'a resumed question', startedAt: 1, result: { answer: 'Resume reattach landed OK', steps: [], toolsUsed: [], images: [], imageUrls: [], ui: [], remaining: 999, allowance: 1000000 } }) }); });

      await page.addInitScript(c => {
        try {
          localStorage.setItem('field-agent-cap', c);
          const id = 'chat-resume-localonly';
          localStorage.setItem('field-agent-chats', JSON.stringify([{ id, title: 'resumecase', ts: Date.now(), lastMsgAt: Date.now(), scopedCap: c }]));
          localStorage.setItem('field-agent-active', id);
          localStorage.setItem('field-agent-tx-' + id, JSON.stringify([]));
        } catch {}
      }, rootCap);
      const pageErrors = [];
      page.on('pageerror', e => pageErrors.push(String(e && e.message || e)));
      await page.goto(`${BASE}/`, { waitUntil: 'load' });
      await page.waitForTimeout(2500);
      await page.evaluate(() => { const it = [...document.querySelectorAll('.chat-item .ci-title')].find(s => /resumecase/.test(s.textContent)); if (it) it.click(); });
      await page.waitForTimeout(400);
      await page.fill('#text', 'a question whose resume the proxy will time out');
      await page.evaluate(() => { const b = document.getElementById('send'); b && b.click(); });
      await page.waitForSelector('.exhausted-card .confirm', { timeout: 8000 });
      ok(true, 'the first turn returned exhausted → the top-up card rendered');
      // Click the owner free top-up → topup ok → resumeIfPending → retryTurn(resume) → 504 HTML → reattach.
      await page.evaluate(() => { const b = document.querySelector('.exhausted-card .confirm'); b && b.click(); });
      await page.waitForTimeout(6000);

      const body = await page.evaluate(() => document.body.innerText);
      if (!/Resume reattach landed OK/.test(body)) {
        const diag = await page.evaluate(() => ({ sid: window.sessionId, bodies: [...document.querySelectorAll('.msg .body')].map(b => b.innerText.slice(0, 60)), status: (document.getElementById('status') || {}).textContent }));
        console.log('  DIAG', JSON.stringify(diag));
      }
      ok(/Resume reattach landed OK/.test(body), 'the resumed turn RE-ATTACHED and rendered the persisted answer (P1-2 resume path)');
      ok(!/Unexpected token|<!DOCTYPE|JSON\.parse/i.test(body), 'no JSON-parse dead-end surfaced from the non-JSON 504 page');
      ok(!pageErrors.some(e => /Unexpected token|JSON/i.test(e)), `no uncaught JSON parse error (page errors: ${JSON.stringify(pageErrors).slice(0, 120)})`);
      ok(chatPosts === 2 && resultPosts >= 1, `resume was attempted once then re-attached (chatPosts=${chatPosts}, resultPosts=${resultPosts})`);
      await page.close();
    }
  } finally { await browser.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); cleanup(); process.exit(2); });
