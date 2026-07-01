#!/usr/bin/env node
// pay-rail.staging.test.mjs — BILLING RAIL #3 end-to-end, like Joshua: a REAL on-chain redeem on
// Linea Sepolia through the real stack (isolated voice-agent server → delegation-pay →
// gator-charge settlement service → Pimlico bundler → DelegationManager), asserting BOTH
// (a) the redeem landed on-chain (tx receipt success + exact wei delta at the treasury) and
// (b) the purse was credited the right µUSD.
//
// Prereqs (all live on this host):
//   • gator-charge.service running (systemctl --user status gator-charge) on 127.0.0.1:8799
//   • ~/.config/field-agent/gator-pay.json (chargeServerUrl/treasury/weiPerUusd/chain)
//   • ~/.config/gator-pay/delegate.key + PIMLICO in /home/dan/.env (used by make-grant + charge-server)
//   • the delegator smart account deployed + funded (node ~/gator-pay/testnet.mjs --redeem once)
//
// COST per run: $1 of test-ETH (weiPerUusd × 1e6 ≈ 0.0004 tETH) moves delegator → treasury (the
// funding EOA, so value recycles), plus bundler gas from the delegate smart account. The grant is
// minted headlessly by ~/gator-pay/make-grant.mjs with a FRESH salt (fresh on-chain allowance), in
// the exact raw ERC-7715 wallet-response shape a real MetaMask grant produces — so this exercises
// the same normalize→store→redeem path as the browser flow, minus only the wallet UI itself.
//
// Run: npm run test:pay-rail   (in packages/chat/voice-agent)
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || '/home/dan';
const PORT = 8796;
const BASE = `http://127.0.0.1:${PORT}`;
const RPC = process.env.LINEA_SEPOLIA_RPC || 'https://rpc.sepolia.linea.build';
const MAKE_GRANT = process.env.MAKE_GRANT || path.join(HOME, 'gator-pay/make-grant.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pay-rail-'));
let srv = null;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const die = m => { console.error('  ABORT -', m); cleanup(); process.exit(1); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

const post = async (p, body) => { const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
const rpc = async (method, params) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;

(async () => {
  // ── 0. the real rail config + the real settlement service must be up (this is a system test) ──
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(path.join(HOME, '.config/field-agent/gator-pay.json'), 'utf8')); } catch { die('no ~/.config/field-agent/gator-pay.json — the rail is not configured'); }
  let info;
  try { info = await (await fetch(`${cfg.chargeServerUrl}/info`)).json(); } catch {}
  if (!info || !info.delegate) die(`charge-server unreachable at ${cfg.chargeServerUrl} — systemctl --user start gator-charge`);
  ok(info.chain === 'linea-sepolia' && /^0x/.test(info.chainId), `settlement service up: chain ${info.chain} (${info.chainId}), delegate ${info.delegate}`);

  // ── 1. isolated voice-agent server (fresh root cap + state; the REAL gator config) ──
  srv = spawn('node', ['server.mjs'], {
    cwd: HERE,
    env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1',
      SEED_FILE: path.join(tmp, 'root.swiss'), OUT_DIR: path.join(tmp, 'out'),
      VOICE_STATE_DIR: path.join(tmp, 'voice-state'), DELEGATION_STORE: path.join(tmp, 'delegations.json'),
      PROJECTS_STORE: path.join(tmp, 'projects.json'), MEMO_RUNS_FILE: path.join(tmp, 'memo.json') },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  let up = false;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/`); if (r.ok || r.status === 404) { up = true; break; } } catch {} await sleep(500); }
  if (!up) die('isolated server did not boot');
  ok(up, 'isolated server booted');
  const cap = fs.readFileSync(path.join(tmp, 'root.swiss'), 'utf8').trim();
  const sid = `payrail-${Date.now().toString(36)}`;

  // ── 2. status advertises the rail + the grant params the client builds its 7715 request from ──
  const st = await post('/pay/delegation/status', { cap, sessionId: sid });
  ok(st.body.available === true, 'status: rail available (gator-pay.json present)');
  ok(st.body.grant && st.body.grant.signer === info.delegate && st.body.grant.chainId === info.chainId && BigInt(st.body.grant.weiPerUsd) > 0n,
    `status: grant params {signer=${st.body.grant && st.body.grant.signer}, chainId=${st.body.grant && st.body.grant.chainId}, weiPerUsd=${st.body.grant && st.body.grant.weiPerUsd}}`);

  // ── 3. REGRESSION: the old broken shapes (raw blob without a permissions context) are rejected ──
  for (const junk of [{ sig: 'mock' }, { context: '0xMOCKGRANT' }]) {
    const r = await post('/pay/delegation/grant', { cap, sessionId: sid, delegation: junk });
    ok(r.status === 400, `grant rejects unredeemable delegation ${JSON.stringify(junk)} (${r.status})`);
  }

  // ── 4. a REAL signed grant (raw ERC-7715 wallet-response shape, fresh salt) ──
  const grant = await new Promise((resolve, reject) => execFile('node', [MAKE_GRANT, '--eth', '0.001'], { timeout: 120000 }, (e, out) => e ? reject(e) : resolve(JSON.parse(out))));
  ok(!!grant.context && !!grant.signerMeta?.delegationManager, 'make-grant minted a real signed grant (context present)');
  const g = await post('/pay/delegation/grant', { cap, sessionId: sid, delegation: grant, subscription: { periodUsd: 10, periodDays: 30 } });
  ok(g.status === 200 && g.body.ok === true && g.body.subscribed === true, 'grant accepted + subscription recorded');

  // ── 5. redeem $1 on-chain and verify BOTH ledgers ──
  const before = (await post('/budget', { cap, sessionId: sid })).body.remaining;
  const treasuryBefore = BigInt(await rpc('eth_getBalance', [cfg.treasury, 'latest']));
  console.log('  … redeeming $1 on-chain (UserOp via Pimlico; this takes a moment)');
  const rd = await post('/pay/delegation/redeem', { cap, sessionId: sid, amountUsd: 1 });
  ok(rd.status === 200 && rd.body.ok === true, `redeem ok: ${JSON.stringify({ ok: rd.body.ok, error: rd.body.error })}`);
  if (!rd.body.ok) { cleanup(); console.log(`\n${fail ? '✗' : '✓'} pay-rail: ${pass} passed, ${fail} failed`); process.exit(1); }
  ok(/^0x[0-9a-fA-F]{64}$/.test(rd.body.ref || ''), `redeem returned a real tx hash: ${rd.body.ref}`);
  ok(rd.body.remaining === before + 1_000_000, `purse credited exactly 1,000,000 µUSD ($1): ${before} → ${rd.body.remaining}`);

  // on-chain: the tx succeeded and the treasury received exactly weiPerUusd × 1e6
  let receipt = null;
  for (let i = 0; i < 30 && !receipt; i++) { receipt = await rpc('eth_getTransactionReceipt', [rd.body.ref]); if (!receipt) await sleep(2000); }
  ok(receipt && receipt.status === '0x1', `on-chain receipt: status ${receipt && receipt.status} in block ${receipt && parseInt(receipt.blockNumber, 16)}`);
  const expectWei = BigInt(cfg.weiPerUusd) * 1_000_000n;
  const treasuryAfter = BigInt(await rpc('eth_getBalance', [cfg.treasury, 'latest']));
  ok(treasuryAfter - treasuryBefore === expectWei, `treasury ${cfg.treasury} received exactly ${expectWei} wei (Δ=${treasuryAfter - treasuryBefore})`);

  cleanup();
  console.log(`\n${fail ? '✗' : '✓'} pay-rail: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('  UNCAUGHT -', e && e.message); cleanup(); process.exit(1); });
