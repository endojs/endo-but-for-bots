#!/usr/bin/env node
// user-agency-allowance.staging.test.mjs — the User Agency loop end-to-end, like Joshua: an isolated
// voice-agent server proves that
//   1. an INVITE can CARRY a usage-credit allowance — minted funded, CONSERVED (the owner's invite
//      wallet is debited exactly what the member's shared wallet is credited; can't-cover → 402);
//   2. the member's caps (and sub-caps minted from them) all draw from that ONE zero-seeded wallet;
//   3. a REAL member turn (live inference through the real /chat loop) charges the funded wallet;
//   4. when the wallet runs dry, /chat answers the DETERMINISTIC top-up state the client's exhaustion
//      card renders from ({exhausted:true, invited:true}) and the existing payment rails
//      (/pay/delegation/status → the MetaMask ERC-7715 grant flow, /pay/checkout) answer for the member.
//
// Mirrors pay-rail.staging.test.mjs: fresh root cap + state dirs, real server, HTTP only.
// Step 3 performs real (local-model) inference — the box's default LLM must be reachable.
//
// Run: npm run test:user-agency   (in packages/chat/voice-agent)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}`;
const WALLET_SEED = 500_000;   // the owner's invite wallet, $0.50 — small so conservation is visible
const ALLOWANCE = 300_000;     // the invite carries $0.30

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'user-agency-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const die = m => { console.error('  ABORT -', m); cleanup(); process.exit(1); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

const post = async (p, body) => { const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

(async () => {
  // ── 1. isolated server, fresh root cap + state, deterministic wallet seed ──
  srv = spawn('node', ['server.mjs'], {
    cwd: HERE,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      VOICE_STATE_DIR: path.join(tmp, 'voice-state'), DELEGATION_STORE: path.join(tmp, 'delegations.json'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json'),
      ROOT_WALLET_UUSD: String(WALLET_SEED) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  if (!up) die('isolated server did not boot');
  ok(up, 'isolated server booted');
  const root = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  // ── 2. the owner's invite wallet is root-gated + seeded ──
  const w0 = await post('/wallet/status', { cap: root });
  ok(w0.status === 200 && w0.body.remaining === WALLET_SEED, `invite wallet seeded: ${w0.body.remaining} µUSD`);

  // ── 3. mint an invite CARRYING an allowance → conserved transfer owner → member ──
  const inv = await post('/invite', { cap: root, powers: ['reference'], label: 'staging-member', allowanceUusd: ALLOWANCE });
  ok(inv.status === 200 && !!inv.body.scopedCap, 'funded invite minted');
  ok(inv.body.allowanceUusd === ALLOWANCE, `invite carries the allowance (${inv.body.allowanceUusd} µUSD)`);
  ok(inv.body.walletRemaining === WALLET_SEED - ALLOWANCE, `owner wallet debited exactly the allowance (${inv.body.walletRemaining} left)`);
  const member = inv.body.scopedCap;

  // a NON-root cap cannot reach the wallet (fund() stays the owner's only balance-increaser)
  const wm = await post('/wallet/fund', { cap: member, amount: 1_000_000 });
  ok(wm.status === 403, 'member cannot fund wallets (403)');

  // ── 4. ONE shared zero-seeded wallet across the member's chats + sub-caps ──
  const b1 = await post('/budget', { cap: member, sessionId: 'chat-one' });
  const b2 = await post('/budget', { cap: member, sessionId: 'chat-two' });
  ok(b1.body.remaining === ALLOWANCE && b2.body.remaining === ALLOWANCE, `member chats share the funded wallet (${b1.body.remaining} µUSD, not the per-chat default)`);
  const sub = await post('/subchat', { cap: member, powers: ['reference'], title: 'sub' });
  ok(sub.status === 200 && !!sub.body.scopedCap, 'member minted a sub-chat cap');
  const bs = await post('/budget', { cap: sub.body.scopedCap, sessionId: 'sub-one' });
  ok(bs.body.remaining === ALLOWANCE, 'the sub-cap ADOPTED the member wallet (same balance, no thin-air purse)');

  // ── 5. OVER-ALLOWANCE: an invite the wallet can't cover is refused, nothing minted/debited ──
  const over = await post('/invite', { cap: root, powers: ['reference'], label: 'too-rich', allowanceUusd: 900_000 });
  ok(over.status === 402, `over-allowance invite refused (402: ${String(over.body.error).slice(0, 60)}…)`);
  const w1 = await post('/wallet/status', { cap: root });
  ok(w1.body.remaining === WALLET_SEED - ALLOWANCE, 'refused invite left the wallet untouched');

  // ── 6. a REAL member turn charges the funded wallet (live inference, the real /chat loop) ──
  console.log('  … running a real member turn (local model)');
  const turn = await post('/chat', { cap: member, sessionId: 'chat-one', text: 'Reply with just the word: pong', model: 'default' });
  ok(turn.status === 200 && !turn.body.error && !turn.body.exhausted, `member turn ran (answer: ${JSON.stringify(String(turn.body.answer || '').slice(0, 40))})`);
  const b3 = await post('/budget', { cap: member, sessionId: 'chat-one' });
  ok(b3.body.remaining < ALLOWANCE, `the turn DEBITED the invite-funded wallet (${ALLOWANCE} → ${b3.body.remaining} µUSD)`);
  ok(b3.body.allowance === ALLOWANCE, `wallet's total-granted still shows the invite's allowance (${b3.body.allowance})`);
  const w2 = await post('/wallet/status', { cap: root });
  ok(w2.body.remaining === WALLET_SEED - ALLOWANCE, 'member spend came from the MEMBER wallet — owner wallet untouched (conserved)');

  // ── 7. EXHAUSTION → the deterministic top-up state the client renders the storefront from ──
  const drain = await post('/budget/set', { cap: root, purseCap: member, sessionId: 'chat-one', amount: 0 });
  ok(drain.status === 200 && drain.body.remaining === 0, 'owner drained the member wallet (test lever for "used it all up")');
  const refused = await post('/chat', { cap: member, sessionId: 'chat-one', text: 'still there?', model: 'default' });
  ok(refused.status === 200 && refused.body.exhausted === true, 'empty wallet → the turn is REFUSED deterministically (exhausted:true, no model call)');
  ok(refused.body.invited === true, 'refusal is marked invited:true → the client says "the credit that came with your invite is used up — buy your own"');
  ok(refused.body.remaining === 0, `refusal carries the balance for the card (${refused.body.remaining})`);

  // ── 8. the top-up rails the exhaustion card offers actually answer for the MEMBER cap ──
  const ds = await post('/pay/delegation/status', { cap: member, sessionId: 'chat-one' });
  ok(ds.status === 200 && typeof ds.body.available === 'boolean', `MetaMask delegation rail answers the member (available: ${ds.body.available})`);
  if (ds.body.available) ok(!!(ds.body.grant && ds.body.grant.signer), 'delegation grant params present (client can build the ERC-7715 request)');
  const co = await post('/pay/checkout', { cap: member, sessionId: 'chat-one', amountUsd: 5 });
  ok(co.status === 200 || co.status === 503, `Stripe checkout rail answers the member (${co.status}${co.status === 503 ? ' — not provisioned, owner notified' : ''})`);

  cleanup();
  console.log(`\n${fail ? '✗' : '✓'} user-agency allowance: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('  UNCAUGHT -', e && e.message); cleanup(); process.exit(1); });
