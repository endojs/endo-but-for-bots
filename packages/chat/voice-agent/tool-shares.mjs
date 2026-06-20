// tool-shares.mjs — the SHARE path for components (custom tools): the collaborative invariant made
// real. Anything you can hold, you can share — both ways, metered, revocable, and chargeable in the
// general currency (µUSD), enforced the standard way (the consumer's purse).
//
//   • FACTORY share  → vends the tool's CLASS bundle so the recipient hosts their OWN instance
//     (import → review → admit). Priced PER IMPORT.
//   • INSTANCE share → an ATTENUATED, REVOCABLE reference to the sharer's OWN hosted instance: the
//     recipient invokes it over the wire, narrowed to allowed methods + rate/quota/TTL. Priced PER USE.
//
// The token is an unguessable web-key — it IS the access (cap-hygiene: shown only in the Shares panel,
// never rendered into a page). `provenance`/earnings track WHO shared (accountability + the sharer's
// revenue). Persisted to JSON; the earnings ledger is the sharer's take.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const makeToolShares = ({ dir }) => {
  fs.mkdirSync(dir, { recursive: true });
  const FILE = path.join(dir, 'tool-shares.json');
  const EARN = path.join(dir, 'tool-earnings.json');
  const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };
  const writeJson = (f, o) => { const tmp = `${f}.tmp-${crypto.randomBytes(4).toString('hex')}`; fs.writeFileSync(tmp, JSON.stringify(o, null, 2)); fs.renameSync(tmp, f); };
  const load = () => readJson(FILE, {});
  const save = o => writeJson(FILE, o);

  // Create a share of a tool. `mode`: 'factory' | 'instance'. Attenuation narrows an instance share.
  const create = ({ toolId, toolName, mode, methods, ratePerMin, quota, ttlMs, priceUsd, sharer, now }) => {
    const token = crypto.randomBytes(24).toString('hex');
    const rec = {
      token,
      toolId: String(toolId),
      toolName: String(toolName || ''),
      mode: mode === 'factory' ? 'factory' : 'instance',
      attenuation: {
        methods: Array.isArray(methods) && methods.length ? methods.map(String) : null, // null = all admitted methods
        ratePerMin: Number(ratePerMin) > 0 ? Math.round(Number(ratePerMin)) : 0, // 0 = unlimited
        quota: Number(quota) > 0 ? Math.round(Number(quota)) : 0, // 0 = unlimited total uses
        expiresAt: Number(ttlMs) > 0 ? Date.now() + Math.round(Number(ttlMs)) : 0, // 0 = no expiry
      },
      priceUsd: Math.max(0, Math.round(Number(priceUsd) || 0)), // µUSD per use (instance) / per import (factory); 0 = free
      sharer: String(sharer || ''),
      revoked: false,
      used: 0,
      recent: [],
      createdAt: now || new Date().toISOString(),
    };
    const all = load();
    all[token] = rec;
    save(all);
    return rec;
  };

  const get = token => load()[String(token || '')] || null;

  // Open a share WITHOUT consuming it (the recipient learns the price + shape before paying).
  const describe = token => {
    const r = get(token);
    if (!r || r.revoked) return null;
    return { mode: r.mode, toolName: r.toolName, priceUsd: r.priceUsd, attenuation: r.attenuation, sharer: r.sharer };
  };

  // Validate attenuation WITHOUT mutating (revoked / expired / method / quota / rate). The server does
  // check → charge → count, so a refused payment never burns quota and a refused gate never charges.
  const check = (token, method) => {
    const r = get(token);
    if (!r) return { ok: false, error: 'unknown share' };
    if (r.revoked) return { ok: false, error: 'this share was revoked' };
    if (r.attenuation.expiresAt && Date.now() > r.attenuation.expiresAt) return { ok: false, error: 'this share has expired' };
    if (r.mode === 'instance' && r.attenuation.methods && method && !r.attenuation.methods.includes(method)) return { ok: false, error: `method "${method}" is not part of this share` };
    if (r.attenuation.quota && r.used >= r.attenuation.quota) return { ok: false, error: "this share's quota is used up" };
    const nowMs = Date.now();
    const recent = (r.recent || []).filter(t => nowMs - t < 60000);
    if (r.attenuation.ratePerMin && recent.length >= r.attenuation.ratePerMin) return { ok: false, error: 'rate limit reached — try again shortly' };
    return { ok: true, rec: r };
  };
  // Count a use (after a successful check + charge): increments total uses + the rate window.
  const count = token => {
    const all = load();
    const r = all[String(token || '')];
    if (!r) return;
    const nowMs = Date.now();
    r.recent = (r.recent || []).filter(t => nowMs - t < 60000);
    r.recent.push(nowMs);
    r.used += 1;
    save(all);
  };

  const revoke = token => { const all = load(); const r = all[String(token || '')]; if (!r) return { ok: false, error: 'unknown share' }; r.revoked = true; save(all); return { ok: true, token: r.token }; };

  // Management list (root): includes the token so the owner can copy/revoke (Shares-panel only).
  const list = () => Object.values(load()).map(r => ({ token: r.token, toolName: r.toolName, mode: r.mode, priceUsd: r.priceUsd, attenuation: r.attenuation, revoked: r.revoked, used: r.used, sharer: r.sharer, createdAt: r.createdAt }));
  const listForSharer = sharer => list().filter(r => r.sharer === String(sharer));

  // Earnings ledger — the sharer's take (credited when a consumer pays to use/import their share).
  const credit = (sharer, amt) => { const e = readJson(EARN, {}); const k = String(sharer || ''); e[k] = (e[k] || 0) + Math.max(0, Math.round(Number(amt) || 0)); writeJson(EARN, e); return e[k]; };
  const earnings = sharer => readJson(EARN, {})[String(sharer || '')] || 0;

  return { create, get, describe, check, count, revoke, list, listForSharer, credit, earnings };
};
harden(makeToolShares);
