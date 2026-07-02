// bsky-handoff.mjs — SEC-16. A one-time, short-lived handoff for the Bluesky OAuth scoped cap.
//
// The OAuth callback must redirect the browser back to the app WITH the scoped cap, but a 302 `Location`
// header (and its #fragment) is logged by any reverse proxy in front of us (ngrok, etc.) — so putting the
// swissnum in `#cap=` risks leaking the credential into a proxy log. Instead the redirect carries a single-use
// NONCE; the client swaps it for the cap over a POST body (never a URL/header). The store is in-memory with a
// short TTL, so the swissnum never touches disk or any log, and a logged nonce is dead the instant it is
// redeemed (or after the TTL).
import crypto from 'node:crypto';

// makeBskyHandoffs({ ttlMs, now, randomNonce }) — `now`/`randomNonce` are injectable for tests.
export const makeBskyHandoffs = ({
  ttlMs = 120_000,
  now = () => Date.now(),
  randomNonce = () => crypto.randomBytes(18).toString('base64url'),
} = {}) => {
  const store = new Map(); // nonce → { cap, exp }
  // mint(scopedCap) → a fresh single-use nonce that maps to it for ttlMs.
  const mint = scopedCap => {
    const nonce = randomNonce();
    store.set(nonce, { cap: String(scopedCap), exp: now() + ttlMs });
    return nonce;
  };
  // redeem(nonce) → the cap, or null if unknown/expired. SINGLE-USE: the entry is deleted on read (even when
  // expired), so a replayed nonce can never yield the cap twice.
  const redeem = nonce => {
    const k = String(nonce || '');
    const h = store.get(k);
    if (!h) return null;
    store.delete(k);
    return now() > h.exp ? null : h.cap;
  };
  // Drop expired entries (a periodic sweep bounds the map; redeem already self-cleans on access).
  const sweep = () => {
    const t = now();
    for (const [n, h] of store) if (t > h.exp) store.delete(n);
  };
  const size = () => store.size;
  return harden({ mint, redeem, sweep, size });
};
harden(makeBskyHandoffs);
