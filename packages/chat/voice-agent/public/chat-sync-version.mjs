// chat-sync-version.mjs — ARCH-4 pure version-vector decision for cross-device chat sync.
//
// The SERVER is the version authority: /chats/save stamps a monotonic per-cap `seq`
// (persisted as data._seq) and returns it; /chats/load returns `{ data, seq }`. The
// client keeps the last server `seq` beside its localStorage bundle and treats
// localStorage as a CACHE keyed to that seq — it adopts a remote bundle only when the
// remote seq is strictly HIGHER than the local one. This replaces the old wall-clock
// `updated` LWW gate, which let a skewed-clock device always win and diverge per-field
// (title/active) across a user's devices.
//
// Backward-compatible: if the server returns no `seq` (an older server), fall back to
// the legacy wall-clock gate (`remoteUpdated >= localUpdated`).
//
// Kept as a pure, DOM-free module so the decision is unit-testable in Node (app.js
// itself can only run in the browser).

/**
 * Decide whether to adopt the server's chat bundle over the local cache.
 * @param {object} a
 * @param {boolean} a.hasChats           remote bundle carries at least one chat
 * @param {number|null|undefined} a.remoteSeq  server-authoritative seq (null/undefined ⇒ legacy server)
 * @param {number} [a.localSeq]          last server seq this client adopted/saved
 * @param {number} [a.remoteUpdated]     remote wall-clock (legacy fallback only)
 * @param {number} [a.localUpdated]      local wall-clock (legacy fallback only)
 * @returns {boolean}
 */
export function shouldAdoptRemote({ hasChats, remoteSeq, localSeq = 0, remoteUpdated = 0, localUpdated = 0 }) {
  if (!hasChats) return false;
  // ARCH-4: server-authoritative monotonic seq is the version vector. Adopt-when-higher.
  if (typeof remoteSeq === 'number') return remoteSeq > (localSeq || 0);
  // Legacy server (no seq) — fall back to the old wall-clock last-writer-wins gate.
  return (remoteUpdated || 0) >= (localUpdated || 0);
}
