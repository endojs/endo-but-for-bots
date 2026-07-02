#!/usr/bin/env node
// paste-link.staging.test.cjs — STAGING proof of the paste-link fix: pasting a link into the composer
// renders the inline card AND, on send, the AGENT receives the (cap-stripped) link in the /chat payload.
// (Bug: the card was client-only; the agent never saw the link.)
//
// Run: node paste-link.staging.test.cjs   (exits non-zero on failure; SKIPs without chromium)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 20000 + (process.pid % 20000); // T-TEST-2: PID-derived port (unique per node --test child); never a fixed 879x
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-link-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

const LINK = 'http://example.com/cool-thing.html';

(async () => {
  srv = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json'),
      FORKS_STORE: path.join(tmp, 'forks.json'), PRINT_ROOT_CAP: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted');
  if (!up) { cleanup(); process.exit(1); }
  const cap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - no chromium'); console.log(`\n${pass} passed, ${fail} failed (skipped)`); cleanup(); process.exit(fail ? 1 : 0); }

  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  try {
    const page = await browser.newPage();
    let chatBody = null;
    // stub the first-turn scope flow so the send proceeds straight to /chat; capture the /chat payload.
    await page.route('**/scope', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ autoApprove: true, proposed: ['web'], catalog: [{ power: 'web', label: 'web access' }] }) }));
    await page.route('**/scope/mint', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ scopedCap: 'scoped-test' }) }));
    await page.route('**/chat', r => { try { chatBody = JSON.parse(r.request().postData() || '{}'); } catch {} r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ answer: 'got it', toolsUsed: [], ui: [] }) }); });
    await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.waitForTimeout(1800);

    // paste a site link into the composer (#text) via a synthetic ClipboardEvent
    const pasted = await page.evaluate(url => {
      const inp = document.getElementById('text'); if (!inp) return 'no-composer';
      inp.focus();
      const dt = new DataTransfer(); dt.setData('text/plain', url);
      inp.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return 'pasted';
    }, LINK);
    ok(pasted === 'pasted', 'pasted a link into the composer');
    await page.waitForTimeout(400);

    const card = await page.evaluate(() => {
      const w = document.querySelector('.inwidget, .msg.widget');
      return { has: !!w, text: w ? w.textContent : '', composerEmpty: (document.getElementById('text').value || '') === '' };
    });
    ok(card.has, 'an inline link card rendered in the transcript');
    ok(card.composerEmpty, 'the link was NOT left as raw text in the composer (preventDefault path)');

    // send (empty composer + staged link) → doSend → sendChat → /chat
    await page.click('#send');
    for (let i = 0; i < 50 && !chatBody; i++) await sleep(150);
    ok(!!chatBody, 'a /chat request was sent');
    ok(chatBody && typeof chatBody.text === 'string' && chatBody.text.includes(LINK),
      `the agent payload TEXT carries the pasted link — got: ${JSON.stringify((chatBody && chatBody.text || '').slice(0, 120))}`);
    ok(chatBody && /link the user shared/i.test(chatBody.text || ''), 'the link is clearly labelled as user-shared context');
    await page.close();
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); cleanup(); process.exit(2); });
