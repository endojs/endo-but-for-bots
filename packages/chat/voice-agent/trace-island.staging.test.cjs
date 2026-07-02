#!/usr/bin/env node
// trace-island.staging.test.cjs — STAGING (real-run) proof that the TRACE VIEW is an ISLAND
// (dan: "make the trace view an island within the island concept of the app, so it is properly
// fork & riffable"). Layers:
//
//   SERVER (isolated instance + a stub OpenAI-compatible LLM so a REAL /chat turn runs real tools):
//     1. chrome-trace-view is seeded at boot with the cell-contract header (the schema riffers see).
//     2. THE CELL IS THE INTERFACE: a /cells/subscribe stream for trace:<sid> receives ≥N monotonic
//        frames from a real turn — running step(s), settled steps, status running→done, rev only grows.
//     3. The trace cell is cap-gated (an invalid cap gets an error frame — tighter than /chat/steps).
//     4. A broken trace-island edit is REFUSED by the render-check gate; HEAD stays.
//     5. A scripted FORK (a minimal list renderer honoring the SAME cell contract) lands via the
//        deterministic edit path and is served at HEAD.
//   BROWSER (headless chromium against the same instance):
//     6. During a REAL chat turn the island mounts in the log, animates the live fan-out (step chips
//        appear while the turn runs), and the host's frame counter shows the cell fed it.
//     7. Alt-click selects the island by registry identity (the ✎ edit / 🍴 fork chip).
//     8. The LIST-RENDERER fork replaces the viz entirely and receives the SAME frames live.
//     9. A THROWING island source falls back to the legacy 3D pendant (never a silent turn) and the
//        error auto-files onto chrome-trace-view's own backlog.
//
// Run: node trace-island.staging.test.cjs   (exits non-zero on failure; SKIPs browser w/o chromium)

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 8850;
const LLM_PORT = 8851;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-island-'));
let srv = null; let stub = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { stub && stub.close(); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
const jget = p => fetch(`${BASE}${p}`).then(r => r.json());
const jpost = (p, b) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());

// ── the stub LLM: an OpenAI-compatible /v1/chat/completions that plays a CodeMode agent. Round 1
//    returns a program that calls REAL toolbox verbs (so emitStep fires with real tool steps); round 2
//    (it sees round 1's OUTPUT marker in the transcript) answers — DELAYED so the turn stays open long
//    enough for the browser half to watch the island animate. ──
const PROGRAM_1 = ['```js',
  "updateProgress('phase one — gathering');",
  "await showChoices({ prompt: 'trace-proof', options: ['a', 'b'] });",
  "await showChoices({ prompt: 'trace-proof-2', options: ['c', 'd'] });",
  "return 'TI-PHASE1';",
  '```'].join('\n');
const PROGRAM_2 = '```js\nanswer("trace island proof done");\n```';
const startStub = () => new Promise(resolve => {
  stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      let text = '{}'; let delay = 30; // non-CodeMode calls (classifier etc): instant, inert
      if (/SECURE SANDBOX/.test(body)) { // a CodeMode round
        if (/TI-PHASE1/.test(body)) { text = PROGRAM_2; delay = 5000; } // hold the turn open for the browser to watch
        else { text = PROGRAM_1; delay = 200; }
      }
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
      }, delay);
    });
  });
  stub.listen(LLM_PORT, '127.0.0.1', resolve);
});

