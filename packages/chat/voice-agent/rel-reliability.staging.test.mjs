#!/usr/bin/env node
// rel-reliability.staging.test.mjs — REL-1 + REL-2 proven against a REAL isolated voice-agent server.
//
// REL-1 (the 13% zero-turn + silent hang): an in-window throw in /chat must NOT escape to the plaintext
//   outer catch (client JSON dead-end) and must NOT leave runResults[sid]='running' forever. The handler
//   must instead return 200 { error, retryable:true } JSON and leave a TERMINAL runResults state.
// REL-2 (process crash = mass zero-turn): the outer catch must not double-end an already-ended response,
//   and a stray promise rejection must not kill the process. Both are exercised via env-gated test seams.
//
// Mirrors user-agency-allowance.staging.test.mjs: fresh root cap + state dirs, real server, HTTP only.
// Run: npm run test:reliability   (in packages/chat/voice-agent)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8796;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-reliability-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const die = m => { console.error('  ABORT -', m); cleanup(); process.exit(1); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
const post = async (p, body) => { const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const txt = await r.text(); let json = null; try { json = JSON.parse(txt); } catch {} return { status: r.status, body: json, raw: txt, ct: r.headers.get('content-type') }; };
const get = async p => { const r = await fetch(`${BASE}${p}`); const txt = await r.text(); let json = null; try { json = JSON.parse(txt); } catch {} return { status: r.status, body: json, raw: txt }; };

(async () => {
  // Boot an isolated server with BOTH test seams armed.
  srv = spawn('node', ['server.mjs'], {
    cwd: HERE,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      VOICE_STATE_DIR: path.join(tmp, 'voice-state'),
      REL_TEST_ROUTES: '1', REL_TEST_CHAT_THROW: '1' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); } // eslint-disable-line no-await-in-loop
  if (!up) die('isolated server did not boot');
  ok(up, 'isolated server booted');
  const root = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  // ── REL-1: an in-window throw in /chat → 200 retryable JSON, terminal runResults, no stuck run ──
  const sid = 'rel1-sid';
  const c = await post('/chat', { sessionId: sid, text: 'hello', cap: root });
  ok(c.status === 200, `/chat returns 200 on an in-window throw (got ${c.status})`);
  ok(c.body && c.body.retryable === true, 'response is { retryable:true } (client can parse + retry)');
  ok(c.ct && c.ct.includes('application/json'), `content-type is JSON, not plaintext (got ${c.ct})`);
  ok(c.raw !== 'error', 'body is NOT the plaintext "error" that dead-ends client res.json()');
  // /chat/result must report a TERMINAL state (not 'running' forever = the silent hang).
  const rr = await post('/chat/result', { sessionId: sid, cap: root });
  ok(rr.status === 200 && rr.body && rr.body.state && rr.body.state !== 'running', `runResults is terminal, not 'running' (state=${rr.body && rr.body.state})`);
  ok(rr.body && rr.body.state === 'error', `runResults ended in the terminal 'error' state (state=${rr.body && rr.body.state})`);

  // ── REL-2a: a route that throws AFTER res ended must NOT crash the process ──
  const te = await get('/rel-test/throw-after-end');
  ok(te.status === 200 && te.body && te.body.ok === true, 'throw-after-end still delivered its 200 response');
  await sleep(300);
  const alive1 = await get('/rel-test/ping');
  ok(alive1.status === 200 && alive1.body && alive1.body.alive === true, 'server STILL SERVING after a throw-after-end (no ERR_STREAM_WRITE_AFTER_END crash)');

  // ── REL-2b: a stray promise rejection must be logged + the server must keep serving ──
  const ur = await post('/rel-test/unhandled-rejection', {});
  ok(ur.status === 200 && ur.body && ur.body.ok === true, 'unhandled-rejection route returned normally');
  await sleep(300);
  const alive2 = await get('/rel-test/ping');
  ok(alive2.status === 200 && alive2.body && alive2.body.alive === true, 'server STILL SERVING after an unhandledRejection (global handler kept it alive)');

  console.log(`\nREL reliability: ${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
