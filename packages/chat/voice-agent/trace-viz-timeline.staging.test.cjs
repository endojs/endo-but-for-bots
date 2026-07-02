#!/usr/bin/env node
// trace-viz-timeline.staging.test.cjs — STAGING (real-run) proof of the "Critical Path" swimlanes trace-viz
// (public/trace-viz-timeline.js), a Tier-2 (sandboxed-iframe, WebGL) trace-viz source on the SAME contract as
// public/trace-viz-3d.js. Mirrors trace-viz-island.staging.test.cjs but focuses on THIS source's semantics.
//
// Two layers (the second SKIPs cleanly without chromium):
//
//   NODE (in-process, deterministic — the correctness meat): evaluate the committed SOURCE against a faithful
//     recording stub of confined.html's `ui` (create()/grain()/call() + a recording canvas-2d context + a
//     one-shot requestAnimationFrame), feed it the splash + a growing trace + thin/empty/truncated snapshots,
//     and assert: it renders without throwing; it COMPUTES + HIGHLIGHTS a critical path (the lit spans are the
//     orchestrator + the heaviest child lane, drawn bright while slack lanes dim, threaded by a gold ribbon);
//     it NEVER emits a swissnum (a #cap-shaped token injected into a step name is scrubbed everywhere it could
//     surface). It also render-checks the source through render-check-child.mjs (the authoring-loop smoke).
//
//   BROWSER (headless chromium + swiftshader so WebGL initializes without a GPU): mount the SOURCE in the REAL
//     Tier-2 runtime (public/confined.html — opaque origin, sandbox=allow-scripts, CSP default-src 'none'),
//     broker the trace:<sid> cell IN over a private MessagePort exactly as the parent app does, and read the
//     component's `vizDiag` host-echo back over the port: WebGL initialized in the sandbox, agents/critical-path
//     computed there, bottleneck named (scrubbed). Screenshot the splash. Assert NO external network egress.
//
// Run: node trace-viz-timeline.staging.test.cjs   (exits non-zero on failure; SKIPs browser w/o chromium)

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DIR = __dirname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvz-timeline-'));

// ── load the committed source + splash ──────────────────────────────────────────────────────────────
const loadMod = async () => import(require('node:url').pathToFileURL(path.join(DIR, 'public/trace-viz-timeline.js')).href);

// ── a faithful recording stub of confined.html's `ui` (kind 'ui'): create/grain/local/call/props +
//    a recording canvas-2d context. Mirrors public/confined.html's create()/apiGrain()/call(). ────────
// opts.motion === true → prefers-reduced-motion:reduce is FALSE (the splash sweep runs); default is
// reduced-motion so span geometry is full + stable (widths don't change frame-to-frame, which keeps the
// hover hit-test + pan/zoom assertions deterministic — the sweep is proven in its own dedicated test).
const makeRecUI = (cellValue, opts) => {
  const diag = [];
  const raf = [];
  const handlers = {}; // event -> [fn], recorded from the overlay canvas's .on(...) (mirrors confined.html)
  global.requestAnimationFrame = fn => { raf.push(fn); return raf.length; };
  global.devicePixelRatio = 1;
  global.matchMedia = () => ({ matches: !(opts && opts.motion) }); // reduced-motion unless opts.motion
  let ctx = null;
  const mkCtx = () => {
    const calls = []; const st = { globalAlpha: 1, fillStyle: '', strokeStyle: '' };
    const rec = (n, a) => calls.push({ n, a, alpha: st.globalAlpha, stroke: st.strokeStyle, fill: st.fillStyle });
    return {
      calls,
      get globalAlpha() { return st.globalAlpha; }, set globalAlpha(v) { st.globalAlpha = v; },
      get fillStyle() { return st.fillStyle; }, set fillStyle(v) { st.fillStyle = v; },
      get strokeStyle() { return st.strokeStyle; }, set strokeStyle(v) { st.strokeStyle = v; },
      set lineWidth(v) {}, set font(v) {}, set textBaseline(v) {}, set textAlign(v) {}, set lineJoin(v) {},
      clearRect() {}, fillRect(...a) { rec('fillRect', a); }, strokeRect(...a) { rec('strokeRect', a); },
      beginPath() {}, moveTo() {}, lineTo() {}, stroke() { rec('stroke', []); }, fill() { rec('fill', []); }, arcTo() {}, closePath() {}, setLineDash() {},
      measureText(t) { return { width: String(t).length * 6 }; }, fillText(t) { rec('fillText', [t]); },
    };
  };
  const canvas = { width: 0, height: 0, clientWidth: 900, clientHeight: 300, getContext(k) { if (k === '2d') { ctx = ctx || mkCtx(); return ctx; } return null; } };
  const create = tag => { const el = tag === 'canvas' ? canvas : {}; const w = { el, style: () => w, push: () => w, on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); return w; } }; return w; };
  const grain = () => ({ subscribe(fn) { if (cellValue !== undefined) { try { fn(cellValue); } catch (e) {} } return () => {}; }, get: () => cellValue, set() {} });
  const ui = { create, grain, local: grain, call: (m, a) => { if (m === 'vizDiag') diag.push(a); return Promise.resolve({}); }, props: { cell: cellValue !== undefined ? 'trace:x' : '' } };
  const fire = (ev, arg) => { (handlers[ev] || []).forEach(fn => { try { fn(arg); } catch (e) {} }); };
  return { ui, diag, fire, tick: () => { raf.splice(0).forEach(fn => fn(16)); }, ctx: () => ctx, clear: () => { if (ctx) ctx.calls.length = 0; } };
};

