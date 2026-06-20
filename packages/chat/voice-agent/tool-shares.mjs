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

  // Create a share of a tool. `mode`: 'factory' | 'instance' | 'git'. A 'git' share vends the component
  // AS its EndoGit object (read or read-write `access`); attenuation narrows an instance share.
  const create = ({ toolId, toolName, mode, access, methods, ratePerMin, quota, ttlMs, priceUsd, sharer, now }) => {
    const token = crypto.randomBytes(24).toString('hex'); // the web-key — IS the access (secret)
    const id = crypto.randomBytes(4).toString('hex'); // a render-safe management handle (NOT secret) — used to revoke without ever exposing the token
    const rec = {
      token,
      id,
      toolId: String(toolId),
      toolName: String(toolName || ''),
      mode: ['factory', 'git'].includes(mode) ? mode : 'instance',
      access: mode === 'git' ? (access === 'write' ? 'write' : 'read') : undefined, // git share: read-only vs collaborator
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
    return { mode: r.mode, access: r.access, toolName: r.toolName, toolId: r.toolId, priceUsd: r.priceUsd, attenuation: r.attenuation, sharer: r.sharer };
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

  // Revoke by the render-safe id OR the token (so the agent can revoke without ever holding the token).
  const revoke = key => { const all = load(); const k = String(key || ''); const r = all[k] || Object.values(all).find(x => x.id === k); if (!r) return { ok: false, error: 'unknown share' }; r.revoked = true; save(all); return { ok: true, id: r.id }; };

  // Management list (root): includes the token so the owner's Shares panel can build the copy-link
  // (held in JS, never rendered) + the render-safe id for display/revoke.
  const list = () => Object.values(load()).map(r => ({ id: r.id, token: r.token, toolName: r.toolName, mode: r.mode, access: r.access, priceUsd: r.priceUsd, attenuation: r.attenuation, revoked: r.revoked, used: r.used, sharer: r.sharer, createdAt: r.createdAt }));
  const listForSharer = sharer => list().filter(r => r.sharer === String(sharer));

  // Earnings ledger — the sharer's take (credited when a consumer pays to use/import their share).
  const credit = (sharer, amt) => { const e = readJson(EARN, {}); const k = String(sharer || ''); e[k] = (e[k] || 0) + Math.max(0, Math.round(Number(amt) || 0)); writeJson(EARN, e); return e[k]; };
  const earnings = sharer => readJson(EARN, {})[String(sharer || '')] || 0;

  return { create, get, describe, check, count, revoke, list, listForSharer, credit, earnings };
};
harden(makeToolShares);
