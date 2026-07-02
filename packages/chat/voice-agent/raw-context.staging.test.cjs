#!/usr/bin/env node
// raw-context.staging.test.cjs — STAGING proof of the { } raw-context viewer: /chat captures the exact
// context handed to the agent (system persona + tool manifest + history + this turn), /chat/context serves
// it cap-gated, and the top-right button opens a monospace modal.
//
// Run: node raw-context.staging.test.cjs   (exits non-zero on failure; SKIPs browser w/o chromium)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 20000 + (process.pid % 20000); // T-TEST-2: PID-derived port (unique per node --test child); never a fixed 879x
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-ctx-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
const post = (p, body) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

(async () => {
  srv = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json'),
      FORKS_STORE: path.join(tmp, 'forks.json'), PRINT_ROOT_CAP: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted');
  if (!up) { cleanup(); process.exit(1); }
  const cap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();
  const sid = 'rawctx-test-sid';

  // gate: no cap → 403
  const noCap = await fetch(`${BASE}/chat/context`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: sid }) });
  ok(noCap.status === 403, 'a valid capability is required (403 without one)');
  // before any turn → friendly "send a message first"
  const pre = await post('/chat/context', { cap, sessionId: sid });
  ok(pre.ok === false && /send a message/.test(pre.error || ''), 'before a turn: tells you to send a message first');

  // fire a turn (the agent run will fail without creds, but lastCtx is captured BEFORE the run) — don't await
  post('/chat', { cap, sessionId: sid, text: 'hello world, what can you do?' }).catch(() => {});
  let ctx = null;
  for (let i = 0; i < 40 && !ctx; i++) { await sleep(200); const r = await post('/chat/context', { cap, sessionId: sid }); if (r.ok) ctx = r.context; }
  ok(!!ctx, 'after firing a turn, /chat/context returns the captured provider call');
  ok(ctx && Array.isArray(ctx.messages) && ctx.messages.length > 0, 'the bundle IS the provider messages array');
  ok(ctx && ctx.messages.some(m => m.role === 'system' && (m.content || '').length > 0), 'it includes a system message');
  ok(ctx && ctx.messages.some(m => m.role === 'user' && /hello world/.test(m.content || '')), 'it includes the user turn text in a user message');
  ok(ctx && ctx.messages.every(m => m.role && typeof m.content === 'string'), 'every message has a role + string content (alternating turns)');
  ok(ctx && Array.isArray(ctx.powers), 'the bundle lists the granted powers');
  ok(ctx && !JSON.stringify(ctx).includes(cap), 'the bundle contains NO swissnum (cap-hygiene)');

  // RECONSTRUCTION: a chat with NO live capture (e.g. after a restart) but a transcript → rebuilt bundle
  const recon = await post('/chat/context', { cap, sessionId: 'never-ran-sid', history: [{ role: 'user', content: 'what is the capital of france' }, { role: 'assistant', content: 'Paris.' }] });
  ok(recon.ok && recon.context.reconstructed === true, 'a chat with no live capture reconstructs from its transcript');
  ok(recon.ok && recon.context.messages.some(m => m.role === 'system' && m.content.length > 0), 'reconstruction includes the cap’s current persona + tool manifest as the system message');
  ok(recon.ok && recon.context.messages.some(m => m.role === 'user' && /capital of france/.test(m.content)) && recon.context.messages.some(m => m.role === 'assistant' && /Paris/.test(m.content)), 'reconstruction includes the alternating transcript turns');

  let chromium = null;
  try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - browser button/modal check (no chromium)'); }
  else {
    const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
    try {
      const page = await browser.newPage();
      await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
      await page.goto(`${BASE}/`, { waitUntil: 'load' });
      await page.waitForTimeout(1500);
      const btn = await page.evaluate(() => { const b = document.getElementById('ctx-btn'); if (!b) return null; const r = b.getBoundingClientRect(); return { text: b.textContent, mono: /mono/i.test(getComputedStyle(b).fontFamily), topRight: r.top < 80 && (innerWidth - r.right) < 80 }; });
      ok(btn && btn.text.includes('{ }'), 'the { } button is present');
      ok(btn && btn.mono && btn.topRight, 'it is monospace and in the top-right corner');
      const opened = await page.evaluate(async () => { document.getElementById('ctx-btn').click(); await new Promise(r => setTimeout(r, 600)); const pre = document.querySelector('div[style*="z-index:90"] pre, div[style*="z-index: 90"] pre'); return pre ? pre.textContent.slice(0, 40) : null; });
      ok(opened !== null, `clicking opens the monospace context modal — got: ${JSON.stringify(opened)}`);
      await page.close();
    } finally { await browser.close(); }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); cleanup(); process.exit(2); });
