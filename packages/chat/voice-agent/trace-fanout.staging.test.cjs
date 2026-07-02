#!/usr/bin/env node
// trace-fanout.staging.test.cjs — a STAGING (real-run) guard for the per-message SVG trace geometry's
// research fan-out. Drives the REAL traceGeometry (exposed as window.__traceGeometry only under ?tracetest=1)
// with a synthetic trace and asserts the behaviour dan asked for:
//   - a node WITH children (research) is collapsed by default (its sub-steps are NOT in the DOM),
//   - hovering it FANS OUT its children as their own LABELED rows arranged VERTICALLY (distinct, increasing
//     y — not the old horizontal unlabeled dots), each indented and individually inspectable,
//   - the fan-out is RECURSIVE (hovering a child reveals its child),
//   - tapping a leaf opens its call/result modal,
//   - the trace renders names/labels only (no capability link / swissnum).
//
// Run: node trace-fanout.staging.test.cjs   (exits non-zero on any failure)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 20000 + (process.pid % 20000); // T-TEST-2: PID-derived port (unique per node --test child); never a fixed 879x
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-staging-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

const STEPS = [
  { name: 'searchNotes', ok: true, call: 'roborock', result: 'a note' },
  { name: 'research', ok: true, detail: 'plan → search → distill', children: [
    { name: '❓ what vacuum models', ok: true, call: 'sub-question one', children: [
      { name: 'fetchUrl', ok: true, call: 'https://example.com/x', result: 'a page about vacuums' },
    ] },
    { name: '❓ which is quietest', ok: true, call: 'sub-question two' },
    { name: 'synthesize', ok: true, result: 'the distilled report text' },
  ] },
  { name: 'generateImage', ok: false },
];

(async () => {
  srv = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json') },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted');
  if (!up) { cleanup(); process.exit(1); }

  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - headless render (playwright-core unavailable)'); console.log(`\n✓ trace-fanout: ${pass} passed, ${fail} failed`); cleanup(); process.exit(fail ? 1 : 0); }

  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    page.on('pageerror', e => console.error('  [pageerror]', e.message));
    await page.goto(`${BASE}/?tracetest=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.__traceGeometry === 'function', { timeout: 15000 });

    // render the real renderer into the page
    await page.evaluate(steps => { const svg = window.__traceGeometry(steps); svg.id = 'tg-test'; document.body.appendChild(svg); }, STEPS);

    // helper: read every rendered node {key, labelText, x, y}
    const readNodes = () => page.evaluate(() => [...document.querySelectorAll('#tg-test [data-nodekey]')].map(g => {
      const t = g.querySelector('text');
      return { key: g.getAttribute('data-nodekey'), label: t ? t.textContent : '', x: t ? Number(t.getAttribute('x')) : 0, y: t ? Number(t.getAttribute('y')) : 0 };
    }));

    // ── 1. collapsed by default: only the 3 top-level rows; research labeled with its child count ──
    let nodes = await readNodes();
    const topKeys = nodes.map(n => n.key).sort();
    ok(topKeys.length === 3 && topKeys.join() === '0,1,2', `collapsed shows only the ${nodes.length} top-level steps (no children in DOM yet)`);
    const research = nodes.find(n => n.key === '1');
    ok(research && /research/.test(research.label) && /·3/.test(research.label), `the research node is labeled with its sub-step count: "${research && research.label}"`);
    ok(!nodes.some(n => n.key.startsWith('1.')), 'research children are NOT rendered while collapsed');

    // ── 2. hover research → its 3 searches FAN OUT vertically, labeled, indented ──
    await page.evaluate(() => document.querySelector('#tg-test [data-nodekey="1"]').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    await sleep(80);
    nodes = await readNodes();
    const kids = nodes.filter(n => /^1\.\d+$/.test(n.key)).sort((a, b) => a.key.localeCompare(b.key));
    ok(kids.length === 3, `hovering research fans out its 3 children as rows (got ${kids.length})`);
    ok(kids.every(k => k.label && k.label.replace(/^[▸▾]\s*/, '').length > 2), 'each fanned-out child is LABELED (not an unlabeled dot)');
    const ys = kids.map(k => k.y);
    ok(ys[0] < ys[1] && ys[1] < ys[2], `children are arranged VERTICALLY — strictly increasing y (${ys.join(' < ')})`);
    ok(new Set(ys).size === 3, 'children do NOT share one row (the old horizontal-dots bug is gone)');
    ok(kids.every(k => k.x > research.x), `children are INDENTED past their parent (child x ${kids[0].x} > research x ${research.x})`);
    ok(kids.every(k => kids[0].x === k.x), 'siblings share one indent column');

    // ── 3. recursive: hovering a child reveals ITS child ──
    await page.evaluate(() => document.querySelector('#tg-test [data-nodekey="1.0"]').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    await sleep(80);
    nodes = await readNodes();
    const grand = nodes.find(n => n.key === '1.0.0');
    ok(!!grand && /fetchUrl/.test(grand.label), `recursive fan-out: hovering a child reveals ITS child ("${grand && grand.label}")`);
    ok(grand && grand.x > kids[0].x, 'the grandchild is indented one level deeper');

    // ── 4. tapping a leaf opens its call/result modal ──
    // re-expand research (the previous hover narrowed the open path to 1.0); hover 1 then click the leaf 1.2
    await page.evaluate(() => document.querySelector('#tg-test [data-nodekey="1"]').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    await sleep(60);
    await page.evaluate(() => { const el = document.querySelector('#tg-test [data-nodekey="1.2"]'); el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await sleep(120);
    const modal = await page.evaluate(() => { const m = document.getElementById('qrmodal'); return { open: !!m && !m.classList.contains('hide'), text: m ? (m.textContent || '') : '' }; });
    ok(modal.open && /synthesize/.test(modal.text), 'tapping a leaf node opens its call/result modal');
    ok(/RESULT/.test(modal.text) && /distilled report/.test(modal.text), 'the modal shows that step\'s result');

    // ── 5. cap-hygiene: the trace SVG renders names/labels only ──
    const svgHtml = await page.evaluate(() => document.getElementById('tg-test').outerHTML);
    ok(!/#(?:cap|k|agent)=[0-9a-f]{16,}/i.test(svgHtml) && !/\b[0-9a-f]{32}\b/i.test(svgHtml), 'the trace SVG leaks no capability link / swissnum');
  } finally { await browser.close(); }

  console.log(`\n${fail ? '✗' : '✓'} trace-fanout staging: ${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); cleanup(); process.exit(1); });
