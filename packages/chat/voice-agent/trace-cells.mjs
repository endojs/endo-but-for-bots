// trace-cells.mjs — the per-chat reasoning TRACE as a monotonic propagator cell (`trace:<sid>`).
//
// PROPAGATOR discipline (client/propagator.js / live-cells.mjs / component-backlog.mjs): a trace is
// APPEND-ONLY knowledge about a running turn. This module folds the same step events that feed the
// /chat/steps SSE (emitStep is the one choke point) into a monotonic per-session value:
//   • a step 'start' APPENDS a running step; its 'done' SETTLES that step in place (merge, never rewind);
//   • 'thinking'/'progress' refresh the live one-liner; 'rnode' upserts the live research sub-tree by key;
//   • 'end' flips status → 'done'; a NEW turn bumps `turn` and starts a fresh steps list (rev keeps
//     growing — the lattice never runs backward within a turn, and `(turn, rev)` orders across turns).
// Every accepted event pushes a fresh snapshot to subscribers, so the trace ISLAND (chrome-trace-view)
// just follows the cell — no client-side SSE parsing of /chat/steps inside any confined component.
//
// CAP-HYGIENE: values are exactly as render-safe as the /chat/steps stream they mirror — tool NAMES,
// scrubbed call/result text, ok flags. Nothing here is a cap/swissnum (emitStep producers scrub upstream).
// OWNERSHIP: `bindOwner(sid, key)` records the NON-SECRET owner key of the cap that ran the turn (the
// same 'root' / 'u:<hash>' key /chat derives); the /cells/subscribe route gates `trace:` subscriptions
// on it exactly like `backlog:` cells gate on component/fork ownership.

const MAX_STEPS = 200;
const MAX_NODES = 300;
const MAX_TRACES = 128;
const S = (v, n) => String(v == null ? '' : v).slice(0, n);

