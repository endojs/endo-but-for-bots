#!/usr/bin/env node
// fork-widget.staging.test.cjs — STAGING proof of the CLIENT fork widget: a shared #fork=<token> link opens
// the fork inline in a chat (recipient flow), it renders confined (no iframe), and "Make mine" adopts it as
// the user's own (owner flow → Edit/Share appear). Real server (FIELD_LOCKDOWN=1) + real headless browser.
//
// Run: node fork-widget.staging.test.cjs   (exits non-zero on failure; SKIPs without chromium)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 20000 + (process.pid % 20000); // T-TEST-2: PID-derived port (unique per node --test child); never a fixed 879x
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-widget-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
const post = (p, body) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

const SRC = "(endowments, props) => endowments.h(Banner, { kind: 'info' }, 'WIDGET-OK ' + (props.who || ''))";

(async () => {
  srv = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1', FIELD_LOCKDOWN: '1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json'),
      FORKS_STORE: path.join(tmp, 'forks.json'),
      PRINT_ROOT_CAP: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted (FIELD_LOCKDOWN=1)');
  if (!up) { cleanup(); process.exit(1); }
  const cap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  // owner creates a fork + shares it → a recipient link token
  const c = await post('/forks/create', { cap, source: SRC, name: 'Widget fork' });
  ok(c.ok && c.id, 'owner created a fork');
  const s = await post('/forks/share', { cap, id: c.id, charge: { scheme: 'free' } });
  ok(s.ok && s.token, 'owner shared it → token');

  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) {
    console.log('  SKIP - headless widget checks (playwright-core unavailable)');
    console.log(`\n${pass} passed, ${fail} failed (browser checks skipped)`);
    cleanup(); process.exit(fail ? 1 : 0);
  }

  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  try {
    const page = await browser.newPage();
    // recipient: cap in localStorage (they hold a cap), open the shared #fork=<token> link
    await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
    await page.goto(`${BASE}/#fork=${encodeURIComponent(s.token)}`, { waitUntil: 'load' });
    await page.waitForTimeout(2600); // boot handoff → openForkInChat → mountForkInto → renderSource

    const mounted = await page.evaluate(() => {
      const mount = document.querySelector('.fork-mount');
      const stage = mount && mount.querySelector('.fork-stage');
      const txt = mount ? mount.textContent : '';
      const buttons = mount ? Array.from(mount.querySelectorAll('button')).map(b => b.textContent) : [];
      return { hasMount: !!mount, text: txt, hasIframe: !!(mount && mount.querySelector('iframe')), buttons, stageText: stage ? stage.textContent : '' };
    });
    ok(mounted.hasMount, 'the shared #fork= link opened a fork widget inline');
    ok(/WIDGET-OK/.test(mounted.stageText || ''), `the shared fork rendered its source inline — got: ${JSON.stringify(mounted.stageText)}`);
    ok(mounted.hasIframe === false, 'rendered without an iframe (in-tree)');
    ok(mounted.buttons.some(b => /Make mine/.test(b)), `recipient sees "Make mine" (adopt) — buttons: ${JSON.stringify(mounted.buttons)}`);

    // adopt: click "Make mine" → becomes owner (Edit/Share appear) and still renders
    await page.evaluate(() => { const b = Array.from(document.querySelectorAll('.fork-mount button')).find(x => /Make mine/.test(x.textContent)); if (b) b.click(); });
    // poll for the owner controls + the re-render (the adopt chain is async: create→remount→read→renderSource)
    await page.waitForFunction(() => {
      const mount = document.querySelector('.fork-mount'); if (!mount) return false;
      const buttons = Array.from(mount.querySelectorAll('button')).map(b => b.textContent);
      const stage = mount.querySelector('.fork-stage');
      return buttons.some(b => /Edit/.test(b)) && buttons.some(b => /Share/.test(b)) && stage && /WIDGET-OK/.test(stage.textContent || '');
    }, { timeout: 6000 }).catch(() => {});
    const adopted = await page.evaluate(() => {
      const mount = document.querySelector('.fork-mount');
      return { buttons: mount ? Array.from(mount.querySelectorAll('button')).map(b => b.textContent) : [], stageText: mount && mount.querySelector('.fork-stage') ? mount.querySelector('.fork-stage').textContent : '' };
    });
    ok(adopted.buttons.some(b => /Edit/.test(b)) && adopted.buttons.some(b => /Share/.test(b)),
      `after "Make mine" the owner controls (Edit/Share) appear — buttons: ${JSON.stringify(adopted.buttons)}`);
    ok(/WIDGET-OK/.test(adopted.stageText || ''), 'the adopted fork still renders inline');

    // the adopt created a NEW owner-fork (re-share branch): owner now has 2 forks
    const mine = await post('/forks/list', { cap });
    ok(mine.ok && mine.forks.length === 2, `adopt created a new owned fork (now ${mine.forks && mine.forks.length} forks)`);
    await page.close();
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); cleanup(); process.exit(2); });
