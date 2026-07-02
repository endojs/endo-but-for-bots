#!/usr/bin/env node
// trace-viz-provenance.staging.test.cjs — STAGING (real-run) proof of the PROVENANCE / CAUSALITY DAG trace
// viz (public/trace-viz-provenance.js), a Tier-2 (canvas) sibling of the reference trace-viz-3d.js. Mirrors
// trace-viz-island.staging.test.cjs in spirit, but is STANDALONE and viz-focused: the full confined-iframe
// mount path (opaque origin, CSP default-src 'none', owner-gated trace:<sid> cell, real /chat turn) is already
// proven for ANY (ui)=>element on this contract by trace-viz-island.staging.test.cjs — so THIS test drives the
// viz's own RENDERING CORRECTNESS in a REAL headless browser through a FAITHFUL confined-contract `ui` harness
// (real <canvas> via document.createElement, real requestAnimationFrame, real getComputedStyle — the exact
// surface public/confined.html hands a source), with a STUB cell we feed the splash + a growing trace.
//
// Asserts:
//   - source is break-out-valid: <=8000 chars, starts `(ui) =>`, no network/eval primitive.
//   - the SPLASH renders in a real browser without throwing: returns an element, gets a 2d context, and draws
//     actual (non-transparent) pixels; screenshotted.
//   - the SPLASH graph is correct: 2 capability nodes (email-send, contacts), a failed tool present, and —
//     the paradigm's signature — the failed tool has NO consumed edge into the answer (badIntoAnswer === false).
//   - a CONTRAST "poisoned" trace, where a failed tool's token IS reused by the answer, is DETECTED
//     (badIntoAnswer === true) — proving the failed-into-answer detector actually fires, not just always-false.
//   - a GROWING trace fed live over the cell drives incremental builds (steps climb) and the canvas renderer
//     initializes (mode === '2d') — the live-growth path.
//   - thin / empty / truncated / malformed snapshots each render without throwing (defensive degradation).
//   - CAP HYGIENE: feeding a trace whose fields contain a swissnum-shaped token leaves NO such token anywhere
//     in the DOM (labels are canvas-drawn; the view renders names, never a secret).
//   - no uncaught page errors across every scenario.
//
// Run: node trace-viz-provenance.staging.test.cjs   (exits non-zero on failure; SKIPs browser w/o chromium)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A swissnum-shaped token (base32-ish, long) we plant in a trace to prove it never reaches the DOM.
const FAKE_SWISS = '0zabcdefghijklmnopqrstuvwxyz234567abcdefghijklmnop';

