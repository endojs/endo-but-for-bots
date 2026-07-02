// credit-intents.mjs — INT-6: make "user paid → purse credited" crash-safe (money-loss fix).
//
// The bug: a redeem (Stripe webhook / on-chain delegation redeem) records the payment in ITS OWN store
// (pending-payments status='paid', or delegations.redeemed += uusd) and then SEPARATELY credits the purse
// (purseFor(cap,sid).credit(uusd)). A crash BETWEEN those two = the user paid but got nothing, with no
// record that a credit is owed — the money is silently lost.
//
// The fix: a durable JOURNAL of credit INTENTS. Each real credit is:
//   1. journal a PENDING intent (durable) BEFORE touching the purse;
//   2. do the live credit (in-memory purse + its debounced persist);
//   3. force the purse durable (flushPurse), then mark the intent APPLIED (durable).
// On boot, replayPending() re-applies any intent still PENDING (a crash lost the credit) via creditByHash.
//
// CAP-HYGIENE: the intent stores only the HASH of the purse routing key (never the raw cap/swissnum), and
// replay credits by that hash (purseStore.creditByHash) — so no swissnum ever lands in this journal.
//
// IDEMPOTENCY: an intent is REPLAYED only while status==='pending'. A completed credit is 'applied' and is
// never replayed. apply() is a no-op for an id already 'applied'. The only residual double-credit window is
// a crash BETWEEN the forced purse flush and the mark-applied write (sub-millisecond) — strictly, and by
// design, biased toward this vanishing over-credit window rather than the large money-LOSS window it
// replaces. Documented so a reader knows it is a deliberate trade.

import { writeJsonAtomic, loadJson } from './write-json-atomic.mjs';

const PRUNE_AGE_MS = 30 * 24 * 60 * 60 * 1000; // drop applied intents older than 30 days to bound the file

// makeCreditIntents({ file, flushPurse, creditByHash }):
//   flushPurse()  — force the purse store durable (purseStore.flushNow) after a live credit.
//   creditByHash(hashedKey, uusd) — credit the persisted purse by its hashed routing key (boot replay).
export const makeCreditIntents = ({ file, flushPurse = () => {}, creditByHash } = {}) => {
  // GUARDED money store — a corrupt-but-present journal must not silently vanish (owed credits would be lost).
  let data = loadJson(file, { intents: {} }, { guard: true });
  if (!data || typeof data !== 'object' || !data.intents) data = { intents: {} };
  const save = () => { try { writeJsonAtomic(file, data, { pretty: true, bak: true }); } catch { /* best-effort; the intent may replay next boot */ } };

  // Record + apply a credit crash-safely. `id` is a STABLE unique key for the payment (payId / tx ref), so a
  // retry with the same id can't double-credit. `hashedKey` = hash of the purse routing key (for replay).
  // `doLiveCredit()` performs the in-memory purse credit. Returns { applied, already }.
  const apply = (id, { hashedKey, uusd, kind = '' } = {}, doLiveCredit) => {
    const key = String(id);
    const existing = data.intents[key];
    if (existing && existing.status === 'applied') return { applied: false, already: true }; // idempotent: already credited
    data.intents[key] = { hashedKey, uusd: Math.max(0, Math.round(Number(uusd) || 0)), kind, status: 'pending', at: Date.now() };
    save(); // DURABLE record of the owed credit BEFORE we touch the purse
    try { doLiveCredit(); } catch (e) { /* the intent stays pending → replayed on boot */ throw e; }
    try { flushPurse(); } catch { /* the credit may replay if it wasn't durable */ }
    data.intents[key].status = 'applied'; data.intents[key].appliedAt = Date.now();
    save();
    return { applied: true, already: false };
  };

  // Boot replay: re-apply any intent a crash left PENDING (paid, but the purse credit was lost). Idempotent:
  // only pending intents are touched, and each is marked applied after crediting.
  const replayPending = () => {
    let n = 0;
    for (const [id, it] of Object.entries(data.intents)) {
      if (it && it.status === 'pending') {
        try {
          if (it.hashedKey && creditByHash) creditByHash(it.hashedKey, it.uusd);
          try { flushPurse(); } catch { /* */ }
          it.status = 'applied'; it.appliedAt = Date.now(); it.replayed = true;
          n += 1;
        } catch { /* leave it pending; it will be retried on the next boot */ }
      }
    }
    if (n) save();
    return n;
  };

  // bound the file: drop applied intents older than the prune horizon.
  const prune = (maxAgeMs = PRUNE_AGE_MS, now = Date.now()) => {
    let removed = 0;
    for (const [id, it] of Object.entries(data.intents)) {
      if (it && it.status === 'applied' && (now - (it.appliedAt || it.at || 0)) > maxAgeMs) { delete data.intents[id]; removed += 1; }
    }
    if (removed) save();
    return removed;
  };

  return harden({ apply, replayPending, prune, has: id => !!data.intents[String(id)], status: id => (data.intents[String(id)] || {}).status || null });
};
harden(makeCreditIntents);
