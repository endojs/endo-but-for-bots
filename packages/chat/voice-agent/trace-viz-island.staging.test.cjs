#!/usr/bin/env node
// trace-viz-island.staging.test.cjs — STAGING (real-run) proof of the TIER-2 (sandboxed-iframe, WebGL)
// trace-viz island. dan (2026-07-02): the SVG/WebGL trace must be an ALT-CLICKABLE, FORKABLE island; the
// SES no-iframe fork path's sanitizer has NO <canvas>/<svg>, so a WebGL trace view needs the opaque-origin
// iframe runtime (public/confined.html). Layers:
//
//   SERVER (isolated instance + a stub OpenAI-compatible LLM so a REAL /chat turn runs real tools):
//     1. the reference viz (public/trace-viz-3d.js) BREAKS OUT into a `uicomp-…` git object (render-check
//        passes) with a backlog — its git identity for fork/riff/edit-chat/backlog.
//     2. the committed source carries the TRACE-VIZ CONTRACT header (what a riffer sees) + declares the cell.
//     3. a VARIANT viz (a distinct (ui)=>element on the SAME contract) breaks out as its own git object —
//        "a fork is a real, git-backed variant".
//     4. NO NETWORK: confined.html's CSP is default-src 'none'; the viz source has no fetch/XHR/import/ws.
//     5. the trace:<sid> cell is OWNER-gated: an invalid cap → 403; a valid non-owner cap → 'not your chat
//        trace' (never the frames).
//   BROWSER (headless chromium + swiftshader so WebGL initializes without a GPU):
//     6. with Tier-2 enabled, a REAL turn mounts the viz in a SANDBOXED IFRAME (data-component-id = the
//        uicomp id), and the host's frame counter shows the brokered cell fed the sandbox live.
//     7. WebGL initialized INSIDE the opaque-origin sandbox (wrap.__vizMode === 'webgl'); '2d' tolerated
//        with a note (real-GPU verification is a headed check).
//     8. alt-click selects the island by its registry identity (✎ edit chip, its name).
//     9. a VARIANT source renders the SAME live frames through the SAME cell contract (fork/riff proof).
//    10. a THROWING viz source falls back to the LEGACY 3D pendant (never a silent turn) and auto-files the
//        error onto the viz's OWN backlog.
//    11. no external network egress from the confined frame during the turn.
//
// Run: node trace-viz-island.staging.test.cjs   (exits non-zero on failure; SKIPs browser w/o chromium)

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 8856;
const LLM_PORT = 8857;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-viz-'));
let srv = null; let stub = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { stub && stub.close(); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
const jpost = (p, b) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());

// stub CodeMode LLM: round 1 runs real tools (emitStep → trace cell), round 2 (sees round 1 output) answers,
// DELAYED so the turn stays open long enough for the browser to watch the island animate.
const PROGRAM_1 = ['```js', "updateProgress('phase one — gathering');", "await showChoices({ prompt: 'viz-proof', options: ['a', 'b'] });", "await showChoices({ prompt: 'viz-proof-2', options: ['c', 'd'] });", "return 'TV-PHASE1';", '```'].join('\n');
const PROGRAM_2 = '```js\nanswer("trace viz island proof done");\n```';
const startStub = () => new Promise(resolve => {
  stub = http.createServer((req, res) => {
    let body = ''; req.on('data', d => { body += d; });
    req.on('end', () => {
      let text = '{}'; let delay = 30;
      if (/SECURE SANDBOX/.test(body)) { if (/TV-PHASE1/.test(body)) { text = PROGRAM_2; delay = 5000; } else { text = PROGRAM_1; delay = 200; } }
      setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 10 } })); }, delay);
    });
  });
  stub.listen(LLM_PORT, '127.0.0.1', resolve);
});

