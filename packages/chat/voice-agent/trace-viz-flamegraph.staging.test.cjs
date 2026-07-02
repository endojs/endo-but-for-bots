#!/usr/bin/env node
// trace-viz-flamegraph.staging.test.cjs — STAGING (real-run) proof of the FLAMEGRAPH (icicle) Tier-2
// trace-viz source (public/trace-viz-flamegraph.js). Mirrors trace-viz-island.staging.test.cjs's browser
// half, but SELF-CONTAINED: it mounts the source in the REAL public/confined.html runtime (opaque-origin
// sandbox, CSP default-src 'none') behind a tiny static server + an inline harness that brokers a STUB
// `trace:<chatId>` cell over a MessagePort — exactly the parent↔frame contract, minus the server/cap.
//
// It proves the source:
//   1. mounts + renders in the sandbox without throwing (no frame 'error' messages, height reported);
//   2. WebGL initialized in the sandbox (vizDiag.mode==='webgl'; '2d' tolerated w/ a note — swiftshader);
//   3. the brokered cell fed the frame live (vizDiag.frames climbs);
//   4. the SPLASH sample renders (screenshotted);
//   5. a live-GROWING trace (rev climbs, steps append) keeps rendering (frames keep climbing, no errors);
//   6. degrades on empty / thin / truncated-running / malformed-node data without throwing;
//   7. NEVER emits a swissnum: a cap-shaped token fed in a prompt/step name never appears in ANY message
//      the frame posts out, and the scrubbed vizDiag.t0 shows ⟨cap⟩ (positive proof scrubbing ran).
//
// Run: node trace-viz-flamegraph.staging.test.cjs   (exits non-zero on failure; SKIPs browser w/o chromium)

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-viz-fg-'));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// a cap-shaped swissnum (base32-ish, 48 chars) — must be caught by the source's scrubCaps.
const SWISS = 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnop';

