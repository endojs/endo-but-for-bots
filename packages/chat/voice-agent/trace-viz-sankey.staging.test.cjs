#!/usr/bin/env node
// trace-viz-sankey.staging.test.cjs — STAGING (real-run) proof of the SANKEY / AUTHORITY-&-DATA FLOW
// Tier-2 trace viz (public/trace-viz-sankey.js). Mirrors trace-viz-island.staging.test.cjs in spirit but
// is self-contained: it does NOT boot the full server. Two layers:
//
//   NODE-STUB (always runs) — mounts the (ui)=>element against a faithful stub of confined.html's runtime
//     (create()/grain()/call()/on()/attr(), a 2d canvas ctx, controllable requestAnimationFrame) and drives
//     real snapshots through the brokered cell, then EXERCISES every restored interaction deterministically:
//       1. it mounts + returns an element without throwing; feeding the SPLASH runs a real frame.
//       2. it derives GRANT ribbons from steps[].granted and DELEGATION from verbs+children (proven via
//          the petname caption: scope{…}, delegateTask, renderImage/upscale) and reports a ribbon count.
//       3. CAP HYGIENE across ALL surfaces — the caption (== the per-node LABELS) and the HOVER TOOLTIP are
//          petnames only, NEVER a swissnum: a granted/named 32-hex token renders «redacted» (the
//          belt-and-braces PET() assert), and #cap=/#k=/#agent= are refused in BOTH labels and tooltips.
//       4. HOVER a ribbon → a "this {data|capability|delegation} went from X → Y" tooltip (petnames).
//       5. CLICK a node → isolate its flows (some ribbons lit, the rest dimmed); background click restores.
//       6. "caps only" toggle → cyan DATA ribbons hidden, amber+violet AUTHORITY skeleton remains.
//       7. the rev SCRUB slider replays the flow at steps[0..k] (fewer ribbons than the full run).
//       8. degrades on thin/empty/idle/truncated snapshots without throwing.
//   BROWSER (headless chromium + swiftshader; SKIP if unavailable) — mounts the REAL public/confined.html
//     in a sandboxed opaque-origin iframe, brokers the cell over a private MessagePort exactly like the
//     host does, feeds a GROWING trace then the SPLASH, asserts WebGL/2d initialized in-sandbox, the cell
//     fed it live (frames echoed via vizDiag), NO frame error, NO external network — then DRIVES the real
//     pointer/click/toggle interactions (reading state back over vizDiag) and screenshots the tooltip,
//     isolated, and caps-only states + the splash.
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
const CAPRE = () => new RegExp('#cap=|#k=|#agent=|[0-9a-f]{32}');
const shotDir = process.env.TRACE_VIZ_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'trace-sankey-'));

