// seed-cells.mjs — IN-FLIGHT capture ingestion progress as a monotonic per-owner cell (`seeds:<ownerKey>`).
//
// dan's ask: "see inbound voice notes being processed in real time in the chats list." A voice note
// ingested through POST /ingest is analyzed server-side (LLM decompose → a propose-only SEED chat) — a
// multi-second gap during which the chats list showed NOTHING. This module surfaces that gap: it holds,
// per NON-SECRET owner key, the list of captures currently being processed with their STAGE, and PUSHES a
// fresh snapshot to subscribers on every transition (same propagator discipline as trace-cells.mjs /
// live-cells.mjs / component-backlog.mjs — subscribe, never poll).
//
// MONOTONIC: a capture's stage only ever advances (received → transcribing → understanding → proposed →
// done); a stray out-of-order emit can never move it backward. BOUNDED: finished captures (proposed/done)
// are pruned after a short TTL — the client resolves them into the real seed-chat row via loadSeedChats,
// so the in-flight row is transient by design.
//
// CAP-HYGIENE: values carry only ids, scrubbed titles, stage labels, timestamps, and the (non-secret) new
// chatId — never a cap/swissnum. OWNERSHIP: keyed by the SAME non-secret 'root'/'u:<hash>' owner key the
// trace cells use; the /cells/subscribe route gates `seeds:` subscriptions on it (owner match or root).

const STAGE_RANK = { received: 0, transcribing: 1, understanding: 2, proposed: 3, done: 4 };
const MAX_INFLIGHT = 64; // per owner — a runaway ingest can't grow the cell without bound
const DONE_TTL_MS = 90 * 1000; // keep a resolved capture visible briefly, then prune (the real row has landed)
const S = (v, n) => String(v == null ? '' : v).slice(0, n);

export const makeSeedCells = ({ ttlMs = DONE_TTL_MS, max = MAX_INFLIGHT, now = () => Date.now() } = {}) => {
  const owners = new Map(); // ownerKey → Map(id → { id, title?, stage, at, doneAt?, chatId? })
  const listeners = new Map(); // ownerKey → Set<fn>

  const mapFor = key => { let m = owners.get(key); if (!m) { m = new Map(); owners.set(key, m); } return m; };

  // the cell VALUE: a render-safe plain-JSON array (goes over SSE as-is), newest first.
  const snapshot = key => {
    const m = owners.get(key); if (!m) return [];
    return [...m.values()].sort((a, b) => b.at - a.at).map(c => ({ ...c }));
  };
  const notify = key => { const set = listeners.get(key); if (!set) return; const v = snapshot(key); for (const fn of [...set]) { try { fn(v); } catch { /* one bad listener can't break the cell */ } } };

  const prune = m => {
    const t = now();
    for (const [id, c] of [...m.entries()]) { if ((c.stage === 'done' || c.stage === 'proposed') && (t - (c.doneAt || c.at)) > ttlMs) m.delete(id); }
    if (m.size > max) { const oldest = [...m.entries()].sort((a, b) => a[1].at - b[1].at); while (m.size > max) { const [id] = oldest.shift(); m.delete(id); } }
  };

  // stage(ownerKey, id, st, extra?) — fold ONE transition into the lattice. Monotonic (never rewinds),
  // upserts title/chatId when they become known, pushes a fresh snapshot. Never throws (a bad call is a no-op).
  const stage = (ownerKey, id, st, extra = {}) => {
    if (!ownerKey || !id || !Object.prototype.hasOwnProperty.call(STAGE_RANK, st)) return;
    const m = mapFor(ownerKey);
    let c = m.get(id);
    if (!c) { c = { id: S(id, 80), stage: st, at: now() }; m.set(id, c); }
    if (STAGE_RANK[st] >= STAGE_RANK[c.stage]) c.stage = st; // monotonic advance only
    if (extra && extra.title) c.title = S(extra.title, 120); // a real (non-empty) title refines the row; placeholders stay client-side
    if (extra && extra.chatId != null) c.chatId = S(extra.chatId, 80);
    if (c.stage === 'proposed' || c.stage === 'done') c.doneAt = c.doneAt || now();
    prune(m);
    notify(ownerKey);
  };

  // cellFor(ownerKey) — the live-cells cell interface ({ get, subscribe(fn)→unsub }) over snapshot(key).
  // PUSH-fed by stage() (never a poll loop); a late subscriber gets the current value immediately.
  const cells = new Map();
  const cellFor = ownerKey => {
    const k = S(ownerKey, 80);
    let cell = cells.get(k);
    if (!cell) {
      cell = {
        get: () => snapshot(k),
        subscribe: fn => {
          let set = listeners.get(k); if (!set) { set = new Set(); listeners.set(k, set); } set.add(fn);
          try { fn(snapshot(k)); } catch { /* */ }
          return () => { set.delete(fn); if (!set.size) listeners.delete(k); };
        },
      };
      cells.set(k, cell);
    }
    return cell;
  };

  return harden({ stage, snapshot, cellFor });
};
harden(makeSeedCells);
