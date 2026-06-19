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

const HOME = process.env.HOME || '/home/dan';
const GATOR_CFG = process.env.GATOR_CONFIG || `${HOME}/.config/field-agent/gator-pay.json`;
const DELEG_STORE = process.env.DELEGATION_STORE || `${HOME}/.local/state/field-agent/delegations.json`;

// gator-pay.json: { chargeServerUrl:"http://127.0.0.1:8799", treasury:"0x…payee",
//   weiPerUusd:"<bigint string>", chain:"linea-sepolia" }. Absent → this rail is off.
export const loadGatorCfg = () => { try { const c = JSON.parse(fs.readFileSync(GATOR_CFG, 'utf8')); return (c && c.chargeServerUrl && c.treasury) ? c : null; } catch { return null; } };
export const gatorConfigured = () => !!loadGatorCfg();

const load = () => { try { return JSON.parse(fs.readFileSync(DELEG_STORE, 'utf8')); } catch { return {}; } };
const save = o => { try { fs.mkdirSync(path.dirname(DELEG_STORE), { recursive: true }); fs.writeFileSync(DELEG_STORE, JSON.stringify(o, null, 2), { mode: 0o600 }); } catch { /* best effort */ } };
const keyFor = (cap, sid) => crypto.createHash('sha256').update(`${cap}:${sid}`).digest('hex'); // cap-hygiene: the swissnum is never stored raw

// Store the user's granted delegation, keyed by a HASH of {cap,sid} (the swissnum never lands on disk).
export const recordDelegation = ({ cap, sid, delegation, now }) => {
  const o = load(); o[keyFor(cap, sid)] = { delegation, grantedAt: now, redeemed: 0 }; save(o);
  return { ok: true };
};
export const hasDelegation = (cap, sid) => !!load()[keyFor(cap, sid)];

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