(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, 'public/trace-viz-provenance.js')).href);
  const SRC = mod.TRACE_VIZ_PROVENANCE_SOURCE;
  const SPLASH = mod.TRACE_VIZ_PROVENANCE_SPLASH;

  // ── static / break-out contract checks (no browser needed) ──────────────────────────────────────────
  ok(typeof SRC === 'string' && SRC.length <= 8000, `source within the 8000-char break-out cap (${SRC.length} chars)`);
  ok(/^\(ui\)\s*=>/.test(SRC), 'source starts `(ui) =>` (passes break-out (ui)=>element validation)');
  ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|\bimport\s*\(|\beval\s*\(|new Function/.test(SRC), 'source has no network/eval primitive (confinement-safe)');
  ok(!new RegExp(FAKE_SWISS).test(SRC) && !/swissnum|#cap=/.test(SRC), 'source itself carries no swissnum/#cap');
  ok(Array.isArray(mod.TRACE_VIZ_PROVENANCE_CELLS) && mod.TRACE_VIZ_PROVENANCE_CELLS.indexOf('trace:<chatId>') >= 0, 'declares the trace:<chatId> cell (gallery/share read this)');
  // the splash convention: a *_SPLASH export + a sibling .splash.json that MATCH.
  const splashJsonPath = path.join(__dirname, 'public/trace-viz-provenance.splash.json');
  let splashJson = null; try { splashJson = JSON.parse(fs.readFileSync(splashJsonPath, 'utf8')); } catch { /* */ }
  ok(splashJson && JSON.stringify(splashJson) === JSON.stringify(SPLASH), 'sibling trace-viz-provenance.splash.json exists and equals the *_SPLASH export (splash convention)');

  // ── browser half ────────────────────────────────────────────────────────────────────────────────────
  let chromium = null;
  try { ({ chromium } = require(process.env.PLAYWRIGHT_CORE || '/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - browser checks (playwright-core unavailable)'); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }

  const browser = await chromium.launch({
    executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
    env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' },
  });
  const shotDir = process.env.TRACE_VIZ_SHOTS || os.tmpdir();
  const errs = [];
  try {
    const page = await browser.newPage({ viewport: { width: 720, height: 420 } });
    page.on('pageerror', e => errs.push(String(e && e.message || e)));

    await page.setContent('<!doctype html><html><head><meta charset="utf-8"><style>:root{--acc:#7c5cff;--acc2:#39d3ff;--fg:#e9e9f2;--trace-bad:#ff7d7d}body{margin:0;background:#0d0d18}</style></head><body></body></html>', { waitUntil: 'load' });

    // The FAITHFUL confined-contract `ui` harness (mirrors public/confined.html's create/grain/local/props/call).
    // Mounts the source, wires an optional stub cell grain, and exposes diag + a live feed on window.
    await page.evaluate((src) => {
      const mkgrain = (init) => { let v = init; const subs = new Set(); return { get: () => v, set: x => { v = x; [...subs].forEach(f => { try { f(x); } catch (e) {} }); }, subscribe: f => { subs.add(f); if (v !== undefined) { try { f(v); } catch (e) {} } return () => subs.delete(f); } }; };
      const mkui = (props) => {
        const cell = mkgrain(undefined);
        const create = (tag) => {
          const el = document.createElement(tag || 'div'); const w = { el };
          w.style = o => { if (o && typeof o === 'object') for (const k in o) { try { el.style[k] = o[k]; } catch (e) {} } return w; };
          w.text = t => { el.textContent = String(t); return w; };
          w.attr = (k, val) => { try { el.setAttribute(k, val); } catch (e) {} return w; };
          w.class = () => w; w.follow = () => w;
          w.push = c => { try { el.appendChild(c && c.el ? c.el : c); } catch (e) {} return w; };
          w.on = (ev, fn) => { try { el.addEventListener(ev, fn); } catch (e) {} return w; };
          return w;
        };
        const grain = id => (props && id === props.cell) ? cell : mkgrain(undefined);
        const ui = { create, h: create, island: create, use: create, grain, local: mkgrain,
          call: (n, a) => { if (n === 'vizDiag') window.__diag = a; return Promise.resolve({}); }, props: props || {}, kit: [] };
        return { ui, cell };
      };
      window.__mount = (props) => {
        document.body.innerHTML = ''; window.__diag = undefined; window.__threw = '';
        const host = document.createElement('div'); host.id = 'host'; host.style.width = '640px'; host.style.height = '340px';
        document.body.appendChild(host);
        const { ui, cell } = mkui(props); window.__cell = cell;
        let fn, el;
        try { fn = new Function('return (' + src + '\n)')(); } catch (e) { window.__threw = 'parse: ' + (e && e.message); return false; }
        try { el = fn(ui); } catch (e) { window.__threw = 'build: ' + (e && e.message); return false; }
        if (!(el && el.el)) { window.__threw = 'no element'; return false; }
        host.appendChild(el.el); window.__root = el.el; return true;
      };
      window.__feed = v => { try { window.__cell.set(v); } catch (e) { window.__threw = 'feed: ' + (e && e.message); } };
      // count non-transparent pixels on the first canvas → proof the 2d renderer actually drew.
      window.__pixels = () => { try { const c = document.querySelector('#host canvas'); if (!c) return -1; const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++; return n; } catch (e) { return -2; } };
    }, SRC);

    // ── 1. SPLASH renders in a real browser: element + 2d context + drawn pixels ─────────────────────────
    const mounted = await page.evaluate(sp => window.__mount({ splash: sp }), SPLASH);
    ok(mounted === true, 'the splash mounts through the confined `ui` contract without throwing (returns an element)');
    await sleep(600); // let requestAnimationFrame run several frames (fit → ctx('2d') → pos → draw)
    const px = await page.evaluate(() => window.__pixels());
    ok(px > 200, `the splash drew real content on a REAL <canvas> 2d context (${px} non-transparent pixels) — canvas render proof`);
    const dg = await page.evaluate(() => window.__diag || {});
    ok(dg.steps === 6 && dg.caps === 2, `the splash graph has the 6 steps + 2 capability nodes (email-send, contacts) [caps=${dg.caps}]`);
    ok(dg.fails === 1, `the splash has the one failed tool (council.gov 503) [fails=${dg.fails}]`);
    ok(dg.badIntoAnswer === false, 'SIGNATURE: the FAILED tool has NO consumed edge into the answer (badIntoAnswer === false)');
    try { await page.screenshot({ path: path.join(shotDir, 'trace-viz-provenance-splash.png') }); console.log('  info - screenshot:', path.join(shotDir, 'trace-viz-provenance-splash.png')); } catch {}

    // ── 2. CONTRAST: a failed tool whose token IS reused by the answer → the detector FIRES ──────────────
    const poisoned = { status: 'done', rev: 3, steps: [
      { name: 'web.fetch', ok: false, call: 'get docket-99881', result: 'partial: docket-99881 body truncated' },
      { name: 'answer', ok: true, call: 'summarize docket-99881', result: 'done' },
    ] };
    const dgP = await page.evaluate(v => { window.__mount({ splash: v }); return window.__diag || {}; }, poisoned);
    ok(dgP.badIntoAnswer === true, 'CONTRAST: when a failed tool result IS consumed by the answer, the detector fires (badIntoAnswer === true)');

    // ── 3. GROWING trace fed LIVE over the stub cell → incremental builds + the 2d renderer initializes ──
    await page.evaluate(() => window.__mount({ cell: 'trace:grow-1' }));
    await sleep(150);
    await page.evaluate(() => window.__feed({ status: 'running', rev: 1, steps: [{ name: 'plan', status: 'running' }] }));
    await sleep(200);
    const g1 = await page.evaluate(() => window.__diag || {});
    await page.evaluate(() => window.__feed({ status: 'running', rev: 2, steps: [
      { name: 'plan', ok: true, detail: 'x' }, { name: 'web.search', ok: true, result: 'hit example.com/doc-4521' }] }));
    await sleep(200);
    await page.evaluate(() => window.__feed({ status: 'done', rev: 3, steps: [
      { name: 'plan', ok: true }, { name: 'web.search', ok: true, result: 'hit example.com/doc-4521' },
      { name: 'answer', ok: true, call: 'use doc-4521', granted: ['notes'] }] }));
    await sleep(250);
    const g3 = await page.evaluate(() => window.__diag || {});
    ok(g1.steps === 1 && g3.steps === 3, `a growing trace drives incremental builds over the cell (steps ${g1.steps} → ${g3.steps})`);
    ok(g3.mode === '2d', `the canvas 2d renderer initialized during live growth (mode="${g3.mode}")`);
    ok(g3.badIntoAnswer === false, 'the grown trace keeps a sound lineage (no failed-into-answer)');

    // ── 4. defensive degradation: thin / empty / truncated / malformed each render without throwing ──────
    const cases = {
      empty: {},
      thin: { status: 'running', rev: 1, steps: [{ name: 'plan', status: 'running' }] },
      truncated: { status: 'done', rev: 2, truncated: true, steps: [{ name: 'a', ok: true, result: 'x' }, { name: 'answer', ok: true }] },
      malformed: { steps: [null, { name: 123 }, {}, { name: 'answer', ok: true, call: 'q' }], nodes: [null, { key: 'z', parent: 'nope' }] },
    };
    for (const [label, val] of Object.entries(cases)) {
      const r = await page.evaluate(v => { const okm = window.__mount({ splash: v }); return { okm, threw: window.__threw }; }, val);
      ok(r.okm === true && !r.threw, `defensive: "${label}" snapshot renders without throwing (${r.threw || 'clean'})`);
    }

    // ── 5. CAP HYGIENE: a swissnum-shaped token in the trace never lands in the DOM ─────────────────────
    const withSwiss = { status: 'done', rev: 4, steps: [
      { name: 'grant', ok: true, result: 'issued cap ' + FAKE_SWISS, granted: ['email-send'] },
      { name: 'answer', ok: true, call: 'send using ' + FAKE_SWISS },
    ] };
    await page.evaluate((v) => window.__mount({ splash: v }), withSwiss);
    await sleep(300);
    const domHasSwiss = await page.evaluate(sw => document.documentElement.outerHTML.indexOf(sw) >= 0, FAKE_SWISS);
    ok(domHasSwiss === false, 'cap hygiene: a swissnum-shaped token in the trace is NEVER placed in the DOM (canvas-drawn only, names not secrets)');

    ok(errs.length === 0, `no uncaught page errors across all scenarios (${errs.slice(0, 2).join(' | ') || 'none'})`);
    await page.close();
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); process.exit(2); });
