#!/usr/bin/env node
// custom-view-render.staging.test.cjs — STAGING proof of the confined-renderer RENDERING CONTRACT that dan's
// broken "Send button" exposed: a confined custom-view renderer must be built with RAW HTML tags via
// endowments.h('tag', …). The host ui-kit COMPONENT primitives (h(Btn,…)/h(TextField,…)) belong to the
// host bundle's Preact and render NOTHING inside a confined renderer — so an agent that used them produced a
// component with no real <input>/<button> and a dead Send button. This test:
//   1. a RAW-TAG renderer mounts a real <input> + <button>, and clicking Send fires props.call('send',[text]);
//   2. (regression guard for the bug) a KIT-COMPONENT renderer renders NO interactive DOM — which is exactly
//      why RENDERER_SYS / the customView tool now forbid the kit primitives and require raw tags.
//
// Run: node custom-view-render.staging.test.cjs   (exits non-zero on failure; SKIPs without chromium)

const { spawn } = require('node:child_process');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const PORT = 8842; const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvrender-'));
let srv = null; let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

const RAW = fs.readFileSync(path.join(__dirname, 'designs', 'kumavis-renderer.example.js'), 'utf8');
// the BUG shape: correct kit API, but kit components don't render in a confined renderer
const KIT = "(endowments, props) => { const { h } = endowments; return h('div', null, [h(TextField, { value: '', placeholder: 'x', onInput: () => {} }), h(Btn, { label: 'Send', onClick: () => {} })]); }";

(async () => {
  srv = spawn('node', ['server.mjs'], { cwd: __dirname, env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1', FIELD_LOCKDOWN: '1',
    SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'), PROJECTS_STORE: path.join(tmp, 'projects.json'),
    MEMO_RUNS_FILE: path.join(tmp, 'memo.json'), FORKS_STORE: path.join(tmp, 'forks.json'), BLOSSOM_STORE: path.join(tmp, 'blossom.json'), PRINT_ROOT_CAP: '1' }, stdio: ['ignore', 'ignore', 'ignore'] });
  let up = false; for (let i = 0; i < 90; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted (FIELD_LOCKDOWN=1)'); if (!up) { cleanup(); process.exit(1); }
  const cap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  let chromium = null; try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - no chromium'); console.log(`\n${pass} passed, ${fail} failed (skipped)`); cleanup(); process.exit(fail ? 1 : 0); }
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: '/var/lib/obsidian/oldlibs' } });
  try {
    const page = await browser.newPage();
    await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
    await page.goto(`${BASE}/`, { waitUntil: 'load' }); await sleep(2000);

    // (1) raw-tag renderer → real interactive DOM + a working mediated Send
    const rawRes = await page.evaluate(async (SRC) => {
      const el = document.createElement('div'); el.id = 'rawmount'; document.body.appendChild(el);
      const calls = []; window.__calls = calls;
      window.__fieldIslands.renderSource(SRC, el, { value: { name: 'Kumavis', summary: 'a peer' }, name: 'Kumavis', methods: ['describe', 'inbox', 'send'], call: (m, a) => { calls.push([m, a]); return Promise.resolve(m === 'inbox' ? [] : { ok: true }); }, refresh: () => {} });
      await new Promise(r => setTimeout(r, 300));
      return { hasInput: !!el.querySelector('input'), hasButton: !!el.querySelector('button'), sendText: !!Array.from(el.querySelectorAll('button')).find(b => /Send/.test(b.textContent)) };
    }, RAW);
    ok(rawRes.hasInput, 'raw-tag renderer mounts a REAL <input>');
    ok(rawRes.hasButton && rawRes.sendText, 'raw-tag renderer mounts a REAL <button> labelled Send');
    // type + click Send → props.call('send',[text]) fires
    await page.fill('#rawmount input', 'hello kumavis'); await sleep(150);
    const enabled = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('#rawmount button')).find(x => /Send/.test(x.textContent)); return b && !b.disabled; });
    ok(enabled, 'typing enables the Send button (onInput → e.target.value works in the confined renderer)');
    await page.evaluate(() => { const b = Array.from(document.querySelectorAll('#rawmount button')).find(x => /Send/.test(x.textContent)); b && b.click(); });
    await page.waitForFunction(() => (window.__calls || []).some(c => c[0] === 'send'), { timeout: 3000 }).catch(() => {});
    const sent = await page.evaluate(() => (window.__calls || []).find(c => c[0] === 'send'));
    ok(!!sent, 'clicking Send fired the mediated props.call');
    ok(sent && sent[1] && sent[1][0] === 'hello kumavis', `the call carried the typed message — got: ${JSON.stringify(sent)}`);

    // (2) regression guard: the kit-COMPONENT shape renders NO interactive DOM (the original bug)
    const kitRes = await page.evaluate((SRC) => {
      const el = document.createElement('div'); document.body.appendChild(el);
      window.__fieldIslands.renderSource(SRC, el, {});
      return { hasInput: !!el.querySelector('input'), hasButton: !!el.querySelector('button') };
    }, KIT);
    ok(!kitRes.hasInput && !kitRes.hasButton, 'kit-COMPONENT primitives (h(Btn,…)/h(TextField,…)) render NO DOM in a confined renderer — why the guidance requires raw tags');
    await page.close();
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); cleanup(); process.exit(2); });
