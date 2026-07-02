// live-cells.mjs — the over-the-wire GRAIN transport for live chat widgets.
//
// A "grain" (after danfinlay/confinable-ui + this repo's grain-store/propagator) is a tiny
// observable cell: { get(), subscribe(fn) } that PUSHES on change. The chat already has in-process
// grains (grain-store.mjs / client/propagator.js) but no way to subscribe to one from the BROWSER.
// This module is that missing piece: named server cells whose value is kept fresh while ≥1 browser
// is subscribed, exposed over a streamed SSE response so a widget SUBSCRIBES (never polls) and a
// pure "lazily written" component just follows the grain.
//
// Sources are LAZY: a cell only does real work (e.g. read Home Assistant) while it has subscribers,
// and stops when the last one disconnects. The BROWSER never polls — it holds one open stream; the
// SERVER refreshes the source (and can later be upgraded to HA's push event stream with no client
// change). Cells are cap-gated: a `ha:<handle>` cell requires the subscribing cap to hold the
// `homeassistant` power AND to reach that handle in its c-list (the same confused-deputy guard as the
// HA verbs). The swissnum never enters this module's keys or output (cap-hygiene).

const same = (a, b) => { try { return JSON.stringify(a) === JSON.stringify(b); } catch { return a === b; } };

// One observable cell with a refresh-while-subscribed source. value pushes to all listeners on change.
const makeCell = ({ source, refreshMs = 6000 }) => {
  let value; // last known value (undefined until first refresh)
  const subs = new Set();
  let timer = null;
  let refreshing = false;
  const notify = () => { for (const fn of [...subs]) { try { fn(value); } catch { /* one bad listener can't break the cell */ } } };
  const refresh = async () => {
    if (refreshing) return; refreshing = true;
    try { const v = await source(); if (!same(v, value)) { value = v; notify(); } }
    catch { /* keep last good value on a transient source error */ }
    finally { refreshing = false; }
  };
  const start = () => { if (timer) return; refresh(); timer = setInterval(refresh, refreshMs); };
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
  return {
    get: () => value,
    subscribe: fn => {
      subs.add(fn);
      if (subs.size === 1) start(); else if (value !== undefined) { try { fn(value); } catch { /* */ } } // give a late joiner the current value immediately
      return () => { subs.delete(fn); if (subs.size === 0) stop(); };
    },
  };
};

// makeLiveCells({ nodeFor }) → { cellFor(cap, id) }.
// id grammar: "ha:<handle>" (live Home Assistant entity state). More kinds slot in here.
export const makeLiveCells = ({ nodeFor }) => {
  const cells = new Map(); // id → shared cell (same entity = one source for all subscribers)

  // get/create the shared cell for an id, sourced by readerFn. Reading an entity is cap-independent, so
  // an owner cap and a share token that both reach the same entity share ONE cell + ONE source loop.
  const cellForReader = (id, readerFn) => {
    let cell = cells.get(id);
    if (!cell) { cell = makeCell({ source: readerFn, refreshMs: 6000 }); cells.set(id, cell); }
    return cell;
  };

  // CAP path: a normal cap subscribes to cells it holds the power + c-list reach for.
  const cellFor = (cap, id) => {
    const node = nodeFor(cap);
    if (!node) return { error: 'no capability' };
    const s = String(id || '');
    const i = s.indexOf(':');
    const kind = i < 0 ? s : s.slice(0, i);
    const arg = i < 0 ? '' : s.slice(i + 1);

    if (kind === 'ha') {
      if (!node.powers.has('homeassistant')) return { error: 'this chat does not hold Home Assistant access' };
      const reach = node.haReach(arg); // c-list gated: refuses a handle this cap can't drill to
      if (!reach || !reach.state) return { error: 'that entity is not reachable by this chat (search for it first)' };
      return { cell: cellForReader(s, () => reach.state()) };
    }
    return { error: `unknown cell kind: ${kind}` };
  };

  return harden({ cellFor, cellForReader });
};
harden(makeLiveCells);
