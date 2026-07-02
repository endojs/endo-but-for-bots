// purse-store.mjs — durable balances so purses survive a server restart (purses are otherwise in-memory
// and reset on every restart, wiping everyone's allowance). A throwaway-stub step toward Increment 6's
// journaled agora bank; same {balance, granted} shape.
//
// CAP-HYGIENE: purses are keyed by `${cap}:${sid}`, and cap is a swissnum — so we NEVER write the raw key
// to disk. The file maps a SHA-256 HASH of the key → {balance, granted}. The hash can't be reversed to a
// swissnum, and purseFor recomputes the same hash, so lookups still work.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const hashKey = key => crypto.createHash('sha256').update(String(key)).digest('hex');

export const makePurseStore = ({ file, debounceMs = 800 }) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { data = {}; }
  let timer = null;
  let pending = false;
  const flush = () => {
    pending = false; timer = null;
    try { const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`; fs.writeFileSync(tmp, JSON.stringify(data)); fs.renameSync(tmp, file); }
    catch { /* best-effort; a missed write loses at most a few seconds of debits */ }
  };
  const schedule = () => { pending = true; if (!timer) timer = setTimeout(flush, debounceMs); };

  return {
    // returns { balance, granted } for a key's HASH, or undefined if never persisted
    get: key => data[hashKey(key)],
    set: (key, balance, granted) => { data[hashKey(key)] = { balance: Math.round(balance) || 0, granted: Math.round(granted) || 0 }; schedule(); },
    // INT-6: credit by the ALREADY-HASHED key. Boot replay of an unapplied payment credit only holds the
    // HASH of the routing key (the raw cap/swissnum is never persisted — cap-hygiene), so it can't call
    // set()/get() which hash their argument. Adds uusd to the existing persisted balance (base 0 if absent);
    // safe because replay runs before any live purse rehydrates from this store. Returns the new balance.
    creditByHash: (h, uusd) => { const cur = data[h] || { balance: 0, granted: 0 }; cur.balance = (Math.round(cur.balance) || 0) + Math.max(0, Math.round(Number(uusd) || 0)); data[h] = cur; schedule(); return cur.balance; },
    remove: key => { const h = hashKey(key); if (h in data) { delete data[h]; schedule(); } },
    // write immediately (used on shutdown so the last debits aren't lost)
    flushNow: () => { if (pending || timer) { clearTimeout(timer); flush(); } },
  };
};
harden(makePurseStore);