// mount the SOURCE against the recording stub; the returned handle lets a test drive interactions
// (fire pointer events), step frames (tick), and read what got drawn (spans/texts/strokes).
const mount = (SRC, cellValue, opts) => {
  const rec = makeRecUI(cellValue, opts);
  const fn = eval(`(${SRC})`); // the confined.html mount() path also evaluates the source expression
  const wrap = fn(rec.ui);
  const spans = () => { const c = rec.ctx(); if (!c) return []; return c.calls.filter(x => x.n === 'fillRect' && (Math.abs(x.alpha - 0.95) < 0.01 || Math.abs(x.alpha - 0.4) < 0.01)).map(x => ({ x: x.a[0], y: x.a[1], w: x.a[2], h: x.a[3], alpha: x.alpha })); };
  const texts = () => { const c = rec.ctx(); return c ? c.calls.filter(x => x.n === 'fillText').map(x => String(x.a[0])).join(' | ') : ''; };
  const strokeColors = () => { const c = rec.ctx(); return c ? c.calls.filter(x => x.n === 'stroke').map(x => x.stroke) : []; };
  return { wrap: !!(wrap && wrap.el), mode: rec.ctx() ? '2d' : 'none', ...rec, spans, texts, strokeColors };
};

// evaluate + render ONE snapshot; returns an analysis of what got drawn (never throws out).
const renderOnce = (SRC, cellValue) => {
  const h = mount(SRC, cellValue);
  h.tick();
  const c = h.ctx();
  const rects = c ? c.calls.filter(x => x.n === 'fillRect') : [];
  const bright = rects.filter(x => Math.abs(x.alpha - 0.95) < 0.01).length;
  const dim = rects.filter(x => Math.abs(x.alpha - 0.4) < 0.01).length;
  const gold = !!c && c.calls.some(x => x.n === 'stroke' && /227,\s*179,\s*65/.test(x.stroke));
  const texts = c ? c.calls.filter(x => x.n === 'fillText').map(x => String(x.a[0])).join(' | ') : '';
  return { wrap: h.wrap, mode: c ? '2d' : 'none', bright, dim, gold, texts, diag: h.diag };
};

const SWISS = '#SwiSs1AbCdEfGhIjKlMnOpQrStUvWxYz0123';
const SWISS_RE = /#?[A-Za-z0-9_-]{22,}/;

