#!/usr/bin/env node
// render-smell.staging.test.cjs — a STAGING (real-run) guard for the "[object Object]" render-smell
// validator. The recurring bug: an agent authors a confined widget and drops a JS OBJECT into a TEXT
// slot (h(Card,{body: someObject}), a Chip label, a followed cell value); the kit coerces with String()
// and the user sees the literal "[object Object]" instead of their data.
//
// It boots an ISOLATED voice-agent on a throwaway port, then asserts END-TO-END with a real headless
// chromium mounting the REAL /confined.html over its real MessagePort handshake:
//   1. a widget that passes an OBJECT into Card.body renders the DATA (readable JSON), NOT "[object Object]";
//   2. that same render EMITS a `render-smell` message (tag "[object Object]", where "Card.body") to the host;
//   3. a CLEAN widget (only strings) emits NO smell (no false positive);
//   4. the server POST /render-smell files the correction (feedback names the smell + how to fix it).
//
// Run: node render-smell.staging.test.cjs   (exits non-zero on any failure)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'render-smell-staging-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

// Drive confined.html's real mount handshake from the TOP document (parent === self): wait for its
// 'ready', transfer a MessagePort on 'mount' with the agent source, and collect any 'render-smell'
// it sends back. Returns { smells, body } — exactly what the host would receive + what the user sees.
const mountAndCollect = async (page, source) => page.evaluate(src => new Promise(resolve => {
  const ch = new MessageChannel();
  let smells = null;
  ch.port1.onmessage = e => { const m = e.data; if (m && m.__cu === 1 && m.type === 'render-smell') smells = m.smells; };
  ch.port1.start();
  const doMount = () => { try { window.postMessage({ __cu: 1, type: 'mount', source: src }, '*', [ch.port2]); } catch (e) {} };
  window.addEventListener('message', e => { const m = e.data; if (m && m.__cu === 1 && m.type === 'ready') doMount(); });
  setTimeout(doMount, 250); // in case 'ready' fired before this listener attached
  setTimeout(() => resolve({ smells, body: String((document.body && document.body.textContent) || '') }), 1500);
}), source);

(async () => {
  srv = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json'),
      PRINT_ROOT_CAP: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted');
  if (!up) { cleanup(); process.exit(1); }
  const rootCap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  // ── 4 (server half, no browser needed): POST /render-smell files the correction ─────────────
  const rs = await (await fetch(`${BASE}/render-smell`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cap: rootCap, name: 'Status Card', source: '(e,p)=>h(Card,{body:p.value})',
      smells: [{ tag: '[object Object]', where: 'Card.body', preview: '{"state":"open"}' }] }) })).json();
  ok(rs && rs.ok && rs.filed, 'POST /render-smell filed the smell into the self-improvement loop');
  ok(rs && /\[object Object\]/.test(rs.feedback || '') && /Card\.body/.test(rs.feedback || ''), 'server feedback names the smell + the offending slot');
  ok(rs && /(JSON\.stringify|field|children)/i.test(rs.feedback || ''), 'server feedback tells the agent HOW to fix it');
  // a smell-free POST is a no-op (guards against noise)
  const rs0 = await (await fetch(`${BASE}/render-smell`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: rootCap, smells: [] }) })).json();
  ok(rs0 && rs0.ok === false, 'POST /render-smell with no smells is a no-op');

  // ── 1–3 (client tier, real headless render of the real confined.html) ────────────────────────
  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) {
    console.log('  SKIP - headless render checks (playwright-core unavailable); server half asserted above');
  } else {
    const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
    try {
      const page = await browser.newPage();
      await page.goto(`${BASE}/confined.html`, { waitUntil: 'load' });

      // BAD widget: an object dropped into Card.body — the exact recurring bug.
      const bad = await mountAndCollect(page, "(ui) => ui.island('Card', { title: 'Sensor', body: { state: 'open', battery: 87 } })");
      ok(!/\[object Object\]/.test(bad.body), `object in Card.body does NOT render "[object Object]" — body="${bad.body.slice(0, 80)}"`);
      ok(/battery|87|state|open/.test(bad.body), 'the readable DATA is shown instead of the smell');
      ok(Array.isArray(bad.smells) && bad.smells.length > 0, 'a render-smell was emitted to the host');
      ok(Array.isArray(bad.smells) && bad.smells.some(s => s.tag === '[object Object]' && s.where === 'Card.body'), 'the smell names the tag + the slot (Card.body)');

      // CLEAN widget: only strings — must NOT trip the validator.
      const clean = await mountAndCollect(page, "(ui) => ui.island('Card', { title: 'Sensor', body: 'door is open · battery 87%' })");
      ok(/door is open/.test(clean.body), 'clean widget renders its text');
      ok(clean.smells == null || clean.smells.length === 0, 'a clean widget emits NO render-smell (no false positive)');
    } finally { await browser.close(); }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.message); cleanup(); process.exit(2); });
