#!/usr/bin/env node
// trace-views-gallery.staging.test.cjs — STAGING (real-run) proof of the TRACE VIEWS GALLERY. dan
// (2026-07-02): "wake up to a gallery of a few different well-researched ways one might view how a
// complicated task is completed, each with a nice splash-page example trace." The 5 confined Tier-2 viz are
// alternative SOURCES for the ONE trace island (the live trace:<sid> cell is the interface). Layers:
//
//   SERVER (isolated instance + a stub OpenAI-compatible LLM so a REAL /chat turn runs real tools):
//     1. all 5 viz JS sources serve over HTTP (the browser imports each to build the gallery), each carrying
//        its (ui)=>element contract; grain-ui.js serves.
//     2. the 3 sibling .splash.json samples serve as valid JSON (the "prefer .splash.json" path); the 2
//        without a json fall back to the *_SPLASH export / shared canonical splash.
//   BROWSER (headless chromium + swiftshader so WebGL initializes without a GPU):
//     3. the Component-Studio "Trace views" section renders all 5 SPLASH CARDS — each a confined instance of
//        its viz rendering its OWN canned example trace (cap-free), with a name + caption. No page errors.
//     4. the 🔭 gallery MODAL (from "views ▾") shows the same 5 cards.
//     5. picking a card sets it active (persisted in localStorage), moves the "active" highlight, and — with
//        Tier-2 OFF — surfaces the legible "Enable Tier-2" gate (never flips the default silently).
//     6. on a LIVE turn (Tier-2 ON) the island mounts the chosen view; 🔀 rotates through the 5, each
//        rendering the SAME live trace:<sid> data (the cell is the interface).
//     7. a screenshot of the gallery with the 5 splash cards.
//
// Run: node trace-views-gallery.staging.test.cjs   (exits non-zero on failure; SKIPs browser w/o chromium)

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 20000 + (process.pid % 20000); // T-TEST-2: PID-derived port (unique per node --test child); never a fixed 879x
const LLM_PORT = 8863;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-views-'));
let srv = null; let stub = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { stub && stub.close(); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
const jpost = (p, b) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());

// stub CodeMode LLM: round 1 runs real tools (emitStep → trace cell), round 2 answers, DELAYED so the turn
// stays open long enough for the browser to watch the island animate + rotate views.
const PROGRAM_1 = ['```js', "updateProgress('phase one — gathering');", "await showChoices({ prompt: 'views-proof', options: ['a', 'b'] });", "await showChoices({ prompt: 'views-proof-2', options: ['c', 'd'] });", "return 'TV-PHASE1';", '```'].join('\n');
const PROGRAM_2 = '```js\nanswer("trace views gallery proof done");\n```';
const startStub = () => new Promise(resolve => {
  stub = http.createServer((req, res) => {
    let body = ''; req.on('data', d => { body += d; });
    req.on('end', () => {
      let text = '{}'; let delay = 30;
      if (/SECURE SANDBOX/.test(body)) { if (/TV-PHASE1/.test(body)) { text = PROGRAM_2; delay = 6000; } else { text = PROGRAM_1; delay = 200; } }
      setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 10 } })); }, delay);
    });
  });
  stub.listen(LLM_PORT, '127.0.0.1', resolve);
});

const VIZ = ['3d', 'flamegraph', 'timeline', 'provenance', 'sankey'];
const SPLASH_JSON = ['timeline', 'provenance', 'sankey']; // the 3 that ship a sibling .splash.json

