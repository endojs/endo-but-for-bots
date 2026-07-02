#!/usr/bin/env node
// trace-viz-sankey.staging.test.cjs — STAGING (real-run) proof of the SANKEY / AUTHORITY-&-DATA FLOW
// Tier-2 trace viz (public/trace-viz-sankey.js). Mirrors trace-viz-island.staging.test.cjs in spirit but
// is self-contained: it does NOT boot the full server. Two layers:
//
//   NODE-STUB (always runs) — mounts the (ui)=>element against a faithful stub of confined.html's runtime
//     (create()/grain()/call(), a 2d canvas ctx, controllable requestAnimationFrame) and drives real
//     snapshots through the brokered cell:
//       1. it mounts + returns an element without throwing; feeding the SPLASH runs a real frame.
//       2. it derives GRANT ribbons from steps[].granted and DELEGATION from verbs+children (proven via
//          the petname caption: scope{…}, delegateTask, renderImage/upscale) and reports a ribbon count.
//       3. CAP HYGIENE: the caption is petnames only — NEVER a swissnum; a granted 32-hex petname renders
//          «redacted» (the belt-and-braces PET() assert), and #cap=/#k=/#agent= are refused too.
//       4. degrades on thin/empty/idle/truncated snapshots without throwing.
//   BROWSER (headless chromium + swiftshader; SKIP if unavailable) — mounts the REAL public/confined.html
//     in a sandboxed opaque-origin iframe, brokers the cell over a private MessagePort exactly like the
//     host does, feeds a GROWING trace then the SPLASH, and asserts WebGL/2d initialized in-sandbox, the
//     cell fed it live (frames echoed via vizDiag), NO frame error, NO external network — then screenshots
//     the splash.
//
// Run: node trace-viz-sankey.staging.test.cjs   (exits non-zero on failure; SKIPs browser w/o chromium)

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SWISS = 'a'.repeat(32); // a bare 32-hex "swissnum" shape the redaction must catch
const shotDir = process.env.TRACE_VIZ_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'trace-sankey-'));