(async () => {
  const mod = require('node:url').pathToFileURL(path.join(__dirname, 'public/trace-viz-sankey.js')).href;
  const { TRACE_VIZ_SANKEY_SOURCE: SRC, TRACE_VIZ_SANKEY_SPLASH: SPLASH, TRACE_VIZ_SANKEY_NAME, TRACE_VIZ_SANKEY_CELLS } = await import(mod);

  ok(typeof SRC === 'string' && SRC.length <= 16000, `source is a (ui)=>element within the 16000-char break-out cap (${SRC.length} chars)`);
  ok(/^\(ui\)\s*=>/.test(SRC), 'source begins with (ui)=> (passes break-out validation)');
  ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|import\s*\(|eval\s*\(/.test(SRC), 'source contains no network/eval primitive (fetch/XHR/WebSocket/dynamic import/eval)');
  ok(Array.isArray(TRACE_VIZ_SANKEY_CELLS) && TRACE_VIZ_SANKEY_CELLS.indexOf('trace:<chatId>') >= 0, `it declares the trace cell (name: ${TRACE_VIZ_SANKEY_NAME})`);
  ok(SPLASH && Array.isArray(SPLASH.steps) && SPLASH.steps.some(s => Array.isArray(s.granted)) && SPLASH.steps.some(s => Array.isArray(s.children)), 'the SPLASH trace carries grant (granted[]) + delegation (children[]) edges');
  ok(!CAPRE().test(JSON.stringify(SPLASH)), 'the SPLASH itself carries no swissnum (scrubbed by construction)');

  // render-check the source through the SAME isolated bwrap child the authoring loop uses (parse + mount smoke).
  try {
    const { validateComponentSource } = await import(require('node:url').pathToFileURL(path.join(__dirname, 'component-source.mjs')).href);
    const { renderCheck } = await import(require('node:url').pathToFileURL(path.join(__dirname, 'render-check.mjs')).href);
    ok(validateComponentSource(SRC).ok === true, 'the source passes validateComponentSource (compile-only parse gate)');
    const rc = await renderCheck(SRC, { kind: 'ui' });
    ok(rc.ok !== false, `the source passes the isolated render-check (bwrap child mount smoke)${rc.ok === false ? ' — ' + rc.error : rc.skipped ? ' [skipped: ' + rc.skipped + ']' : ''}`);
  } catch (e) { ok(false, 'render-check harness loaded — ' + ((e && e.message) || e)); }

  // ── NODE-STUB layer: a faithful-enough mirror of public/confined.html's ui runtime ─────────────────
  const mount = (props) => {
    const created = [];
    const grains = {};
    const calls = [];
    const noopCtx = () => new Proxy({}, { get: (t, p) => (p in t ? t[p] : () => {}), set: (t, p, v) => { t[p] = v; return true; } });
    const elw = (tag) => {
      const w = { _tag: String(tag || 'div'), _text: null, _class: '', _on: {} };
      w.el = { _w: w, clientWidth: 900, clientHeight: 300, width: 900, height: 300, getContext: (t) => (w._tag === 'canvas' ? (t === '2d' ? noopCtx() : null) : null) };
      w.style = () => w; w.class = (c) => { w._class = String(c || ''); return w; }; w.push = () => w; w.attr = () => w;
      w.on = (ev, fn) => { w._on[String(ev)] = fn; return w; };
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
    const lastDiag = () => (calls.filter(c => c.m === 'vizDiag').slice(-1)[0] || { a: {} }).a;
    const mainCanvas = () => created.find(w => w._tag === 'canvas');            // the first canvas = the interactive one
    const capsBtn = () => created.find(w => w._tag === 'button');
    const slider = () => created.find(w => w._tag === 'input');
    const fire = (target, ev, e) => { const t = target && target._on && target._on[ev]; if (typeof t === 'function') t(e || {}); };
    // sweep the pointer over a grid, firing pointermove; return the set of every tooltip string seen.
    const sweepHover = () => { const cv = mainCanvas(); const seen = new Set(); for (let y = 6; y < 300; y += 12) for (let x = 6; x < 900; x += 12) { fire(cv, 'pointermove', { x, y }); const h = lastDiag().hover; if (h) seen.add(h); } return seen; };
    // sweep pointerdown until a node isolates; return the diag at that moment (or null).
    const sweepIsolate = () => { const cv = mainCanvas(); for (let y = 6; y < 300; y += 6) for (let x = 6; x < 900; x += 6) { fire(cv, 'pointerdown', { x, y }); if (lastDiag().isolated) return { x, y, diag: lastDiag() }; } return null; };
    return { root, feed: (v) => grains[String((props || {}).cell)] && grains[String((props || {}).cell)]._emit(v), tick, caption, lastDiag, calls, created, mainCanvas, capsBtn, slider, fire, sweepHover, sweepIsolate };
  };

  const S = mount({ cell: 'trace:x' });
  ok(!!(S.root && S.root.el), 'mounts and returns an element (ui.create(...))');

  let threw = false;
  try { S.feed(SPLASH); S.tick(2); } catch (e) { threw = true; console.error('   ', e && e.message); }
  ok(!threw, 'feeding the SPLASH runs a real frame without throwing');
  const d = S.lastDiag();
  ok(!!d && d.ribbons > 3 && d.mode === '2d', `vizDiag echoed the derived flow (${d && d.ribbons} ribbons, mode=${d && d.mode})`);
  const cap = S.caption();
  ok(/scope \{[^}]*gpu/.test(cap) && /images/.test(cap), 'GRANT edges: the scope node unions the granted[] petnames (gpu · images …; long labels PET-clip at 26)');
  ok(/delegateTask/.test(cap) && /renderImage/.test(cap) && /upscale/.test(cap), 'DELEGATION edges: the delegateTask sub-agent + its children (renderImage/upscale) are in the flow');
  ok(!CAPRE().test(cap), 'CAP HYGIENE (labels): the rendered petname caption/labels emit NO swissnum');

  // ── (4) HOVER tooltip: petnames "this <kind> went from X → Y", NEVER a swissnum ─────────────────────
  const hovers = S.sweepHover();
  ok(hovers.size > 0, `hovering ribbons yields tooltips (${hovers.size} distinct from→to strings)`);
  const anyHover = [...hovers];
  ok(anyHover.some(t => /this (data|capability|delegation) went from .+ → .+/.test(t)), `the tooltip reads "this {kind} went from X → Y" (e.g. ${JSON.stringify(anyHover.find(t => /went from/.test(t)) || '')})`);
  ok(anyHover.some(t => /capability/.test(t)) || anyHover.some(t => /delegation/.test(t)), 'authority ribbons produce a "capability"/"delegation" tooltip (the ocap flow named)');
  ok(!anyHover.some(t => CAPRE().test(t)), 'CAP HYGIENE (tooltips): NO hover tooltip ever contains a swissnum/#cap/#k/#agent');

  // ── (5) CLICK-to-isolate: one node lit, the rest dimmed; background click restores ──────────────────
  const iso = S.sweepIsolate();
  ok(!!iso && iso.diag.isolated, `clicking a node isolates it (isolated=${iso && iso.diag.isolated})`);
  ok(!!iso && iso.diag.lit > 0 && iso.diag.dim > 0, `isolate LIGHTS the node's flows and DIMS the rest (lit=${iso && iso.diag.lit}, dim=${iso && iso.diag.dim})`);
  S.fire(S.mainCanvas(), 'pointerdown', { x: 898, y: 2 }); // an empty corner = background → restore
  ok(!S.lastDiag().isolated, 'clicking empty background restores (isolation cleared)');

  // ── (6) "caps only" toggle: cyan DATA ribbons hidden, amber+violet AUTHORITY skeleton remains ───────
  const before = S.lastDiag();
  S.fire(S.capsBtn(), 'click');
  const afterCaps = S.lastDiag();
  ok(afterCaps.capsOnly === true && afterCaps.dataDrawn === 0, `"caps only" hides every DATA ribbon (dataDrawn ${before.dataDrawn} → ${afterCaps.dataDrawn}), keeps the authority skeleton (authDrawn=${afterCaps.authDrawn})`);
  ok(afterCaps.authDrawn > 0, 'the amber GRANT + violet DELEGATION ribbons survive the caps-only X-ray');
  S.fire(S.capsBtn(), 'click'); // back to all flows
  ok(S.lastDiag().capsOnly === false && S.lastDiag().dataDrawn > 0, 'toggling again restores the data ribbons');

  // ── (7) rev SCRUB slider: replay at steps[0..k] renders FEWER ribbons than the full run ─────────────
  const full = S.lastDiag().ribbons;
  S.fire(S.slider(), 'input', { value: '1' }); // scrub back to just step 0
  const scrubbed = S.lastDiag().ribbons;
  ok(scrubbed < full && scrubbed > 0, `the scrub slider replays the flow growing hop-by-hop (steps[0..1] → ${scrubbed} ribbons < full ${full})`);
  S.fire(S.slider(), 'input', { value: String(SPLASH.steps.length) }); // back to full
  ok(S.lastDiag().ribbons === full, 'scrubbing to the end restores the full flow');

  // ── (3) redaction across BOTH labels AND tooltips: a cap-shaped token must render «redacted» ────────
  const R = mount({ cell: 'trace:r' });
  R.feed({ status: 'done', rev: 1, agent: 'field-agent', steps: [{ name: SWISS, granted: [SWISS], ok: true }, { name: 'hdr', detail: '#cap=' + SWISS, granted: ['#agent=' + SWISS] }] });
  R.tick(2);
  const rc = R.caption();
  ok(rc.indexOf(SWISS) < 0 && !new RegExp('#cap=|#agent=').test(rc), 'a swissnum/#cap/#agent shaped label NEVER reaches the caption (per-node labels are redacted)');
  ok(/«redacted»/.test(rc), 'the belt-and-braces PET() assert rendered «redacted» in the labels');
  const rHovers = [...R.sweepHover()];
  ok(rHovers.length > 0 && !rHovers.some(t => CAPRE().test(t)), `and NO tooltip leaks the planted swissnum either (${rHovers.length} tooltips, all clean)`);
  ok(rHovers.some(t => /«redacted»/.test(t)), 'the planted cap-shaped node surfaces as «redacted» inside the tooltip too');

  // degradations — none may throw
  const degs = [{}, { status: 'idle' }, { steps: [] }, { steps: [{ name: 'only' }] }, { truncated: true, status: 'running', steps: [{ name: 'a', granted: ['x'] }] }, { nodes: [{ key: 0, label: 'root' }, { key: 1, parent: 0, label: 'child', state: 'fail' }] }];
  let degOk = true; let degWhich = '';
  for (const g of degs) { try { const T = mount({ cell: 'trace:d' }); T.feed(g); T.tick(2); T.sweepHover(); T.sweepIsolate(); } catch (e) { degOk = false; degWhich = (e && e.message) || 'threw'; break; } }
  ok(degOk, `thin/empty/idle/one-step/truncated/research snapshots (incl. hover+click) all render without throwing${degOk ? '' : ' — ' + degWhich}`);

  // growth is monotone: a second, larger snapshot keeps rendering + reports more ribbons
  const G = mount({ cell: 'trace:g' });
  G.feed({ status: 'running', rev: 1, steps: [{ name: 'mintLease', granted: ['gpu'] }] });
  G.tick(1); const g1 = G.lastDiag();
  G.feed(SPLASH); G.tick(1); const g2 = G.lastDiag();
  ok(g1 && g2 && g2.ribbons > g1.ribbons, `the flow grows as the trace grows (${g1 && g1.ribbons} → ${g2 && g2.ribbons} ribbons)`);

  // ── BROWSER layer ─────────────────────────────────────────────────────────────────────────────────
  let chromium = null;
  try { ({ chromium } = require(process.env.PLAYWRIGHT_CORE || '/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - browser checks (playwright-core unavailable)'); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }

  const confined = fs.readFileSync(path.join(__dirname, 'public/confined.html'), 'utf8');
  const parentHtml = `<!doctype html><meta charset=utf-8><body style="margin:0;background:#0d1117">
<script>
const SRC=${JSON.stringify(SRC)}, SPLASH=${JSON.stringify(SPLASH)};
window.__diag={frames:0,mode:'',ribbons:0,dataDrawn:-1,capsOnly:false,isolated:'',hover:'',errors:[],mounted:false};
const ifr=document.createElement('iframe');
ifr.setAttribute('sandbox','allow-scripts');
ifr.src='/confined.html';
ifr.style.cssText='position:absolute;left:0;top:0;width:900px;height:430px;border:0;display:block';
document.body.appendChild(ifr);
let port,rev=0;
const feed=v=>{ try{ port.postMessage({__cu:1,type:'cell',id:'trace:demo',value:v}); }catch(e){} };
window.addEventListener('message',e=>{
  if(e.source!==ifr.contentWindow) return;
  const m=e.data; if(!m||m.__cu!==1||m.type!=='ready') return;
  const ch=new MessageChannel(); port=ch.port1;
  port.onmessage=pe=>{ const pm=pe.data; if(!pm||pm.__cu!==1) return;
    if(pm.type==='call'&&pm.method==='vizDiag'){ const a=pm.args||{}; const D=window.__diag;
      D.frames=a.frames||D.frames; D.mode=a.mode||D.mode; D.ribbons=a.ribbons||D.ribbons;
      if(a.dataDrawn!==undefined)D.dataDrawn=a.dataDrawn; if(a.capsOnly!==undefined)D.capsOnly=a.capsOnly;
      if(a.isolated!==undefined)D.isolated=a.isolated; if(a.hover!==undefined)D.hover=a.hover;
      try{port.postMessage({__cu:1,type:'call-result',id:pm.id,ok:true,value:{}});}catch(_){}}
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
    const page = await browser.newPage({ viewport: { width: 960, height: 480 } });
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

    const readDiag = () => page.evaluate(() => window.__diag);

    // (4) HOVER — sweep the real pointer over the canvas until the confined frame reports a tooltip.
    let hoverText = '';
    outer: for (let y = 20; y < 300 && !hoverText; y += 24) {
      for (let x = 20; x < 880; x += 24) { await page.mouse.move(x, y); const D = await readDiag(); if (D.hover) { hoverText = D.hover; break outer; } }
    }
    ok(!!hoverText && !CAPRE().test(hoverText), `HOVER drove a real from→to tooltip in the confined frame (${JSON.stringify(hoverText)}) with NO swissnum`);
    await sleep(120);
    try { await page.screenshot({ path: path.join(shotDir, 'trace-viz-sankey-tooltip.png') }); console.log('  info - screenshot: trace-viz-sankey-tooltip.png'); } catch {}

    // (5) CLICK-to-isolate — sweep clicks until a node isolates.
    let isoState = '', isoX = 0, isoY = 0;
    outerC: for (let y = 20; y < 300 && !isoState; y += 12) {
      for (let x = 20; x < 880; x += 12) { await page.mouse.click(x, y); const D = await readDiag(); if (D.isolated) { isoState = D.isolated; isoX = x; isoY = y; break outerC; } }
    }
    ok(!!isoState, `CLICK isolated a node's flows in the confined frame (isolated=${isoState})`);
    await sleep(120);
    try { await page.screenshot({ path: path.join(shotDir, 'trace-viz-sankey-isolated.png') }); console.log('  info - screenshot: trace-viz-sankey-isolated.png'); } catch {}
    // restore: clicking the same node again toggles isolation off (robust — the exact node coords we just hit).
    for (let i = 0; i < 4 && (await readDiag()).isolated; i++) { await page.mouse.click(isoX, isoY); await sleep(40); }
    ok(!(await readDiag()).isolated, 'CLICK on the isolated node again restored the full graph (isolation cleared)');

    // (6) "caps only" — the toggle lives in the bar just below the 320px canvas; sweep clicks along it.
    let capsOn = false;
    outerB: for (let y = 328; y < 366 && !capsOn; y += 6) {
      for (let x = 8; x < 220; x += 10) { await page.mouse.click(x, y); const D = await readDiag(); if (D.capsOnly) { capsOn = true; break outerB; } }
    }
    const capsDiag = await readDiag();
    ok(capsOn && capsDiag.dataDrawn === 0, `"caps only" toggle in the real frame hid the DATA ribbons (dataDrawn=${capsDiag.dataDrawn}, capsOnly=${capsDiag.capsOnly})`);
    await page.mouse.move(600, 500); await sleep(160); // pointer off the viz so the shot is the clean authority skeleton
    try { await page.screenshot({ path: path.join(shotDir, 'trace-viz-sankey-caps-only.png') }); console.log('  info - screenshot: trace-viz-sankey-caps-only.png'); } catch {}

    // reset to the full braid for the hero shot: toggle caps back off, drop the hover tooltip.
    for (let i = 0; i < 4 && (await readDiag()).capsOnly; i++) { await page.mouse.click(40, 344); await sleep(40); }
    ok((await readDiag()).dataDrawn > 0, 'toggling "caps only" off in the real frame restored the DATA ribbons (the full braid)');
    await page.mouse.move(600, 500); // move pointer off the viz before the hero shot
    await sleep(300);
    const shot = path.join(shotDir, 'trace-viz-sankey-splash.png');
    try { await page.screenshot({ path: shot }); console.log('  info - screenshot:', shot); } catch {}
    const finalDg = await readDiag();
    ok((finalDg && finalDg.errors.length === 0), `no error surfaced from the confined frame (${finalDg && finalDg.errors.slice(0, 2).join(' | ')})`);
    ok(perr.length === 0, `no page errors (${perr.slice(0, 2).join(' | ')})`);
    const external = reqs.filter(u => u && !u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('about:') && !u.startsWith('blob:'));
    ok(external.length === 0, `no external network egress (${external.length ? external.slice(0, 2).join(', ') : 'all same-origin'})`);
    await page.close();
  } finally { await browser.close(); srv.close(); }

  console.log(`\nscreenshots in ${shotDir}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', (e && e.stack) || e); process.exit(2); });