(async () => {
  await startStub();
  srv = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1', PRINT_ROOT_CAP: '1', FIELD_LOCKDOWN: '1',
      AGENT_LLM: `http://127.0.0.1:${LLM_PORT}/v1/chat/completions`,
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      VOICE_STATE_DIR: path.join(tmp, 'voice-state'), DASH_STATE_DIR: path.join(tmp, 'dash-state'),
      COMPONENT_GIT_DIR: path.join(tmp, 'component-git'), BACKLOG_STORE: path.join(tmp, 'component-backlog.json'),
      CUSTOM_TOOLS_STORE: path.join(tmp, 'custom-tools.json'), CUSTOM_TOOLS_STATE: path.join(tmp, 'tool-state'),
      COMPONENT_GRAINS: path.join(tmp, 'component-grains'), FORKS_STORE: path.join(tmp, 'forks.json'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json'),
      USERS_FILE: path.join(tmp, 'users.json'), AUTO_ADMIT: '0', AUTO_REVISE: '0' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted (throwaway state, FIELD_LOCKDOWN=1, stub LLM)');
  if (!up) { cleanup(); process.exit(1); }
  const rootCap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  // ── 1. all 5 viz sources serve over HTTP (the client imports each to build the gallery) ──────────────
  let allJs = true;
  for (const k of VIZ) {
    const r = await fetch(`${BASE}/trace-viz-${k}.js`);
    const t = r.ok ? await r.text() : '';
    const good = r.ok && /_SOURCE\s*=/.test(t) && /ui\.props\.cell|ui\.props&&ui\.props/.test(t);
    if (!good) { allJs = false; console.error(`    (trace-viz-${k}.js: status ${r.status})`); }
  }
  ok(allJs, 'all 5 trace-viz sources serve over HTTP with the (ui)=>element cell contract');
  const gu = await fetch(`${BASE}/grain-ui.js`); const guT = gu.ok ? await gu.text() : '';
  ok(gu.ok && /loadTraceVizKinds/.test(guT) && /mountVizSplash/.test(guT), 'grain-ui.js serves with the registry loader + splash mounter');

  // ── 2. the 3 sibling .splash.json samples serve as valid JSON (the "prefer .splash.json" path) ────────
  let allJson = true;
  for (const k of SPLASH_JSON) {
    const r = await fetch(`${BASE}/trace-viz-${k}.splash.json`);
    try { const j = r.ok ? await r.json() : null; if (!j || typeof j !== 'object' || !Array.isArray(j.steps)) allJson = false; } catch { allJson = false; }
  }
  ok(allJson, 'the 3 .splash.json samples serve as valid canned traces (timeline/provenance/sankey)');
  const noJson = await fetch(`${BASE}/trace-viz-3d.splash.json`); // 3d ships none → 404 → export/shared fallback (non-fatal)
  ok(noJson.status === 404, '3d ships no .splash.json (404) — the loader falls back to the shared canonical splash');

  // ── browser half ────────────────────────────────────────────────────────────────────────────────
  let chromium = null;
  try { ({ chromium } = require(process.env.PLAYWRIGHT_CORE || '/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - browser checks (playwright-core unavailable)'); console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(fail ? 1 : 0); }
  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
    env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  const shotDir = process.env.TRACE_VIEWS_SHOTS || tmp;
  // seed: cap + a prior chat (skips the consent scoper). tier2 explicit per-page: Tier-2 is now the DEFAULT
  // surface, so the gate test must EXPLICITLY opt OUT ('0') to surface the "Enable Tier-2" banner; the live
  // turn opts IN ('1'). (Passing no flag would leave it at the ON default — not what the gate test wants.)
  const seed = (page, chatId, tier2) => page.addInitScript(({ c, id, t }) => { try {
    localStorage.setItem('field-agent-cap', c);
    localStorage.setItem('field-agent-chats', JSON.stringify([{ id, title: 'viewschat', ts: Date.now(), lastMsgAt: Date.now() }]));
    localStorage.setItem('field-agent-active', id);
    localStorage.setItem('field-agent-tx-' + id, JSON.stringify([{ who: 'you', text: 'warmup' }, { who: 'agent', text: 'ready' }]));
    localStorage.setItem('field-trace-tier2', t ? '1' : '0');
  } catch {} }, { c: rootCap, id: chatId, t: !!tier2 });
  try {
    // ── 3. the Component-Studio "Trace views" section renders all 5 SPLASH CARDS ───────────────────────
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    await seed(page, 'tv-studio-1', false); // EXPLICIT opt-OUT (field-trace-tier2='0'): splash cards must render anyway
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.waitForSelector('#tab-components:not(.hide)', { timeout: 15000 });
    await page.evaluate(() => document.getElementById('tab-components').click());
    await page.waitForSelector('[data-trace-view]', { timeout: 15000 });
    await page.waitForTimeout(2500); // let the 5 confined iframes mount + report height
    const cards = await page.evaluate(() => [...document.querySelectorAll('#component-gallery [data-trace-view]')].map(c => ({ key: c.getAttribute('data-trace-view'), hasFrame: !!c.querySelector('iframe'), tall: (c.querySelector('iframe') || {}).offsetHeight || 0 })));
    ok(cards.length === 5 && VIZ.every(k => cards.some(c => c.key === k)), `the Studio "Trace views" section lists all 5 viz (${cards.map(c => c.key).join(', ')})`);
    ok(cards.every(c => c.hasFrame), 'every card mounted a confined splash instance (an iframe)');
    ok(cards.every(c => c.tall >= 120), `every splash card rendered its example (confined frame reported its canvas height: ${cards.map(c => c.tall).join('/')})`);
    ok(errs.length === 0, `no page errors while mounting the 5 splash cards (${errs.slice(0, 2).join(' | ')})`);
    try { await page.screenshot({ path: path.join(shotDir, 'trace-views-gallery.png'), fullPage: true }); console.log('  info - screenshot:', path.join(shotDir, 'trace-views-gallery.png')); } catch {}

    // ── 4. the 🔭 gallery MODAL shows the same 5 cards ────────────────────────────────────────────────
    await page.evaluate(() => window.openTraceViewsGallery());
    await page.waitForSelector('#tv-gallery-overlay [data-trace-view]', { timeout: 8000 });
    await page.waitForTimeout(1200);
    const modalCards = await page.evaluate(() => [...document.querySelectorAll('#tv-gallery-overlay [data-trace-view]')].map(c => c.getAttribute('data-trace-view')));
    ok(modalCards.length === 5, `the 🔭 gallery modal shows all 5 splash cards (${modalCards.length})`);

    // ── 5. picking a card sets it active (persisted) + surfaces the Tier-2 gate (opted OUT here: '0') ────
    await page.evaluate(() => { const c = document.querySelector('#tv-gallery-overlay [data-trace-view="sankey"]'); if (c) c.click(); });
    await page.waitForTimeout(600);
    const choice = await page.evaluate(() => localStorage.getItem('field-trace-viz-choice'));
    ok(choice === 'sankey', `picking the Sankey card set it as the active trace view (persisted: "${choice}")`);
    const gate = await page.evaluate(() => !!document.querySelector('#tv-gallery-overlay [data-enable-tier2]'));
    ok(gate, 'with Tier-2 explicitly opted OUT (\'0\'), selecting a WebGL view surfaces the legible "Enable Tier-2" gate (the opt-out escape hatch back in)');
    const active = await page.evaluate(() => { const c = document.querySelector('#tv-gallery-overlay [data-trace-view="sankey"]'); return c ? /active/.test(c.textContent || '') : false; });
    ok(active, 'the active view is badged "active" in the gallery after the pick');
    await page.close();

    // ── 6. a LIVE turn (Tier-2 ON) mounts the chosen view; 🔀 rotates through the 5 over the SAME data ──
    const pageL = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
    const errsL = []; pageL.on('pageerror', e => errsL.push(e.message));
    await seed(pageL, 'tv-live-1', true); // Tier-2 ON
    await pageL.evaluate(() => localStorage.setItem('field-trace-viz-choice', '3d')).catch(() => {});
    await pageL.addInitScript(() => { try { localStorage.setItem('field-trace-viz-choice', '3d'); } catch {} });
    await pageL.goto(`${BASE}/`, { waitUntil: 'load' });
    await pageL.waitForSelector('#tab-components:not(.hide)', { timeout: 15000 });
    await pageL.evaluate(() => { const it = [...document.querySelectorAll('.chat-item .ci-title')].find(s => /viewschat/.test(s.textContent)); if (it) it.click(); });
    await pageL.waitForTimeout(400);
    await pageL.evaluate(() => { document.getElementById('text').value = 'run the trace views proof'; document.getElementById('send').click(); });
    await pageL.waitForSelector('.trace-island-host iframe', { timeout: 15000 });
    ok(true, 'the Tier-2 trace island mounts during a real turn with the chosen view');
    const bar = await pageL.evaluate(() => ({ views: !!document.querySelector('[data-trace-views-bar] [title*="5 ways"], [data-trace-views-bar] button'), rot: !!document.querySelector('[data-trace-rotate]') }));
    ok(bar.rot, 'the live island carries the "views ▾" + 🔀 rotate control bar');
    let f0 = 0; for (let i = 0; i < 40 && f0 < 2; i++) { f0 = await pageL.evaluate(() => (window.__traceIsland || {}).frames || 0); if (f0 < 2) await sleep(250); }
    const key0 = await pageL.evaluate(() => (window.__traceIsland || {}).vizKey || '');
    ok(f0 >= 2 && key0 === '3d', `the default view ("3d") received the live trace:<sid> data (${f0} frames)`);
    // rotate 🔀 → the NEXT view re-mounts and receives the SAME live data through the SAME cell
    await pageL.evaluate(() => document.querySelector('[data-trace-rotate]').click());
    await pageL.waitForTimeout(600);
    let f1 = 0, key1 = ''; for (let i = 0; i < 40; i++) { const st = await pageL.evaluate(() => ({ f: (window.__traceIsland || {}).frames || 0, k: (window.__traceIsland || {}).vizKey || '' })); f1 = st.f; key1 = st.k; if (key1 && key1 !== '3d' && f1 >= 1) break; await sleep(250); }
    ok(key1 && key1 !== key0, `🔀 rotated the live trace to a different view ("${key0}" → "${key1}") — same island, different lens`);
    ok(f1 >= 1, `the rotated view re-rendered the SAME live trace data through the shared cell (${f1} frames after rotate)`);
    ok(errsL.length === 0, `no page errors on the live rotate path (${errsL.slice(0, 2).join(' | ')})`);
    await pageL.close();
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); cleanup(); process.exit(2); });
