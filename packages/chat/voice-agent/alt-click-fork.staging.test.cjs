#!/usr/bin/env node
// alt-click-fork.staging.test.cjs — STAGING proof of Phase-3 alt-click selection on a LIVE mounted fork.
// Mounts an owner fork inline (window.forkIntoChat), then Alt+clicks it: the overlay chip offers ✎ edit /
// ⑂ fork (available to a cap-holder, not just root), and ⑂ fork spawns a NEW fork from the live one.
//
// Run: node alt-click-fork.staging.test.cjs   (exits non-zero on failure; SKIPs without chromium)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 20000 + (process.pid % 20000); // T-TEST-2: PID-derived port (unique per node --test child); never a fixed 879x
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alt-fork-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
const post = (p, body) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

const SRC = "(endowments, props) => endowments.h(Banner, { kind: 'info' }, 'ALT-FORK-OK')";

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

  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) {
    console.log('  SKIP - headless alt-click checks (playwright-core unavailable)');
    console.log(`\n${pass} passed, ${fail} failed (browser checks skipped)`);
    cleanup(); process.exit(fail ? 1 : 0);
  }

  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  try {
    const page = await browser.newPage();
    page.on('dialog', d => d.accept('Alt forked copy')); // the ⑂ fork name prompt
    await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.waitForTimeout(2200);

    // mount an OWNER fork inline (creates it + opens it in a fresh chat; data-fork-id gets tagged)
    await page.evaluate(src => window.forkIntoChat({ source: src, name: 'AltFork' }), SRC);
    await page.waitForFunction(() => {
      const m = document.querySelector('.fork-mount[data-fork-id]');
      return m && /ALT-FORK-OK/.test((m.querySelector('.fork-stage') || {}).textContent || '');
    }, { timeout: 6000 }).catch(() => {});
    const mounted = await page.evaluate(() => {
      const m = document.querySelector('.fork-mount[data-fork-id]');
      return { has: !!m, fid: m && m.getAttribute('data-fork-id'), text: m && m.querySelector('.fork-stage') ? m.querySelector('.fork-stage').textContent : '' };
    });
    ok(mounted.has && mounted.fid, 'an owner fork mounted inline, tagged with data-fork-id');
    ok(/ALT-FORK-OK/.test(mounted.text || ''), 'the mounted fork rendered');

    // Alt+click the fork stage → the overlay chip should offer ✎ edit / ⑂ fork
    const chip = await page.evaluate(() => {
      const stage = document.querySelector('.fork-mount[data-fork-id] .fork-stage');
      stage.dispatchEvent(new MouseEvent('click', { altKey: true, bubbles: true, cancelable: true }));
      const chipEl = Array.from(document.querySelectorAll('div')).find(d => /✎ edit/.test(d.textContent) && /⑂ fork/.test(d.textContent) && d.style.display === 'flex');
      return chipEl ? Array.from(chipEl.querySelectorAll('button')).map(b => b.textContent) : null;
    });
    ok(chip && chip.some(b => /edit/.test(b)) && chip.some(b => /fork/.test(b)),
      `Alt+click a live fork shows the edit/fork chip — got: ${JSON.stringify(chip)}`);

    const before = (await post('/forks/list', { cap })).forks.length;
    // click ⑂ fork in the chip → forkForkAct → /forks/read → prompt(accepted) → forkIntoChat (new fork)
    await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find(x => /⑂ fork/.test(x.textContent)); if (b) b.click(); });
    await page.waitForFunction(b0 => true, {}, before).catch(() => {});
    await sleep(1500);
    const after = (await post('/forks/list', { cap })).forks.length;
    ok(after === before + 1, `⑂ fork created a new fork from the live one (${before} → ${after})`);
    await page.close();
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); cleanup(); process.exit(2); });
