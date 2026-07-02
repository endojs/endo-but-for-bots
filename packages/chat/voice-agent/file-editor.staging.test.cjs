#!/usr/bin/env node
// file-editor.staging.test.cjs — STAGING proof of file-level VIEW + EDIT + SAVE in the FS browser (the
// standalone /apps/file-browser surface): open a text file, ✎ Edit → textarea, change it, ✓ Save → the
// change lands on disk via /files/put.  (Real-time automerge collaboration is the next increment on the
// now-live wss://sync.chu.vmkqx.com sync server.)
//
// Run: node file-editor.staging.test.cjs   (exits non-zero on failure; SKIPs without chromium)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 20000 + (process.pid % 20000); // T-TEST-2: PID-derived port (unique per node --test child); never a fixed 879x
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'file-editor-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const post = (p, body) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

const FNAME = 'editor-test.txt';
const ORIG = 'original content line 1\noriginal line 2';
const EDITED = 'EDITED by the in-browser editor ✎\nsecond line changed';

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

  // seed a text file in the 'home' power folder
  const put = await post('/files/put', { cap, root: 'home', path: FNAME, b64: b64(ORIG) });
  ok(put && !put.error, 'seeded a text file in the home folder');

  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - browser editor check (no chromium)'); console.log(`\n${pass} passed, ${fail} failed (skipped)`); cleanup(); process.exit(fail ? 1 : 0); }

  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  try {
    const page = await browser.newPage();
    await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
    await page.goto(`${BASE}/apps/file-browser`, { waitUntil: 'load' });
    // switch to the home root + wait for the file to appear in the list
    await page.waitForTimeout(2500);
    // the app may default to the vault root; click the 'home' segment if a root selector exists, else the file may be under home already
    await page.evaluate(() => { const seg = Array.from(document.querySelectorAll('button,[role=tab],.kit-seg-opt')).find(b => /home|projects/i.test(b.textContent)); if (seg) seg.click(); });
    await page.waitForFunction(fn => !!Array.from(document.querySelectorAll('*')).find(e => e.childElementCount === 0 && e.textContent === fn), { timeout: 6000 }, FNAME).catch(() => {});
    const sawFile = await page.evaluate(fn => !!Array.from(document.querySelectorAll('*')).find(e => e.textContent && e.textContent.includes(fn)), FNAME);
    ok(sawFile, 'the seeded file shows in the browser listing');

    // open the file
    await page.evaluate(fn => { const item = Array.from(document.querySelectorAll('*')).find(e => e.textContent === fn && e.childElementCount === 0); let el = item; while (el && !(el.onclick || el.getAttribute('role') === 'button' || /kit-list/.test(el.className || ''))) el = el.parentElement; (el || item).click(); }, FNAME);
    await page.waitForFunction(() => /original content/.test(document.body.textContent || ''), { timeout: 6000 }).catch(() => {});
    ok(await page.evaluate(() => /original content/.test(document.body.textContent || '')), 'opening the file shows its content (view)');

    // ✎ Edit → textarea appears
    await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find(x => /Edit/.test(x.textContent)); if (b) b.click(); });
    await page.waitForSelector('textarea', { timeout: 5000 }).catch(() => {});
    ok(await page.$('textarea') !== null, '✎ Edit reveals an editable textarea');

    // change the content + Save
    await page.fill('textarea', EDITED);
    await page.waitForTimeout(200);
    await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find(x => /Save/.test(x.textContent)); if (b) b.click(); });
    await page.waitForTimeout(800);

    const onDisk = await post('/files/get', { cap, root: 'home', path: FNAME });
    ok(onDisk && onDisk.text === EDITED, `Save wrote the edit to disk — got: ${JSON.stringify((onDisk && onDisk.text || '').slice(0, 40))}`);
    await page.close();
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); cleanup(); process.exit(2); });
