#!/usr/bin/env node
// fork-edit-chat.staging.test.cjs — STAGING proof of P2-for-forks: Alt-click ✎ edit on a LIVE mounted fork
// opens the CONVERSATIONAL edit chat (openComponentEditChat, kind:'fork') backed by /forks/edit-chat — the
// same real agent loop components get — not the one-shot /forks/edit window.prompt. Two layers:
//   1. SERVER (isolated instance, throwaway state; no LLM spend): /forks/edit-chat exists, is OWNER-gated
//     (no cap → 403; valid cap + someone else's/unknown fork → refused), and validates input. Round-trip is
//     proven end-to-end with the agent-loop's editFork intercepted at the LLM seam via a real /forks/edit
//     direct-source edit — the same forks.edit() the route's toolbox commits through.
//   2. CLIENT (live :8778, root cap; /forks/edit-chat intercepted so the test never spends an Opus loop —
//     the component-edit-chat precedent): a real fork is created + mounted, Alt-click → chip → ✎ edit opens
//     the conversational modal, a message posts {cap,id,message,history} to /forks/edit-chat, a clarifying
//     question renders (asking turn), the second turn carries the history + shows the applied version.
// Run: node fork-edit-chat.staging.test.cjs   (exits non-zero on any failure; SKIPs client layer w/o chromium)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-edit-chat-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
const post = (p, body) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

