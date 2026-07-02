// user-store.mjs — per-user CAPABILITIES for the multi-user app (live-editable plan, dan's annotation): on a
// user's FIRST open with an invite cap, mint a persistent USER capability they hold, storing (a) their
// PREFERENCES and (b) a pointer to the ROOT object they treat as the app's entry point — so different users can
// fork + run their own VARIANT of the app over a shared component fork-tree (different Root pointers), diverging
// from one another. INVITE-ONLY / TAILNET-PRIVATE (dan's call): a user-cap is only ever minted FROM a valid cap
// the opener already holds (an invite) — there is no public/anonymous minting path here.
//
// cap-hygiene: the user-cap swissnum is the user's secret identity token; it is NEVER stored in plaintext — the
// record is keyed by sha256(userCap) (like purse-store / forks / component-shares). The swissnum lives only in
// the holder's browser; the server keeps only its hash → {prefs, root}.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { writeJsonAtomic } from './write-json-atomic.mjs';

const hash = t => crypto.createHash('sha256').update(`user:${t}`).digest('hex');
const newSwiss = () => crypto.randomBytes(16).toString('hex');
const CANONICAL_ROOT = 'canonical'; // the shared, canonical app root (a user's variant diverges from this)

export const makeUserStore = ({ file }) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let data = { users: {} }; // hash(userCap) → { root, prefs, createdAt, lastSeen }
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); if (d && d.users) data = d; } catch { /* fresh */ }
  const save = () => { try { writeJsonAtomic(file, data, { pretty: true, mode: 0o600 }); } catch { /* best effort */ } }; // INT-1: torn-write-safe
  const recOf = userCap => { const h = hash(String(userCap || '')); return data.users[h] ? { h, rec: data.users[h] } : null; };
  const view = rec => ({ root: rec.root || CANONICAL_ROOT, prefs: rec.prefs || {} });

  // INIT: mint a NEW persistent user-cap (the caller already holds a valid invite cap — verified by the server
  // BEFORE calling this). Returns the user-cap swissnum (shown once) + the fresh record's view.
  const mint = ({ root = CANONICAL_ROOT, prefs = {} } = {}) => {
    const userCap = newSwiss();
    data.users[hash(userCap)] = { root: String(root || CANONICAL_ROOT), prefs: (prefs && typeof prefs === 'object') ? { ...prefs } : {}, createdAt: new Date().toISOString(), lastSeen: new Date().toISOString() };
    save();
    return { ok: true, userCap, ...view(data.users[hash(userCap)]) };
  };

  // GET: resolve a held user-cap → its { root, prefs } (and bump lastSeen). null if unknown/revoked.
  const get = userCap => { const r = recOf(userCap); if (!r) return null; r.rec.lastSeen = new Date().toISOString(); save(); return view(r.rec); };

  // PREFS: shallow-merge the user's preferences (their own data — fires directly, reversible by re-setting).
  const setPrefs = (userCap, prefs) => { const r = recOf(userCap); if (!r) return { ok: false, error: 'unknown user' }; r.rec.prefs = { ...(r.rec.prefs || {}), ...((prefs && typeof prefs === 'object') ? prefs : {}) }; save(); return { ok: true, prefs: r.rec.prefs }; };

  // ROOT POINTER: which app variant this user sees (the canonical root, or a component/fork id of their variant).
  // This is how a user's edits/forks of the SHELL diverge from everyone else's without affecting them.
  const setRoot = (userCap, root) => { const r = recOf(userCap); if (!r) return { ok: false, error: 'unknown user' }; r.rec.root = String(root || CANONICAL_ROOT); save(); return { ok: true, root: r.rec.root }; };

  // DELETE (INC-3 / P4 delete-my-data): forget a user's record entirely. Self-authorizing — the caller PRESENTS
  // the user-cap (designation by reference), exactly like get/prefs/root; holding it is the authorization, so a
  // holder can only ever delete their OWN record. Idempotent: an unknown/already-deleted cap is a safe no-op
  // ({ existed: false }). torn-write-safe via the same atomic save. No swissnum touches disk (keyed by hash).
  const del = userCap => {
    const r = recOf(userCap);
    if (!r) return { ok: true, existed: false };
    delete data.users[r.h];
    save();
    return { ok: true, existed: true };
  };
  const count = () => Object.keys(data.users).length;
  return { mint, get, setPrefs, setRoot, delete: del, count, CANONICAL_ROOT };
};
