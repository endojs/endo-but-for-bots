#!/usr/bin/env node
// seed-chat-no-persist.staging.test.mjs — INT-3. A seed-chat is a GLOBAL, read-time view; adopting one must
// NOT write it into the presenting cap's per-cap store (that fan-out replicated 1305 rows → 191 unique, each
// independently mutable so titles diverged). The server's /chats/save must DROP seed-owned ids from the bundle
// while keeping the cap's own chats — and /seed-chats/load must still surface the seed (the view is intact).
//
// Isolated server, ephemeral port, mkdtemp stores — never the live :8778.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 20000 + (process.pid % 20000); // T-TEST-2: PID-derived port (unique per node --test child); never a fixed 879x
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'int3-seed-'));
const SEED_FILE = path.join(tmp, 'seed-chats.json');
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
const post = async (p, body) => { const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

(async () => {
  // Pre-populate the GLOBAL seed-chats store with one ingested voice note.
  fs.writeFileSync(SEED_FILE, JSON.stringify({ chats: [{ id: 'seed-voice-1', title: 'voice note', ts: Date.now(), tx: [{ who: 'you', text: 'hi' }] }] }));

  srv = spawn('node', ['server.mjs'], {
    cwd: HERE,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      VOICE_STATE_DIR: path.join(tmp, 'voice-state'), SEED_CHATS_FILE: SEED_FILE,
      DELEGATION_STORE: path.join(tmp, 'd.json'), PROJECTS_STORE: path.join(tmp, 'p.json'), MEMO_RUNS_FILE: path.join(tmp, 'm.json') },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  if (!up) { console.error('  ABORT - no boot'); cleanup(); process.exit(1); }
  ok(up, 'isolated server booted');
  const root = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  // 1. the seed is visible via the global view.
  const sl0 = await post('/seed-chats/load', { cap: root });
  ok(sl0.status === 200 && (sl0.body.chats || []).some(c => c.id === 'seed-voice-1'), 'the seed voice-note shows in /seed-chats/load (the read-time view)');

  // 2. a client saves a bundle that (like the old buggy client) INCLUDES the adopted seed + a REAL own chat.
  const save = await post('/chats/save', { cap: root, data: {
    chats: [{ id: 'seed-voice-1', title: 'voice note' }, { id: 'own-abc', title: 'my own chat' }],
    tx: { 'seed-voice-1': [{ who: 'you', text: 'hi' }], 'own-abc': [{ who: 'you', text: 'mine' }] },
    updated: Date.now(),
  } });
  ok(save.status === 200 && save.body.ok, 'the bundle saved');

  // 3. the persisted per-cap store keeps the OWN chat but DROPPED the seed (no per-cap replication).
  const load = await post('/chats/load', { cap: root });
  const stored = (load.body && load.body.data) || {};
  const ids = (stored.chats || []).map(c => c.id);
  ok(ids.includes('own-abc'), 'the cap’s OWN chat was persisted');
  ok(!ids.includes('seed-voice-1'), 'the adopted seed was NOT persisted into the cap’s store (no fan-out)');
  ok(!stored.tx || !('seed-voice-1' in stored.tx), 'the seed’s transcript was NOT persisted either');
  ok(stored.tx && stored.tx['own-abc'], 'the own chat’s transcript WAS persisted');

  // 4. the seed still shows in the global view (adoption is read-time, not destructive).
  const sl1 = await post('/seed-chats/load', { cap: root });
  ok((sl1.body.chats || []).some(c => c.id === 'seed-voice-1'), 'the seed still shows in /seed-chats/load after the save');

  cleanup();
  console.log(`\n${fail ? '✗' : '✓'} seed-chat no-persist: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('  UNCAUGHT -', e && e.message); cleanup(); process.exit(1); });