(async () => {
  const mod = require('node:url').pathToFileURL(path.join(__dirname, 'public/trace-viz-sankey.js')).href;
  const { TRACE_VIZ_SANKEY_SOURCE: SRC, TRACE_VIZ_SANKEY_SPLASH: SPLASH, TRACE_VIZ_SANKEY_NAME, TRACE_VIZ_SANKEY_CELLS } = await import(mod);

  ok(typeof SRC === 'string' && SRC.length <= 8000, `source is a (ui)=>element within the 8000-char break-out cap (${SRC.length} chars)`);
  ok(/^\(ui\)\s*=>/.test(SRC), 'source begins with (ui)=> (passes break-out validation)');
  ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|import\s*\(/.test(SRC), 'source contains no network primitive (fetch/XHR/WebSocket/dynamic import)');
  ok(Array.isArray(TRACE_VIZ_SANKEY_CELLS) && TRACE_VIZ_SANKEY_CELLS.indexOf('trace:<chatId>') >= 0, `it declares the trace cell (name: ${TRACE_VIZ_SANKEY_NAME})`);
  ok(SPLASH && Array.isArray(SPLASH.steps) && SPLASH.steps.some(s => Array.isArray(s.granted)) && SPLASH.steps.some(s => Array.isArray(s.children)), 'the SPLASH trace carries grant (granted[]) + delegation (children[]) edges');
  ok(!new RegExp('#cap=|#k=|#agent=|[0-9a-f]{32}').test(JSON.stringify(SPLASH)), 'the SPLASH itself carries no swissnum (scrubbed by construction)');

  // ── NODE-STUB layer: a faithful-enough mirror of public/confined.html's ui runtime ─────────────────
  const mount = (props) => {
    const created = [];
    const grains = {};
    const calls = [];
    const noopCtx = () => new Proxy({}, { get: (t, p) => (p in t ? t[p] : () => {}), set: (t, p, v) => { t[p] = v; return true; } });
    const elw = (tag) => {
      const w = { _tag: String(tag || 'div'), _text: null, _class: '' };
      w.el = { _w: w, clientWidth: 900, clientHeight: 300, width: 900, height: 300, getContext: (t) => (w._tag === 'canvas' ? (t === '2d' ? noopCtx() : null) : null) };
      w.style = () => w; w.class = (c) => { w._class = String(c || ''); return w; }; w.push = () => w; w.on = () => w;
      w.text = (s) => { w._text = (s == null ? '' : String(s)); return w; };
      created.push(w); return w;
    };
    const grain = (id) => { id = String(id); if (!grains[id]) { const subs = []; grains[id] = { subscribe: (fn) => { subs.push(fn); return () => {}; }, _emit: (v) => subs.forEach(f => f(v)), get: () => undefined, set: () => {} }; } return grains[id]; };
    const ui = { create: elw, h: elw, grain, local: () => ({ subscribe: () => {}, get: () => {}, set: () => {} }), call: (m, a) => { calls.push({ m, a }); return Promise.resolve({}); }, props: props || {}, kit: [] };
    const rafQ = [];
    global.requestAnimationFrame = (cb) => { rafQ.push(cb); return rafQ.length; };
    global.devicePixelRatio = 1;
    // eslint-disable-next-line no-new-func
    const fn = new Function('return (' + SRC + ');')();
    const root = fn(ui);
    const tick = (n) => { let ts = 16; for (let i = 0; i < (n || 1); i++) { const q = rafQ.splice(0); q.forEach(cb => { try { cb(ts); } catch (e) { throw e; } }); ts += 16; } };
    const caption = () => { const c = created.find(w => w._class === 'cu-meta'); return c ? (c._text || '') : ''; };
    const lastDiag = () => calls.filter(c => c.m === 'vizDiag').slice(-1)[0];
    return { root, feed: (v) => grains[String((props || {}).cell)] && grains[String((props || {}).cell)]._emit(v), tick, caption, lastDiag, calls };
  };

  const S = mount({ cell: 'trace:x' });
  ok(!!(S.root && S.root.el), 'mounts and returns an element (ui.create(...))');

  let threw = false;
  try { S.feed(SPLASH); S.tick(2); } catch (e) { threw = true; console.error('   ', e && e.message); }
  ok(!threw, 'feeding the SPLASH runs a real frame without throwing');
  const d = S.lastDiag();
  ok(!!d && d.a && d.a.ribbons > 3 && d.a.mode === '2d', `vizDiag echoed the derived flow (${d && d.a && d.a.ribbons} ribbons, mode=${d && d.a && d.a.mode})`);
  const cap = S.caption();
  ok(/scope \{[^}]*gpu/.test(cap) && /images/.test(cap), 'GRANT edges: the scope node unions the granted[] petnames (gpu · images …; long labels PET-clip at 26)');
  ok(/delegateTask/.test(cap) && /renderImage/.test(cap) && /upscale/.test(cap), 'DELEGATION edges: the delegateTask sub-agent + its children (renderImage/upscale) are in the flow');
  ok(!new RegExp('#cap=|#k=|#agent=|[0-9a-f]{32}').test(cap), 'CAP HYGIENE: the rendered petname caption emits NO swissnum');

  // redaction: a granted petname shaped like a swissnum must render «redacted», never the raw 32-hex
  const R = mount({ cell: 'trace:r' });
  R.feed({ status: 'done', rev: 1, agent: 'field-agent', steps: [{ name: 'sneaky', granted: [SWISS], ok: true }, { name: 'hdr', detail: '#cap=' + SWISS, granted: ['#agent=' + SWISS] }] });
  R.tick(2);
  const rc = R.caption();
  ok(rc.indexOf(SWISS) < 0 && !new RegExp('#cap=|#agent=').test(rc), 'a swissnum/#cap/#agent shaped petname NEVER reaches the caption');
  ok(/«redacted»/.test(rc), 'the belt-and-braces PET() assert rendered «redacted» in its place');

  // degradations — none may throw
  const degs = [{}, { status: 'idle' }, { steps: [] }, { steps: [{ name: 'only' }] }, { truncated: true, status: 'running', steps: [{ name: 'a', granted: ['x'] }] }, { nodes: [{ key: 0, label: 'root' }, { key: 1, parent: 0, label: 'child', state: 'fail' }] }];
  let degOk = true; let degWhich = '';
  for (const g of degs) { try { const T = mount({ cell: 'trace:d' }); T.feed(g); T.tick(2); } catch (e) { degOk = false; degWhich = (e && e.message) || 'threw'; break; } }
  ok(degOk, `thin/empty/idle/one-step/truncated/research snapshots all render without throwing${degOk ? '' : ' — ' + degWhich}`);

  // growth is monotone: a second, larger snapshot keeps rendering + reports more ribbons
  const G = mount({ cell: 'trace:g' });
  G.feed({ status: 'running', rev: 1, steps: [{ name: 'mintLease', granted: ['gpu'] }] });
  G.tick(1); const g1 = G.lastDiag();
  G.feed(SPLASH); G.tick(1); const g2 = G.lastDiag();
  ok(g1 && g2 && g2.a.ribbons > g1.a.ribbons, `the flow grows as the trace grows (${g1 && g1.a.ribbons} → ${g2 && g2.a.ribbons} ribbons)`);

  // ── BROWSER layer ─────────────────────────────────────────────────────────────────────────────────
  let chromium = null;
  try { ({ chromium } = require(process.env.PLAYWRIGHT_CORE || '/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - browser checks (playwright-core unavailable)'); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }

  const confined = fs.readFileSync(path.join(__dirname, 'public/confined.html'), 'utf8');
  const parentHtml = `<!doctype html><meta charset=utf-8><body style="margin:0;background:#0d1117">
<script>
const SRC=${JSON.stringify(SRC)}, SPLASH=${JSON.stringify(SPLASH)};
window.__diag={frames:0,mode:'',ribbons:0,errors:[],mounted:false};
const ifr=document.createElement('iframe');
ifr.setAttribute('sandbox','allow-scripts');
ifr.src='/confined.html';
ifr.style.cssText='width:900px;height:340px;border:0;display:block';
document.body.appendChild(ifr);
let port,rev=0;
const feed=v=>{ try{ port.postMessage({__cu:1,type:'cell',id:'trace:demo',value:v}); }catch(e){} };
window.addEventListener('message',e=>{
  if(e.source!==ifr.contentWindow) return;
  const m=e.data; if(!m||m.__cu!==1||m.type!=='ready') return;
  const ch=new MessageChannel(); port=ch.port1;
  port.onmessage=pe=>{ const pm=pe.data; if(!pm||pm.__cu!==1) return;
    if(pm.type==='call'&&pm.method==='vizDiag'){ const a=pm.args||{}; window.__diag.frames=a.frames||window.__diag.frames; window.__diag.mode=a.mode||window.__diag.mode; window.__diag.ribbons=a.ribbons||window.__diag.ribbons; try{port.postMessage({__cu:1,type:'call-result',id:pm.id,ok:true,value:{}});}catch(_){}}
    else if(pm.type==='error'){ window.__diag.errors.push(String(pm.error)); }
  };
  port.start();
  ifr.contentWindow.postMessage({__cu:1,type:'mount',source:SRC,props:{cell:'trace:demo'},theme:{}},'*',[ch.port2]);
  window.__diag.mounted=true;
  // a GROWING trace, then the SPLASH freeze-frame
  feed({status:'running',rev:++rev,steps:[{name:'mintLease',granted:['gpu']}]});
  setTimeout(()=>feed({status:'running',rev:++rev,steps:[{name:'mintLease',granted:['gpu'],ok:true},{name:'delegateTask',granted:['images'],children:[{name:'renderImage'}]}]}),150);
  setTimeout(()=>feed(SPLASH),400);
});
</script></body>`;

  const srv = http.createServer((req, res) => {
    if (req.url === '/' || req.url.startsWith('/?')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(parentHtml); return; }
    if (req.url.startsWith('/confined.html')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(confined); return; }
    res.writeHead(404); res.end('no');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const PORT = srv.address().port; const BASE = `http://127.0.0.1:${PORT}`;

  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
    env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 400 } });
    const perr = []; page.on('pageerror', e => perr.push(e.message));
    const reqs = []; page.on('request', r => { try { reqs.push(r.url()); } catch {} });
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.waitForFunction(() => window.__diag && window.__diag.mounted, null, { timeout: 15000 }).catch(() => {});
    let dg = null;
    for (let i = 0; i < 44 && !(dg && dg.frames >= 2 && dg.mode); i++) { dg = await page.evaluate(() => window.__diag); if (!(dg.frames >= 2 && dg.mode)) await sleep(200); }
    ok(!!dg && dg.mounted, 'the viz mounted in the REAL sandboxed opaque-origin /confined.html iframe');
    const sb = await page.evaluate(() => { const f = document.querySelector('iframe'); const s = f.getAttribute('sandbox') || ''; return /allow-scripts/.test(s) && !/allow-same-origin/.test(s) && /confined\.html/.test(f.getAttribute('src') || ''); });
    ok(sb, 'the iframe is opaque-origin (sandbox=allow-scripts, NO allow-same-origin) loading /confined.html');
    ok(!!dg && dg.frames >= 2, `the brokered trace cell fed the SANDBOX live (${dg && dg.frames} frames echoed via vizDiag from inside the frame)`);
    ok(!!dg && dg.ribbons > 3, `the SPLASH derived a multi-ribbon flow inside the sandbox (${dg && dg.ribbons} ribbons)`);
    if (dg && dg.mode === 'webgl') ok(true, 'WebGL initialized inside the opaque-origin sandbox (mode=webgl)');
    else ok(!!dg && dg.mode === '2d', `WebGL unavailable headless — fell back to canvas2d in-sandbox (mode=${dg && dg.mode}); real-GPU WebGL is a headed check`);
    await sleep(400);
    const shot = path.join(shotDir, 'trace-viz-sankey-splash.png');
    try { await page.screenshot({ path: shot }); console.log('  info - screenshot:', shot); } catch {}
    ok((dg && dg.errors.length === 0), `no error surfaced from the confined frame (${dg && dg.errors.slice(0, 2).join(' | ')})`);
    ok(perr.length === 0, `no page errors (${perr.slice(0, 2).join(' | ')})`);
    const external = reqs.filter(u => u && !u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('about:') && !u.startsWith('blob:'));
    ok(external.length === 0, `no external network egress (${external.length ? external.slice(0, 2).join(', ') : 'all same-origin'})`);
    await page.close();
  } finally { await browser.close(); srv.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', (e && e.stack) || e); process.exit(2); });
