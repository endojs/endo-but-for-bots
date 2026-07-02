#!/usr/bin/env node
// component-error-loop.staging.test.cjs — STAGING proof of the render-feedback loop (chat 1cbe89a9):
// agents SEE their component errors and iterate, instead of shipping a broken widget the human must
// hand-carry back ("⚠️ component threw while building: safeSaleAmount is not defined" — typed by dan).
//
// Three layers:
//   1. SERVER, sync half (isolated instance, throwaway state, no LLM spend): an agent-authored FORK edit
//      with a deliberate bug (undefined variable at render) is REFUSED — the error IS the edit's result,
//      the broken version is never saved, a scripted second edit (the "agent iterates" step) with the fix
//      lands, and the fixed fork reads back live. The exact round-trip dan asked for.
//   2. SERVER, async half: a runtime error posted to /error/flag with a sessionId is queued for THAT chat
//      and injected into the agent's next /chat turn as system feedback (verified via /chat/context — the
//      truth of what the model sees), then drained (a second turn is clean).
//   3. BROWSER (headless chromium vs the same isolated instance): the REAL confined.html frame reports a
//      mount-time throw AND a post-mount event-handler throw over its port; the real app page paints the
//      visible system note + POSTs /error/flag when a component error is reported.
// Run: node component-error-loop.staging.test.cjs   (exits non-zero on any failure; SKIPs browser layer w/o chromium)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 20000 + (process.pid % 20000); // T-TEST-2: PID-derived port (unique per node --test child); never a fixed 879x
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-err-loop-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
const post = (p, body) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

