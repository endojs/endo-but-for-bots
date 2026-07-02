#!/usr/bin/env node
// p15-restart-idempotency.staging.test.mjs — P1-5 proven END-TO-END against a REAL voice-agent server that is
// KILLED mid-turn and RESTARTED over the SAME stores. The money-shot: a destructive tool must fire EXACTLY ONCE
// TOTAL across the restart — never twice.
//
// Mechanism (all via the P15_TEST_SEAM=1 seam — no model, no real side effects, no live :8778):
//   • an injected DESTRUCTIVE `testFire` verb whose fire-count is a FILE (survives the restart), and
//   • a scripted LLM: turn 1 writes a program that fires testFire and returns; once that OUTPUT is in the
//     transcript it answers 'recovered-ok'. P15_TEST_HANG=1 makes the post-fire step BLOCK so we can SIGKILL the
//     server exactly mid-turn (after the fire, before completion).
//
// Two recoveries are exercised, each on its own sandbox dir + counter:
//   A) REPLAY:  server B replays the persisted transcript (resume:true) → testFire is never reached → counter 1.
//   B) LEDGER:  the durable transcript is deleted → server B does a FULL re-run → the model re-emits the testFire
//               program, but the idempotency ledger short-circuits the real verb → counter STILL 1.
//
// Run: npm run test:p15-restart   (in packages/chat/voice-agent)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const live = new Set();
const killAll = () => { for (const c of [...live]) { try { c.kill('SIGKILL'); } catch {} } };
process.on('exit', killAll); process.on('SIGINT', () => { killAll(); process.exit(130); }); process.on('SIGTERM', () => { killAll(); process.exit(143); });

const counterOf = f => { try { return parseInt(fs.readFileSync(f, 'utf8'), 10) || 0; } catch { return 0; } };
const resumePathFor = (voiceDir, sid) => path.join(voiceDir, 'turn-resume', crypto.createHash('sha256').update(String(sid)).digest('hex').slice(0, 40) + '.json');

