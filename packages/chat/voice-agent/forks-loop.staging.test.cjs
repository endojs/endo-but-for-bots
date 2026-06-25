#!/usr/bin/env node
// forks-loop.staging.test.cjs — STAGING proof of the fork→edit→re-share LOOP end-to-end against the real
// server (FIELD_LOCKDOWN=1) and a real headless browser. Exercises the actual HTTP routes, then renders a
// SHARE-REDEEMED fork source inline (no iframe) via __fieldIslands.renderSource under lockdown.
//
// Loop: create (with source) → read → edit (new version) → history → share(free) → open(token, no cap) →
// render the opened source inline in the browser → revoke → open fails. Plus: a bogus cap can't own/read.
//
// Run: node forks-loop.staging.test.cjs   (exits non-zero on failure; SKIPs render check w/o chromium)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 8804;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forks-loop-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
const post = (p, body) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

const SRC = "(endowments, props) => endowments.h('div', { class: 'fk' }, 'FORK v1 ' + (props.who || ''))";
const SRC2 = "(endowments, props) => endowments.h(Banner, { kind: 'info' }, 'FORK v2 EDITED ' + (props.who || ''))";

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

  // ── HTTP loop ──────────────────────────────────────────────────────────────────────────────────
  const created = await post('/forks/create', { cap, source: SRC, name: 'Loop fork', baseId: 'island-file-browser' });
  ok(created.ok && created.id, 'create → a fork id');
  const id = created.id;

  const read = await post('/forks/read', { cap, id });
  ok(read.ok && read.source === SRC && read.version === 1, 'read → source at v1');

  const bogus = await post('/forks/read', { cap: 'not-a-real-cap', id });
  ok(bogus.ok === false, 'a bogus cap cannot read the fork (owner-gated)');

  const edited = await post('/forks/edit', { cap, id, source: SRC2 });
  ok(edited.ok && edited.version === 2, 'edit (direct source) → v2');
  const hist = await post('/forks/history', { cap, id });
  ok(hist.ok && hist.versions.length === 2, 'history → 2 versions');

  const reverted = await post('/forks/revert', { cap, id, version: 1 });
  ok(reverted.ok && reverted.version === 3, 'revert v1 → NEW v3 (non-destructive)');
  const afterRevert = await post('/forks/read', { cap, id });
  ok(afterRevert.source === SRC, 'reverted source is v1 again');
  // edit back to v2 so the render check sees the ui-kit Banner version
  await post('/forks/edit', { cap, id, source: SRC2 });

  const shared = await post('/forks/share', { cap, id, charge: { scheme: 'free' } });
  ok(shared.ok && shared.token, 'share(free) → a token');
  const token = shared.token;

  const opened = await post('/forks/open', { token }); // NOTE: no cap — the token is the only authority
  ok(opened.ok && opened.source === SRC2 && opened.name === 'Loop fork', 'open(token, NO cap) → just the source');
  ok(!('owner' in opened) && !('history' in opened), 'the share grants nothing but id/name/source');

  // ── browser render of the SHARE-REDEEMED source, inline + confined ───────────────────────────────
  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) {
    console.log('  SKIP - headless render of the opened fork (playwright-core unavailable)');
  } else {
    const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
    try {
      const page = await browser.newPage();
      await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
      await page.goto(`${BASE}/`, { waitUntil: 'load' });
      await page.waitForTimeout(2200);
      const r = await page.evaluate(async source => {
        const el = document.createElement('div'); document.body.appendChild(el);
        const okk = globalThis.__fieldIslands.renderSource(source, el, { who: 'bob' });
        await new Promise(res => setTimeout(res, 150));
        return { okk, text: el.textContent, hasIframe: !!el.querySelector('iframe') };
      }, opened.source);
      ok(r.okk === true && /FORK v2 EDITED bob/.test(r.text || '') && !r.hasIframe,
        `the opened (shared) fork renders inline, confined, no iframe — got: ${JSON.stringify(r.text)}`);
      await page.close();
    } finally { await browser.close(); }
  }

  // ── revoke kills the share ───────────────────────────────────────────────────────────────────────
  const rev = await post('/forks/share/revoke', { cap, token });
  ok(rev.ok === true, 'owner revokes the share');
  const openAfter = await post('/forks/open', { token });
  ok(openAfter.ok === false, 'open after revoke is denied (the token is dead)');

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); cleanup(); process.exit(2); });
