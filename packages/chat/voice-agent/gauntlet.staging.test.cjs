#!/usr/bin/env node
// gauntlet.staging.test.cjs — STAGING proof of the Feedback-loops Gauntlet: /gauntlet returns the dev
// agent's gate-lanes (the real 4-discipline review panel + the FAPO verify/merge/reverify/revert) in the
// propagator-gate model, owner-gated; and Settings → 🛡️ Checks renders them as gate cards.
//
// Run: node gauntlet.staging.test.cjs   (exits non-zero on failure; SKIPs browser w/o chromium)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 8820;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-'));
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

  // gate: owner-only
  const noCap = await fetch(`${BASE}/gauntlet`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
  ok(noCap.status === 403, 'the feedback-loops view is owner-only (403 without root)');

  const g = await (await fetch(`${BASE}/gauntlet`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) })).json();
  ok(g.ok && /propagator-gate/i.test(g.model), 'returns the propagator-gate model framing');
  ok(g.ok && Array.isArray(g.lanes) && g.lanes.length >= 2, 'returns at least the two lanes (component-admission + FAPO)');
  const disc = g.lanes.find(l => /Admit/.test(l.action));
  ok(disc && disc.gates.map(x => x.id).join(',') === 'ocapReviewer,propagatorReviewer,capHygieneReviewer,sharingReviewer', 'the admission lane has the 4 real discipline gates');
  ok(disc && disc.gates.every(x => x.reads && x.verdictCell && x.policy), 'each gate carries the propagator-gate fields (reads ⟨cells⟩ → verdict, policy)');
  const fapo = g.lanes.find(l => /FAPO|Self-improve/.test(l.action));
  ok(fapo && fapo.gates.map(x => x.id).join(',') === 'verify,merge,reverify,revert', 'the FAPO lane has verify→merge→reverify→revert');
  ok(fapo && fapo.gates.some(x => x.policy === 'BLOCK') && fapo.gates.some(x => x.policy === 'REVERT'), 'FAPO gates carry their real policies (BLOCK / REVERT)');

  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - browser render (no chromium)'); }
  else {
    const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
    try {
      const page = await browser.newPage();
      await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
      await page.goto(`${BASE}/`, { waitUntil: 'load' }); await sleep(1500);
      await page.evaluate(() => document.getElementById('drawer-foot').click()); await sleep(800);
      await page.evaluate(() => { const b = Array.from(document.querySelectorAll('.setnav-item')).find(x => x.getAttribute('data-sec') === 'feedback'); if (b) b.click(); });
      await page.waitForFunction(() => { const l = document.getElementById('gl-lanes'); return l && l.textContent.includes('ocap discipline'); }, { timeout: 6000 }).catch(() => {});
      const cards = await page.evaluate(() => { const l = document.getElementById('gl-lanes'); return l ? Array.from(l.querySelectorAll('div')).filter(d => /flex:0 0/.test(d.getAttribute('style') || '')).length : 0; });
      ok(cards >= 8, `the Checks section renders the gate cards as a gauntlet (${cards} cards)`);
      await page.close();
    } finally { await browser.close(); }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); cleanup(); process.exit(2); });
