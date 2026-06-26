#!/usr/bin/env node
// component-attenuation.staging.test.cjs — STAGING proof of "read-only is by construction, not a type". A
// custom view receives a mediated handle to ONE object, ATTENUATED to exactly the methods it was granted. A
// component handed only a READ method (inbox) literally cannot call a WRITE method (send) — the host rejects
// it before it ever reaches the wire. There is no "read-only component type"; the attenuation of the object
// handle the component holds IS its read-only-ness.
//
// Run: node component-attenuation.staging.test.cjs   (exits non-zero on failure; SKIPs without chromium)

const { spawn } = require('node:child_process');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const PORT = 8844; const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attn-'));
let srv = null; let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

// a renderer that tries BOTH a write (send) and a read (inbox) through props.call, recording the outcome
const RENDERER = "(endowments, props) => { const { h, useState } = endowments; const [note, setNote] = useState(''); return h('div', null, [ h('button', { id: 'try-send', class: 'mini', onClick: async () => { try { await props.call('send', ['x']); setNote('SEND-ALLOWED'); } catch (e) { setNote('SEND-BLOCKED: ' + (e && e.message || '')); } } }, 'trysend'), h('button', { id: 'try-inbox', class: 'mini', onClick: async () => { try { await props.call('inbox', []); setNote('INBOX-OK'); } catch (e) { setNote('INBOX-ERR'); } } }, 'tryinbox'), h('div', { id: 'note' }, note) ]); }";

(async () => {
  srv = spawn('node', ['server.mjs'], { cwd: __dirname, env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1', FIELD_LOCKDOWN: '1',
    SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'), PROJECTS_STORE: path.join(tmp, 'projects.json'),
    MEMO_RUNS_FILE: path.join(tmp, 'memo.json'), FORKS_STORE: path.join(tmp, 'forks.json'), BLOSSOM_STORE: path.join(tmp, 'blossom.json'), PRINT_ROOT_CAP: '1' }, stdio: ['ignore', 'ignore', 'ignore'] });
  let up = false; for (let i = 0; i < 90; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted'); if (!up) { cleanup(); process.exit(1); }
  const cap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();
  // register the renderer as the READ-ONLY view: granted methods = ['inbox'] only (NO send)
  const reg = await (await fetch(`${BASE}/blossom/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, kind: 'object', methods: ['inbox'], source: RENDERER, name: 'ReadOnlyPeer' }) })).json();
  ok(reg.ok, 'registered a read-only (inbox-only) custom view');

  let chromium = null; try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - no chromium'); console.log(`\n${pass} passed, ${fail} failed (skipped)`); cleanup(); process.exit(fail ? 1 : 0); }
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: '/var/lib/obsidian/oldlibs' } });
  try {
    const page = await browser.newPage();
    // intercept /rpc: record every objectCall method that REACHES the wire; fulfill them
    await page.addInitScript(() => {
      window.__wire = [];
      const orig = window.fetch;
      window.fetch = (url, opts) => {
        try { const u = String(url || ''); if (u.endsWith('/rpc') && opts && opts.method === 'POST') { const b = JSON.parse(opts.body || '{}'); if (b.method === 'objectCall') { window.__wire.push(b.args && b.args[1]); return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { ok: true, value: [] } }), { status: 200, headers: { 'content-type': 'application/json' } })); } } } catch {}
        return orig(url, opts);
      };
    });
    await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
    await page.goto(`${BASE}/`, { waitUntil: 'load' }); await sleep(2200);
    // mount the read-only view (methods scoped to ['inbox'])
    await page.evaluate(() => window.requestCustomView({ name: 'ReadOnlyPeer', kind: 'object', methods: ['inbox'], callable: true }));
    await page.waitForFunction(() => document.querySelector('.cv-mount #try-send'), { timeout: 9000 }).catch(() => {});
    ok(await page.$('.cv-mount #try-send') !== null, 'the read-only view mounted (try-send / try-inbox buttons)');

    // attempt the WRITE (send) — must be blocked BY THE HANDLE, never reaching the wire
    await page.click('.cv-mount #try-send');
    await page.waitForFunction(() => /SEND-(BLOCKED|ALLOWED)/.test(document.querySelector('.cv-mount #note')?.textContent || ''), { timeout: 4000 }).catch(() => {});
    const sendNote = await page.evaluate(() => document.querySelector('.cv-mount #note')?.textContent || '');
    ok(/SEND-BLOCKED/.test(sendNote) && /scoped to: inbox/.test(sendNote), `send is rejected by the attenuated handle — got: ${JSON.stringify(sendNote)}`);
    const wireAfterSend = await page.evaluate(() => (window.__wire || []).slice());
    ok(!wireAfterSend.includes('send'), `the forbidden "send" NEVER reached the wire (read-only by construction) — wire saw: ${JSON.stringify(wireAfterSend)}`);

    // attempt the READ (inbox) — must be allowed and reach the wire
    await page.click('.cv-mount #try-inbox');
    await page.waitForFunction(() => /INBOX-OK/.test(document.querySelector('.cv-mount #note')?.textContent || ''), { timeout: 4000 }).catch(() => {});
    const inboxOk = await page.evaluate(() => /INBOX-OK/.test(document.querySelector('.cv-mount #note')?.textContent || ''));
    const wireSawInbox = await page.evaluate(() => (window.__wire || []).includes('inbox'));
    ok(inboxOk && wireSawInbox, 'the granted "inbox" read IS allowed and reaches the object');
    await page.close();
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); cleanup(); process.exit(2); });
