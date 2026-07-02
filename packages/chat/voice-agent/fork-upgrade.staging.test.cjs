#!/usr/bin/env node
// fork-upgrade.staging.test.cjs — STAGING proof of Phase-4 sharing & upgrades through real HTTP + a real
// browser fork widget: a recipient pins to the invited version, the owner edits, the widget shows an
// "⬆ available" banner, Try-it-on renders the new version non-destructively, Accept commits it, and the
// owner's ✉ notice reaches the recipient's inbox.
//
// Run: node fork-upgrade.staging.test.cjs   (exits non-zero on failure; SKIPs without chromium)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 20000 + (process.pid % 20000); // T-TEST-2: PID-derived port (unique per node --test child); never a fixed 879x
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-upg-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
const post = (p, body) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

const V1 = "(endowments, props) => endowments.h(Banner, { kind: 'info' }, 'UPGRADE v1')";
const V2 = "(endowments, props) => endowments.h(Banner, { kind: 'info' }, 'UPGRADE v2 NEW')";

(async () => {
  srv = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1', FIELD_LOCKDOWN: '1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json'),
      FORKS_STORE: path.join(tmp, 'forks.json'), PRINT_ROOT_CAP: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted (FIELD_LOCKDOWN=1)');
  if (!up) { cleanup(); process.exit(1); }
  const cap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  const c = await post('/forks/create', { cap, source: V1, name: 'Upgrade fork' });
  const s = await post('/forks/share', { cap, id: c.id, charge: { scheme: 'free' } });
  ok(c.ok && s.ok && s.token, 'owner created + shared a fork (pinned at v1)');

  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) {
    console.log('  SKIP - headless upgrade checks (playwright-core unavailable)');
    console.log(`\n${pass} passed, ${fail} failed (browser checks skipped)`);
    cleanup(); process.exit(fail ? 1 : 0);
  }

  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  try {
    const page = await browser.newPage();
    await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
    // recipient opens the shared link — pins at v1
    await page.goto(`${BASE}/#fork=${encodeURIComponent(s.token)}`, { waitUntil: 'load' });
    await page.waitForFunction(() => { const st = document.querySelector('.fork-stage'); return st && /UPGRADE v1/.test(st.textContent || ''); }, { timeout: 6000 }).catch(() => {});
    ok(await page.evaluate(() => /UPGRADE v1/.test((document.querySelector('.fork-stage') || {}).textContent || '')), 'recipient sees v1 (pinned at invite)');
    ok(await page.evaluate(() => !/available/.test(document.querySelector('.fork-upgrade').textContent || '')), 'no upgrade available yet (distribution badge may show)');

    // owner edits → v2, and notifies
    await post('/forks/edit', { cap, id: c.id, source: V2 });
    await post('/forks/notify', { cap, id: c.id, message: 'made it new' });

    // recipient re-opens → still v1 (non-destructive) BUT an upgrade banner + the notice appear.
    // The ?r=2 query forces a REAL document navigation (a hash-only change wouldn't reload → boot handoff
    // wouldn't re-run); pathname stays '/' so the server still serves the shell.
    await page.goto(`${BASE}/?r=2#fork=${encodeURIComponent(s.token)}`, { waitUntil: 'load' });
    await page.waitForFunction(() => { const u = document.querySelector('.fork-upgrade'); return u && /available/.test(u.textContent || ''); }, { timeout: 6000 }).catch(() => {});
    const state = await page.evaluate(() => ({
      stage: (document.querySelector('.fork-stage') || {}).textContent || '',
      upgrade: (document.querySelector('.fork-upgrade') || {}).textContent || '',
    }));
    ok(/UPGRADE v1/.test(state.stage), 'recipient STILL on v1 (owner edit did not force-upgrade)');
    ok(/available/.test(state.upgrade), `an "⬆ available" upgrade banner appeared — got: ${JSON.stringify(state.upgrade.slice(0, 60))}`);
    ok(/made it new/.test(state.upgrade), 'the owner notice reached the recipient inbox');

    // Try it on → renders v2 without committing the pin
    await page.evaluate(() => { const b = Array.from(document.querySelectorAll('.fork-upgrade button')).find(x => /Try it on/.test(x.textContent)); if (b) b.click(); });
    await page.waitForFunction(() => /UPGRADE v2 NEW/.test((document.querySelector('.fork-stage') || {}).textContent || ''), { timeout: 5000 }).catch(() => {});
    ok(await page.evaluate(() => /UPGRADE v2 NEW/.test((document.querySelector('.fork-stage') || {}).textContent || '')), 'Try-it-on rendered v2 (try-on)');
    ok((await post('/forks/open', { token: s.token })).version === 1, 'try-on did NOT commit (server pin still v1)');

    // Accept → commits to v2
    await page.evaluate(() => { const b = Array.from(document.querySelectorAll('.fork-upgrade button')).find(x => /Accept/.test(x.textContent)); if (b) b.click(); });
    await page.waitForFunction(() => { const u = document.querySelector('.fork-upgrade'); return u && !/available/.test(u.textContent || ''); }, { timeout: 5000 }).catch(() => {});
    ok((await post('/forks/open', { token: s.token })).version === 2, 'Accept committed the upgrade (server pin now v2)');
    await page.close();
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); cleanup(); process.exit(2); });