(async () => {
  const mod = await loadMod();
  const SRC = mod.TRACE_VIZ_TIMELINE_SOURCE;
  const SPLASH = mod.TRACE_VIZ_TIMELINE_SPLASH;

  // ── contract + hygiene of the committed source itself ──────────────────────────────────────────────
  ok(SRC.length <= 16000, `source is within the (raised) break-out cap (${SRC.length} ≤ 16000 chars)`);
  ok(/^\(ui\)=>/.test(SRC), 'source is a `(ui) => element` (passes break-out validation)');
  ok(/TRACE-VIZ/.test(SRC) && /FORK FREELY/.test(SRC) && /ui\.grain\(ui\.props\.cell\)/.test(SRC), 'the source documents the cell contract + the riff invitation (what the edit-chat shows)');
  ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|\bimport\s*\(/.test(SRC), 'no network primitive in the source (fetch/XHR/WebSocket/dynamic import)');
  ok(!/#[A-Za-z0-9_-]{20,}/.test(SRC), 'the source text carries no #cap-shaped token (long WebGL identifiers are not caps)');
  ok(Array.isArray(mod.TRACE_VIZ_TIMELINE_CELLS) && mod.TRACE_VIZ_TIMELINE_CELLS.indexOf('trace:<chatId>') >= 0, 'it declares the trace:<chatId> cell (gallery + share flow read this)');
  ok(SPLASH && Array.isArray(SPLASH.steps) && SPLASH.steps.length === 8, 'a SPLASH export ships the canned fan-out trace (orchestrator + 3 specialists)');
  const splashJson = path.join(DIR, 'public/trace-viz-timeline.splash.json');
  ok(fs.existsSync(splashJson) && JSON.parse(fs.readFileSync(splashJson, 'utf8')).steps.length === 8, 'sibling <name>.splash.json exists (the splash convention, for tooling/the gallery)');

  // ── render-check smoke (the authoring loop): would it mount? ───────────────────────────────────────
  const rc = await new Promise(res => {
    const cp = require('node:child_process').spawn(process.execPath, [path.join(DIR, 'render-check-child.mjs'), 'ui'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; cp.stdout.on('data', d => { out += d; }); cp.on('close', () => { try { res(JSON.parse(out.trim())); } catch { res({ ok: false, error: out }); } });
    cp.stdin.end(SRC);
  });
  ok(rc.ok === true, `render-check passes — the component mounts cleanly in the Node stub (no getContext/RAF/DOM): ${rc.error || 'ok'}`);

  // ── NODE render: the SPLASH computes + highlights the critical path ────────────────────────────────
  const sp = renderOnce(SRC, undefined); // undefined cell → the component falls back to its inline splash
  ok(sp.wrap && sp.mode === '2d', 'the splash renders (returns an element; canvas-2d path exercised) without throwing');
  ok(sp.bright === 4 && sp.dim === 4, `critical path COMPUTED: 4 lit spans (orchestrator scope+synthesize + the DevTools lane) vs 4 dimmed slack spans (Jaeger+Zipkin) — got bright=${sp.bright}, dim=${sp.dim}`);
  ok(sp.gold, 'the critical path is HIGHLIGHTED as a gold ribbon threading the lit spans lane→lane');
  ok(/3 agents/.test(sp.texts) && /bottleneck: web/.test(sp.texts) && /speedup/.test(sp.texts), `the metrics chip names the parallelism + the bottleneck ("${(sp.texts.match(/\d agents[^|]*/) || [''])[0].trim()}")`);
  ok(!SWISS_RE.test(sp.texts), 'the splash emits no swissnum');
  const spDiag = sp.diag[sp.diag.length - 1];
  ok(spDiag && spDiag.ag === 3 && spDiag.cp === 4, `vizDiag host-echo reports the model (agents=${spDiag && spDiag.ag}, critical-span-count=${spDiag && spDiag.cp})`);

  // ── NODE render: the SPLASH fed as a real cell value (as the parent brokers it) ────────────────────
  const spc = renderOnce(SRC, SPLASH);
  ok(spc.wrap && spc.bright === 4 && spc.dim === 4 && spc.gold, 'the SAME splash fed over the cell (brokered snapshot) lights the same critical path');

  // ── NODE render: degradation ladder — empty / thin / truncated ─────────────────────────────────────
  const empty = renderOnce(SRC, { status: 'done', steps: [] });
  ok(empty.wrap && !empty.gold && !SWISS_RE.test(empty.texts), 'empty trace renders (chip only, no ribbon) — no throw, no clutter');
  const thin = renderOnce(SRC, { status: 'running', steps: [{ name: 'web', agent: 'orchestrator', status: 'running', t0: 0, t1: 1 }] });
  ok(thin.wrap && thin.bright >= 1, 'a thin single-lane trace collapses to a one-lane waterfall (still useful)');
  const trunc = renderOnce(SRC, { status: 'done', truncated: true, steps: [{ name: 'web', agent: 'orchestrator', ok: true, t0: 0, t1: 1 }] });
  ok(trunc.wrap && /\+truncated/.test(trunc.texts), 'a truncated trace renders + is badged "+truncated" (never implies completeness)');

  // ── NODE render: a GROWING trace with an injected swissnum + a failing span ────────────────────────
  const growing = [
    { status: 'running', steps: [{ name: 'scope', agent: 'orchestrator', ok: true, t0: 0, t1: 0.2 }] },
    { status: 'running', steps: [{ name: 'scope', agent: 'orchestrator', ok: true, t0: 0, t1: 0.2 }, { name: `web ${SWISS}`, agent: 'Alpha', status: 'running', t0: 0.3, t1: 4.5 }, { name: 'read', agent: 'Beta', ok: false, t0: 0.3, t1: 1.0 }] },
    { status: 'done', steps: [{ name: 'scope', agent: 'orchestrator', ok: true, t0: 0, t1: 0.2 }, { name: `web ${SWISS}`, agent: 'Alpha', ok: true, t0: 0.3, t1: 4.5 }, { name: 'read', agent: 'Beta', ok: false, t0: 0.3, t1: 1.0 }, { name: 'synthesize', agent: 'orchestrator', ok: true, t0: 4.6, t1: 5.2 }] },
  ];
  let grew = true, noSwiss = true, litBottleneck = false;
  for (const snap of growing) { const r = renderOnce(SRC, snap); if (!r.wrap) grew = false; if (SWISS_RE.test(r.texts)) noSwiss = false; const d = r.diag[r.diag.length - 1]; if (d && d.ag === 2 && d.cp === 3) litBottleneck = true; }
  ok(grew, 'the growing trace renders at every step (start → fan-out → join) without throwing');
  ok(litBottleneck, 'as the trace grows the critical path re-computes (2 agents, the heavy "Alpha" lane on the path)');
  ok(noSwiss, 'a #cap-shaped token injected into a step name is SCRUBBED everywhere it could surface (labels + bottleneck chip)');

  // ── RESTORED INTERACTION LAYER (the features dropped to fit under 8000, now back under 16000) ───────

  // (1) HOVER TOOLTIP — hovering a span draws a cap-SCRUBBED tooltip (agent/step name, kind, ok, duration).
  const tipSnap = { status: 'done', steps: [
    { name: 'scope', agent: 'orchestrator', ok: true, t0: 0, t1: 0.2 },
    { name: `web ${SWISS}`, agent: 'Alpha', ok: true, t0: 0.3, t1: 4.5 }, // the widest span (the one we hover)
    { name: 'read', agent: 'Beta', ok: false, t0: 0.3, t1: 1.0 },
    { name: 'synthesize', agent: 'orchestrator', ok: true, t0: 4.6, t1: 5.2 },
  ] };
  {
    const h = mount(SRC, tipSnap); // default = reduced-motion → full, stable span widths for a deterministic hit-test
    h.tick();
    const widest = h.spans().reduce((a, b) => (b.w > a.w ? b : a)); // the Alpha "web" span
    h.clear();
    h.fire('pointermove', { x: widest.x + widest.w / 2, y: widest.y + widest.h / 2 }); // hover its center (no prior pointerdown ⇒ hit-test)
    h.tick();
    const tip = h.texts();
    ok(/Alpha/.test(tip), `hovering a span shows a tooltip naming the agent lane ("Alpha") — got: ${(tip.match(/Alpha[^|]*/) || [''])[0].trim()}`);
    ok(/web/.test(tip) && /ok/.test(tip) && /4\.2s/.test(tip), 'the tooltip carries the step name + ok/fail + duration (web · ✓ ok · 4.2s)');
    ok(!SWISS_RE.test(tip), 'the tooltip is cap-SCRUBBED: a #cap-shaped token planted in the hovered span name never reaches the tooltip');
  }

  // (2) ZOOM / SCRUB / PAN — a drag (DevTools-style: horizontal = pan, vertical = zoom) moves the visible window.
  {
    const h = mount(SRC, SPLASH);
    h.tick();
    const s1 = h.spans().map(r => r.x);
    const spread1 = Math.max(...s1) - Math.min(...s1);
    h.fire('pointerdown', { x: 450, y: 150 });
    h.fire('pointermove', { x: 250, y: 60 }); // drag left+up → pan left, zoom in
    h.clear();
    h.tick();
    const s2 = h.spans().map(r => r.x);
    const spread2 = Math.max(...s2) - Math.min(...s2);
    ok(spread2 > spread1 * 1.2, `zoom changed the time scale: span spread widened ${spread1.toFixed(0)}px → ${spread2.toFixed(0)}px`);
    ok(Math.abs(Math.min(...s2) - Math.min(...s1)) > 2, 'pan changed the visible window (the left-most span moved)');
    // a bounded release restores nothing catastrophic — after pointerup the view is stable, still renders
    h.fire('pointerup', {});
    h.clear(); h.tick();
    ok(h.spans().length === 8, 'after pointerup the (zoomed) view keeps rendering all spans — interaction stays bounded/defensive');
  }

  // (3) FORK/JOIN CONNECTORS for the SLACK lanes (thin grey connectors, distinct from the gold ribbon).
  {
    const h = mount(SRC, SPLASH); // slack lanes = Jaeger + Zipkin (DevTools is the critical lane → rides the ribbon)
    h.tick();
    const cons = h.strokeColors().some(c => /139,\s*148,\s*163/.test(c || ''));
    ok(cons, 'thin fork/join connectors render for the dimmed (slack) lanes so spawn/return is legible everywhere');
    ok(h.strokeColors().some(c => /227,\s*179,\s*65/.test(c || '')), 'the gold critical-path ribbon still threads the critical lane (both connector styles coexist)');
  }

  // (4) IN-SPAN TEXT LABELS — short step labels are drawn inside spans wide enough to hold them.
  {
    const lab = renderOnce(SRC, SPLASH).texts;
    ok(/synthesize/.test(lab), 'in-span labels draw the step name inside wide spans ("synthesize" is a span label, not a lane label)');
  }

  // (5) SPLASH SWEEP + prefers-reduced-motion — the playhead sweeps under motion, and is SUPPRESSED under reduce.
  {
    const moving = mount(SRC, SPLASH, { motion: true }); // prefers-reduced-motion:reduce = false
    moving.tick(); // one frame → sweep is mid-flight → a playhead line is drawn
    ok(moving.strokeColors().some(c => /227,\s*179,\s*65,\s*\.70/.test(c || '')), 'splash sweep animation: a playhead line sweeps across while the trace reveals (motion allowed)');
    const still = mount(SRC, SPLASH); // default reduced-motion
    still.tick();
    ok(!still.strokeColors().some(c => /227,\s*179,\s*65,\s*\.70/.test(c || '')), 'prefers-reduced-motion:reduce SUPPRESSES the sweep playhead (no animation)');
  }

  // ── BROWSER: mount in the REAL Tier-2 runtime (public/confined.html) ───────────────────────────────
  let chromium = null;
  try { ({ chromium } = require(process.env.PLAYWRIGHT_CORE || '/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - browser checks (playwright-core unavailable)'); console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(fail ? 1 : 0); }

  // tiny static server for public/ + a harness page that drives confined.html's mount handshake.
  const PUB = path.join(DIR, 'public');
  const HARNESS = `<!doctype html><meta charset=utf-8><body><script>
    window.__diag=[];window.__errs=[];window.__mounted=false;window.__feedIdx=0;
    var ifr=document.createElement('iframe');ifr.setAttribute('sandbox','allow-scripts');ifr.src='/confined.html';
    ifr.style.cssText='width:900px;height:320px;border:0;background:#0d1117';document.body.appendChild(ifr);var ch;
    function feed(v){ if(ch) ch.port1.postMessage({__cu:1,type:'cell',id:'trace:x',value:v}); }
    window.__feed=function(v){ feed(v); };
    window.addEventListener('message',function(e){ if(e.source!==ifr.contentWindow)return; var m=e.data; if(!m||m.__cu!==1)return;
      if(m.type==='ready'){ ch=new MessageChannel();
        ch.port1.onmessage=function(pe){ var pm=pe.data; if(!pm||pm.__cu!==1)return;
          if(pm.type==='subscribe'){ feed(window.__FEEDS[0]); }
          else if(pm.type==='call'&&pm.method==='vizDiag'){ window.__diag.push(pm.args); ch.port1.postMessage({__cu:1,type:'call-result',id:pm.id,ok:true,value:{}}); }
          else if(pm.type==='error'){ window.__errs.push(pm.error); }
          else if(pm.type==='height'){ window.__mounted=true; } };
        ifr.contentWindow.postMessage({__cu:1,type:'mount',source:window.__SRC,props:{cell:'trace:x'},theme:{'--acc':'#7c5cff'}},'*',[ch.port2]); }
    });
  </script></body>`;
  const srv = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u === '/t-harness.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HARNESS); return; }
    const fp = path.join(PUB, path.normalize(u).replace(/^(\.\.[/\\])+/, ''));
    if (fp.startsWith(PUB) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      const ext = path.extname(fp); const ct = ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : ext === '.json' ? 'application/json' : 'text/plain';
      res.writeHead(200, { 'content-type': `${ct}; charset=utf-8` }); res.end(fs.readFileSync(fp)); return;
    }
    res.writeHead(404); res.end('nope');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const PORT = srv.address().port; const BASE = `http://127.0.0.1:${PORT}`;

  const browser = await chromium.launch({
    executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
    env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' },
  });
  const shotDir = process.env.TRACE_VIZ_SHOTS || tmp;
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 380 } });
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    const reqs = []; page.on('request', r => { try { reqs.push(r.url()); } catch {} });
    await page.addInitScript(({ src, feeds }) => { window.__SRC = src; window.__FEEDS = feeds; }, { src: SRC, feeds: [SPLASH] });
    await page.goto(`${BASE}/t-harness.html`, { waitUntil: 'load' });

    // confirm the iframe is the opaque Tier-2 jail loading confined.html
    const sb = await page.evaluate(() => { const f = document.querySelector('iframe'); return { sandbox: f && f.getAttribute('sandbox'), src: f && f.getAttribute('src') }; });
    ok(sb.sandbox === 'allow-scripts' && /confined\.html/.test(sb.src || ''), 'mounted in the REAL Tier-2 runtime: opaque iframe (sandbox=allow-scripts, NO allow-same-origin) loading /confined.html');

    // wait for the mount handshake + the first vizDiag echo back over the private MessagePort
    let d0 = null;
    for (let i = 0; i < 60 && !d0; i++) { const st = await page.evaluate(() => ({ diag: window.__diag, errs: window.__errs, mounted: window.__mounted })); if (st.errs.length) { ok(false, `confined frame reported an error: ${st.errs[0]}`); break; } if (st.diag.length) d0 = st.diag[st.diag.length - 1]; else await sleep(200); }
    ok(!!d0, 'the source mounted in the sandbox + the brokered trace:<sid> cell fed it (a vizDiag echo came back over the MessagePort)');
    if (d0 && d0.md === 'gl') ok(true, 'WebGL INITIALIZED inside the opaque-origin sandbox (ANGLE instanced quads; md === "gl")');
    else ok(!!d0 && d0.md === '2d', `WebGL unavailable headless — fell back to canvas2d in-sandbox (md="${d0 && d0.md}"); real-GPU WebGL is a headed check`);
    ok(!!d0 && d0.ag === 3 && d0.cp === 4, `the critical path was computed INSIDE the sandbox (agents=${d0 && d0.ag}, lit spans=${d0 && d0.cp})`);
    ok(!!d0 && d0.bn === 'web' && !SWISS_RE.test(d0.bn || ''), `the bottleneck is named (scrubbed) — "${d0 && d0.bn}"`);

    // screenshot the splash (let the sweep settle first)
    await sleep(900);
    let shot = '';
    try { shot = path.join(shotDir, 'trace-viz-timeline-splash.png'); await page.screenshot({ path: shot }); console.log('  info - screenshot:', shot); } catch {}
    ok(!!shot && fs.existsSync(shot) && fs.statSync(shot).size > 1000, 'screenshotted the splash card (non-trivial PNG)');

    // drive the RESTORED interactions IN THE REAL FRAME + screenshot the tooltip and a zoomed state.
    // The iframe sits at the body's top-left (~8px margin); a span center is ~(8+455, 8+150).
    const OX = 8, OY = 8;
    try {
      await page.mouse.move(OX + 300, OY + 120); await sleep(40);
      await page.mouse.move(OX + 450, OY + 250); // hover the wide DevTools "web" span (bottom lane) → tooltip
      await sleep(120);
      const tshot = path.join(shotDir, 'trace-viz-timeline-tooltip.png');
      await page.screenshot({ path: tshot }); console.log('  info - screenshot:', tshot);
      ok(fs.existsSync(tshot) && fs.statSync(tshot).size > 1000, 'screenshotted the hover TOOLTIP over a span (non-trivial PNG)');
    } catch (e) { ok(false, `tooltip screenshot failed: ${e && e.message}`); }
    try {
      await page.mouse.move(OX + 450, OY + 160); await page.mouse.down();
      await page.mouse.move(OX + 250, OY + 60, { steps: 6 }); // drag left+up → pan + zoom in
      await sleep(120);
      const zshot = path.join(shotDir, 'trace-viz-timeline-zoomed.png');
      await page.screenshot({ path: zshot }); console.log('  info - screenshot:', zshot);
      await page.mouse.up();
      ok(fs.existsSync(zshot) && fs.statSync(zshot).size > 1000, 'screenshotted a ZOOMED/panned state (drag-to-zoom in the real frame; non-trivial PNG)');
    } catch (e) { ok(false, `zoom screenshot failed: ${e && e.message}`); }

    // feed a swissnum-tainted growing snapshot; assert the sandbox re-computes + never echoes the swissnum
    await page.evaluate(sw => window.__feed({ status: 'done', steps: [{ name: 'scope', agent: 'orchestrator', ok: true, t0: 0, t1: 0.2 }, { name: `web ${sw}`, agent: 'Alpha', ok: true, t0: 0.3, t1: 4.5 }, { name: 'read', agent: 'Beta', ok: false, t0: 0.3, t1: 1.0 }, { name: 'synthesize', agent: 'orchestrator', ok: true, t0: 4.6, t1: 5.2 }] }), SWISS);
    let d1 = null;
    for (let i = 0; i < 40 && !d1; i++) { const diag = await page.evaluate(() => window.__diag); const last = diag[diag.length - 1]; if (last && last.ag === 2) d1 = last; else await sleep(150); }
    ok(!!d1 && d1.ag === 2 && d1.cp === 3, 're-fed a growing trace: the sandbox re-computed the critical path live over the cell');
    ok(!!d1 && !SWISS_RE.test(JSON.stringify(d1)), 'the injected swissnum is NEVER echoed out of the sandbox (scrubbed in the diag payload too)');

    // no external network egress from the whole page (confined CSP + observed requests)
    const external = reqs.filter(u => u && !u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('about:') && !u.startsWith('blob:'));
    ok(external.length === 0, `no external network egress (${external.length ? external.slice(0, 2).join(', ') : 'all requests same-origin'})`);
    ok(errs.length === 0, `no page errors on the Tier-2 path (${errs.slice(0, 2).join(' | ')})`);
    await page.close();
  } finally { await browser.close(); srv.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', (e && e.stack) || e); cleanup(); process.exit(2); });

function cleanup() { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