const HARNESS = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
var P1=null,CELL='',LAST=undefined,SUB=false;
window.__msgs=[];window.__errors=[];window.__diag={mode:'',frames:0,t0:''};window.__height=0;
window.__mount=function(source,cell){return new Promise(function(res){CELL=cell;
  var ifr=document.createElement('iframe');ifr.setAttribute('sandbox','allow-scripts');ifr.setAttribute('referrerpolicy','no-referrer');
  ifr.style.cssText='width:900px;height:340px;border:0;display:block';ifr.src='/confined.html';window.__ifr=ifr;
  function onWin(e){if(e.source!==ifr.contentWindow)return;var m=e.data;if(!m||m.__cu!==1||m.type!=='ready')return;window.removeEventListener('message',onWin);
    var ch=new MessageChannel();P1=ch.port1;
    P1.onmessage=function(pe){var pm=pe.data;if(!pm||pm.__cu!==1)return;window.__msgs.push(pm);
      if(pm.type==='subscribe'){SUB=true;if(LAST!==undefined)P1.postMessage({__cu:1,type:'cell',id:CELL,value:LAST});}
      else if(pm.type==='height'){window.__height=pm.px;}
      else if(pm.type==='error'){window.__errors.push(pm.error);}
      else if(pm.type==='call'){if(pm.method==='vizDiag'){var a=pm.args||{};window.__diag={mode:a.mode||'',frames:a.frames||0,t0:a.t0||''};}P1.postMessage({__cu:1,type:'call-result',id:pm.id,ok:true,value:{}});}
    };P1.start();
    ifr.contentWindow.postMessage({__cu:1,type:'mount',source:source,props:{cell:CELL}},'*',[ch.port2]);
    res(true);
  }
  window.addEventListener('message',onWin);document.body.appendChild(ifr);
});};
window.__feed=function(v){LAST=v;if(SUB&&P1)P1.postMessage({__cu:1,type:'cell',id:CELL,value:v});};
<\/script></body></html>`;

const startServer = () => new Promise(resolve => {
  const pub = path.join(__dirname, 'public');
  const srv = http.createServer((req, res) => {
    const u = (req.url || '/').split('?')[0];
    if (u === '/' || u === '/harness') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HARNESS); return; }
    const file = path.join(pub, u.replace(/^\/+/, ''));
    if (!file.startsWith(pub)) { res.writeHead(403); res.end('no'); return; }
    fs.readFile(file, (e, b) => { if (e) { res.writeHead(404); res.end('nf'); return; } res.writeHead(200, { 'content-type': u.endsWith('.html') ? 'text/html' : 'application/javascript' }); res.end(b); });
  });
  srv.listen(0, '127.0.0.1', () => resolve(srv));
});

(async () => {
  const srv = await startServer();
  const PORT = srv.address().port;
  const BASE = `http://127.0.0.1:${PORT}`;
  const cleanup = () => { try { srv.close(); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

  const { TRACE_VIZ_FLAMEGRAPH_SOURCE: SRC, TRACE_VIZ_FLAMEGRAPH_SPLASH: SPLASH } =
    await import(require('node:url').pathToFileURL(path.join(__dirname, 'public/trace-viz-flamegraph.js')).href);

  // ── source-level guards (hold even without a browser) ──────────────────────────────────────────────
  ok(SRC.length <= 8000, `source is within the 8000-char break-out cap (${SRC.length})`);
  ok(/^\(ui\)\s*=>/.test(SRC), 'source is a `(ui) => element` (passes break-out validation)');
  ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|import\s*\(/.test(SRC), 'source contains no network primitive (fetch/XHR/WebSocket/dynamic import)');
  ok(SPLASH && Array.isArray(SPLASH.steps) && SPLASH.steps.length === 4 && SPLASH.status === 'done', 'the exported SPLASH is a canned done-trace the gallery can preview');

  let chromium = null;
  try { ({ chromium } = require(process.env.PLAYWRIGHT_CORE || '/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - browser checks (playwright-core unavailable)'); console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(fail ? 1 : 0); }

  const browser = await chromium.launch({
    executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
    env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' },
  });
  const shotDir = process.env.TRACE_VIZ_FG_SHOTS || tmp;
  const shot = path.join(shotDir, 'trace-viz-flamegraph-splash.png');
  try {
    const page = await browser.newPage({ viewport: { width: 980, height: 420 } });
    const pageErrs = []; page.on('pageerror', e => pageErrs.push(e.message));
    const reqs = []; page.on('request', r => { try { reqs.push(r.url()); } catch {} });
    await page.goto(`${BASE}/harness`, { waitUntil: 'load' });

    // ── 1-4. mount + feed the SPLASH; it renders in the sandbox, WebGL inits, the cell feeds it live ──
    await page.evaluate(src => window.__mount(src, 'trace:splash'), SRC);
    await page.evaluate(v => window.__feed(v), SPLASH);
    let d = null;
    for (let i = 0; i < 60 && !d; i++) { const s = await page.evaluate(() => window.__diag); if (s.frames >= 1 && s.mode) d = s; else await sleep(200); }
    ok(!!d && d.frames >= 1, `the brokered trace cell fed the sandbox live (vizDiag frames=${d && d.frames})`);
    const errs1 = await page.evaluate(() => window.__errors);
    ok(errs1.length === 0, `the SPLASH mounted + rendered with no frame errors (${errs1.slice(0, 2).join(' | ')})`);
    const h1 = await page.evaluate(() => window.__height);
    ok(h1 > 40, `the frame reported a real content height (${h1}px)`);
    if (d && d.mode === 'webgl') ok(true, 'WebGL INITIALIZED inside the opaque-origin sandbox (vizDiag.mode === "webgl")');
    else ok(!!d && d.mode === '2d', `WebGL unavailable headless — fell back to canvas2d in-sandbox (mode="${d && d.mode}")`);
    await sleep(1200); // let the build-in sweep settle before the screenshot
    try { await page.screenshot({ path: shot }); console.log('  info - screenshot:', shot); } catch {}

    // ── 5. a live-GROWING trace: rev climbs, steps append, a running frontier — keeps rendering ─────────
    const framesBefore = (await page.evaluate(() => window.__diag)).frames;
    for (let step = 1; step <= 5; step++) {
      const kids = [];
      for (let j = 0; j < step; j++) kids.push({ name: 'web: fetch ' + j, ok: true, status: 'done' });
      kids.push({ name: 'web: fetch ' + step, status: 'running' });
      await page.evaluate(v => window.__feed(v), { status: 'running', rev: step, prompt: 'growing research task', steps: [{ name: 'research', status: 'running', children: kids }] });
      await sleep(180);
    }
    const dg = await page.evaluate(() => window.__diag);
    ok(dg.frames > framesBefore, `the live-growing trace kept feeding + re-rendering (frames ${framesBefore} → ${dg.frames})`);
    const errs2 = await page.evaluate(() => window.__errors);
    ok(errs2.length === 0, `no errors across the growth animation (${errs2.slice(0, 2).join(' | ')})`);

    // ── 6. degradation: empty / thin / truncated-running / malformed — none throw ───────────────────────
    const feeds = [
      {},
      { steps: [{ name: 'web: search' }] },
      { status: 'running', rev: 9, steps: [{ name: 'research', status: 'running', children: [{ name: 'web', status: 'running' }] }] },
      { steps: [{}, { name: null }, null, { name: 'notes', ok: false }] },
      { nodes: [{ key: 0, name: 'root-ish' }, { key: 1, parent: 0, name: 'child', state: 'pending' }] },
    ];
    for (const f of feeds) { await page.evaluate(v => window.__feed(v), f); await sleep(160); }
    const errs3 = await page.evaluate(() => window.__errors);
    ok(errs3.length === 0, `empty/thin/truncated/malformed/nodes-only all render without throwing (${errs3.slice(0, 2).join(' | ')})`);

    // ── 7. NEVER emits a swissnum: feed a cap-shaped token, assert it never leaves the frame + is scrubbed ─
    await page.evaluate((v) => window.__feed(v), { status: 'done', rev: 20, prompt: 'root ' + SWISS, steps: [{ name: 'web: ' + SWISS, ok: true, status: 'done' }] });
    await sleep(400);
    const outMsgs = await page.evaluate(() => JSON.stringify(window.__msgs));
    ok(outMsgs.indexOf(SWISS) === -1, 'the cap-shaped token NEVER appears in any message the frame posts out (no swissnum egress)');
    const t0 = (await page.evaluate(() => window.__diag)).t0;
    ok(/⟨cap⟩/.test(t0) && t0.indexOf(SWISS) === -1, `the frame scrubbed the cap out of its telemetry label ("${t0}")`);

    ok(pageErrs.length === 0, `no uncaught page errors on the whole run (${pageErrs.slice(0, 2).join(' | ')})`);
    const external = reqs.filter(u => u && !u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('about:') && !u.startsWith('blob:'));
    ok(external.length === 0, `no external network egress (${external.length ? external.slice(0, 2).join(', ') : 'all same-origin'})`);
    await page.close();
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', (e && e.stack) || e); process.exit(2); });
