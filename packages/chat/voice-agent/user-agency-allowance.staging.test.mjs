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
import '@endo/init'; // SES: gives `harden` for the direct costModel import below (first, so it runs before it)
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { costOf, rateFor } from './costModel.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Test-only cost seam: price the (production-free) local model so the real /chat turns below
// DEBIT the funded wallet — proving the metering + allowance-CONSERVATION spine end-to-end with
// deterministic local inference (no paid-API round-trip). Production leaves this unset (P1-9).
const TEST_RATE_OVERRIDES = JSON.stringify({ 'gemma-tinix': [1, 4] });
const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}`;
const WALLET_SEED = 500_000;   // the owner's invite wallet, $0.50 — small so conservation is visible
const ALLOWANCE = 300_000;     // the invite carries $0.30
const NS_SEED = 120_000;       // a Bluesky namespace's conserved wallet seed, $0.12 (BLUESKY_NS_WALLET_UUSD)

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
      ROOT_WALLET_UUSD: String(WALLET_SEED),
      FIELD_TEST_RATE_OVERRIDES: TEST_RATE_OVERRIDES,
      BLUESKY_NS_WALLET_UUSD: String(NS_SEED), BSKY_CLAIMS_FILE: path.join(tmp, 'bluesky-claims.json') },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  if (!up) die('isolated server did not boot');
  ok(up, 'isolated server booted');
  const root = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();

  // ── P1-9 invariant: in PRODUCTION the local model is genuinely FREE. This runs in the test's
  // own process (no FIELD_TEST_RATE_OVERRIDES here — only the server child got it), so it reads
  // the real rate table. The metered turns below run against the priced child seam. ──
  ok(rateFor('default')[0] === 0 && rateFor('default')[1] === 0, 'local gemma is priced [0,0] by default (P1-9: free local model)');
  ok(costOf('default', { prompt_tokens: 2000, completion_tokens: 2000 }) === 0, 'a free-model turn debits nothing by default (0 µUSD)');

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
  ok(b3.body.remaining < ALLOWANCE, `the (priced-seam) turn DEBITED the invite-funded wallet (${ALLOWANCE} → ${b3.body.remaining} µUSD)`);
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

  // ── 9. BLUESKY NAMESPACES: one CONSERVED per-namespace wallet, adopted by /subchat children ──
  // A namespace cap is a scoped cap whose hash the claim store marks (bluesky-claim.mjs signIn does this
  // after OAuth; here we mint the cap and mark it directly in the isolated BSKY_CLAIMS_FILE — the store
  // re-reads per call, so the running server picks it up live). Before this fix a namespace's /subchat
  // children fell through to fresh default-allowance purses minted from NOTHING.
  const ns = await post('/scope/mint', { cap: root, powers: ['reference'], label: 'bsky-ns' });
  ok(ns.status === 200 && !!ns.body.scopedCap, 'minted a scoped cap to serve as a Bluesky namespace');
  const nsCap = ns.body.scopedCap;
  fs.writeFileSync(path.join(tmp, 'bluesky-claims.json'), JSON.stringify({ byDid: {}, namespaces: { [crypto.createHash('sha256').update(nsCap).digest('hex')]: true } }));
  const wBefore = (await post('/wallet/status', { cap: root })).body.remaining;
  const nb1 = await post('/budget', { cap: nsCap, sessionId: 'ns-chat-one' }); // first use → the wallet is seeded
  ok(nb1.body.remaining === NS_SEED, `namespace wallet seeded with BLUESKY_NS_WALLET_UUSD on first use (${nb1.body.remaining} µUSD, not the ${nb1.body.defaultAllowance} default)`);
  const wAfter = (await post('/wallet/status', { cap: root })).body.remaining;
  ok(wAfter === wBefore - NS_SEED, `the seed is a CONSERVED transfer — wallet:root debited exactly it (${wBefore} → ${wAfter})`);
  const nb2 = await post('/budget', { cap: nsCap, sessionId: 'ns-chat-two' });
  ok(nb2.body.remaining === NS_SEED, 'a second chat shares the ONE namespace wallet (no re-seed, no per-chat purse)');
  const nsub = await post('/subchat', { cap: nsCap, powers: ['reference'], title: 'ns-sub' });
  ok(nsub.status === 200 && !!nsub.body.scopedCap, 'namespace member minted a sub-chat cap');
  const nbs = await post('/budget', { cap: nsub.body.scopedCap, sessionId: 'ns-sub-one' });
  ok(nbs.body.remaining === NS_SEED, `the sub-cap ADOPTED the namespace wallet (${nbs.body.remaining} µUSD — no thin-air default purse)`);
  ok((await post('/wallet/status', { cap: root })).body.remaining === wAfter, 'the sub-chat cost wallet:root NOTHING (one seed per namespace, ever)');
  // drain the namespace wallet through the PARENT cap → the CHILD sees the same emptiness (same purse, not a lookalike)
  const ndrain = await post('/budget/set', { cap: root, purseCap: nsCap, sessionId: 'ns-chat-one', amount: 70_000 });
  ok(ndrain.status === 200 && ndrain.body.remaining === 70_000, 'owner adjusted the namespace wallet via the parent cap');
  const nbs2 = await post('/budget', { cap: nsub.body.scopedCap, sessionId: 'ns-sub-one' });
  ok(nbs2.body.remaining === 70_000, 'the child reads the SAME wallet balance — parent and sub-chat spend one conserved pot');
  // a REAL charge through the CHILD (live inference) debits the NAMESPACE wallet — visible from the parent
  console.log('  … running a real namespace-child turn (local model)');
  const nturn = await post('/chat', { cap: nsub.body.scopedCap, sessionId: 'ns-sub-one', text: 'Reply with just the word: pong', model: 'default' });
  ok(nturn.status === 200 && !nturn.body.error && !nturn.body.exhausted, `namespace child turn ran (answer: ${JSON.stringify(String(nturn.body.answer || '').slice(0, 40))})`);
  const nbp = await post('/budget', { cap: nsCap, sessionId: 'ns-chat-one' });
  ok(nbp.body.remaining < 70_000, `the child's (priced-seam) charge DEBITED the shared namespace wallet (70000 → ${nbp.body.remaining} µUSD, read via the PARENT cap)`);
  ok((await post('/wallet/status', { cap: root })).body.remaining === wAfter, 'and wallet:root stayed untouched — the spend came from the namespace pot');

  cleanup();
  console.log(`\n${fail ? '✗' : '✓'} user-agency allowance: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('  UNCAUGHT -', e && e.message); cleanup(); process.exit(1); });
