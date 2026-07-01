// delegation-pay.mjs — Phase 2 billing rail #3: pay with an ERC-7710 delegation granted via
// MetaMask "advanced permissions" (ERC-7715 wallet_grantPermissions). The user pre-authorizes a
// spending allowance (a delegation = an on-chain CAPABILITY to spend, capped + revocable — the same
// ocap shape as everything else here); our settlement service (gator-pay charge-server, the PROVEN
// Linea Sepolia rail) redeems against it to collect payment, and we credit the purse.
//
// SES/viem split: the chain code (viem + @metamask/delegation-toolkit) runs OUTSIDE @endo/init in
// the local gator-pay charge-server (127.0.0.1); this module only talks to it over fetch. The signed
// delegation is opaque Passable data we hold + forward — no keys here.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { CONFIG_DIR, STATE_DIR } from './field-config.mjs';

// Personal-family paths resolve through field-config (byte-identical defaults on the NUC;
// rebase onto FIELD_PERSONAL_ROOT when the personal volume is mounted).
const GATOR_CFG = process.env.GATOR_CONFIG || path.join(CONFIG_DIR, 'gator-pay.json');
const DELEG_STORE = process.env.DELEGATION_STORE || path.join(STATE_DIR, 'delegations.json');

// gator-pay.json: { chargeServerUrl:"http://127.0.0.1:8799", treasury:"0x…payee",
//   weiPerUusd:"<bigint string>", chain:"linea-sepolia" }. Absent → this rail is off.
export const loadGatorCfg = () => { try { const c = JSON.parse(fs.readFileSync(GATOR_CFG, 'utf8')); return (c && c.chargeServerUrl && c.treasury) ? c : null; } catch { return null; } };
export const gatorConfigured = () => !!loadGatorCfg();

// Normalize an ERC-7715 grant into the {permissionsContext, delegationManager, accountMetadata}
// triple the settlement service redeems with (ERC-7710). Accepts, in order of currency:
//   • CURRENT MetaMask Flask 13.x ExecutionPermissionResponse — request-echo + TOP-LEVEL
//     {context, delegationManager, dependencies:[{factory,factoryData}]} (ground truth: the
//     Flask 13.37 bundle schema + wallet-e2e probes, 2026-07-01);
//   • the 2025 toolkit-0.12 shape ({context, signerMeta:{delegationManager}, dependencyInfo});
//   • an already-normalized object.
// Returns null when there is no permissions context — the one shape a redeem can't work without
// (this is what used to slip through: a raw wallet blob the charge-server couldn't redeem).
export const normalizeGrant = d => {
  const g = (Array.isArray(d) ? d[0] : d) || null;
  if (!g || typeof g !== 'object') return null;
  const permissionsContext = g.permissionsContext || g.context;
  if (typeof permissionsContext !== 'string' || !/^0x[0-9a-fA-F]+$/.test(permissionsContext)) return null;
  const delegationManager = g.delegationManager || (g.signerMeta && g.signerMeta.delegationManager) || null;
  const accountMetadata = [g.accountMetadata, g.dependencies, g.dependencyInfo].find(Array.isArray) || [];
  return { permissionsContext, delegationManager, accountMetadata };
};

// The public facts a client needs to BUILD a correct ERC-7715 request: `to` (the settlement
// delegate that will redeem — current Flask's request field; `signer` kept as a legacy alias),
// the chain, and the wei-per-USD rate (so the client sizes periodAmount).
// Cached per process; null when the rail is off or the charge-server is unreachable. No secrets.
let cachedInfo = null;
export const grantParams = async (fetchImpl = fetch) => {
  const cfg = loadGatorCfg();
  if (!cfg) return null;
  try {
    if (!cachedInfo) { cachedInfo = await (await fetchImpl(`${cfg.chargeServerUrl}/info`)).json(); }
    if (!cachedInfo || !cachedInfo.delegate || !cachedInfo.chainId) { cachedInfo = null; return null; }
    return { chainId: cachedInfo.chainId, to: cachedInfo.delegate, signer: cachedInfo.delegate, chain: cachedInfo.chain || cfg.chain || '', weiPerUsd: (BigInt(cfg.weiPerUusd || '0') * 1000000n).toString() };
  } catch { cachedInfo = null; return null; }
};

const load = () => { try { return JSON.parse(fs.readFileSync(DELEG_STORE, 'utf8')); } catch { return {}; } };
const save = o => { try { fs.mkdirSync(path.dirname(DELEG_STORE), { recursive: true }); fs.writeFileSync(DELEG_STORE, JSON.stringify(o, null, 2), { mode: 0o600 }); } catch { /* best effort */ } };
const keyFor = (cap, sid) => crypto.createHash('sha256').update(`${cap}:${sid}`).digest('hex'); // cap-hygiene: the swissnum is never stored raw

