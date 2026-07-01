// render-check-child.mjs — the ISOLATED render-smoke worker for render-check.mjs. Runs an agent-authored
// confined-component source against a faithful STUB of its real runtime and reports whether the MOUNT
// (build) phase throws — the class of error that used to reach only the human's eyeball (a broken widget)
// while the authoring agent's tool step said ok:true (the chat-1cbe89a9 failure).
//
// Isolation model (deliberate, in order):
//   1. THROWAWAY CHILD PROCESS with a hard timeout in the parent (render-check.mjs) — a `while(true)`
//      in a component body kills THIS process, never the live server.
//   2. BARE ENVIRONMENT — the parent spawns us with env={PATH} only; no cap, secret, or state dir here.
//   3. SHADOWED AMBIENT GLOBALS — the source is evaluated via `new Function` with process/require/
//      Buffer/fetch/… shadowed to undefined, so the node ambient surface is out of lexical reach.
// We intentionally do NOT evaluate in a SES Compartment: the compartment scope proxy resolves an
// UNKNOWN VARIABLE READ to `undefined` instead of throwing, which is exactly the bug class we exist to
// catch (chat-1cbe89a9 v1: a bare `safeSaleAmount` → ReferenceError in the REAL browser iframe). Plain
// function evaluation reproduces the iframe's semantics; for forks it is deliberately STRICTER than the
// production compartment (an undefined variable is a bug either way — better a loud check than a silent
// "undefined" on screen). The real confinement boundary for this code remains the browser sandbox.
//
// Two kinds, matching the two live render pipelines:
//   ui   — showComponent / break-out sources: `(ui) => element`, mounted by public/confined.html.
//          The stub `ui` mirrors that frame: create()/island()/grain()/local()/use()/call()/props/kit,
//          and the result must be an element (`.el`), else the frame's exact error is reproduced.
//   fork — fork / customView sources: `(endowments, props) => vnode`, rendered via
//          @endo/preact-container confineComponent (client/confined-source.js). The stub endowments
//          mirror preact-container's (h/Fragment/hooks) and the shadow scope mirrors FORK_VOCAB
//          (h, Fragment + every ui-kit export as bare names).
//
// usage: node render-check-child.mjs <ui|fork> [propsJSON]   (source on stdin)
// output: one JSON line {ok:true} | {ok:false,error} on stdout. KEEP THE ERROR PHRASING IN LOCKSTEP with
// public/confined.html's mount() — the agent should see the SAME message the live frame would produce.
import fs from 'node:fs';

const out = r => { process.stdout.write(`${JSON.stringify(r)}\n`); process.exit(0); };

const kind = process.argv[2] === 'fork' ? 'fork' : 'ui';
let props = {};
try { const p = JSON.parse(process.argv[3] || '{}'); if (p && typeof p === 'object' && !Array.isArray(p)) props = p; } catch { /* default {} */ }
const source = fs.readFileSync(0, 'utf8');
if (!source.trim()) out({ ok: false, error: 'empty component source' });

// node ambient globals shadowed OUT of the source's lexical reach (each becomes `undefined` inside).
// `console` is shadowed for protocol hygiene too — stray logs must not corrupt the JSON verdict line.
const SHADOW = ['process', 'require', 'module', 'exports', 'Buffer', 'global', 'globalThis', 'fetch', 'setImmediate', 'queueMicrotask', 'structuredClone', 'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'];
const noopConsole = { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };
const shadowValues = SHADOW.map(name => (name === 'console' ? noopConsole
  : name === 'setTimeout' || name === 'setInterval' ? () => 0
  : name === 'clearTimeout' || name === 'clearInterval' || name === 'queueMicrotask' ? () => {}
  : undefined));

// Evaluate `(<source>)` the way the frame does (non-strict, expression position), with the shadow scope
// (+ any extra names, e.g. the fork vocabulary) as parameters. Throws propagate to the caller.
const evalSource = (src, extraNames = [], extraValues = []) =>
  // eslint-disable-next-line no-new-func
  new Function(...SHADOW, ...extraNames, `return (${src}\n);`)(...shadowValues, ...extraValues);

// ── shared: a grain, as both runtimes model state ({ get, set, subscribe }) ─────────────────────────
const makeGrain = initial => {
  let value = initial; const subs = new Set();
  const g = {
    get: () => value,
    set: v => { value = v; for (const fn of [...subs]) { try { fn(v); } catch { /* mirror the frame: subscriber errors are swallowed */ } } },
    subscribe: fn => { subs.add(fn); if (value !== undefined) { try { fn(value); } catch { /* */ } } return () => subs.delete(fn); },
  };
  g.assign = g.set;
  return g;
};

