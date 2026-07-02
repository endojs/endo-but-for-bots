// component-backlog.mjs — every component/fork project-object carries its own BACKLOG.
//
// dan's rule: creating a component IMPLICITLY endows the creator with the right to add to and receive
// requests on its backlog — issue requests, errors thrown, and things. There is no separate "backlog
// cap" to mint or string name to guess: the backlog is KEYED BY the component/fork's git identity
// (the same `uicomp-…` / `fork-…` id component-git.mjs and forks.mjs already use), and the OWNER FACET
// (read/list, ack/done, add) is gated by exactly the ownership check the object's other routes use —
// designation by the id the caller already holds, ownership by the cap that owns the object. Others
// (share/fork recipients) get an ATTENUATED ADD-ONLY verb: they can file, never read.
//
// PROPAGATOR discipline (client/propagator.js / live-cells.mjs): the store is the ONE source of truth;
// all writes go through the verbs below (add / setStatus), each mutation is a MERGE into the per-object
// item lattice (dedupe by kind+title; `count` is the monotonic join — re-delivering the same info bumps
// a counter, never forks a duplicate row), and every mutation PUSHES to per-object subscribers. cellFor(id)
// vends the live-cells cell interface ({ get, subscribe }) over the OPEN view, so the /cells/subscribe
// broker can stream it to the owner's UI — badge counts and open-issue lists update live, no polling,
// no parallel mechanism. The cell is the READ/NOTIFY surface (owner-only); the verbs are the WRITE surface.
//
// Item: { id, kind: 'error'|'issue'|'request', title, body, from, at, status: 'open'|'ack'|'done', count }.
// `from` is an OPAQUE, NON-SECRET origin tag ('runtime' | 'owner' | a share-token hash prefix) — never a
// cap, token, or swissnum (cap-hygiene: nothing in this store or its cell view is secret).

import crypto from 'node:crypto';
import fs from 'node:fs';

import { writeJsonAtomic } from './write-json-atomic.mjs';

const KINDS = ['error', 'issue', 'request'];
const STATUSES = ['open', 'ack', 'done'];
const clean = (s, n) => String(s == null ? '' : s).slice(0, n);

