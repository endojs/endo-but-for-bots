// turn-watchdog.mjs — pure detection for the UNANSWERED-TURN watchdog (P1-6, imp-ae117636).
//
// ~13% of turns end with the user's message and NO assistant reply — a run that died silently (the crash/
// 500 case, or a run whose in-memory controller vanished while /chat/result still reports 'running'). The
// ingress-warden self-heals only fixed systemd services and has no notion of a chat turn, so this was
// invisible. This module holds the two PURE detectors (no I/O, no server state — everything is passed in) so
// they're unit-testable; the server drives them on a periodic tick (retry-once + notify) and the
// ingress-warden reuses scanUnansweredBundle over the persisted chat store on disk (the cross-process net
// for when the server itself is down).

const asArray = v => (Array.isArray(v) ? v : []);

/**
 * detectStuckRuns — a `runResults[sid].state === 'running'` whose run is actually DEAD.
 * Two dead shapes (the ticket's cross-check): the in-memory run controller is gone (`!runs.has(sid)` —
 * /chat/result STILL reports 'running' in this case, the silent hang), OR it's been 'running' longer than
 * the per-turn deadline (a run that overran its own timer).
 *
 * @param {object} a
 * @param {Map<string, {state?:string, text?:string, startedAt?:number}>} a.runResults
 * @param {Map<string, unknown>} a.runs  sid → live AbortController (presence = in-flight)
 * @param {number} a.now
 * @param {number} a.deadlineMs
 * @returns {{sid:string, reason:'no-run'|'stale', text:string, startedAt:number}[]}
 */
export const detectStuckRuns = ({ runResults, runs, now, deadlineMs }) => {
  const out = [];
  if (!runResults || typeof runResults.entries !== 'function') return out;
  for (const [sid, rr] of runResults) {
    if (!rr || rr.state !== 'running') continue;
    const dead = !(runs && runs.has && runs.has(sid));
    const started = Number(rr.startedAt) || 0;
    const stale = started > 0 && (now - started) > deadlineMs;
    if (dead || stale) out.push({ sid: String(sid), reason: dead ? 'no-run' : 'stale', text: String(rr.text || ''), startedAt: started });
  }
  return out;
};
harden(detectStuckRuns);

/**
 * scanUnansweredBundle — a PERSISTED chat that ends on a USER message with no following assistant turn
 * (the crash/500 case). Reads the synced chat bundle shape ({ chats:[{id,title,lastMsgAt}], tx:{ id:[{who,
 * text,at}] } }). Bounded to RECENT breakage (older than the deadline, younger than maxAgeMs) so it flags a
 * real stall — not every ancient abandoned chat.
 *
 * @param {{chats?:any[], tx?:Record<string, any[]>}} bundle
 * @param {object} a
 * @param {number} a.now
 * @param {number} a.deadlineMs   a turn quiet longer than this = plausibly unanswered
 * @param {number} [a.maxAgeMs]   ignore breakage older than this (default 6h)
 * @returns {{chatId:string, title:string, lastUserText:string, at:number}[]}
 */
export const scanUnansweredBundle = (bundle, { now, deadlineMs, maxAgeMs = 6 * 60 * 60 * 1000 }) => {
  const out = [];
  const chats = asArray(bundle && bundle.chats);
  const tx = (bundle && bundle.tx && typeof bundle.tx === 'object') ? bundle.tx : {};
  for (const c of chats) {
    if (!c || !c.id) continue;
    const msgs = asArray(tx[c.id]).filter(m => m && String(m.text || '').trim());
    if (!msgs.length) continue;
    const last = msgs[msgs.length - 1];
    if (last.who !== 'you') continue; // ended on a user message = no assistant reply landed
    const at = Number(last.at) || Number(c.lastMsgAt) || 0;
    if (!at) continue;
    const age = now - at;
    if (age > deadlineMs && age < maxAgeMs) out.push({ chatId: String(c.id), title: String(c.title || ''), lastUserText: String(last.text || '').slice(0, 200), at });
  }
  return out;
};
harden(scanUnansweredBundle);