const openCellStream = (cap, cellId) => {
  const frames = []; const ctrl = new AbortController(); const st = { status: 0 };
  const done = (async () => {
    try {
      const res = await fetch(`${BASE}/cells/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, cells: [cellId] }), signal: ctrl.signal });
      st.status = res.status; if (!res.ok || !res.body) return;
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) { const { done: end, value } = await reader.read(); if (end) break; buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n\n')) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); const line = block.split('\n').find(l => l.startsWith('data:')); if (!line) continue; try { frames.push(JSON.parse(line.slice(5).trim())); } catch {} } }
    } catch {}
  })();
  return { frames, st, stop: () => { try { ctrl.abort(); } catch {} return done; } };
};

// a distinct VARIANT viz honoring the SAME contract (WebGL clear, or 2d bars) — proves fork/riff.
const VARIANT_SOURCE = `(ui) => {
  var cw=ui.create('canvas').style({display:'block',width:'100%',height:'200px'}); var c=cw.el;
  var gl=c&&c.getContext?(c.getContext('webgl')||c.getContext('experimental-webgl')):null;
  var g2=gl?null:(c&&c.getContext?c.getContext('2d'):null); var mode=gl?'webgl':(g2?'2d':'none'); var frames=0;
  ui.grain(ui.props.cell).subscribe(function(v){ frames++; var n=(v&&v.steps?v.steps.length:0);
    if(gl){ c.width=200;c.height=120; gl.viewport(0,0,200,120); gl.clearColor(0.05,0.9-Math.min(n,8)*0.09,0.5,1); gl.clear(gl.COLOR_BUFFER_BIT); }
    else if(g2){ c.width=200;c.height=120; g2.clearRect(0,0,200,120); for(var i=0;i<n;i++){ g2.fillStyle='#39d3ff'; g2.fillRect(6+i*16,10,12,90); } }
    if(typeof ui.call==='function')ui.call('vizDiag',{mode:mode,frames:frames,steps:n});
  });
  return cw;
}`;
const BROKEN_SOURCE = `(ui) => { throw new Error("staged webgl trace breakage"); }`;

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

  // the canonical reference source (served to the client + committed to git via break-out)
  const vizMod = require('node:url').pathToFileURL(path.join(__dirname, 'public/trace-viz-3d.js')).href;
  const { TRACE_VIZ_3D_SOURCE } = await import(vizMod);

  // ── 1. the reference viz breaks out into a uicomp git object (render-check PASSES) + gets a backlog ──
  const bo = await jpost('/components/break-out', { cap: rootCap, source: TRACE_VIZ_3D_SOURCE, name: 'Trace 3D (force graph)', cells: ['trace:<chatId>'] });
  ok(bo.ok === true && /^uicomp-/.test(String(bo.id || '')), `the reference viz passes render-check + commits as a git object (${bo.id})`);
  const vizId = bo.id;
  const bl0 = await jpost('/components/backlog', { cap: rootCap, id: vizId });
  ok(bl0.ok === true && Array.isArray(bl0.items), 'breaking it out endowed it with a backlog (owner facet, empty at birth)');

  // ── 2. the committed source documents the cell contract (what the alt-click edit chat shows) ─────────
  const lu = await jpost('/components/list-ui', { cap: rootCap });
  const rec = (lu.components || []).find(c => c.id === vizId);
  ok(!!rec && /TRACE-VIZ/.test(rec.source) && /FORK FREELY/.test(rec.source) && /ui\.grain\(ui\.props\.cell\)/.test(rec.source), 'the committed source header documents the cell/canvas contract + the riff invitation');
  ok(!!rec && Array.isArray(rec.cells) && rec.cells.indexOf('trace:<chatId>') >= 0, 'it declares the trace cell (the gallery + share flow read this)');

  // ── 3. a VARIANT viz is a real, git-backed variant (a distinct (ui)=>element on the same contract) ───
  const bo2 = await jpost('/components/break-out', { cap: rootCap, source: VARIANT_SOURCE, name: 'Trace bars (riff)', cells: ['trace:<chatId>'] });
  ok(bo2.ok === true && /^uicomp-/.test(String(bo2.id || '')), `a riff/variant viz commits as its OWN git object (${bo2.id})`);
  const readVar = await jpost('/components/ui', { cap: rootCap, id: bo2.id });
  ok(readVar.ok === true && /ui\.grain\(ui\.props\.cell\)/.test(readVar.source || ''), 'the variant reads back as a real (ui)=>element on the same cell contract');

  // ── 4. NO NETWORK: confined.html CSP + the viz source has no exfil primitive ────────────────────────
  const confined = await (await fetch(`${BASE}/confined.html`)).text();
  ok(/default-src 'none'/.test(confined) && !/connect-src\s+(?!'none')/.test(confined), "confined.html CSP is default-src 'none' (no network; no connect-src loosening)");
  ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|import\s*\(/.test(TRACE_VIZ_3D_SOURCE), 'the viz source contains no network primitive (fetch/XHR/WebSocket/dynamic import)');

  // ── 5. the trace:<sid> cell is owner-gated (run a turn to bind the owner, then probe) ───────────────
  const gsid = 'tv-gate-1';
  await jpost('/chat', { cap: rootCap, sessionId: gsid, text: 'bind the trace owner' });
  const bad = openCellStream('deadbeef'.repeat(4), `trace:${gsid}`); await sleep(500); await bad.stop();
  ok(bad.st.status === 403 && bad.frames.length === 0, 'an invalid cap is refused outright (403, no frames)');
  const minted = await jpost('/scope/mint', { cap: rootCap, powers: ['notes'], label: 'viz-gate-probe' });
  const other = openCellStream(minted.scopedCap, `trace:${gsid}`); await sleep(600); await other.stop();
  ok(other.frames.some(f => f && /not your chat trace/.test(f.error || '')) && !other.frames.some(f => f && f.value), "a valid non-owner cap gets 'not your chat trace', never the frames (owner-gated)");

  // ── browser half ────────────────────────────────────────────────────────────────────────────────
  let chromium = null;
  try { ({ chromium } = require(process.env.PLAYWRIGHT_CORE || '/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - browser checks (playwright-core unavailable)'); console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(fail ? 1 : 0); }
  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
    env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  const shotDir = process.env.TRACE_VIZ_SHOTS || tmp;
  // seed: cap + a prior chat (skips the consent scoper) + Tier-2 ON + the viz's git id (so the island mounts
  // with its identity immediately). Optional per-page source override exercises variant/broken paths.
  const seed = (page, chatId, override) => page.addInitScript(({ c, id, vid, ov }) => { try {
    localStorage.setItem('field-agent-cap', c);
    localStorage.setItem('field-agent-chats', JSON.stringify([{ id, title: 'vizchat', ts: Date.now(), lastMsgAt: Date.now() }]));
    localStorage.setItem('field-agent-active', id);
    localStorage.setItem('field-agent-tx-' + id, JSON.stringify([{ who: 'you', text: 'warmup' }, { who: 'agent', text: 'ready' }]));
    // NO field-trace-tier2 set on purpose: Tier-2 WebGL is the DEFAULT surface (dan's 2026-07 policy call),
    // so the island must mount with no opt-in flag. This proves default-ON; trace-island.staging.test.cjs
    // sets field-trace-tier2='0' to prove the opt-OUT legacy path.
    localStorage.setItem('field-trace-viz-id', vid);           // its uicomp git id (identity from turn 1)
    if (ov) window.__traceVizSourceOverride = ov;              // test-only: swap the mounted viz source
  } catch {} }, { c: rootCap, id: chatId, vid: vizId, ov: override || '' });
  const openAndSend = async page => {
    await page.evaluate(() => { const it = [...document.querySelectorAll('.chat-item .ci-title')].find(s => /vizchat/.test(s.textContent)); if (it) it.click(); });
    await page.waitForTimeout(400);
    await page.evaluate(() => { document.getElementById('text').value = 'run the trace viz island proof'; document.getElementById('send').click(); });
  };
  const islandSel = `#log .gw-component[data-component-id="${vizId}"]`;
  try {
    // ── 6/7. the Tier-2 iframe island mounts during a REAL turn, WebGL inits in the sandbox, cell feeds it ──
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    const reqs = []; page.on('request', r => { try { reqs.push({ url: r.url(), frame: (r.frame() && r.frame().url()) || '' }); } catch {} });
    await seed(page, 'tv-ui-1');
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.waitForSelector('#tab-components:not(.hide)', { timeout: 15000 });
    await openAndSend(page);
    await page.waitForSelector(`${islandSel} iframe`, { timeout: 15000 });
    ok(true, 'the Tier-2 trace-viz island mounts in a SANDBOXED IFRAME during the turn (data-component-id = its uicomp git id)');
    const sandboxOk = await page.evaluate(sel => { const ifr = document.querySelector(sel + ' iframe'); return !!ifr && /allow-scripts/.test(ifr.getAttribute('sandbox') || '') && !/allow-same-origin/.test(ifr.getAttribute('sandbox') || '') && /confined\.html/.test(ifr.getAttribute('src') || ''); }, islandSel);
    ok(sandboxOk, 'the iframe is opaque-origin (sandbox=allow-scripts, NO allow-same-origin) loading /confined.html');
    let mid = null;
    for (let i = 0; i < 44 && !mid; i++) {
      const st = await page.evaluate(sel => ({ frames: (window.__traceIsland || {}).frames || 0, tier2: !!(window.__traceIsland || {}).tier2, mode: (document.querySelector(sel) || {}).__vizMode || '' }), islandSel);
      if (st.frames >= 2 && st.mode) mid = st; else await sleep(250);
    }
    ok(!!mid && mid.frames >= 2, `the brokered trace:<sid> cell fed the SANDBOX live (${mid && mid.frames} frames echoed from inside the iframe)`);
    ok(!!mid && mid.tier2, 'the active island is the Tier-2 (iframe) surface, not the divs chrome');
    if (mid && mid.mode === 'webgl') ok(true, 'WebGL INITIALIZED inside the opaque-origin sandbox (wrap.__vizMode === "webgl")');
    else ok(!!mid && mid.mode === '2d', `WebGL unavailable headless — viz fell back to canvas2d in-sandbox (mode="${mid && mid.mode}"); real-GPU WebGL is a headed check`);
    try { await page.screenshot({ path: path.join(shotDir, 'trace-viz-island-live.png') }); console.log('  info - screenshot:', path.join(shotDir, 'trace-viz-island-live.png')); } catch {}

    // ── 8. alt-click selects the island by registry identity (✎ edit chip) ────────────────────────────
    const sel = await page.evaluate(s => {
      const el = document.querySelector(s); if (!el) return { hasEdit: false, label: '(none)' };
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, altKey: true, clientX: r.left + 8, clientY: r.top + 8 }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true, clientX: r.left + 8, clientY: r.top + 8 }));
      const edit = [...document.querySelectorAll('button')].find(b => (b.textContent || '') === '✎ edit');
      const chip = edit && edit.closest('div');
      return { hasEdit: !!edit, label: chip ? chip.textContent : '' };
    }, islandSel);
    ok(sel.hasEdit && /Trace 3D/.test(sel.label), `alt-click selects the island by its registry name with the ✎ edit chip ("${String(sel.label).slice(0, 40)}")`);
    await page.keyboard.press('Escape');

    // ── 11. NO external network egress during the turn (CSP + observed requests) ──────────────────────
    await page.waitForFunction(() => [...document.querySelectorAll('.msg .body')].some(b => /trace viz island proof done/.test(b.textContent || '')), null, { timeout: 30000 }).catch(() => {});
    const external = reqs.filter(r => r.url && !r.url.startsWith(BASE) && !r.url.startsWith('data:') && !r.url.startsWith('about:') && !r.url.startsWith('blob:'));
    ok(external.length === 0, `no external network egress during the turn (${external.length ? external.slice(0, 2).map(r => r.url).join(', ') : 'all requests same-origin'})`);
    ok(errs.length === 0, `no page errors on the Tier-2 path (${errs.slice(0, 2).join(' | ')})`);
    await page.close();

    // ── 9. a VARIANT source renders the SAME live frames through the SAME cell contract ────────────────
    const pageV = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await seed(pageV, 'tv-ui-2', VARIANT_SOURCE);
    await pageV.goto(`${BASE}/`, { waitUntil: 'load' });
    await pageV.waitForSelector('#tab-components:not(.hide)', { timeout: 15000 });
    await openAndSend(pageV);
    await pageV.waitForSelector(`${islandSel} iframe`, { timeout: 15000 });
    let vframes = 0;
    for (let i = 0; i < 44 && vframes < 2; i++) { vframes = await pageV.evaluate(() => (window.__traceIsland || {}).frames || 0); if (vframes < 2) await sleep(250); }
    ok(vframes >= 2, `the VARIANT viz renders + receives the SAME live frames via the contract (${vframes} frames) — the gallery/riff substrate`);
    await pageV.close();

    // ── 10. a THROWING viz falls back to the LEGACY 3D pendant + auto-files onto the viz's OWN backlog ──
    const pageB = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await seed(pageB, 'tv-ui-3', BROKEN_SOURCE);
    await pageB.goto(`${BASE}/`, { waitUntil: 'load' });
    await pageB.waitForSelector('#tab-components:not(.hide)', { timeout: 15000 });
    await openAndSend(pageB);
    let fb = null;
    for (let i = 0; i < 44 && !fb; i++) {
      const st = await pageB.evaluate(sel => ({ island: !!document.querySelector(sel + ' iframe'), pendant: (() => { const w = document.getElementById('pendant-wrap'); return !!w && !w.classList.contains('hide'); })() }), islandSel);
      if (st.pendant) fb = st; else await sleep(250);
    }
    ok(!!fb && fb.pendant, 'a broken Tier-2 viz falls back to the LEGACY 3D pendant during the turn (never a silent turn)');
    await pageB.waitForTimeout(2500); // let /error/flag land
    const bl = await jpost('/components/backlog', { cap: rootCap, id: vizId });
    const item = (bl.items || []).find(i => i.kind === 'error' && /staged webgl trace breakage/.test((i.title || '') + ' ' + (i.body || '')));
    ok(!!item, `the throwing viz auto-filed onto the viz's OWN backlog ("${item && String(item.title).slice(0, 54)}…")`);
    await pageB.close();
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); cleanup(); process.exit(2); });