export const makeComponentBacklog = ({ file, maxItems = 200 } = {}) => {
  let data = {}; // componentId → { createdAt, items: [item…] }
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* fresh */ }
  const save = () => { try { writeJsonAtomic(file, data); } catch { /* best-effort */ } }; // INT-1: torn-write-safe

  // ── the propagator seam: per-object subscribers, pushed a fresh snapshot on every mutation ──
  const listeners = new Map(); // componentId → Set<fn>
  const itemView = it => ({ id: it.id, kind: it.kind, title: it.title, body: it.body, from: it.from, at: it.at, status: it.status, count: it.count });
  // the cell's VALUE: the open view + counts. Render-safe pure data (JSON over SSE) — no cap, no token.
  const snapshot = id => {
    const rec = data[id];
    const items = (rec && rec.items) || [];
    const open = items.filter(it => it.status === 'open').map(itemView);
    return { id, open, counts: { open: open.length, total: items.length } };
  };
  const notify = id => { const set = listeners.get(id); if (!set) return; const v = snapshot(id); for (const fn of [...set]) { try { fn(v); } catch { /* one bad listener can't break the cell */ } } };

  const recFor = id => data[String(id)] || null;
  const ensure = id => { const k = clean(id, 80); if (!k) return false; if (!data[k]) { data[k] = { createdAt: new Date().toISOString(), items: [] }; save(); } return true; };

  // add — the ONE write path for new information. MERGE semantics (the lattice join): an open item with
  // the same kind+title absorbs the re-delivery as count+1 (+ a fresher `at`), so a re-thrown error or a
  // re-filed identical issue never duplicates a row. Bounded: past maxItems the oldest resolved (then
  // oldest) items fall off — the backlog never grows without bound.
  const add = (id, { kind, title, body = '', from = '' } = {}) => {
    const k = clean(id, 80); if (!k) return { ok: false, error: 'no component id' };
    const t = clean(title, 200).trim(); if (!t) return { ok: false, error: 'an item needs a title' };
    const kd = KINDS.includes(kind) ? kind : 'issue';
    ensure(k);
    const rec = data[k];
    const dup = rec.items.find(it => it.kind === kd && it.title === t && it.status === 'open');
    if (dup) { dup.count += 1; dup.at = new Date().toISOString(); save(); notify(k); return { ok: true, id: dup.id, deduped: true, count: dup.count }; }
    const item = { id: `bl-${crypto.randomBytes(5).toString('hex')}`, kind: kd, title: t, body: clean(body, 2000), from: clean(from, 40), at: new Date().toISOString(), status: 'open', count: 1 };
    rec.items.push(item);
    while (rec.items.length > maxItems) { const i = rec.items.findIndex(it => it.status !== 'open'); rec.items.splice(i >= 0 ? i : 0, 1); }
    save(); notify(k);
    return { ok: true, id: item.id, deduped: false, count: 1 };
  };

  // SEC-15: the ADD-ONLY facet, now STRUCTURAL rather than route discipline. A share/fork recipient (and
  // the /components|forks/backlog/report routes) hold ONLY this object — bound to one componentId by
  // construction — so add-only is enforced by the SHAPE of the capability they were handed (no list/open/
  // counts/setStatus/remove/cellFor to reach), not by a route remembering to call the right method. The
  // holder can file exactly one kind of thing against exactly one object and read nothing back.
  const addOnlyFacet = id => { const k = clean(id, 80); return harden({ add: item => add(k, item) }); };

  // owner reads — never reachable from the add-only facet (the routes enforce that; nothing here is).
  const list = (id, { status } = {}) => { const rec = recFor(clean(id, 80)); const items = (rec && rec.items) || []; return (status ? items.filter(it => it.status === status) : items).map(itemView); };
  const open = id => list(id, { status: 'open' });
  const counts = id => snapshot(clean(id, 80)).counts;

  // ack / done / re-open — the owner's resolution verbs (the other write path; also pushes the cell).
  const setStatus = (id, itemId, status) => {
    const k = clean(id, 80); const rec = recFor(k);
    if (!rec) return { ok: false, error: 'unknown component/fork backlog' };
    const st = STATUSES.includes(status) ? status : 'done';
    const it = rec.items.find(x => x.id === String(itemId || ''));
    if (!it) return { ok: false, error: 'unknown backlog item' };
    if (it.status !== st) { it.status = st; save(); notify(k); }
    return { ok: true, id: it.id, status: it.status };
  };

  const remove = id => { const k = clean(id, 80); if (!data[k]) return false; delete data[k]; save(); notify(k); return true; };

  // cellFor(id) — the live-cells cell interface ({ get, subscribe(fn)→unsub }) over snapshot(id).
  // PUSH-fed by the store's own mutations (never a poll loop); a late subscriber gets the current
  // value immediately (the propagator "catch a late-wired neighbour up" rule).
  const cells = new Map();
  const cellFor = id => {
    const k = clean(id, 80);
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

  // the injectable context note — the SAME open view the cell serves, phrased for the edit-chat agent.
  // One source of truth: what the owner's badge shows is what the editor agent reads.
  const contextNote = (id, name) => {
    const items = open(id);
    if (!items.length) return '';
    return `\n\nOPEN BACKLOG for "${clean(name || id, 80)}" — ${items.length} item(s) filed against this component (runtime errors auto-file; share recipients file issues). Address what's relevant this conversation and resolve items you fix with resolveBacklogItem:\n${items.map(it => `- [${it.kind}] ${it.title}${it.count > 1 ? ` (×${it.count})` : ''}${it.body ? ` — ${clean(it.body, 200)}` : ''} (item ${it.id}, from ${it.from || 'unknown'})`).join('\n')}`;
  };

  return harden({ ensure, add, addOnlyFacet, list, open, counts, setStatus, remove, cellFor, contextNote });
};
harden(makeComponentBacklog);