(async () => {
  // ── layer 1: the SERVER route on an ISOLATED instance ────────────────────────────────────────────────
  srv = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1', FIELD_LOCKDOWN: '1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json'),
      FORKS_STORE: path.join(tmp, 'forks.json'), PRINT_ROOT_CAP: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted (FIELD_LOCKDOWN=1)');
  if (!up) { cleanup(); process.exit(1); }
  const cap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  // the route EXISTS and is owner-gated: no/bad cap → 403 (never the agent loop)
  const noCap = await post('/forks/edit-chat', { id: 'x', message: 'hi' });
  ok(noCap.status === 403, `/forks/edit-chat without a cap is refused with 403 — got: ${noCap.status}`);
  // valid cap + a fork that isn't yours/doesn't exist → refused (and NOT the 404 'unknown forks route',
  // which is what a missing route would return)
  const unknown = await (await post('/forks/edit-chat', { cap, id: 'no-such-fork', message: 'hi' })).json();
  ok(unknown.ok === false && /unknown fork/.test(unknown.error || ''), `an unknown fork is refused (route present, owner-gated) — got: ${JSON.stringify(unknown)}`);
  const empty = await (await post('/forks/edit-chat', { cap, id: 'no-such-fork', message: '   ' })).json();
  ok(empty.ok === false && /empty message/.test(empty.error || ''), 'an empty message is refused before any agent work');

  // a REAL owner fork + a round-trip through the same forks.edit() the route's editFork commits with:
  // create → deterministic source edit → version advanced + source live. (The agent loop itself is LLM-
  // driven; its editFork tool is exactly this path — the client layer below proves the loop wiring.)
  const created = await (await post('/forks/create', { cap, source: "(endowments, props) => endowments.h('div', null, 'FEC-V1')", name: 'FecFork' })).json();
  ok(created.ok && created.id, `an owner fork was created (${created.id})`);
  const edited = await (await post('/forks/edit', { cap, id: created.id, source: "(endowments, props) => endowments.h('div', null, 'FEC-V2')" })).json();
  ok(edited.ok && edited.version === 2, `the fork's edit path round-trips one edit (v1 → v${edited.version})`);
  const readBack = await (await post('/forks/read', { cap, id: created.id })).json();
  ok(readBack.ok && /FEC-V2/.test(readBack.source || ''), 'the edited source reads back live');
  srv.kill('SIGKILL'); srv = null;

  // ── layer 2: the CLIENT wiring against the LIVE service (:8778, root cap) ────────────────────────────
  let chromium = null; try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) {
    console.log('  SKIP - client-wiring layer (playwright-core unavailable)');
    console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(fail ? 1 : 0);
  }
  const liveCap = fs.readFileSync(path.join(os.homedir(), '.config/field-agent/root.swiss'), 'utf8').trim();
  const br = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  let liveForkId = null;
  try {
    const page = await br.newPage({ viewport: { width: 1100, height: 900 } });
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    // intercept the conversational endpoint so the test never spends a real Opus agent loop (the
    // component-edit-chat precedent): turn 1 asks a clarifying question, turn 2 applies the edit.
    let editBody = null, turns = 0;
    await page.route('**/forks/edit-chat', r => {
      try { editBody = JSON.parse(r.request().postData() || '{}'); } catch {}
      turns += 1;
      const body = turns === 1
        ? { ok: true, answer: 'Teal the border or the text?', asking: true, edited: null, steps: ['readForkSource'] }
        : { ok: true, answer: 'Made the border teal.', asking: false, edited: { version: 2 }, steps: ['readForkSource', 'editFork'] };
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, liveCap);
    await page.goto('http://127.0.0.1:8778/', { waitUntil: 'load' });
    await page.waitForSelector('#tab-components:not(.hide)', { timeout: 20000 });

    // mount a REAL live fork (cleaned up below), then Alt-click it → chip → ✎ edit
    await page.evaluate(src => window.forkIntoChat({ source: src, name: 'FecLive' }),
      "(endowments, props) => endowments.h('div', null, 'FEC-LIVE-OK')");
    await page.waitForFunction(() => {
      const m = document.querySelector('.fork-mount[data-fork-id]');
      return m && /FEC-LIVE-OK/.test((m.querySelector('.fork-stage') || {}).textContent || '');
    }, { timeout: 10000 }).catch(() => {});
    liveForkId = await page.evaluate(() => { const m = document.querySelector('.fork-mount[data-fork-id]'); return m && m.getAttribute('data-fork-id'); });
    ok(!!liveForkId, 'a live fork mounted inline, tagged with data-fork-id');
    const chip = await page.evaluate(() => {
      const stage = document.querySelector('.fork-mount[data-fork-id] .fork-stage');
      stage.dispatchEvent(new MouseEvent('click', { altKey: true, bubbles: true, cancelable: true }));
      const b = document.querySelector('[data-act=fedit]'); if (b) { b.click(); return true; } return false;
    });
    ok(chip, 'Alt-click the live fork → chip → ✎ edit clicked');
    await page.waitForTimeout(300);
    ok(await page.evaluate(() => !!document.getElementById('ce-input') && !!document.getElementById('ce-log')),
      '✎ edit on a FORK opens the CONVERSATIONAL edit chat (not a window.prompt)');
    // turn 1 — message + fork id hit /forks/edit-chat; the agent asks a clarifying question
    await page.evaluate(() => { document.getElementById('ce-input').value = 'make it teal'; document.getElementById('ce-send').click(); });
    await page.waitForTimeout(500);
    ok(editBody && editBody.message === 'make it teal' && editBody.id === liveForkId,
      'a message runs the agent loop (message + fork id sent to /forks/edit-chat)');
    ok(/Teal the border or the text\?/.test(await page.evaluate(() => document.getElementById('ce-log').innerText)),
      'the fork agent can ask a clarifying question (conversational, not one-shot)');
    // turn 2 — the prior exchange rides along as history; the applied edit shows its version
    await page.evaluate(() => { document.getElementById('ce-input').value = 'the border'; document.getElementById('ce-send').click(); });
    await page.waitForTimeout(500);
    ok(editBody && Array.isArray(editBody.history) && editBody.history.length >= 2,
      'the prior exchange is sent as history (a real conversation)');
    const log = await page.evaluate(() => document.getElementById('ce-log').innerText);
    ok(/Made the border teal\./.test(log), "the agent's reply renders");
    ok(/v2/.test(log), 'an applied edit shows the new live version');
    ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join('; ')})`);
    // clean up: remove the test fork from live state (real request; the route intercept only covered edit-chat)
    if (liveForkId) {
      const rm = await page.evaluate(async id => (await (await fetch('/forks/remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: localStorage.getItem('field-agent-cap'), id }) })).json()), liveForkId);
      ok(rm && rm.ok, 'test fork removed from live state');
    }
    await page.close();
  } finally { await br.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); cleanup(); process.exit(2); });
