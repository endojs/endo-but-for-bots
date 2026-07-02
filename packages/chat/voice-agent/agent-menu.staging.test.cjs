#!/usr/bin/env node
// agent-menu.staging.test.cjs — STAGING guard for the built-in domain agents (Dietician, …) appearing in BOTH
// the header agent menu AND the Settings → 🕸️ Agents picker/viewer. Boots an ISOLATED voice-agent (fresh seed
// → the 5 built-ins, 0 spawned specialists), opens it as root in a headless browser, and asserts:
//   1. the header #agent-sel has an "Agents" optgroup containing the Dietician (and the other built-ins),
//   2. the Settings → Agents shape picker (#shape-agent) lists them too, and selecting the Dietician renders
//      its held powers (dietician + web + …).
//
// Run: node agent-menu.staging.test.cjs   (exits non-zero on any failure)
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 8795;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmenu-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
const BUILTINS = ['dietician', 'researcher', 'home', 'scheduler', 'image-studio', 'specialist-builder'];

(async () => {
  srv = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json'),
      SPECIALISTS_FILE: path.join(tmp, 'specialists.json'), PRINT_ROOT_CAP: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted');
  if (!up) { cleanup(); process.exit(1); }
  const rootCap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  // endpoint sanity: listSpecialists includes the built-ins flagged builtin:true
  const ls = await (await fetch(`${BASE}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ swissnum: rootCap, method: 'listSpecialists' }) })).json();
  const ids = (ls.result || []).filter(s => s.builtin).map(s => s.id);
  ok(BUILTINS.every(b => ids.includes(b)), `listSpecialists carries the built-in agents (${ids.join(', ')})`);
  const sb = (ls.result || []).find(s => s.id === 'specialist-builder');
  ok(sb && sb.powers.includes('specialists') && sb.powers.includes('selfPrompt'), 'the Specialist Builder holds specialists (to build them) + selfPrompt (to edit its own prompt)');
  // least authority: the Dietician reads ONLY the Dietician/ folder (notes.dietician), not all personal notes.
  const diet = (ls.result || []).find(s => s.id === 'dietician');
  ok(diet && diet.powers.includes('notes.dietician'), `the Dietician holds the scoped notes.dietician power (${(diet && diet.powers || []).join(', ')})`);
  ok(diet && !diet.powers.includes('notes') && !diet.powers.includes('jotNote'), 'the Dietician does NOT hold full personal-notes read (notes) or vault write (jotNote)');

  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - headless (playwright-core unavailable)'); console.log(`\n✓ agent-menu: ${pass} passed, ${fail} failed`); cleanup(); process.exit(fail ? 1 : 0); }

  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    page.on('pageerror', e => console.error('  [pageerror]', e.message));
    // cap-hygiene: inject the cap via localStorage BEFORE navigation, never in the URL fragment.
    await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, rootCap);
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    // wait for loadAgentList to populate the header select with the built-ins
    await page.waitForFunction(() => { const s = document.getElementById('agent-sel'); return s && s.querySelector('optgroup[label="Agents"]'); }, { timeout: 15000 });

    const header = await page.evaluate(() => {
      const s = document.getElementById('agent-sel');
      const grp = s.querySelector('optgroup[label="Agents"]');
      return { groupLabels: [...s.querySelectorAll('optgroup')].map(g => g.label),
        builtinValues: grp ? [...grp.querySelectorAll('option')].map(o => o.value) : [],
        dietText: grp ? ([...grp.querySelectorAll('option')].find(o => o.value === 'dietician') || {}).textContent : '' };
    });
    ok(header.groupLabels.includes('Agents'), `header menu has an "Agents" group (groups: ${header.groupLabels.join(', ')})`);
    ok(BUILTINS.every(b => header.builtinValues.includes(b)), `header "Agents" group lists all built-ins (${header.builtinValues.join(', ')})`);
    ok(/Dietician/.test(header.dietText), `the Dietician shows with its display name ("${header.dietText}")`);

    // Settings → Agents picker (#shape-agent) lists the built-ins too
    await page.evaluate(() => document.getElementById('drawer-foot').click());
    await page.waitForSelector('.setwrap', { timeout: 8000 });
    await page.evaluate(() => { const b = document.querySelector('.setnav-item[data-sec="agents"]'); if (b) b.click(); });
    await page.waitForSelector('#shape-agent', { timeout: 8000 });
    const picker = await page.evaluate(() => {
      const s = document.getElementById('shape-agent');
      const grp = s.querySelector('optgroup[label="Agents"]');
      return { builtinValues: grp ? [...grp.querySelectorAll('option')].map(o => o.value) : [] };
    });
    ok(BUILTINS.every(b => picker.builtinValues.includes(b)), `Settings shape picker lists the built-ins (${picker.builtinValues.join(', ')})`);

    // select the Dietician → its held powers render
    await page.evaluate(() => { const s = document.getElementById('shape-agent'); s.value = 'dietician'; s.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.waitForFunction(() => { const h = document.getElementById('shape-body'); return h && /dietician/.test(h.textContent || ''); }, { timeout: 8000 });
    const shapeTxt = await page.$eval('#shape-body', el => el.textContent);
    ok(/dietician/.test(shapeTxt) && /web/.test(shapeTxt), 'selecting the Dietician renders its held powers (dietician + web + …)');
  } finally { await browser.close(); }

  console.log(`\n${fail ? '✗' : '✓'} agent-menu staging: ${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); cleanup(); process.exit(1); });