// ── read a /cells/subscribe SSE stream, collecting parsed frames until told to stop ──
const openCellStream = (cap, cellId) => {
  const frames = [];
  const ctrl = new AbortController();
  const st = { status: 0 };
  const done = (async () => {
    try {
      const res = await fetch(`${BASE}/cells/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, cells: [cellId] }), signal: ctrl.signal });
      st.status = res.status;
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { done: end, value } = await reader.read(); if (end) break;
        buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = block.split('\n').find(l => l.startsWith('data:')); if (!line) continue;
          try { frames.push(JSON.parse(line.slice(5).trim())); } catch { /* */ }
        }
      }
    } catch { /* aborted */ }
  })();
  return { frames, st, stop: () => { try { ctrl.abort(); } catch {} return done; } };
};

// the scripted RIFF: a fork that replaces the viz entirely — a plain list honoring the SAME cell contract.
const LIST_SOURCE = `// riff: the trace as a PLAIN LIST — same cell contract (props.trace from trace:<chatId>).
(endowments, props) => {
  const h = endowments.h;
  const tr = props.trace || {};
  const steps = Array.isArray(tr.steps) ? tr.steps : [];
  return h('ul', { class: 'trace-list', style: 'margin:8px 0;padding:6px 12px;border:1px solid var(--edge,#30363d);border-radius:10px;list-style:none' },
    steps.length ? steps.map((s, i) => h('li', { key: i, class: 'trace-li', style: 'font:12px ui-monospace,monospace;color:var(--ink,#e6edf3)' },
      (s.status === 'running' ? '… ' : (s.ok === false ? '✕ ' : '✓ ')) + String(s.name || 'step')))
      : [h('li', { class: 'trace-li-empty', style: 'font:12px ui-monospace,monospace;color:var(--mut,#8b949e)' }, tr.status === 'done' ? 'no steps' : 'thinking…')]);
}`;

(async () => {
  await startStub();
  srv = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1', PRINT_ROOT_CAP: '1', FIELD_LOCKDOWN: '1',
      AGENT_LLM: `http://127.0.0.1:${LLM_PORT}/v1/chat/completions`,
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      VOICE_STATE_DIR: path.join(tmp, 'voice-state'), DASH_STATE_DIR: path.join(tmp, 'dash-state'),
      COMPONENT_GIT_DIR: path.join(tmp, 'component-git'), BACKLOG_STORE: path.join(tmp, 'component-backlog.json'),
      CUSTOM_TOOLS_STORE: path.join(tmp, 'custom-tools.json'), CUSTOM_TOOLS_STATE: path.join(tmp, 'tool-state'),
      COMPONENT_GRAINS: path.join(tmp, 'component-grains'), FORKS_STORE: path.join(tmp, 'forks.json'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json'),
      USERS_FILE: path.join(tmp, 'users.json'), AUTO_ADMIT: '0', AUTO_REVISE: '0' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted (throwaway state, FIELD_LOCKDOWN=1, stub LLM)');
  if (!up) { cleanup(); process.exit(1); }
  const rootCap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  // ── 1. seeded with the cell contract in the source header ──────────────────────────────────────
  const reg = await jget('/chrome/components');
  const tv = (reg.components || []).find(c => c.id === 'chrome-trace-view');
  ok(!!tv, 'chrome-trace-view is a seeded chrome component');
  ok(!!tv && /THE CELL IS THE INTERFACE/.test(tv.source) && /trace:<chatId>/.test(tv.source) && /FORK \/ RIFF FREELY/.test(tv.source),
    'the seeded source HEADER documents the cell schema + riff invitation (what the edit chat shows)');
  ok(!!tv && /^[0-9a-f]{6,40}$/.test(String(tv.version)), `it carries a real git version (${tv && String(tv.version).slice(0, 8)})`);
  const seedVersion = tv && tv.version;

  // ── 2. the trace:<sid> cell streams a REAL turn's fan-out, monotonically ────────────────────────
  const sid = 'ti-proof-1';
  const stream = openCellStream(rootCap, `trace:${sid}`);
  await sleep(300); // the subscribe lands (unbound trace → any valid cap may attach pre-turn)
  const turnP = jpost('/chat', { cap: rootCap, sessionId: sid, text: 'run the trace island proof' });
  const turn = await turnP;
  await sleep(500); // let the trailing 'end' frame flush
  await stream.stop();
  ok(turn && !turn.error && /trace island proof done/.test(turn.answer || ''), `the real turn completed through the stub agent ("${String(turn.answer || turn.error).slice(0, 50)}")`);
  ok((turn.steps || []).length >= 2, `the turn ran real tool steps (${(turn.steps || []).length})`);
  const vals = stream.frames.filter(f => f && f.value && !f.error).map(f => f.value);
  ok(vals.length >= 4, `the cell pushed ≥4 frames over ONE subscribe stream (${vals.length})`);
  ok(vals.some(v => (v.steps || []).some(s => s.status === 'running')), 'a frame caught a step IN FLIGHT (status running — the live fan-out, not just the record)');
  const last = vals[vals.length - 1];
  ok(!!last && last.status === 'done' && (last.steps || []).length >= 2 && last.steps.every(s => s.status === 'done'),
    `the final frame is the settled trace (done, ${last && (last.steps || []).length} steps)`);
  ok(!!last && (last.steps || []).some(s => s.name === 'showChoices'), 'settled steps carry the real tool names');
  ok(vals.every((v, i) => i === 0 || v.rev >= vals[i - 1].rev), 'rev is MONOTONIC across every push (append + settle, never rewind)');
  ok(vals.some(v => /phase one/.test(v.progress || '')), "the agent's updateProgress ping rode the cell too");

  // ── 3. the cell is cap-gated (tighter than the sid-only /chat/steps SSE) ────────────────────────
  const bad = openCellStream('deadbeef'.repeat(4), `trace:${sid}`);
  await sleep(600); await bad.stop();
  ok(bad.st.status === 403 && bad.frames.length === 0, `an invalid cap is refused outright (403, no frames — /chat/steps needs no cap at all)`);
  // OWNER-MISMATCH: a valid but DIFFERENT cap (a scoped mint) may not read root's bound chat trace
  const minted = await jpost('/scope/mint', { cap: rootCap, powers: ['notes'], label: 'trace-gate-probe' });
  ok(!!minted.scopedCap, 'a scoped (non-root) cap was minted for the ownership probe');
  const other = openCellStream(minted.scopedCap, `trace:${sid}`);
  await sleep(600); await other.stop();
  ok(other.frames.some(f => f && /not your chat trace/.test(f.error || '')) && !other.frames.some(f => f && f.value),
    "a valid cap that doesn't own the chat gets 'not your chat trace', never the frames (owner-gated like backlog cells)");

  // ── 4. render-check gate: a broken island edit is refused; HEAD stays ───────────────────────────
  const broken = await jpost('/components/edit', { cap: rootCap, id: 'chrome-trace-view', source: '(endowments, props) => { throw new Error("riff gone wrong") }' });
  ok(broken.ok === false && /render check/i.test(broken.error || ''), `a THROWING trace-island edit is refused by the render check (${(broken.error || '').slice(0, 50)}…)`);
  const reg2 = await jget('/chrome/components');
  ok(reg2.components.find(c => c.id === 'chrome-trace-view').version === seedVersion, 'HEAD unchanged after the refused edit');

  // ── 5. the scripted FORK: a list renderer honoring the SAME cell contract lands ─────────────────
  const riff = await jpost('/components/edit', { cap: rootCap, id: 'chrome-trace-view', source: LIST_SOURCE });
  ok(riff.ok === true && riff.version && riff.version !== seedVersion, `the list-renderer riff passes the gate and commits (${String(riff.version).slice(0, 8)})`);
  const reg3 = await jget('/chrome/components');
  ok(/trace-list/.test(reg3.components.find(c => c.id === 'chrome-trace-view').source), 'the served HEAD is the riff');
  // put the seed back for the browser half's first run
  const rv = await jpost('/components/revert', { cap: rootCap, id: 'chrome-trace-view', version: seedVersion });
  ok(rv.ok === true, 'revert restores the seed (non-destructive lineage)');

  // ── browser half ────────────────────────────────────────────────────────────────────────────────
  let chromium = null;
  try { ({ chromium } = require(process.env.PLAYWRIGHT_CORE || '/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) {
    console.log('  SKIP - browser checks (playwright-core unavailable)');
    console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(fail ? 1 : 0);
  }
  const browser = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
  const shotDir = process.env.TRACE_ISLAND_SHOTS || tmp;
  try {
    const seedChat = (page, chatId) => page.addInitScript(({ c, id }) => { try {
      localStorage.setItem('field-agent-cap', c);
      localStorage.setItem('field-agent-chats', JSON.stringify([{ id, title: 'tracechat', ts: Date.now(), lastMsgAt: Date.now() }]));
      localStorage.setItem('field-agent-active', id);
      localStorage.setItem('field-agent-tx-' + id, JSON.stringify([{ who: 'you', text: 'warmup' }, { who: 'agent', text: 'ready' }])); // prior turns → the consent scoper is skipped (not a first message)
      localStorage.setItem('field-trace-tier2', '0'); // EXPLICIT opt-OUT: Tier-2 WebGL is now the DEFAULT surface; this suite proves the LEGACY chrome-trace-view divs island (the opt-out escape hatch stays covered). The default WebGL surface is proven by trace-viz-island.staging.test.cjs.
    } catch {} }, { c: rootCap, id: chatId });
    const openChatAndSend = async page => {
      await page.evaluate(() => { const it = [...document.querySelectorAll('.chat-item .ci-title')].find(s => /tracechat/.test(s.textContent)); if (it) it.click(); });
      await page.waitForTimeout(400);
      await page.evaluate(() => { document.getElementById('text').value = 'run the trace island proof'; document.getElementById('send').click(); });
    };

    // ── 6. the island mounts during a REAL turn and animates the live fan-out ─────────────────────
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    await seedChat(page, 'ti-ui-1');
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.waitForSelector('#tab-components:not(.hide)', { timeout: 15000 });
    await openChatAndSend(page);
    await page.waitForSelector('#log [data-component-id=chrome-trace-view]', { timeout: 15000 });
    ok(true, 'the trace island mounts in the log when the turn starts (registry-tagged chrome-trace-view)');
    // the live fan-out: settled step chips appear WHILE the turn is still running (round 2 is held open)
    let mid = null;
    for (let i = 0; i < 40 && !mid; i++) {
      const st = await page.evaluate(() => ({
        chips: document.querySelectorAll('#log [data-component-id=chrome-trace-view] .trace-step').length,
        running: !!document.querySelector('#log [data-component-id=chrome-trace-view]'),
        frames: (window.__traceIsland || {}).frames || 0,
      }));
      if (st.chips >= 2) mid = st; else await sleep(250);
    }
    ok(!!mid && mid.chips >= 2, `step chips grew IN the island while the turn ran (${mid && mid.chips} chips mid-turn)`);
    ok(!!mid && mid.frames >= 2, `the host's cell stream fed the island live (${mid && mid.frames} frames mid-turn)`);
    try { await page.screenshot({ path: path.join(shotDir, 'trace-island-live.png') }); console.log('  info - mid-turn screenshot:', path.join(shotDir, 'trace-island-live.png')); } catch {}

    // ── 7. alt-click selects the island by registry identity (✎/⑂ chip) ───────────────────────────
    const sel = await page.evaluate(() => {
      const el = document.querySelector('#log [data-component-id=chrome-trace-view]');
      if (!el) return { hasEdit: false, label: '(no island)' };
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, altKey: true, clientX: r.left + 8, clientY: r.top + 8 }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true, clientX: r.left + 8, clientY: r.top + 8 }));
      const edit = [...document.querySelectorAll('button')].find(b => (b.textContent || '') === '✎ edit');
      const chip = edit && edit.closest('div');
      return { hasEdit: !!edit, label: chip ? chip.textContent : '' };
    });
    ok(sel.hasEdit && /Trace view/.test(sel.label), `alt-click selects the island with the ✎/⑂ chip by its registry name ("${String(sel.label).slice(0, 40)}")`);
    await page.keyboard.press('Escape');
    // let the turn finish; the island hands off to the per-message SVG record
    await page.waitForFunction(() => !document.querySelector('#log [data-component-id=chrome-trace-view]'), null, { timeout: 30000 });
    const fin = await page.evaluate(() => ({ frames: (window.__traceIsland || {}).frames || 0, answer: [...document.querySelectorAll('.msg .body')].some(b => /trace island proof done/.test(b.textContent || '')) }));
    ok(fin.frames >= 3, `the island received ≥3 cell frames over the whole turn (${fin.frames})`);
    ok(fin.answer, 'the answer landed after the island handed off (island never blocked the turn)');
    ok(errs.length === 0, `no page errors on the island path (${errs.slice(0, 2).join(' | ')})`);
    await page.close();

    // ── 8. the FORK receives the SAME frames: swap the viz for the list renderer, run another turn ─
    const swapped = await jpost('/components/edit', { cap: rootCap, id: 'chrome-trace-view', source: LIST_SOURCE });
    ok(swapped.ok === true, 'the list-renderer riff is applied for the fork run');
    const page3 = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await seedChat(page3, 'ti-ui-2');
    await page3.goto(`${BASE}/`, { waitUntil: 'load' });
    await page3.waitForSelector('#tab-components:not(.hide)', { timeout: 15000 });
    await openChatAndSend(page3);
    await page3.waitForSelector('#log [data-component-id=chrome-trace-view] ul.trace-list', { timeout: 15000 });
    let forkMid = null;
    for (let i = 0; i < 40 && !forkMid; i++) {
      const n = await page3.evaluate(() => document.querySelectorAll('#log [data-component-id=chrome-trace-view] li.trace-li').length);
      if (n >= 2) forkMid = n; else await sleep(250);
    }
    ok(forkMid >= 2, `the FORK renders the same live frames through the same cell contract (${forkMid} list rows mid-turn)`);
    try { await page3.screenshot({ path: path.join(shotDir, 'trace-island-fork.png') }); } catch {}
    await page3.waitForFunction(() => !document.querySelector('#log [data-component-id=chrome-trace-view]'), null, { timeout: 30000 }).catch(() => {});
    await page3.close();
    await jpost('/components/revert', { cap: rootCap, id: 'chrome-trace-view', version: seedVersion });

    // ── 9. a BROKEN island falls back to the legacy pendant + auto-files to its backlog ────────────
    const page2 = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const realReg = await jget('/chrome/components');
    const patched = { ok: true, components: realReg.components.map(c => c.id === 'chrome-trace-view'
      ? { ...c, version: 'broken1', source: '(endowments, props) => { throw new Error("staged trace island breakage") }' } : c) };
    await page2.route('**/chrome/components', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(patched) }));
    await seedChat(page2, 'ti-ui-3');
    await page2.goto(`${BASE}/`, { waitUntil: 'load' });
    await page2.waitForSelector('#tab-components:not(.hide)', { timeout: 15000 });
    await openChatAndSend(page2);
    let fb = null;
    for (let i = 0; i < 40 && !fb; i++) {
      const st = await page2.evaluate(() => ({
        island: !!document.querySelector('#log [data-component-id=chrome-trace-view]'),
        pendant: (() => { const w = document.getElementById('pendant-wrap'); return !!w && !w.classList.contains('hide'); })(),
      }));
      if (st.pendant) fb = st; else await sleep(250);
    }
    ok(!!fb && fb.pendant, 'a broken island falls back to the LEGACY 3D pendant during the turn (never a silent turn)');
    ok(!!fb && !fb.island, 'the broken island never stays mounted');
    await page2.waitForTimeout(2500); // let /error/flag land
    const bl = await jpost('/components/backlog', { cap: rootCap, id: 'chrome-trace-view' });
    const item = (bl.items || []).find(i => i.kind === 'error' && /chrome component failed/.test(i.title) && /staged trace island breakage/.test(i.title + ' ' + (i.body || '')));
    ok(!!item, `the throwing fork auto-filed onto chrome-trace-view's OWN backlog ("${item && item.title.slice(0, 60)}…")`);
    await page2.close();
  } finally { await browser.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.stack || e); cleanup(); process.exit(2); });
