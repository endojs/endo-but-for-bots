// inbox-cells.mjs — the 🔔 bell + inbox as PUSH cells (`feed:<ownerKey>` / `asks:<ownerKey>`) instead of a
// 60s poll. The most central always-on surface: the notification badge and the inbox list. It used to
// `setInterval(refreshBadge, 60000)` — two fetches a minute, forever, on every open tab — so a proposal or a
// new ask could sit up to a minute before the bell noticed.
//
// This holds, per NON-SECRET owner key, a MONOTONIC revision for each family, and PUSHES a fresh {rev,at} to
// subscribers whenever feed.json / asks.json changes (same propagator discipline as seed-cells.mjs /
// trace-cells.mjs — subscribe, never poll). The value is a bare POKE (a revision counter, no content): the
// client re-reads the owner-gated /feed/load + /asks/load ON a push, so the per-cap dismissed-state and the
// root-only content gate stay EXACTLY where they already live (cap-hygiene — a swissnum never rides a cell).
//
// PUSH TRIGGER. feed.json / asks.json are written by MANY processes — the server (postFeed, /asks/answer),
// the agent-facing `notify`/`pushFeed` cap (feed.mjs, another worker's file), the off-app asks drain, the
// dashboard. So the trigger is an fs.watch on their directory(ies): an EXTERNAL write pushes just as a
// server-side one does. The server ALSO calls bump() at its own mutation sites for zero-latency immediacy;
// a doubled bump is harmless (the client refresh is idempotent + debounced).
//
// CONTENT IS ROOT-ONLY (matching /feed/load → empty for a non-root cap, /asks/load → 403). So a bump only
// ever targets the 'root' owner; a non-root cap that follows feed:self / asks:self gets a valid but IDLE
// cell (rev 0, never fed) — an empty inbox, no leak, no refusal. The OWNER GATE (server.mjs) refuses a cap
// asking for a FOREIGN owner key, exactly like seeds:/backlog:.

import fs from 'node:fs';
import path from 'node:path';

const FAMILIES = ['feed', 'asks', 'dev'];

/**
 * @param {object} opts
 * @param {string} [opts.feedFile] path to feed.json (its directory is watched)
 * @param {string} [opts.asksFile] path to asks.json (its directory is watched)
 * @param {string} [opts.devFile] path to the Blacksmith dev-task queue (its directory is watched)
 * @param {() => number} [opts.now]
 * @param {number} [opts.debounceMs] coalesce the burst of events an atomic temp+rename fires
 * @param {boolean} [opts.watch] set false in unit tests that drive bump() directly
 */
export const makeInboxCells = ({ feedFile, asksFile, devFile, now = () => Date.now(), debounceMs = 120, watch = true } = {}) => {
  const state = { feed: new Map(), asks: new Map(), dev: new Map() }; // family → Map(ownerKey → { rev, at })
  const listeners = { feed: new Map(), asks: new Map(), dev: new Map() }; // family → Map(ownerKey → Set<fn>)

  const valOf = (fam, key) => state[fam].get(key) || { rev: 0, at: 0 };
  const notifyKey = (fam, key) => {
    const set = listeners[fam].get(key);
    if (!set) return;
    const v = { ...valOf(fam, key) };
    for (const fn of [...set]) { try { fn(v); } catch { /* one bad listener can't break the cell */ } }
  };

  // bump(family[, ownerKey='root']) — fold ONE change into the family's revision + push. Content is
  // root-only, so a bump targets 'root' by default. Never throws (an unknown family is a no-op).
  const bump = (fam, ownerKey = 'root') => {
    if (!FAMILIES.includes(fam)) return;
    const k = String(ownerKey || 'root').slice(0, 80);
    const cur = valOf(fam, k);
    state[fam].set(k, { rev: cur.rev + 1, at: now() });
    notifyKey(fam, k);
  };

  const cells = new Map(); // `${fam}:${key}` → cell
  const cellFor = (fam, ownerKey) => {
    const f = FAMILIES.includes(fam) ? fam : 'feed';
    const k = String(ownerKey || '').slice(0, 80);
    const ck = `${f}:${k}`;
    let cell = cells.get(ck);
    if (!cell) {
      cell = {
        get: () => ({ ...valOf(f, k) }),
        // PUSH-fed by bump() (never a poll loop); a late subscriber gets the current value immediately.
        subscribe: fn => {
          let set = listeners[f].get(k);
          if (!set) { set = new Set(); listeners[f].set(k, set); }
          set.add(fn);
          try { fn({ ...valOf(f, k) }); } catch { /* */ }
          return () => { set.delete(fn); if (!set.size) listeners[f].delete(k); };
        },
      };
      cells.set(ck, cell);
    }
    return cell;
  };

  // fs.watch(dir) — feed.json + asks.json share DASH_STATE_DIR (one watcher covers both). Watch the DIR (not
  // the file) so a temp+rename replace, or a first-ever create, is still seen. Debounced per family.
  const watchers = [];
  const timers = new Map();
  if (watch) {
    const dirs = new Map(); // dir → { [basename]: 'feed'|'asks' }
    const arm = (file, fam) => {
      if (!file) return;
      const dir = path.dirname(file);
      const base = path.basename(file);
      const m = dirs.get(dir) || {};
      m[base] = fam;
      dirs.set(dir, m);
    };
    arm(feedFile, 'feed');
    arm(asksFile, 'asks');
    arm(devFile, 'dev');
    for (const [dir, bases] of dirs) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
      try {
        const w = fs.watch(dir, (_ev, fn) => {
          const fam = fn && bases[String(fn)];
          if (!fam) return;
          clearTimeout(timers.get(fam));
          timers.set(fam, setTimeout(() => bump(fam), debounceMs));
        });
        w.unref?.();
        watchers.push(w);
      } catch { /* fs.watch unsupported here → the explicit bump() sites still push */ }
    }
  }

  const close = () => {
    for (const t of timers.values()) clearTimeout(t);
    for (const w of watchers) { try { w.close(); } catch { /* */ } }
  };

  return harden({ bump, cellFor, close, snapshot: (fam, key = 'root') => ({ ...valOf(FAMILIES.includes(fam) ? fam : 'feed', key) }) });
};
harden(makeInboxCells);