// Store the user's granted delegation, keyed by a HASH of {cap,sid} (the swissnum never lands on disk).
// `subscription` (optional) makes it RECURRING: { periodUusd, periodMs } = "up to periodUusd per periodMs",
// which the server auto-draws from to keep the purse funded (so inference + hosting just keep working). The
// on-chain ERC-7715 grant the user signed is itself periodic; this mirrors its terms for our own accounting.
export const recordDelegation = ({ cap, sid, delegation, now, subscription = null }) => {
  const o = load(); const k = keyFor(cap, sid); const prev = o[k] || {};
  o[k] = {
    delegation, grantedAt: now, redeemed: prev.redeemed || 0,
    sub: subscription ? { periodUusd: Math.max(0, Math.round(subscription.periodUusd || 0)), periodMs: Math.max(60000, Math.round(subscription.periodMs || 0)) } : (prev.sub || null),
    periodStart: now, periodRedeemed: 0,
  };
  save(o); return { ok: true };
};
export const hasDelegation = (cap, sid) => !!load()[keyFor(cap, sid)];
export const getSubscription = (cap, sid) => { const r = load()[keyFor(cap, sid)]; return r && r.sub ? r.sub : null; };

// Subscription state for the UI — never returns the delegation/key, only terms + how much of THIS period is left.
export const subscriptionStatus = (cap, sid, now = Date.now()) => {
  const rec = load()[keyFor(cap, sid)];
  const configured = gatorConfigured();
  if (!rec || !rec.sub) return { subscribed: false, configured };
  let start = Date.parse(rec.periodStart || rec.grantedAt || ''); if (Number.isNaN(start)) start = now;
  const elapsed = now - start;
  const redeemedThisPeriod = elapsed >= rec.sub.periodMs ? 0 : (rec.periodRedeemed || 0);
  return { subscribed: true, configured, periodUusd: rec.sub.periodUusd, periodMs: rec.sub.periodMs, periodRedeemed: redeemedThisPeriod, periodRemaining: Math.max(0, rec.sub.periodUusd - redeemedThisPeriod), resetsInMs: Math.max(0, rec.sub.periodMs - elapsed), totalRedeemed: rec.redeemed || 0 };
};

// AUTO-TOP-UP: redeem up to `uusd` from the subscription to refill the purse, RESPECTING the period cap (resets
// each period). The caller credits the purse on ok (so the purse stays the single real-time ledger). This is
// what makes it "simply pay": granted once, the user's turns + hosting keep flowing without a manual payment.
export const autoTopup = async ({ cap, sid, uusd, fetchImpl = fetch, now = Date.now() }) => {
  const o = load(); const k = keyFor(cap, sid); const rec = o[k];
  if (!rec || !rec.delegation || !rec.sub) return { ok: false, error: 'no active subscription' };
  let start = Date.parse(rec.periodStart || rec.grantedAt || ''); if (Number.isNaN(start)) start = now;
  let redeemed = rec.periodRedeemed || 0;
  if (now - start >= rec.sub.periodMs) { start = now; redeemed = 0; } // new period → reset the cap
  const avail = Math.max(0, rec.sub.periodUusd - redeemed);
  if (avail <= 0) return { ok: false, error: 'subscription period cap reached', resetsInMs: rec.sub.periodMs - (now - start) };
  const want = Math.min(Math.max(0, Math.round(Number(uusd) || 0)), avail);
  if (want <= 0) return { ok: false, error: 'nothing to redeem' };
  const r = await redeemDelegation({ cap, sid, uusd: want, fetchImpl }); // settles on-chain (bumps rec.redeemed)
  if (!r.ok) return r;
  const o2 = load(); const rec2 = o2[k]; if (rec2) { rec2.periodStart = new Date(start).toISOString(); rec2.periodRedeemed = redeemed + want; save(o2); }
  return { ok: true, uusd: want, ref: r.ref };
};

// µUSD → on-chain wei via the configured rate. Kept here so the conversion is one place.
export const uusdToWei = (cfg, uusd) => (BigInt(Math.max(0, Math.round(Number(uusd) || 0))) * BigInt(cfg.weiPerUusd || '0'));

// Redeem `uusd` worth against the stored delegation via the charge-server; returns {ok, ref|error}.
// On ok the CALLER credits the purse (so the purse stays the single real-time ledger).
export const redeemDelegation = async ({ cap, sid, uusd, fetchImpl = fetch }) => {
  const cfg = loadGatorCfg();
  if (!cfg) return { ok: false, needsOwner: true, error: 'delegated payment is not set up (no gator-pay.json)' };
  const rec = load()[keyFor(cap, sid)];
  if (!rec || !rec.delegation) return { ok: false, error: 'no delegation on file — grant a spending permission first' };
  const wei = uusdToWei(cfg, uusd);
  if (wei <= 0n) return { ok: false, error: 'configure weiPerUusd' };
  let r;
  try { r = await (await fetchImpl(`${cfg.chargeServerUrl}/charge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delegation: rec.delegation, amount: wei.toString(), payee: cfg.treasury }) })).json(); }
  catch (e) { return { ok: false, error: `settlement service unreachable: ${(e && e.message) || e}` }; }
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'redeem failed (allowance exhausted or reverted)' };
  const o = load(); const k = keyFor(cap, sid); if (o[k]) { o[k].redeemed = (o[k].redeemed || 0) + Math.round(Number(uusd) || 0); save(o); }
  return { ok: true, ref: r.ref, uusd: Math.round(Number(uusd) || 0) };
};
