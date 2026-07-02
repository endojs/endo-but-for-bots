#!/usr/bin/env node
// audit-server-fixes.staging.test.mjs — route-level proof for SEC-10, SEC-11 and PORT-1 against a REAL
// isolated voice-agent server (fresh root cap + temp state dirs, HTTP only). Mirrors the
// rel-reliability / user-agency staging harness. Run: npm run test:audit-fixes
//
// PORT-1: the server is booted with NO explicit BIND and a BIND_DEFAULT whose first address is a TEST-NET
//   (203.0.113.7) that this host does NOT have. The old default would EADDRNOTAVAIL-crash; the fix filters
//   the default to present addresses, so it must still boot + serve on 127.0.0.1.
// SEC-10: /toll/* is cap-gated (no cap → 403), works with a valid cap, and rate-limits a burst (→ 429).
// SEC-11: /error/flag is cap-gated (no cap → 403) and accepts an owner (root) report.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 20000 + (process.pid % 20000); // T-TEST-2: PID-derived port (unique per node --test child); never a fixed 879x
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-fixes-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const die = m => { console.error('  ABORT -', m); cleanup(); process.exit(1); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
const post = async (p, body) => { const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch {} return { status: r.status, body: j, raw: txt }; };

(async () => {
  srv = spawn('node', ['server.mjs'], {
    cwd: HERE,
    env: { ...process.env, PORT: String(PORT),
      // PORT-1: no BIND; a default whose first entry is a TEST-NET address this host lacks.
      BIND_DEFAULT: '203.0.113.7,127.0.0.1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      VOICE_STATE_DIR: path.join(tmp, 'voice-state'),
      TOLL_RATE_MAX: '60' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); } // eslint-disable-line no-await-in-loop
  if (!up) die('isolated server did not boot');
  // PORT-1: it booted + serves on loopback despite the absent TEST-NET address in the default BIND list.
  ok(up, 'PORT-1: server self-heals — boots + serves on 127.0.0.1 though the default BIND had an absent TEST-NET IP');
  const root = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  // ── SEC-10: cap gate + valid-cap success ──
  const noCap = await post('/toll/check', { account: 'acct-A' });
  ok(noCap.status === 403, `SEC-10: /toll/check with NO cap → 403 (got ${noCap.status})`);
  const badCap = await post('/toll/check', { cap: 'not-a-real-swissnum', account: 'acct-A' });
  ok(badCap.status === 403, `SEC-10: /toll/check with an invalid cap → 403 (got ${badCap.status})`);
  const rootCheck = await post('/toll/check', { cap: root, account: 'acct-A' });
  ok(rootCheck.status === 200 && rootCheck.body && typeof rootCheck.body.remaining === 'number', 'SEC-10: /toll/check with a valid cap → 200 with a balance');
  const rootAcct = await post('/toll/account', { cap: root, account: 'acct-A' });
  ok(rootAcct.status === 200 && rootAcct.body && Array.isArray(rootAcct.body.hosting), 'SEC-10: /toll/account with a valid cap → 200');
  const acctNoCap = await post('/toll/account', { account: 'acct-A' });
  ok(acctNoCap.status === 403, `SEC-10: /toll/account with NO cap → 403 (got ${acctNoCap.status})`);

  // ── SEC-10: per-cap rate limit → a burst eventually 429s ──
  let saw429 = false;
  for (let i = 0; i < 75; i++) { const r = await post('/toll/check', { cap: root, account: 'acct-rate' }); if (r.status === 429) { saw429 = true; break; } } // eslint-disable-line no-await-in-loop
  ok(saw429, 'SEC-10: a burst of toll ops from one cap eventually hits the rate limit (429)');

  // ── SEC-11: /error/flag cap gate + owner accepts ──
  const efNoCap = await post('/error/flag', { kind: 'runtime', error: 'boom', sessionId: 's1' });
  ok(efNoCap.status === 403, `SEC-11: /error/flag with NO cap → 403 (got ${efNoCap.status})`);
  const efRoot = await post('/error/flag', { cap: root, kind: 'runtime', error: 'owner-reported boom', sessionId: 's1' });
  ok(efRoot.status === 200 && efRoot.body && efRoot.body.ok === true, 'SEC-11: /error/flag with the owner (root) cap → 200 ok');

  console.log(`\n  ${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
