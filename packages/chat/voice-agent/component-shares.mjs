// component-shares.mjs — durable, least-authority share tokens for a broken-out component.
//
// A share token is NOT a cap-node: it grants exactly ONE thing — "subscribe (read-only) to this
// component's FROZEN list of declared cells" — and nothing else. It cannot open a chat, hold a power,
// or reach any cell outside its list. The owner mints it (reach-verified at mint), the recipient opens
// /c/<id>#k=<token>, and /cells/subscribe + the standalone /c/ui honour it for ONLY those cells.
//
// W3 — CHARGE SCHEMES (monetization, composing existing rails). A share carries a `charge`:
//   • free       — anyone with the link, no limit (default).
//   • expires    — a TIME-BOXED lease: works until expiresAt, then the token is dead (the by-time scheme).
//   • allowance  — an owner-funded µUSD allowance metered PER OPEN: each /c open debits `perOpen` from a
//                  durable purse the owner funded with `total`; when it runs dry, access stops (the per-use
//                  scheme, expressed as social-collateral / an allowance — dan's invite model).
// The recipient-PAYS variants (one-time / subscription via Stripe/gator) are the follow-on (real money +
// outward-facing = the operator's explicit call); these two are self-contained and need no payment backend.
//
// cap-hygiene: the plaintext token never lands on disk — only its sha256 (like purse-store).

import crypto from 'node:crypto';
import fs from 'node:fs';

import { writeJsonAtomic } from './write-json-atomic.mjs';

const hash = t => crypto.createHash('sha256').update(`cshare:${t}`).digest('hex');
const now = () => Date.now();

// makeComponentShares({ file, makePurse, purseStore }) — makePurse+purseStore power the allowance scheme.
export const makeComponentShares = ({ file, makePurse, purseStore }) => {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* fresh */ }
  const save = () => { try { writeJsonAtomic(file, data, { pretty: true }); } catch { /* best-effort */ } }; // INT-1: torn-write-safe
  const purseKeyFor = th => `cshare:${th}`; // namespace in the shared purse-store (hashed key)
  const purseOf = rec => { if (!rec || !rec.purseKey || !makePurse || !purseStore) return null; const s = purseStore.get(rec.purseKey); return makePurse(s ? s.balance : 0, { granted: s ? s.granted : 0, onChange: (b, g) => purseStore.set(rec.purseKey, b, g) }); };

  // create({ componentId, cells:[{id, handle}], readOnly, charge }) → plaintext token (shown once).
  // charge: { scheme:'free'|'expires'|'allowance', hours?, total?(µUSD), perOpen?(µUSD) }
  const create = ({ componentId, cells, readOnly = true, charge = {} }) => {
    const token = crypto.randomBytes(18).toString('base64url'); const th = hash(token);
    const scheme = ['free', 'expires', 'allowance'].includes(charge.scheme) ? charge.scheme : 'free';
    const rec = { componentId: String(componentId), cells: (cells || []).map(c => ({ id: String(c.id), handle: String(c.handle || '') })), readOnly: !!readOnly, createdAt: new Date().toISOString(), revoked: false, scheme };
    if (scheme === 'expires') rec.expiresAt = now() + Math.max(1, Math.min(8760, Number(charge.hours) || 24)) * 3600e3; // 1h..1yr
    if (scheme === 'allowance' && makePurse && purseStore) { rec.purseKey = purseKeyFor(th); rec.perOpen = Math.max(1, Math.round(Number(charge.perOpen) || 10000)); const total = Math.max(rec.perOpen, Math.round(Number(charge.total) || 1000000)); const p = makePurse(total, { onChange: (b, g) => purseStore.set(rec.purseKey, b, g) }); purseStore.set(rec.purseKey, p.balance(), p.granted()); }
    data[th] = rec; save();
    return token;
  };
  // get(token) → the record, or null if unknown / revoked / EXPIRED. (Does NOT debit — that's chargeOpen.)
  const get = token => { const r = data[hash(String(token || ''))]; if (!r || r.revoked) return null; if (r.scheme === 'expires' && r.expiresAt && now() > r.expiresAt) return null; return r; };
  // chargeOpen(token) — call ONCE per recipient "open" (a /c/ui load). For 'allowance', debit perOpen; deny
  // when the purse can't afford. free/expires always pass (expiry already gated in get()).
  const chargeOpen = token => {
    const r = get(token); if (!r) return { ok: false, error: 'this share link is no longer valid' };
    if (r.scheme !== 'allowance') return { ok: true };
    const p = purseOf(r); if (!p) return { ok: true };
    if (!p.canAfford(r.perOpen)) return { ok: false, error: 'this shared component’s usage allowance is used up' };
    p.debit(r.perOpen); return { ok: true, remaining: p.balance() };
  };
  const revoke = token => { const k = hash(String(token || '')); if (data[k]) { data[k].revoked = true; save(); return true; } return false; };
  const listFor = componentId => Object.values(data).filter(r => r.componentId === String(componentId) && !r.revoked).map(r => { const p = purseOf(r); return { componentId: r.componentId, cells: r.cells.map(c => c.id), createdAt: r.createdAt, scheme: r.scheme, expiresAt: r.expiresAt || null, remaining: p ? p.balance() : null, granted: p ? p.granted() : null }; });

  return harden({ create, get, chargeOpen, revoke, listFor });
};
harden(makeComponentShares);
