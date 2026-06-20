// The DEFAULT island architecture: propagation networks (Radul & Sussman, MIT-CSAIL-TR-2009-053)
// + Caputi grains. Islands are NOT stateful components — they are STATELESS functional/render
// PROPAGATORS wired to CELLS (data grains) that hold the state.
//
//   • A CELL (data grain) accumulates information about a value: writes MERGE (they don't blind-
//     overwrite), the cell never silently loses info, and it NOTIFIES its neighbours on change
//     (that is `subscribe`). State lives ONLY in cells.
//   • A PROPAGATOR is a stateless, memoryless machine wired to the cells it neighbours: it reads
//     its input cells, runs a pure function, and writes an output cell, re-firing whenever an input
//     changes — until the network is quiescent (no cell gains new info). A propagator's authority
//     IS the set of cells it is wired to; nothing else is in scope.
//
// This file is the substrate (no DOM, no preact). The *render* propagator (cells → confined DOM)
// lives in islands.js where renderConfined is in scope.

// The empty cell: "no information yet". A cell holding NOTHING has not been told anything.
export const NOTHING = Symbol('propagator/nothing');

// ── merge functions (the grain's accumulation policy) ───────────────────────────────────────────
// Default: last-writer-wins — pragmatic for UI facts that genuinely change over time (the current
// shares list, the current balance). Swap in a monotonic merge for grains that should only ever gain
// information (a set that only grows, a max, a TMS cell). A merge MUST be commutative/idempotent
// enough that re-delivering the same info is a no-op (that is what makes propagation order-independent).
export const lastWriteWins = (_old, next) => next;
export const mergeEqual = (old, next) => {
  if (Object.is(old, next)) return old;
  throw new Error('cell contradiction: a grain was told two different values');
};
export const unionSet = (old, next) => {
  const out = new Set(old instanceof Set ? old : []);
  for (const x of next instanceof Set ? next : [next]) out.add(x);
  return out;
};
export const max = (old, next) => (next > old ? next : old);

// ── makeCell — a data grain ─────────────────────────────────────────────────────────────────────
// addContent(info): merge `info` into the cell; if that yields new information, notify neighbours.
// read(): the current accumulated content (or NOTHING). subscribe(fn): be notified on change; fires
// immediately if the cell already has content (so a late-wired propagator catches up). Optionally
// carries `provenance` (who/what supplied the info) for TMS-style "try-on" worldviews + accountability.
export const makeCell = (initial = NOTHING, merge = lastWriteWins) => {
  let content = initial;
  const subscribers = new Set();
  const notify = () => { for (const fn of [...subscribers]) { try { fn(content); } catch { /* a bad neighbour can't wedge the net */ } } };
  const cell = {
    read: () => content,
    hasContent: () => content !== NOTHING,
    addContent: info => {
      const merged = content === NOTHING ? info : merge(content, info);
      if (Object.is(merged, content)) return; // quiescent: no new information
      content = merged;
      notify();
    },
    subscribe: fn => {
      subscribers.add(fn);
      if (content !== NOTHING) { try { fn(content); } catch { /* ignore */ } }
      return () => subscribers.delete(fn);
    },
  };
  return cell;
};

// ── propagator — a stateless machine wiring input cells → an output cell ─────────────────────────
// Reads `inputs`, and when ALL have content, writes fn(...values) into `output`. Re-runs whenever any
// input changes. Holds NO state of its own. Returns a disposer that unwires it.
export const propagator = (inputs, fn, output) => {
  const run = () => {
    const values = inputs.map(c => c.read());
    if (values.some(v => v === NOTHING)) return; // not enough information yet
    output.addContent(fn(...values));
  };
  const disposers = inputs.map(c => c.subscribe(run));
  run();
  return () => disposers.forEach(d => d());
};

// lift: turn a plain pure function into a propagator constructor (the paper's `function->propagator`).
export const lift = fn => (inputs, output) => propagator(inputs, fn, output);

// react: the degenerate propagator whose effect is a side effect (e.g. a render) rather than an output
// cell. Runs `effect(...values)` whenever the wired cells change and all have content.
export const react = (inputs, effect) => {
  const run = () => {
    const values = inputs.map(c => c.read());
    if (values.some(v => v === NOTHING)) return;
    effect(...values);
  };
  const disposers = inputs.map(c => c.subscribe(run));
  run();
  return () => disposers.forEach(d => d());
};