// ── kind: ui — mirror public/confined.html's mount() ────────────────────────────────────────────────
const checkUi = src => {
  // element factory — chainable exactly like the frame's create(); `.el` is the element marker the
  // frame's mount() checks for. The 2D canvas facet is stubbed method-for-method (pure chainables).
  const create = () => {
    const w = {};
    const chain = () => w;
    Object.assign(w, {
      el: { stub: true },
      text: chain, attr: chain, class: chain, style: chain, push: chain, follow: chain, followWith: chain, on: chain,
      ctx: () => {
        const f = {};
        const fchain = () => f;
        for (const m of ['size', 'clear', 'fillStyle', 'strokeStyle', 'lineWidth', 'lineCap', 'lineJoin', 'alpha', 'composite', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'rect', 'fill', 'stroke', 'fillRect', 'clearRect', 'dot', 'drawCanvas']) f[m] = fchain;
        f.width = () => 300; f.height = () => 150;
        f.drawImageUrl = () => Promise.resolve(f);
        f.toDataURL = () => '';
        return f;
      },
    });
    return w;
  };
  // island(): the frame CATCHES a kit component's own throw and renders an inline ⚠ element — an island
  // never aborts the mount. Mirror that: island always returns an element. (An expression that throws
  // while BUILDING island args still propagates — that's the component's own code, as in the frame.)
  const island = () => create();
  const use = () => create(); // an unresolved ref renders a labelled fallback element in the frame
  const UI = {
    create,
    h: create,
    island,
    use,
    grain: () => makeGrain(undefined), // a live server cell arrives later; starts undefined, like the frame
    local: initial => makeGrain(initial),
    call: () => Promise.resolve({}), // host-gated action — resolves benignly; rejection paths are runtime, not mount
    props,
    kit: ['Card', 'Btn', 'Chip', 'Badge', 'Banner', 'Meta', 'Stack', 'Row', 'Divider', 'EmptyState', 'ProgressBar', 'Spinner', 'Field', 'TextField', 'Textarea', 'Select', 'List', 'Table', 'Avatar'],
  };
  let fn;
  try { fn = evalSource(src); }
  catch (e) { out({ ok: false, error: `component source must be a function (ui) => element (or it failed to parse): ${(e && e.message) || e}` }); }
  if (typeof fn !== 'function') out({ ok: false, error: 'component source must be a function (ui) => element (or it failed to parse)' });
  let rootEl;
  try { rootEl = fn(UI); }
  catch (e) { out({ ok: false, error: `component threw while building: ${(e && e.message) || e}` }); }
  if (!(rootEl && rootEl.el)) out({ ok: false, error: 'component must return ui.create(...) (an element)' });
  out({ ok: true });
};

// ── kind: fork — mirror client/confined-source.js + @endo/preact-container confineComponent ─────────
const checkFork = src => {
  // h does NOT invoke component types (preact calls them at diff time) — it just records the vnode.
  const h = (type, p, ...children) => ({ type, props: p || {}, children });
  const Fragment = { isFragmentStub: true };
  // FORK_VOCAB names: every ui-kit export, available as BARE names like the real compartment globals.
  // Parse the kit file's export list so the vocabulary can't drift from client/ui-kit.js (PascalCase =
  // components — referenced, not called, by h(); camelCase helpers ARE called during build, so give the
  // known ones real-enough behavior).
  const vocabNames = ['h', 'Fragment'];
  const vocabValues = [h, Fragment];
  try {
    const kitText = fs.readFileSync(new URL('./client/ui-kit.js', import.meta.url), 'utf8');
    for (const m of kitText.matchAll(/^export (?:const|function) (\w+)/gm)) {
      const name = m[1];
      if (vocabNames.includes(name)) continue;
      vocabNames.push(name);
      vocabValues.push(/^[A-Z]/.test(name)
        ? (p = {}) => h('div', p) // a kit COMPONENT: a callable marker (h never calls it; harmless if the fork does)
        : items => (Array.isArray(items) ? items.filter(x => x != null && x !== '') : items)); // helper (joinDot-shaped)
    }
  } catch { /* kit file unreadable → bare h/Fragment vocabulary (still catches undefined-var/type bugs) */ }
  // endowments mirror @endo/preact-container/compartment.js — hooks behave sanely for ONE synchronous call.
  const endowments = {
    h,
    Fragment,
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: fn2 => fn2,
    useMemo: fn2 => { try { return fn2(); } catch { return undefined; } },
    useRef: v => ({ current: v }),
    useReducer: (r, initial) => [initial, () => {}],
  };
  // functions can't cross the argv-JSON boundary — restore the live-object seam a customView renderer
  // holds at render time (host-mediated call + refresh), benign here.
  const checkProps = { call: () => Promise.resolve({}), refresh: () => {}, ...props };
  let fn;
  try { fn = evalSource(src, vocabNames, vocabValues); }
  catch (e) { out({ ok: false, error: `fork source failed to parse — it must be a single function expression (endowments, props) => vnode: ${(e && e.message) || e}` }); }
  if (typeof fn !== 'function') out({ ok: false, error: 'fork source must evaluate to a function: (endowments, props) => vnode' });
  let vnode;
  try { vnode = fn(endowments, checkProps); }
  catch (e) { out({ ok: false, error: `fork threw while rendering: ${(e && e.message) || e}` }); }
  // confineComponent coerces any return — but `undefined` renders NOTHING (the silent blank widget).
  if (vnode === undefined) out({ ok: false, error: 'fork returned undefined (no vnode) — it would render a blank widget' });
  out({ ok: true });
};

if (kind === 'fork') checkFork(source); else checkUi(source);
