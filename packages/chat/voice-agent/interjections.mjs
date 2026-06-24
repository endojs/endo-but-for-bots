// interjections.mjs — a per-turn queue of mid-turn user messages, keyed by sessionId (the system's turn
// identity — there is no separate turnId; a session has at most one in-flight run). The flow:
//   POST /chat/interject {sessionId,text}  → push (only while a turn is running)
//   runAgentCode, at each step boundary     → take (DRAINS, once-only) → folds into the model's context
//   /chat handler, when the turn ends        → drop (so nothing leaks into the next turn)
// In-memory by design: an interjection is only meaningful while a turn runs; there is nothing to persist.
// (No module-level harden so it stays importable in plain-node tests; the server hardens what it returns.)
export const makeInterjections = () => {
  const q = new Map(); // sessionId → [text, …]
  return {
    // queue a mid-turn message; returns false on empty text / no id. Caller gates on "a turn is running".
    push: (id, text) => {
      const k = String(id || ''); const t = String(text || '').trim().slice(0, 2000);
      if (!k || !t) return false;
      q.set(k, [...(q.get(k) || []), t]);
      return true;
    },
    // DRAIN everything queued for this turn, exactly once (a second take returns []).
    take: id => { const k = String(id || ''); const a = q.get(k) || []; if (a.length) q.delete(k); return a; },
    // turn ended → forget anything still queued (never carries into the next turn).
    drop: id => q.delete(String(id || '')),
    pending: id => (q.get(String(id || '')) || []).length,
  };
};
