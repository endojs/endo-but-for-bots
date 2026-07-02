#!/usr/bin/env node
// obj-nav.staging.test.cjs — STAGING proof of the file-system-feel object navigator (Powers/Shares):
// whole-row click drills a folder (no "open" button needed), and clicking a NOTE leaf opens its text
// (you can "click into" a text document in the vault/"Obsidian" tree).
//
// Run: node obj-nav.staging.test.cjs   (exits non-zero on failure; SKIPs without chromium)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 20000 + (process.pid % 20000); // T-TEST-2: PID-derived port (unique per node --test child); never a fixed 879x
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'objnav-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

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
    await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    // open the object navigator (Shares tab)
    await page.evaluate(() => document.getElementById('tab-shares').click());
    await page.waitForFunction(() => document.querySelectorAll('#obj-list .obj-row').length > 0, { timeout: 6000 }).catch(() => {});
    const rootRows = await page.evaluate(() => Array.from(document.querySelectorAll('#obj-list .obj-row')).map(r => r.textContent.trim()));
    ok(rootRows.length > 0, `root folders render as clickable rows — ${JSON.stringify(rootRows.slice(0, 6))}`);
    ok(await page.evaluate(() => !document.querySelector('#obj-list button[data-drill]')), 'rows no longer use a separate "open" button (the row itself is clickable)');

    // click the whole "Notes" row (not a button) → drills into the vault
    await page.evaluate(() => { const r = Array.from(document.querySelectorAll('#obj-list .obj-row')).find(x => /Notes|vault/i.test(x.textContent)); if (r) r.click(); });
    await page.waitForFunction(() => Array.from(document.querySelectorAll('#obj-list .obj-row')).some(r => /📄/.test(r.textContent)), { timeout: 6000 }).catch(() => {});
    const inNotes = await page.evaluate(() => Array.from(document.querySelectorAll('#obj-list .obj-row')).map(r => r.textContent.trim()).slice(0, 4));
    ok(inNotes.length > 0, `clicking the Notes ROW drilled into the vault — ${JSON.stringify(inNotes)}`);

    // click a NOTE leaf (📄) row → its text content opens
    const clickedNote = await page.evaluate(() => { const r = Array.from(document.querySelectorAll('#obj-list .obj-row')).find(x => /📄/.test(x.textContent)); if (r) { r.click(); return r.textContent.trim(); } return null; });
    ok(clickedNote, `found + clicked a text-document (note) row — ${JSON.stringify((clickedNote || '').slice(0, 40))}`);
    await page.waitForFunction(() => { const p = document.querySelector('#obj-node pre'); return p && (p.textContent || '').length > 0; }, { timeout: 6000 }).catch(() => {});
    const noteShown = await page.evaluate(() => { const p = document.querySelector('#obj-node pre'); return p ? p.textContent.length : 0; });
    ok(noteShown > 0, `clicking the note opened its TEXT content in the detail panel (${noteShown} chars)`);
    await page.close();
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); cleanup(); process.exit(2); });
