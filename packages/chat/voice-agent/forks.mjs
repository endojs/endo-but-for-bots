// forks.mjs — user-owned FORKS of confined Preact components (the in-tree, no-iframe model from
// designs/preact-component-trie.md). A fork is a `(endowments, props) => vnode` SOURCE string plus lineage;
// it holds NO state (state lives in grains) and NO caps — its entire authority is FORK_VOCAB (h/Fragment +
// ui-kit), seeded at render time by client/islands.js → renderSource. So a fork is pure, reviewable UI code.
//
// The fork→edit→re-share loop:
//   • create({ source, name, baseId, owner })  — fork from an island/app/another fork (or a blank template).
//   • edit(id, source, owner)                  — the owner's micro-agent rewrites the source → a new version
//                                                (lineage kept; revert is non-destructive).
//   • share({ id, owner, charge })             — mint a least-authority token that vends ONLY the source to
//                                                render, metered by the same free/expires/allowance schemes
//                                                as component-shares (the allowance = dan's social-collateral
//                                                invite). openShare(token) returns the source + debits.
//
// `owner` is an opaque, NON-SECRET stable id the server derives from the cap (never the cap itself) — a fork
// is owner-gated: only its owner edits/shares/revokes/removes it. cap-hygiene: no cap/token plaintext on disk
// (share tokens are stored sha256-hashed, like purse-store / component-shares).

import crypto from 'node:crypto';
import fs from 'node:fs';

const hash = t => crypto.createHash('sha256').update(`fshare:${t}`).digest('hex');
const now = () => Date.now();
const FORK_MAX_SRC = 64 * 1024; // a fork is UI code, not a payload
const HISTORY_MAX = 50;
const newId = () => `fork-${crypto.randomBytes(6).toString('hex')}`;

const cleanSource = src => {
  const s = String(src == null ? '' : src);
  if (!s.trim()) throw new Error('fork source is empty');
  if (s.length > FORK_MAX_SRC) throw new Error(`fork source exceeds ${FORK_MAX_SRC} bytes`);
  return s;
};

