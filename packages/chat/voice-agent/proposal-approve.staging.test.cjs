#!/usr/bin/env node
// proposal-approve.staging.test.cjs — STAGING proof of the propose-only sub-agent APPROVAL flow. A voice-note
// ingest creates a propose-only seed chat (proposedPowers + a reviewable proposedPrompt). Opening it must show
// "🔍 View proposed agent prompt" + an "✅ Approve & run" button; clicking Approve must (1) grant EXACTLY the
// proposed powers to the chat (mint a confined scoped cap → the powers banner shows them) and (2) run the
// agent on the proposed prompt. The agent turn is stubbed (no live LLM) so we can assert the wiring
// deterministically: the /chat turn fires under the SCOPED cap and carries the proposed prompt.
//
// Run: node proposal-approve.staging.test.cjs   (exits non-zero on failure; SKIPs without chromium)

const { spawn } = require('node:child_process');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const PORT = 20000 + (process.pid % 20000); const BASE = `http://127.0.0.1:${PORT}`; // T-TEST-2: PID-derived port (unique per node --test child); never a fixed 879x
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'propappr-'));
let srv = null; let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

const PROMPT = 'Your goal is to research the cause of sharp thumb-pad pain. Using ONLY the research tool, produce a concise sourced brief. Do not access personal/vault data.';
const seedFile = path.join(tmp, 'seed-chats.json');
fs.writeFileSync(seedFile, JSON.stringify({ chats: [{
  id: 'chat-propself', title: 'Sharp Thumb Pain Investigation', ts: Date.now(), source: 'voice-note',
  transcript: 'My thumb pad has sharp pains when I touch things.', proposeOnly: true, proposedPowers: ['research'], proposedPrompt: PROMPT,
  tx: [{ who: 'you', text: 'My thumb pad has sharp pains when I touch things.' }, { who: 'agent', text: '* Research causes — approve an agent with: research', tools: [], steps: [], proposedPowers: ['research'], proposedPrompt: PROMPT }],
  versions: [{ v: 0, label: 'original', env: { persona: 'ingest:propose-only' }, answer: '* Research causes — approve an agent with: research', toolsUsed: [], steps: [], proposedPowers: ['research'], proposedPrompt: PROMPT, at: new Date().toISOString() }],
}] }));

(async () => {
  srv = spawn('node', ['server.mjs'], { cwd: __dirname, env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1', FIELD_LOCKDOWN: '1',
    SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'), PROJECTS_STORE: path.join(tmp, 'projects.json'),
    MEMO_RUNS_FILE: path.join(tmp, 'memo.json'), FORKS_STORE: path.join(tmp, 'forks.json'), BLOSSOM_STORE: path.join(tmp, 'blossom.json'),
    SEED_CHATS_FILE: seedFile, PRINT_ROOT_CAP: '1' }, stdio: ['ignore', 'ignore', 'ignore'] });
  let up = false; for (let i = 0; i < 90; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted with a seeded propose-only chat'); if (!up) { cleanup(); process.exit(1); }
  const cap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  let chromium = null; try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) { console.log('  SKIP - no chromium'); console.log(`\n${pass} passed, ${fail} failed (skipped)`); cleanup(); process.exit(fail ? 1 : 0); }
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: '/var/lib/obsidian/oldlibs' } });
  try {
    const page = await browser.newPage();
    // stub the agent turn so Approve&run doesn't need a live LLM; capture the cap + text it runs under
    await page.addInitScript(() => {
      window.__turns = [];
      const orig = window.fetch;
      window.fetch = (url, opts) => {
        try { const u = String(url || ''); if (u.endsWith('/chat') && opts && opts.method === 'POST') { const b = JSON.parse(opts.body || '{}'); window.__turns.push({ cap: b.cap, text: b.text }); return Promise.resolve(new Response(JSON.stringify({ ok: true, answer: '(stubbed run)', steps: [], ui: [] }), { status: 200, headers: { 'content-type': 'application/json' } })); } } catch {}
        return orig(url, opts);
      };
    });
    await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
    await page.goto(`${BASE}/`, { waitUntil: 'load' }); await sleep(2500);
    await page.evaluate(() => { const it = [...document.querySelectorAll('.chat-item .ci-title')].find(s => /Sharp Thumb Pain/.test(s.textContent)); if (it) it.click(); });
    await sleep(900);

    const before = await page.evaluate(() => {
      const log = document.getElementById('log');
      const approve = [...log.querySelectorAll('button')].find(b => /Approve & run/.test(b.textContent));
      const viewer = [...log.querySelectorAll('details')].find(d => /View proposed agent prompt/.test(d.textContent));
      const banner = log.querySelector('.powers-banner');
      return { approve: approve ? approve.textContent.trim() : null, viewer: !!viewer, bannerGrants: banner ? /research/.test(banner.textContent) : false, rootCap: window.localStorage.getItem('field-agent-cap') };
    });
    ok(/Approve & run/.test(before.approve || '') && /research/.test(before.approve || ''), `the proposal shows "✅ Approve & run · grants research" — got: ${JSON.stringify(before.approve)}`);
    ok(before.viewer, 'the proposal shows the "🔍 View proposed agent prompt" viewer');
    ok(!before.bannerGrants, 'before approval the chat is NOT yet scoped to research');

    // click Approve & run
    await page.evaluate(() => { const b = [...document.querySelectorAll('#log button')].find(x => /Approve & run/.test(x.textContent)); b && b.click(); });
    await page.waitForFunction(() => (window.__turns || []).length > 0, { timeout: 8000 }).catch(() => {});
    await sleep(600);

    const after = await page.evaluate(() => {
      const log = document.getElementById('log');
      const banner = log.querySelector('.powers-banner');
      const turn = (window.__turns || [])[0] || {};
      return { bannerGrants: banner ? /research/.test(banner.textContent) : false, turnText: turn.text || '', turnCap: turn.cap || '', rootCap: window.localStorage.getItem('field-agent-cap'), stillApprove: !![...log.querySelectorAll('button')].find(b => /Approve & run/.test(b.textContent)) };
    });
    ok(after.bannerGrants, 'after approval the chat is scoped → the powers banner shows 🔑 research');
    ok(after.turnText.includes('research the cause of sharp thumb-pad pain'), `the agent turn runs the PROPOSED PROMPT — got: ${JSON.stringify((after.turnText || '').slice(0, 60))}`);
    ok(after.turnCap && after.turnCap !== after.rootCap, 'the turn runs under the CONFINED scoped cap (not the root cap) — least authority');
    ok(!after.stillApprove, 'the Approve button is consumed after approval (not shown again)');
    await page.close();
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); cleanup(); process.exit(2); });
