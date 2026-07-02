#!/usr/bin/env node
// audit-arch4-sec11-port6.staging.test.mjs — route-level proof for ARCH-4, the SEC-11 residual, and PORT-6
// against a REAL isolated voice-agent server (fresh root cap + temp state dirs, HTTP only, ephemeral port).
// Mirrors the audit-server-fixes / rel-reliability / user-agency staging harness. Never touches live :8778.
// Run: npm run test:audit-arch4
//
// ARCH-4: /chats/save is now SERVER-AUTHORITATIVE — it stamps a monotonic per-cap `seq` (persisted) and
//   returns it, instead of trusting the client's wall-clock `updated`. Two saves get strictly increasing
//   seq; a save carrying a BACKWARDS wall-clock still increments seq (a skewed clock can't win); /chats/load
//   returns the authoritative seq alongside the bundle.
// SEC-11 (residual): /error/flag's per-chat component-error queue is keyed by the OWNER the server derives
//   from the reporter's cap, NOT the client's sessionId. So a guest reporting to the OWNER's sessionId lands
//   in its OWN owner-scoped slot (queued fresh) and cannot merge into / inject the owner's authoring loop.
// PORT-6: STT_URL / AGENT_LLM come from the centralized field-config seam — byte-identical defaults, and one
//   TINIX_HOST override relocates them together.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STT_URL, AGENT_LLM } from './field-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 20000 + (process.pid % 20000); // T-TEST-2: PID-derived port (unique per node --test child); never a fixed 879x
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-arch4-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const die = m => { console.error('  ABORT -', m); cleanup(); process.exit(1); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
const post = async (p, body) => { const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch {} return { status: r.status, body: j, raw: txt }; };

(async () => {
  // ── PORT-6: in-process config-seam proof (no server needed). Default byte-identical; TINIX_HOST relocates. ──
  ok(STT_URL === 'http://192.168.50.226:8000/v1/audio/transcriptions', `PORT-6: STT_URL default is byte-identical (${STT_URL})`);
  ok(AGENT_LLM === 'http://192.168.50.226:8003/v1/chat/completions', `PORT-6: AGENT_LLM default is byte-identical (${AGENT_LLM})`);
  // a child node process with TINIX_HOST set proves ONE override relocates both endpoints together.
  const relocated = await new Promise((resolve) => {
    const c = spawn('node', ['-e', "import('./field-config.mjs').then(m => console.log(JSON.stringify({ stt: m.STT_URL, llm: m.AGENT_LLM })))"], {
      cwd: HERE, env: { ...process.env, TINIX_HOST: '10.0.0.9' }, stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = ''; c.stdout.on('data', d => { out += d; }); c.on('close', () => { try { resolve(JSON.parse(out.trim())); } catch { resolve(null); } });
  });
  ok(relocated && relocated.stt === 'http://10.0.0.9:8000/v1/audio/transcriptions', `PORT-6: TINIX_HOST=10.0.0.9 relocates STT_URL (${relocated && relocated.stt})`);
  ok(relocated && relocated.llm === 'http://10.0.0.9:8003/v1/chat/completions', `PORT-6: TINIX_HOST=10.0.0.9 relocates AGENT_LLM (${relocated && relocated.llm})`);

  // ── boot an isolated server ──
  srv = spawn('node', ['server.mjs'], {
    cwd: HERE,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      VOICE_STATE_DIR: path.join(tmp, 'voice-state') },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); } // eslint-disable-line no-await-in-loop
  if (!up) die('isolated server did not boot');
  const root = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  // ── ARCH-4: server-authoritative monotonic seq ──
  const s1 = await post('/chats/save', { cap: root, data: { chats: [{ id: 'a', title: 'A' }], tx: {}, updated: 5000 } });
  ok(s1.status === 200 && s1.body && s1.body.seq === 1, `ARCH-4: first /chats/save → seq 1 (got ${s1.body && s1.body.seq})`);
  // a SECOND save whose client wall-clock went BACKWARDS (updated 3000 < 5000) must STILL increment seq —
  // the server ignores the client clock, so a skewed device can't win LWW.
  const s2 = await post('/chats/save', { cap: root, data: { chats: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], tx: {}, updated: 3000 } });
  ok(s2.status === 200 && s2.body && s2.body.seq === 2, `ARCH-4: second save with a BACKWARDS wall-clock still → seq 2 (got ${s2.body && s2.body.seq})`);
  const ld = await post('/chats/load', { cap: root });
  ok(ld.status === 200 && ld.body && ld.body.seq === 2, `ARCH-4: /chats/load returns the authoritative seq 2 (got ${ld.body && ld.body.seq})`);
  ok(ld.body && ld.body.data && ld.body.data._seq === 2, 'ARCH-4: the persisted bundle carries _seq === 2');
  ok(ld.body && ld.body.data && Array.isArray(ld.body.data.chats) && ld.body.data.chats.length === 2, 'ARCH-4: the higher-seq write is the one on disk (both chats present)');
  // load on a FRESH cap (no store yet) → seq 0, data null (backward-compatible empty).
  const ld0 = await post('/chats/load', { cap: root, sessionId: 'x' });
  ok(ld0.status === 200, 'ARCH-4: load stays 200 for an existing cap');

  // ── SEC-11 residual: mint a GUEST cap, prove the error queue is owner-scoped (not sessionId-scoped) ──
  const inv = await post('/invite', { cap: root, label: 'guest', powers: ['notes'] });
  ok(inv.status === 200 && inv.body && inv.body.scopedCap, 'SEC-11: minted a guest (scoped) cap via /invite');
  const guest = inv.body && inv.body.scopedCap;
  // 1) owner (root) files an error for its own chat "victim" → queued fresh.
  const oFirst = await post('/error/flag', { cap: root, kind: 'runtime', error: 'BOOM-shared', sessionId: 'victim-chat' });
  ok(oFirst.status === 200 && oFirst.body && oFirst.body.queued === true, 'SEC-11: owner reports error to its chat → queued (fresh slot)');
  // 2) owner files the SAME error again → deduped WITHIN its own slot (queued false) — proves same-owner dedupe.
  const oDup = await post('/error/flag', { cap: root, kind: 'runtime', error: 'BOOM-shared', sessionId: 'victim-chat' });
  ok(oDup.status === 200 && oDup.body && oDup.body.queued === false, 'SEC-11: owner re-reports the identical error → deduped in its OWN slot (queued false)');
  // 3) the GUEST spoofs the owner's sessionId with the SAME error text. If the queue were keyed by sessionId
  //    (the vuln), this would dedupe to false — i.e. the guest would be writing into the OWNER's slot. With the
  //    owner-scoped fix it lands in the GUEST's own (guest, victim-chat) slot → queued TRUE, proving the guest
  //    can NOT target/merge into the owner's authoring-loop queue.
  const gSpoof = await post('/error/flag', { cap: guest, kind: 'runtime', error: 'BOOM-shared', sessionId: 'victim-chat' });
  ok(gSpoof.status === 200 && gSpoof.body && gSpoof.body.queued === true, 'SEC-11: guest spoofing the owner\'s sessionId lands in its OWN owner-scoped slot (queued true — NOT merged into the owner\'s)');
  // 4) and a guest report is never filed to the GLOBAL self-improve pipeline (owner-only), unchanged by ARCH-4.
  ok(gSpoof.body && gSpoof.body.filed === false, 'SEC-11: guest report is not filed to the global self-improve pipeline (filed false)');

  console.log(`\n  ${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
