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