// Boot a voice-agent server over the GIVEN sandbox dirs (so a second boot recovers the first's state). Returns the
// child + a promise that resolves once it answers HTTP. AGENT_LLM points at a dead port so classifyTurn fail-opens
// fast (the only real callLLM; the turn itself runs on the scripted seam LLM).
async function boot({ port, tmp, counterFile, hang }) {
  const env = {
    ...process.env, PORT: String(port), BIND: '127.0.0.1', BIND_DEFAULT: '127.0.0.1',
    FIELD_MODE: 'personal', PRINT_ROOT_CAP: '1',
    FIELD_CONFIG_DIR: path.join(tmp, 'config'), FIELD_STATE_DIR: path.join(tmp, 'state'),
    VOICE_STATE_DIR: path.join(tmp, 'voice'), DASH_STATE_DIR: path.join(tmp, 'dash'),
    OBSIDIAN_VAULT: path.join(tmp, 'vault'), FIELD_HOME_BASE: path.join(tmp, 'home'),
    SEED_FILE: path.join(tmp, 'config', 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
    AGENT_LLM: 'http://127.0.0.1:1/dead', // classifyTurn fail-opens instantly (never used by the seam turn)
    P15_TEST_SEAM: '1', P15_TEST_COUNTER: counterFile, ...(hang ? { P15_TEST_HANG: '1' } : {}),
  };
  const c = spawn('node', ['server.mjs'], { cwd: HERE, env, stdio: ['ignore', 'ignore', 'ignore'] });
  live.add(c);
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (c.exitCode !== null) throw new Error('server exited during boot');
    try { const r = await fetch(base); if (r.ok || r.status === 404) return c; } catch {} // eslint-disable-line no-await-in-loop
    await sleep(200); // eslint-disable-line no-await-in-loop
  }
  throw new Error('server did not boot');
}
const rootCap = tmp => { const f = path.join(tmp, 'config', 'root.swiss'); for (let i = 0; i < 60; i++) { try { const s = fs.readFileSync(f, 'utf8').trim(); if (s) return s; } catch {} } return ''; };
const postNoWait = (port, body) => { fetch(`http://127.0.0.1:${port}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {}); };
const post = async (port, p, body) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch {} return { status: r.status, body: j, raw: txt }; };

// Drive server A: fire the destructive verb, HANG mid-turn, then SIGKILL — leaving the durable transcript+ledger.
async function fireAndKill({ tmp, counterFile, sid, port }) {
  const a = await boot({ port, tmp, counterFile, hang: true });
  const cap = rootCap(tmp);
  if (!cap) throw new Error('no root cap minted');
  postNoWait(port, { sessionId: sid, text: 'fire it', cap }); // hangs after the fire
  // wait for the destructive fire (durable counter → 1), then for the transcript to be persisted
  const rp = resumePathFor(path.join(tmp, 'voice'), sid);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !(counterOf(counterFile) >= 1 && fs.existsSync(rp))) await sleep(150); // eslint-disable-line no-await-in-loop
  ok(counterOf(counterFile) === 1, `[setup ${sid}] the destructive tool fired once on server A (counter=${counterOf(counterFile)})`);
  ok(fs.existsSync(rp), `[setup ${sid}] the in-flight transcript was persisted durably before the kill`);
  try { a.kill('SIGKILL'); } catch {} live.delete(a);
  await sleep(400); // let the port free + the SIGKILL settle
  return cap;
}

(async () => {
  // ── A) REPLAY recovery: resume:true on a restarted server replays the transcript; testFire not re-reached ──
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p15-replay-'));
    const counterFile = path.join(tmp, 'counter');
    const sid = 'p15-replay';
    const portA = 21000 + (process.pid % 1000);
    const cap = await fireAndKill({ tmp, counterFile, sid, port: portA });

    const portB = portA + 1;
    await boot({ port: portB, tmp, counterFile, hang: false }); // restart, no hang → it will answer
    const r = await post(portB, '/chat', { sessionId: sid, text: 'fire it', cap, resume: true });
    ok(r.status === 200, `[REPLAY] recovery /chat returned 200 (got ${r.status})`);
    ok(r.body && /recovered-ok/.test(r.body.answer || ''), `[REPLAY] the turn completed with the right answer (${r.body && JSON.stringify(r.body.answer)})`);
    ok(counterOf(counterFile) === 1, `THE MONEY SHOT [REPLAY]: the destructive tool fired EXACTLY ONCE total across the restart (counter=${counterOf(counterFile)}, must be 1 not 2)`);
    killAll(); live.clear();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    await sleep(300);
  }

  // ── B) LEDGER recovery: delete the durable transcript → server B FULL-re-runs → ledger blocks the second fire ──
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p15-ledger-'));
    const counterFile = path.join(tmp, 'counter');
    const sid = 'p15-ledger';
    const portA = 22000 + (process.pid % 1000);
    const cap = await fireAndKill({ tmp, counterFile, sid, port: portA });

    // Simulate the WORST case: the transcript persist did NOT survive but the destructive verb DID commit (its
    // ledger entry is written when it fires). Deleting the transcript forces server B into a FULL re-run.
    try { fs.rmSync(resumePathFor(path.join(tmp, 'voice'), sid), { force: true }); } catch {}
    ok(!fs.existsSync(resumePathFor(path.join(tmp, 'voice'), sid)), '[LEDGER] durable transcript removed → recovery must FULL-re-run (no replay)');

    const portB = portA + 1;
    await boot({ port: portB, tmp, counterFile, hang: false });
    const r = await post(portB, '/chat', { sessionId: sid, text: 'fire it', cap }); // NO resume → full re-run
    ok(r.status === 200, `[LEDGER] recovery /chat returned 200 (got ${r.status})`);
    ok(r.body && /recovered-ok/.test(r.body.answer || ''), `[LEDGER] the turn completed with the right answer (${r.body && JSON.stringify(r.body.answer)})`);
    ok(counterOf(counterFile) === 1, `THE MONEY SHOT [LEDGER]: a FULL re-run re-emitted the destructive program but the ledger blocked the second fire — counter=${counterOf(counterFile)} (must be 1 not 2)`);
    killAll(); live.clear();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log(`\nP1-5 restart-idempotency: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ABORT', e && e.stack || e); killAll(); process.exit(1); });