// ── makeTmsCell — a provenance-carrying data grain (Truth Maintenance) ───────────────────────────
// A plain cell forgets WHO told it what. A TMS grain keeps every supported fact tagged with the PEER
// that supplied it. Crucially, a peer is designated by an unforgeable OBJECT REFERENCE, never a string
// name (ocap discipline: a string is forgeable ambient authority — anyone who guesses "invitee:bob"
// could attribute or believe a fact "from Bob"). The premise IS the peer's reference; holding that
// reference IS the right to attribute to, try on, or retract that peer's contribution. Identity is by
// reference (===), so you cannot cite a peer you do not hold.
//
// The believed value is the most-recent fact whose peer-reference is currently believed (the
// "worldview"). This lets a shared change be TRIED ON non-destructively and accepted/rejected ATOMICALLY:
//   • a contribution arrives as a fact whose peer you do NOT yet believe → the displayed value is unchanged;
//   • believe(peerRef)  → try it on (the grain now shows their value); a wired propagator re-paints;
//   • retract(peerRef)  → reject — atomically revert to what you believed before (the fact is kept,
//                         just disbelieved, so you can try it on again later);
//   • forget(peerRef)   → drop that peer's contributions entirely.
// It satisfies the cell interface (read/hasContent/addContent/subscribe), so propagators wire to it
// transparently. `provenance()` returns the believed value's PEER REFERENCE; `ledger()`/`proposals()`
// return references (the accountability the social-collateral trust gate needs). For DISPLAY, the host
// maps a reference to a render-safe petname (`labelOf`) — the reference itself, being authority, is
// never rendered.

// The holder's own reference — a distinct object identity, NOT the string 'self'.
export const SELF = (typeof harden === 'function' ? harden : Object.freeze)({ self: true });
// A render-safe label for a peer reference, for ledger/proposals display. Reads an optional `petname`
// the host attached to the reference; the reference itself (authority) is never put in the DOM.
export const labelOf = ref => (ref === SELF ? 'you' : (ref && (ref.petname || ref.label)) || 'a peer');

export const makeTmsCell = (selfRef = SELF) => {
  let facts = []; // [{ value, peer (object reference), seq }]
  let seq = 0;
  const believed = new Set([selfRef]); // a Set of peer REFERENCES — membership is by identity (===)
  const subscribers = new Set();
  let current = NOTHING;

  const recompute = () => {
    let best = NOTHING;
    let bestSeq = -1;
    for (const f of facts) if (believed.has(f.peer) && f.seq > bestSeq) { best = f.value; bestSeq = f.seq; }
    return best;
  };
  const refresh = () => {
    const next = recompute();
    if (Object.is(next, current)) return;
    current = next;
    for (const fn of [...subscribers]) { try { fn(current); } catch { /* a bad neighbour can't wedge the net */ } }
  };
  const requireRef = peer => { if (peer === null || typeof peer !== 'object' && typeof peer !== 'function') throw new Error('a peer must be designated by reference, not a name/string'); return peer; };

  const cell = {
    // cell interface — propagators see only the believed value
    read: () => current,
    hasContent: () => current !== NOTHING,
    addContent: value => cell.addFact(value, selfRef, { believe: true }),
    subscribe: fn => {
      subscribers.add(fn);
      if (current !== NOTHING) { try { fn(current); } catch { /* ignore */ } }
      return () => subscribers.delete(fn);
    },
    // TMS / provenance — `peer` is the contributor's REFERENCE (you must hold it to cite them)
    addFact: (value, peer = selfRef, { believe = true } = {}) => {
      requireRef(peer);
      seq += 1;
      facts.push({ value, peer, seq });
      if (believe) believed.add(peer);
      refresh();
      return { peer, seq };
    },
    believe: peer => { requireRef(peer); if (!believed.has(peer)) { believed.add(peer); refresh(); } }, // try-on / accept
    retract: peer => { if (believed.delete(requireRef(peer))) refresh(); },                              // reject (fact kept, disbelieved)
    forget: peer => { requireRef(peer); facts = facts.filter(f => f.peer !== peer); believed.delete(peer); refresh(); },
    worldview: () => new Set(believed),
    setWorldview: peers => { believed.clear(); for (const p of peers) believed.add(requireRef(p)); refresh(); },
    // the believed value's PEER REFERENCE; un-believed contributions awaiting try-on; the full audit trail
    provenance: () => { let best = null; let bestSeq = -1; for (const f of facts) if (believed.has(f.peer) && f.seq > bestSeq) { best = f; bestSeq = f.seq; } return best ? best.peer : null; },
    proposals: () => facts.filter(f => !believed.has(f.peer)).map(f => ({ peer: f.peer, value: f.value })),
    ledger: () => facts.map(f => ({ value: f.value, peer: f.peer, seq: f.seq, believed: believed.has(f.peer) })),
    // flag when distinct believed peers disagree on a value, so the UI can surface a real conflict
    contradiction: () => {
      const byPeer = new Map();
      for (const f of facts) if (believed.has(f.peer)) byPeer.set(f.peer, f.value);
      return new Set(byPeer.values()).size > 1;
    },
  };
  return cell;
};