export const makeTraceCells = ({ maxSteps = MAX_STEPS, maxNodes = MAX_NODES, maxTraces = MAX_TRACES } = {}) => {
  const traces = new Map(); // sid → { turn, status, progress, steps, nodes, owner, rev, at }
  const listeners = new Map(); // sid → Set<fn>

  const fresh = () => ({ turn: 0, status: 'idle', progress: '', steps: [], nodes: [], owner: '', rev: 0, truncated: false, at: Date.now() });
  const stateFor = sid => { let t = traces.get(sid); if (!t) { t = fresh(); traces.set(sid, t); prune(); } return t; };
  const prune = () => { // bounded: oldest-touched traces fall off (a finished trace is reconstructible from the persisted steps)
    if (traces.size <= maxTraces) return;
    const bySid = [...traces.entries()].sort((a, b) => a[1].at - b[1].at);
    while (bySid.length > maxTraces) { const [sid] = bySid.shift(); traces.delete(sid); }
  };

  // the cell VALUE: a render-safe plain-JSON snapshot (goes over SSE as-is).
  const snapshot = sid => {
    const t = traces.get(sid) || fresh();
    return {
      sid: S(sid, 64), turn: t.turn, status: t.status, progress: t.progress, rev: t.rev, truncated: t.truncated,
      steps: t.steps.map(s => ({ ...s })), nodes: t.nodes.map(n => ({ ...n })),
    };
  };
  const notify = sid => { const set = listeners.get(sid); if (!set) return; const v = snapshot(sid); for (const fn of [...set]) { try { fn(v); } catch { /* one bad listener can't break the cell */ } } };
  const touch = (t, sid) => { t.rev += 1; t.at = Date.now(); notify(sid); };

  // a NEW turn: fresh steps under a bumped turn counter (monotonic across turns via (turn, rev)).
  const begin = sid => {
    const t = stateFor(sid);
    t.turn += 1; t.status = 'running'; t.progress = 'Thinking…'; t.steps = []; t.nodes = []; t.truncated = false;
    touch(t, sid);
  };

  // bind the trace to the NON-SECRET owner key of the cap that runs its turns (first writer wins).
  const bindOwner = (sid, key) => { const t = stateFor(sid); if (!t.owner && key) { t.owner = S(key, 80); } };
  const ownerOf = sid => (traces.get(sid) || {}).owner || '';

  // feed(sid, ev) — fold ONE emitStep event into the lattice. Never throws (a bad event is dropped).
  const feed = (sid, ev) => {
    if (!ev || typeof ev !== 'object') return;
    const t = stateFor(sid);
    const kind = ev.t;
    if (kind === 'thinking') { if (t.status !== 'running') { t.status = 'running'; } if (!t.progress) t.progress = 'Thinking…'; touch(t, sid); return; }
    if (kind === 'progress') { t.progress = S(ev.text, 280); if (t.status !== 'running') t.status = 'running'; touch(t, sid); return; }
    if (kind === 'start') {
      t.status = 'running';
      if (t.steps.length >= maxSteps) { t.truncated = true; touch(t, sid); return; } // bounded, still monotonic (the count of dropped work is visible)
      const step = { i: t.steps.length, name: S(ev.name, 80), status: 'running' };
      if (ev.detail) step.detail = S(ev.detail, 200);
      if (ev.call) step.call = S(ev.call, 4000);
      t.steps.push(step);
      touch(t, sid); return;
    }
    if (kind === 'done') {
      // settle the EARLIEST still-running step with this name (parallel same-name calls settle in order);
      // an unmatched done (e.g. joined mid-run past the buffer) APPENDS as already-settled — never rewinds.
      let step = t.steps.find(s => s.status === 'running' && s.name === S(ev.name, 80));
      if (!step) {
        if (t.steps.length >= maxSteps) { t.truncated = true; touch(t, sid); return; }
        step = { i: t.steps.length, name: S(ev.name, 80), status: 'running' };
        t.steps.push(step);
      }
      step.status = 'done';
      step.ok = ev.ok !== false;
      if (ev.detail) step.detail = S(ev.detail, 200);
      if (ev.call && !step.call) step.call = S(ev.call, 4000);
      if (ev.result) step.result = S(ev.result, 4000);
      if (Array.isArray(ev.children)) step.children = ev.children.slice(0, 40).map(c => ({ name: S(c && c.name, 80), detail: S(c && c.detail, 200) }));
      if (Array.isArray(ev.granted) && ev.granted.length) step.granted = ev.granted.slice(0, 20).map(p => S(p, 40));
      touch(t, sid); return;
    }
    if (kind === 'rnode') { // live research sub-tree: UPSERT by key (state/label/info only ever refresh, rows never vanish)
      const key = S(ev.key, 40); if (!key) return;
      let n = t.nodes.find(x => x.key === key);
      if (!n) {
        if (t.nodes.length >= maxNodes) { t.truncated = true; touch(t, sid); return; }
        n = { key }; t.nodes.push(n);
      }
      if (ev.parent) n.parent = S(ev.parent, 40);
      if (ev.kind) n.kind = S(ev.kind, 20);
      if (ev.label) n.label = S(ev.label, 120);
      if (ev.detail) n.detail = S(ev.detail, 300);
      if (ev.state) n.state = S(ev.state, 20);
      if (ev.info) n.info = S(ev.info, 300);
      touch(t, sid); return;
    }
    if (kind === 'child-done') { // legacy flat child event → fold into the nodes list (append/settle by derived key)
      const key = `${S(ev.parent, 40)}/${S(ev.name, 60)}`;
      let n = t.nodes.find(x => x.key === key);
      if (!n) { if (t.nodes.length >= maxNodes) { t.truncated = true; touch(t, sid); return; } n = { key, parent: S(ev.parent, 40), label: S(ev.name, 120) }; t.nodes.push(n); }
      n.state = ev.ok === false ? 'fail' : 'done';
      touch(t, sid); return;
    }
    if (kind === 'end') { t.status = 'done'; t.progress = ''; touch(t, sid); return; }
    // unknown event kinds are ignored (forward-compatible: new emitStep kinds don't break the cell)
  };

  // cellFor(sid) — the live-cells cell interface ({ get, subscribe(fn)→unsub }) over snapshot(sid).
  // PUSH-fed by feed() (never a poll loop); a late subscriber gets the current value immediately
  // (the propagator "catch a late-wired neighbour up" rule — a mid-run join sees the whole fan-out).
  const cells = new Map();
  const cellFor = sid => {
    const k = S(sid, 64);
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

  return harden({ begin, feed, bindOwner, ownerOf, snapshot, cellFor });
};
harden(makeTraceCells);