// makeForks({ file, makePurse, purseStore }) — makePurse+purseStore power the allowance charge scheme.
export const makeForks = ({ file, makePurse, purseStore }) => {
  let data = { forks: {}, shares: {} };
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); data = { forks: d.forks || {}, shares: d.shares || {} }; } catch { /* fresh */ }
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch { /* best-effort */ } };

  const purseKeyFor = th => `fshare:${th}`;
  const purseOf = rec => { if (!rec || !rec.purseKey || !makePurse || !purseStore) return null; const s = purseStore.get(rec.purseKey); return makePurse(s ? s.balance : 0, { granted: s ? s.granted : 0, onChange: (b, g) => purseStore.set(rec.purseKey, b, g) }); };

  const redact = f => ({ id: f.id, name: f.name, baseId: f.baseId || null, owner: f.owner, version: f.history.length, createdAt: f.createdAt, updatedAt: f.updatedAt });
  const owns = (f, owner) => !!f && f.owner === String(owner);

  // create({ source, name, baseId, owner }) → { ok, id } — a new fork at version 1.
  const create = ({ source, name, baseId = null, owner }) => {
    let src; try { src = cleanSource(source); } catch (e) { return { ok: false, error: e.message }; }
    if (!owner) return { ok: false, error: 'a fork needs an owner' };
    const id = newId();
    const stamp = new Date().toISOString();
    data.forks[id] = { id, name: String(name || 'Untitled fork').slice(0, 80), baseId: baseId ? String(baseId) : null,
      owner: String(owner), source: src, createdAt: stamp, updatedAt: stamp,
      history: [{ source: src, at: stamp, note: 'fork created' }] };
    save();
    return { ok: true, id };
  };

  const get = (id, owner) => { const f = data.forks[String(id)]; if (!owns(f, owner)) return null; return f; };
  // source(id, owner) → the current source (owner-gated) for the OWNER to render/edit. Shared rendering goes
  // through openShare (token-gated), never this.
  const source = (id, owner) => { const f = get(id, owner); return f ? f.source : null; };
  const list = owner => Object.values(data.forks).filter(f => owns(f, owner)).map(redact);
  const read = (id, owner) => { const f = get(id, owner); return f ? { ...redact(f), source: f.source } : null; };

  // edit(id, source, owner, note) → { ok, version } — append a new version (lineage kept).
  const edit = (id, source, owner, note = 'edit') => {
    const f = get(id, owner); if (!f) return { ok: false, error: 'unknown fork (or not yours)' };
    let src; try { src = cleanSource(source); } catch (e) { return { ok: false, error: e.message }; }
    f.source = src; f.updatedAt = new Date().toISOString();
    f.history.push({ source: src, at: f.updatedAt, note: String(note || 'edit').slice(0, 80) });
    if (f.history.length > HISTORY_MAX) f.history = f.history.slice(-HISTORY_MAX);
    save();
    return { ok: true, version: f.history.length };
  };

  const history = (id, owner) => { const f = get(id, owner); return f ? f.history.map((h, i) => ({ version: i + 1, at: h.at, note: h.note })) : null; };
  // revert(id, version, owner) — non-destructive: re-commit an earlier source as a NEW version.
  const revert = (id, version, owner) => {
    const f = get(id, owner); if (!f) return { ok: false, error: 'unknown fork (or not yours)' };
    const v = Number(version); const past = f.history[v - 1]; if (!past) return { ok: false, error: 'unknown version' };
    return edit(id, past.source, owner, `revert to v${v}`);
  };
  const remove = (id, owner) => { const f = get(id, owner); if (!f) return false; delete data.forks[String(id)]; save(); return true; };
  // exists(id) — bare existence (no owner, NO source/state): lets the error→backlog feeder validate a
  // reported fork identity without gaining any read on the fork.
  const exists = id => !!data.forks[String(id)];

  const curVersion = f => f.history.length;
  const sourceAtVersion = (f, v) => (f.history[v - 1] || {}).source || f.source;

  // ── least-authority share tokens (vend ONLY the source to render, optionally metered) ──
  // share({ id, owner, charge }) → { ok, token } (plaintext, shown once). charge mirrors component-shares.
  // The share PINS to the fork's current version (the invite = current mutated state). Later owner edits
  // become an UPGRADE the recipient chooses to accept (atomic), preview (try-on), or auto-accept — Phase 4.
  const share = ({ id, owner, charge = {}, forEndUsers = false }) => {
    const f = get(id, owner); if (!f) return { ok: false, error: 'unknown fork (or not yours)' };
    const token = crypto.randomBytes(18).toString('base64url'); const th = hash(token);
    const scheme = ['free', 'expires', 'allowance'].includes(charge.scheme) ? charge.scheme : 'free';
    // forEndUsers = a distribution share: the recipient (a code-illiterate end-user) only receives source
    // a distribution reviewer has APPROVED (Phase 5; the gate is enforced server-side at /forks/open).
    const rec = { forkId: id, owner: String(owner), createdAt: new Date().toISOString(), revoked: false, scheme, forEndUsers: !!forEndUsers, pinnedVersion: curVersion(f), autoAccept: false, inbox: [] };
    if (scheme === 'expires') rec.expiresAt = now() + Math.max(1, Math.min(8760, Number(charge.hours) || 24)) * 3600e3;
    if (scheme === 'allowance' && makePurse && purseStore) { rec.purseKey = purseKeyFor(th); rec.perOpen = Math.max(1, Math.round(Number(charge.perOpen) || 10000)); const total = Math.max(rec.perOpen, Math.round(Number(charge.total) || 1000000)); const p = makePurse(total, { onChange: (b, g) => purseStore.set(rec.purseKey, b, g) }); purseStore.set(rec.purseKey, p.balance(), p.granted()); }
    data.shares[th] = rec; save();
    return { ok: true, token };
  };
  const shareRec = token => { const r = data.shares[hash(String(token || ''))]; if (!r || r.revoked) return null; if (r.scheme === 'expires' && r.expiresAt && now() > r.expiresAt) return null; return r; };
  // openShare(token) → { ok, id, name, source, version, currentVersion, upgradeAvailable, autoAccept, inbox }
  // and DEBITS the allowance (call once per recipient open). The recipient sees the source at THEIR pinned
  // version (non-destructive: an owner's newer edits do not force-upgrade them), plus whether an upgrade is
  // available + the owner's inbox messages. This is the ONLY path that hands a fork's source to a non-owner.
  const openShare = token => {
    const r = shareRec(token); if (!r) return { ok: false, error: 'this share link is no longer valid' };
    const f = data.forks[r.forkId]; if (!f) return { ok: false, error: 'the shared fork no longer exists' };
    if (r.scheme === 'allowance') { const p = purseOf(r); if (p) { if (!p.canAfford(r.perOpen)) return { ok: false, error: 'this fork’s usage allowance is used up' }; p.debit(r.perOpen); } }
    const cur = curVersion(f);
    if (r.autoAccept && r.pinnedVersion !== cur) { r.pinnedVersion = cur; save(); } // auto: always ride the latest
    const ver = Math.min(r.pinnedVersion || cur, cur);
    return { ok: true, id: f.id, name: f.name, source: sourceAtVersion(f, ver), version: ver, currentVersion: cur, upgradeAvailable: ver < cur, autoAccept: !!r.autoAccept, forEndUsers: !!r.forEndUsers, inbox: (r.inbox || []).slice(-20) };
  };
  // ── Phase 4: atomic upgrades + try-on (recipient-side, token-gated — no cap) ──
  // previewUpgrade: the LATEST source WITHOUT changing the pin (non-destructive "try it on for size").
  const previewUpgrade = token => { const r = shareRec(token); if (!r) return { ok: false, error: 'invalid share' }; const f = data.forks[r.forkId]; if (!f) return { ok: false, error: 'gone' }; const cur = curVersion(f); return { ok: true, source: sourceAtVersion(f, cur), version: cur, current: cur, fromVersion: Math.min(r.pinnedVersion || cur, cur) }; };
  // acceptUpgrade: atomically jump the pin to the current version (commit the try-on).
  const acceptUpgrade = token => { const r = shareRec(token); if (!r) return { ok: false, error: 'invalid share' }; const f = data.forks[r.forkId]; if (!f) return { ok: false, error: 'gone' }; r.pinnedVersion = curVersion(f); save(); return { ok: true, version: r.pinnedVersion, source: sourceAtVersion(f, r.pinnedVersion) }; };
  // setAutoAccept: opt this share into always riding the owner's latest (or back to manual).
  const setAutoAccept = (token, on) => { const r = shareRec(token); if (!r) return { ok: false, error: 'invalid share' }; r.autoAccept = !!on; if (r.autoAccept) { const f = data.forks[r.forkId]; if (f) r.pinnedVersion = curVersion(f); } save(); return { ok: true, autoAccept: r.autoAccept }; };
  // ── invite-carries-inbox: the OWNER messages recipients ("I changed X — update?"); recipients read it on open.
  const notifyRecipients = (id, owner, message) => { const f = get(id, owner); if (!f) return { ok: false, error: 'unknown fork (or not yours)' }; const msg = { at: new Date().toISOString(), message: String(message || '').slice(0, 280) }; let n = 0; for (const r of Object.values(data.shares)) { if (r.forkId === id && !r.revoked) { r.inbox = (r.inbox || []).concat(msg).slice(-20); n += 1; } } save(); return { ok: true, delivered: n }; };
  const shareInbox = token => { const r = shareRec(token); if (!r) return { ok: false, error: 'invalid share' }; return { ok: true, inbox: (r.inbox || []).slice(-20) }; };
  // shareTarget(token) → { ok, forkId } and NOTHING else (no source, no owner, no inbox): the seam the
  // add-only backlog verb uses — a valid share designates WHICH fork to file against, granting no read.
  const shareTarget = token => { const r = shareRec(token); return r ? { ok: true, forkId: r.forkId } : { ok: false, error: 'this share link is no longer valid' }; };
  const revokeShare = (token, owner) => { const k = hash(String(token || '')); const r = data.shares[k]; if (!r || (owner && r.owner !== String(owner))) return false; r.revoked = true; save(); return true; };
  const sharesFor = (id, owner) => { const f = get(id, owner); if (!f) return []; return Object.entries(data.shares).filter(([, r]) => r.forkId === id && !r.revoked).map(([, r]) => { const p = purseOf(r); return { scheme: r.scheme, createdAt: r.createdAt, expiresAt: r.expiresAt || null, remaining: p ? p.balance() : null, granted: p ? p.granted() : null }; }); };

  return harden({ create, get, source, list, read, edit, history, revert, remove, exists, share, openShare, previewUpgrade, acceptUpgrade, setAutoAccept, notifyRecipients, shareInbox, shareTarget, revokeShare, sharesFor });
};
harden(makeForks);