(async () => {
  srv = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1', FIELD_LOCKDOWN: '1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      VOICE_STATE_DIR: path.join(tmp, 'voice-state'), // pending component errors + chats land here, never in live state
      PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json'),
      FORKS_STORE: path.join(tmp, 'forks.json'), PRINT_ROOT_CAP: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted (FIELD_LOCKDOWN=1, throwaway VOICE_STATE_DIR)');
  if (!up) { cleanup(); process.exit(1); }
  const cap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  // ── layer 1: SYNC — the authoring loop refuses a source that can't render, agent iterates, fix lands ──
  const good = "(endowments, props) => endowments.h('div', null, 'CEL-v1 works')";
  const created = await (await post('/forks/create', { cap, source: good, name: 'CelFork' })).json();
  ok(created.ok && created.id, `a working fork was created (${created.id})`);

  // the DELIBERATE BUG dan specified: an undefined variable at render (the chat-1cbe89a9 v1 class)
  const buggy = "(endowments, props) => endowments.h('div', null, 'total: ' + String(safeSaleAmount))";
  const rejected = await (await post('/forks/edit', { cap, id: created.id, source: buggy })).json();
  ok(rejected.ok === false, 'the buggy edit is REFUSED — the error is the edit result (not a silent ok:true)');
  ok(/render check/i.test(rejected.error || ''), `…as a render-check failure — got: ${String(rejected.error).slice(0, 120)}`);
  ok(/safeSaleAmount is not defined/.test(rejected.error || ''), '…naming the EXACT underlying error (safeSaleAmount is not defined)');
  const after = await (await post('/forks/read', { cap, id: created.id })).json();
  ok(after.ok && /CEL-v1 works/.test(after.source || '') && after.version === 1, 'the broken version was NEVER saved — v1 (working) stays live');

  // the agent ITERATES on the returned error: second edit fixes the bug → lands as v2
  const fixed = "(endowments, props) => { const safeSaleAmount = 1000000; return endowments.h('div', null, 'total: ' + String(safeSaleAmount)); }";
  const applied = await (await post('/forks/edit', { cap, id: created.id, source: fixed })).json();
  ok(applied.ok && applied.version === 2, `the FIXED source (the iterate step) lands (v${applied.version})`);
  const final = await (await post('/forks/read', { cap, id: created.id })).json();
  ok(final.ok && /const safeSaleAmount/.test(final.source || ''), 'the fixed fork reads back live — bug → error → iterate → fixed, round-tripped');

  // ── layer 2: ASYNC — a runtime error queues for its chat and reaches the agent's next turn ──────────
  const sid = `cel-proof-${Date.now()}`;
  const flagged = await (await post('/error/flag', { cap, kind: 'component-render', sessionId: sid, name: 'Equity Slice Simulator', error: "component threw while building: safeSaleAmount is not defined", source: '(ui) => …' })).json();
  ok(flagged.ok === true && flagged.queued === true, 'a runtime component error posts with its sessionId and is QUEUED for that chat');
  const dup = await (await post('/error/flag', { cap, kind: 'component-render', sessionId: sid, name: 'Equity Slice Simulator', error: "component threw while building: safeSaleAmount is not defined" })).json();
  ok(dup.queued === false, 'the same error re-thrown on re-render dedupes (queued once)');

  // fire the chat turn (the LLM may be unavailable in staging — irrelevant: the injected context is
  // seeded into /chat/context BEFORE the model runs, which is exactly what the model would see).
  post('/chat', { cap, sessionId: sid, text: 'did my widget work?' }).catch(() => {});
  let ctx = null;
  for (let i = 0; i < 30; i++) { const r = await (await post('/chat/context', { cap, sessionId: sid })).json(); const msgs = (r.context && r.context.messages) || []; const usr = msgs.filter(m => m.role === 'user').pop(); if (usr && /SYSTEM render feedback/.test(usr.content)) { ctx = usr.content; break; } await sleep(400); }
  ok(!!ctx, "the agent's next turn CONTAINS the render feedback (seen via /chat/context — what the model sees)");
  ok(ctx && /Equity Slice Simulator/.test(ctx) && /safeSaleAmount is not defined/.test(ctx), '…naming the component and the exact error');
  ok(ctx && /did my widget work\?/.test(ctx), "…prepended to the user's real message, not replacing it");
  // drained: the turn CONSUMED the queue. Deterministic proof: re-flagging the IDENTICAL error now
  // re-queues (queued:true) — impossible unless the turn emptied the per-chat list (dedup proved above).
  const reflag = await (await post('/error/flag', { cap, kind: 'component-render', sessionId: sid, name: 'Equity Slice Simulator', error: "component threw while building: safeSaleAmount is not defined" })).json();
  ok(reflag.queued === true, 'the queue DRAINED into that turn (the identical error re-queues afterward — the list was emptied)');

  // ── layer 3: BROWSER — the real confined frame + app wiring ─────────────────────────────────────────
  let chromium = null; try { ({ chromium } = require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core')); } catch {}
  if (!chromium) {
    console.log('  SKIP - browser layer (playwright-core unavailable)');
  } else {
    const br = await chromium.launch({ executablePath: process.env.FIELD_CHROMIUM || '/usr/bin/chromium', headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' } });
    try {
      // 3a. the REAL confined.html frame reports a MOUNT throw over its channel.
      // Host page = the app root (confined.html's own default-src 'none' CSP would block child iframes).
      const page = await br.newPage({ viewport: { width: 900, height: 700 } });
      await page.goto(`${BASE}/`);
      const mountAndCollect = async source => await page.evaluate(async src => {
        const fr = document.createElement('iframe');
        fr.setAttribute('sandbox', 'allow-scripts');
        fr.src = '/confined.html';
        document.body.appendChild(fr);
        return await new Promise(resolve => {
          const errors = [];
          const timer = setTimeout(() => resolve({ errors, timeout: errors.length === 0 }), 4000);
          window.addEventListener('message', function onMsg(e) {
            const m = e.data; if (!m || m.__cu !== 1) return;
            if (m.type === 'ready') {
              const ch = new MessageChannel();
              ch.port1.onmessage = pe => { const pm = pe.data; if (pm && pm.__cu === 1 && pm.type === 'error') { errors.push({ error: pm.error, runtime: !!pm.runtime }); if (pm.runtime || errors.length) { clearTimeout(timer); setTimeout(() => resolve({ errors }), 300); } } };
              ch.port1.start();
              fr.contentWindow.postMessage({ __cu: 1, type: 'mount', source: src }, '*', [ch.port2]);
            }
          });
        });
      }, source);
      const mountErr = await mountAndCollect("(ui) => { return ui.create('div').text('x: ' + safeSaleAmount); }");
      ok(mountErr.errors.some(e => /threw while building/.test(e.error) && /safeSaleAmount/.test(e.error)), `the LIVE frame reports the mount throw over its port — got: ${JSON.stringify(mountErr.errors).slice(0, 140)}`);

      // 3b. a POST-MOUNT runtime throw is reported too (used to be swallowed — the dead-widget class).
      // The component schedules its own throw after mount → lands on the frame's window.onerror → must
      // be reported over the port with runtime:true (deterministic: no synthetic click race needed).
      const rtDirect = await page.evaluate(async () => {
        const fr = document.createElement('iframe');
        fr.setAttribute('sandbox', 'allow-scripts');
        fr.src = '/confined.html';
        document.body.appendChild(fr);
        return await new Promise(resolve => {
          const errors = [];
          setTimeout(() => resolve({ errors }), 5000);
          window.addEventListener('message', e => {
            const m = e.data; if (!m || m.__cu !== 1) return;
            if (m.type === 'ready') {
              const ch = new MessageChannel();
              ch.port1.onmessage = pe => { const pm = pe.data; if (pm && pm.__cu === 1 && pm.type === 'error' && pm.runtime) { errors.push(pm.error); resolve({ errors }); } };
              ch.port1.start();
              // setTimeout is allowed in the frame: the component schedules its own post-mount throw →
              // lands on window.onerror in the frame → must be REPORTED (was silently swallowed before)
              fr.contentWindow.postMessage({ __cu: 1, type: 'mount', source: "(ui) => { setTimeout(() => { deadButtonBug(); }, 100); return ui.create('div').text('mounted'); }" }, '*', [ch.port2]);
            }
          });
        });
      });
      ok(rtDirect.errors.some(e => /runtime error after mount/.test(e) && /deadButtonBug/.test(e)), `the LIVE frame reports a POST-MOUNT runtime throw (was swallowed before) — got: ${JSON.stringify(rtDirect.errors).slice(0, 140)}`);

      // 3c. the real app page: a reported component error paints the visible system note + POSTs /error/flag
      const app = await br.newPage({ viewport: { width: 1100, height: 900 } });
      let flaggedBody = null;
      await app.route('**/error/flag', async route => { try { flaggedBody = route.request().postDataJSON(); } catch {} await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"queued":true}' }); });
      // cap-hygiene: inject the cap via localStorage BEFORE navigation, never in the URL fragment.
      await app.addInitScript(c => { try { localStorage.setItem('field-agent-cap', c); } catch {} }, cap);
      await app.goto(`${BASE}/`);
      await app.waitForFunction(() => typeof window.__fieldReportError === 'function', null, { timeout: 15000 });
      await app.evaluate(() => window.__fieldReportError('component threw while building: safeSaleAmount is not defined', '(ui) => …', { name: 'Equity Slice Simulator' }));
      await app.waitForSelector('.comp-err-note', { timeout: 5000 });
      const noteText = await app.$eval('.comp-err-note', el => el.textContent);
      ok(/Equity Slice Simulator/.test(noteText) && /safeSaleAmount/.test(noteText), `the visible system note renders in the transcript — "${String(noteText).slice(0, 110)}…"`);
      ok(!!flaggedBody && flaggedBody.name === 'Equity Slice Simulator' && typeof flaggedBody.sessionId === 'string' && /safeSaleAmount/.test(flaggedBody.error || ''), `/error/flag carries {sessionId, name, error} — sessionId=${flaggedBody && JSON.stringify(flaggedBody.sessionId)}`);
      const pageErrs = [];
      app.on('pageerror', e => pageErrs.push(e.message));
      ok(pageErrs.length === 0, 'no page errors while reporting');
    } finally { try { await br.close(); } catch {} }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('test crashed:', e); cleanup(); process.exit(1); });
