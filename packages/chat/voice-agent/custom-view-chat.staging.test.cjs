#!/usr/bin/env node
// custom-view-chat.staging.test.cjs — STAGING proof that "the chat IS the studio". The bespoke renderer
// studio is GONE; instead a custom view is GRANTED to a chat and a NORMAL chat agent (visible in the trace)
// authors/revises it via the `customView` tool. This test verifies, deterministically (no live LLM):
//   1. the studio is removed — window.openRendererStudio / mountBlossomStudio no longer exist;
//   2. /blossom/register installs an agent-supplied renderer source directly (the tool's server primitive);
//   3. requestCustomView on a kind that ALREADY has a renderer = a REVISE: it mounts the LIVE component into
//      the chat (fed the leaf's real data) and pre-fills the composer (no auto-send);
//   4. requestCustomView on a NEW kind = a GENERATE: it seeds a normal chat turn whose AGENT-FACING text
//      carries the structured `[custom-view task …]` (kind + sample), and grants a (placeholder) component.
//
// Run: node custom-view-chat.staging.test.cjs   (exits non-zero on failure; SKIPs without chromium)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 20000 + (process.pid % 20000); // T-TEST-2: PID-derived port (unique per node --test child); never a fixed 879x
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvchat-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

const CONTACT_RENDERER = "(endowments, props) => endowments.h('div', { class: 'cv' }, 'CONTACT: ' + ((props.value && props.value.name) || 'EMPTY') + ' @ ' + ((props.value && props.value.org) || '?'))";

(async () => {
  srv = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1', FIELD_LOCKDOWN: '1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json'),
      FORKS_STORE: path.join(tmp, 'forks.json'), BLOSSOM_STORE: path.join(tmp, 'blossom.json'), PRINT_ROOT_CAP: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted (FIELD_LOCKDOWN=1)');
  if (!up) { cleanup(); process.exit(1); }
  const cap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  // (2) /blossom/register — the customView tool's server primitive: install an agent-supplied source directly
  const reg = await (await fetch(`${BASE}/blossom/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, kind: 'contact', methods: [], source: CONTACT_RENDERER, name: 'Alice' }) })).json();
  ok(reg.ok && reg.forkId && reg.version === 1, 'POST /blossom/register installs an agent-authored renderer (ready, a fork, v1)');
  const forC = await (await fetch(`${BASE}/blossom/for`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, methods: [], kind: 'contact' }) })).json();
  ok(forC.ok && forC.entry.status === 'ready' && forC.entry.sig === reg.sig, 'the contact kind now resolves to the registered renderer');
  const srcC = await (await fetch(`${BASE}/blossom/source`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, sig: reg.sig }) })).json();
  ok(srcC.ok && srcC.source === CONTACT_RENDERER, '/blossom/source returns exactly the agent-authored source');

  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - browser (no chromium)'); console.log(`\n${pass} passed, ${fail} failed (skipped browser)`); cleanup(); process.exit(fail ? 1 : 0); }

  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  try {
    const page = await browser.newPage();
    await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
    // capture the agent-facing text of any /chat turn WITHOUT running a real LLM (stub the response)
    await page.addInitScript(() => {
      window.__chatSends = [];
      const orig = window.fetch;
      window.fetch = (url, opts) => {
        try { const u = String(url || ''); if (u.endsWith('/chat') && opts && opts.method === 'POST') { const body = JSON.parse(opts.body || '{}'); window.__chatSends.push(body.text || ''); return Promise.resolve(new Response(JSON.stringify({ ok: true, answer: '(stubbed)', steps: [], ui: [] }), { status: 200, headers: { 'content-type': 'application/json' } })); } } catch {}
        return orig(url, opts);
      };
    });
    await page.goto(`${BASE}/`, { waitUntil: 'load' }); await sleep(2200);

    // (1) the bespoke studio is GONE
    const gone = await page.evaluate(() => ({ studio: typeof window.openRendererStudio, mount: typeof window.mountBlossomStudio, req: typeof window.requestCustomView }));
    ok(gone.studio === 'undefined' && gone.mount === 'undefined', 'the renderer STUDIO is removed (openRendererStudio / mountBlossomStudio undefined)');
    ok(gone.req === 'function', 'requestCustomView (grant-to-chat) is the replacement');

    // (3) REVISE: a kind that ALREADY has a renderer → live component mounted + composer pre-filled (no send)
    await page.evaluate(() => window.requestCustomView({ name: 'Alice', kind: 'contact', methods: [], data: { name: 'Alice', org: 'Acme' }, callable: false }));
    await page.waitForFunction(() => /CONTACT: Alice/.test(document.querySelector('.cv-mount')?.textContent || ''), { timeout: 8000 }).catch(() => {});
    const rev = await page.evaluate(() => { const m = document.querySelector('.cv-mount'); return { text: m ? m.textContent : '', noIframe: m ? !m.querySelector('iframe') : true, composer: (document.getElementById('text') || {}).value || '', sends: (window.__chatSends || []).length }; });
    ok(/CONTACT: Alice @ Acme/.test(rev.text), `the LIVE component is granted to the chat, fed the leaf's real data — got: ${JSON.stringify((rev.text.match(/CONTACT:[^<]*/) || [rev.text.slice(0, 40)])[0])}`);
    ok(rev.noIframe, 'the granted component renders confined inline (no iframe)');
    ok(/^Revise the custom view for the contact "Alice":/.test(rev.composer), 'a REVISE pre-fills the composer for the user (no auto-send)');
    ok(rev.sends === 0, 'a revise does NOT auto-send a turn (the user types the change)');

    // (4) GENERATE: a NEW kind → a normal chat turn is seeded carrying the structured custom-view task
    await page.evaluate(() => window.requestCustomView({ name: 'Doohickey', kind: 'gadget', methods: [], data: { color: 'red', size: 7 }, callable: false }));
    await page.waitForFunction(() => (window.__chatSends || []).some(t => /custom-view task/.test(t)), { timeout: 8000 }).catch(() => {});
    const gen = await page.evaluate(() => { const t = (window.__chatSends || []).find(x => /custom-view task/.test(x)) || ''; return { t, hasKind: /kind:\s*"gadget"/.test(t), hasSample: /"color"\s*:\s*"red"/.test(t), hasTool: /customView\(/.test(t), placeholder: /authoring this view/.test(document.querySelector('.cv-mount')?.textContent || '') }; });
    ok(!!gen.t, 'a GENERATE seeds a normal chat turn (visible in the trace — a normal agent)');
    ok(gen.hasKind && gen.hasSample, 'the seeded turn carries the structured task: the kind + a sample of the data');
    ok(gen.hasTool, 'the task tells the agent to register via the customView tool');
    ok(gen.placeholder, 'the (not-yet-authored) component is granted to the chat as a live placeholder');
    await page.close();
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); cleanup(); process.exit(2); });
