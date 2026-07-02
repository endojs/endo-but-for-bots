#!/usr/bin/env node
// turn-watchdog.staging.test.cjs — a STAGING (real-run) guard for the P1-6 unanswered-turn watchdog.
//
// Boots an ISOLATED voice-agent (ephemeral port, mkdtemp state — NEVER live :8778) with WATCHDOG_TEST_SEAM=1
// and asserts, over the REAL server tick, that BOTH unanswered-turn shapes are detected → retry/notify:
//   (a) an in-memory runResults[sid]='running' with a DEAD run (no live controller) — the /chat/result
//       "running" lie — is RETRIED (deterministic offline stub) and lands a TERMINAL 'done' (recovered)
//       state so the client stops hanging;
//   (b) a PERSISTED chat (saved via the real /chats/save) ending on a user message with no assistant reply
//       is DETECTED and its chatId is notified (added to the watchdog's notified set).
//
// Run: node turn-watchdog.staging.test.cjs   (exits non-zero on any failure)

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 8814;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-watchdog-staging-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

const post = (pathname, body) => new Promise((resolve, reject) => {
  const q = http.request(`${BASE}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' } }, x => {
    let d = ''; x.on('data', c => (d += c)); x.on('end', () => { try { resolve({ status: x.statusCode, body: d ? JSON.parse(d) : null }); } catch { resolve({ status: x.statusCode, body: d }); } });
  });
  q.on('error', reject); q.end(JSON.stringify(body));
});

(async () => {
  const dash = path.join(tmp, 'dash');
  const voice = path.join(tmp, 'voice');
  srv = spawn('node', ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1', WATCHDOG_TEST_SEAM: '1',
      WATCHDOG_INTERVAL_MS: '999999999', // don't let the auto-tick race the test; we drive /watchdog/_tick
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      DASH_STATE_DIR: dash, VOICE_STATE_DIR: voice,
      MEMO_RUNS_FILE: path.join(tmp, 'memo.json'), SEED_CHATS_FILE: path.join(tmp, 'seed-chats.json'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), PRINT_ROOT_CAP: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const swissPath = path.join(tmp, 'root.swiss');
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if ((r.ok || r.status === 404) && fs.existsSync(swissPath)) { up = true; break; } } catch {} await sleep(500); }
  ok(up, 'isolated server booted (root.swiss written)');
  if (!up) { cleanup(); process.exit(1); }
  const rootCap = fs.readFileSync(swissPath, 'utf8').trim();

  // ── (a) a stuck-'running'-but-DEAD run → retry + terminal 'done' (recovered) ───────────────────────
  const stuckSid = 'chat-stuck-1';
  await post('/watchdog/_inject-run', { cap: rootCap, sid: stuckSid, text: 'what is the capital of France?' });
  // sanity: /chat/result reports the STALE 'running' before the watchdog runs (the hang the ticket describes)
  const before = await post('/chat/result', { cap: rootCap, sessionId: stuckSid });
  ok(before.body && before.body.state === 'running', 'pre-watchdog: /chat/result still reports "running" for the dead run (the hang)');

  // ── (b) a persisted chat ending on a user message with no assistant reply (saved via the real route) ─
  const unSid = 'chat-unanswered-1';
  const old = Date.now() - 400000; // older than the 360s deadline, well within the 6h recent window
  await post('/chats/save', { cap: rootCap, data: { chats: [{ id: unSid, title: 'Unanswered', lastMsgAt: old }], tx: { [unSid]: [{ who: 'you', text: 'remind me to call the dentist', at: old }] } } });

  // drive ONE watchdog pass and read back the resulting states
  const tick = await post('/watchdog/_tick', { cap: rootCap, sids: [stuckSid] });
  ok(tick.body && tick.body.ok, 'watchdog tick ran');
  const st = tick.body && tick.body.states && tick.body.states[stuckSid];
  ok(st && st.state === 'done', `(a) the stuck run was RETRIED to a terminal 'done' state (got: ${st && st.state})`);
  ok(st && st.recovered === true, '(a) the recovered payload is marked recovered:true');
  ok(tick.body && Array.isArray(tick.body.notifiedChats) && tick.body.notifiedChats.includes(unSid), `(b) the unanswered persisted chat was detected + notified (${(tick.body && tick.body.notifiedChats || []).join(',')})`);

  // post-watchdog: /chat/result now reports a real terminal outcome (never 'running' forever) + the answer
  const after = await post('/chat/result', { cap: rootCap, sessionId: stuckSid });
  ok(after.body && after.body.state === 'done', 'post-watchdog: /chat/result reports the recovered terminal state (the client stops hanging)');
  ok(after.body && after.body.result && /watchdog test recovery/i.test(String(after.body.result.answer || '')), 'post-watchdog: the recovered answer is served to a re-attaching client');

  // idempotence: a second tick does not re-notify the same unanswered chat, and doesn't un-finish the run
  const tick2 = await post('/watchdog/_tick', { cap: rootCap, sids: [stuckSid] });
  const notifiedCount = (tick2.body.notifiedChats || []).filter(c => c === unSid).length;
  ok(notifiedCount === 1, '(b) a second tick does NOT re-notify the same unanswered chat (deduped)');

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('staging test error:', e && e.message); cleanup(); process.exit(2); });
