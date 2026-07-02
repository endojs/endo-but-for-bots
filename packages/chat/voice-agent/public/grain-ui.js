// grain-ui.js — LIVE, INTERACTIVE chat widgets, grain-native.
//
import { theme, applyTheme } from './theme.js'; // the user's global style propagator — pushed down into confined widgets
// A response can carry `ui: [widgetSpec...]` (the agent emits these via showEntityStatus / showCountdowns
// / showChoices). We render each into the chat bubble. The pattern follows danfinlay/confinable-ui: data
// is a GRAIN (a tiny { get, subscribe } observable that PUSHES on change); a component just FOLLOWS the
// grain — never polls. The over-the-wire grain is /cells/subscribe (one open stream the server pushes to);
// a countdown's grain is local time. Specs are pure data (no cap, no swissnum) so they persist + re-hydrate
// live when a chat is reopened: a door widget re-subscribes and shows the latest state; a countdown re-ticks.

// ── grain: { get(), set(v), subscribe(fn)->unsub } ─────────────────────────────────────────────
export const makeGrain = initial => {
  let value = initial; const subs = new Set();
  return {
    get: () => value,
    set: v => { value = v; for (const fn of [...subs]) { try { fn(v); } catch { /* */ } } },
    subscribe: fn => { subs.add(fn); if (value !== undefined) { try { fn(value); } catch { /* */ } } return () => subs.delete(fn); },
  };
};

// follow(grain, render): paint render(value) now + on every push. The "lazily written component" seam.
const follow = (grain, render) => grain.subscribe(render);

const MAX_WIDGETS = 12;     // cap widgets rendered per call (a flood of specs can't open unbounded streams)
const MAX_LIVE_STREAMS = 24; // global ceiling on concurrent /cells/subscribe streams in this view

// ── over-the-wire grain: open ONE SSE stream for a cell. The credential (a cap OR a least-authority
//    component-share token) goes in the POST body (cap-hygiene — never a URL). Returns an abort fn. The
//    server pushes the current value + every change (no polling). ──
const authBody = auth => (typeof auth === 'string' ? { cap: auth } : { cap: auth && auth.cap, shareToken: auth && auth.shareToken });
const openCellStream = (auth, id, onMsg) => {
  const ctrl = new AbortController();
  (async () => {
    try {
      const res = await fetch('/cells/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...authBody(auth), cells: [id] }), signal: ctrl.signal });
      if (!res.ok || !res.body) { onMsg({ id, error: `subscribe failed (${res.status})` }); return; }
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { done, value } = await reader.read(); if (done) { onMsg({ id, error: 'stream ended' }); break; }
        buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = block.split('\n').find(l => l.startsWith('data:')); if (!line) continue;
          try { onMsg(JSON.parse(line.slice(5).trim())); } catch { /* ignore malformed frame */ }
        }
      }
    } catch { /* aborted / network drop — silent; a re-render re-subscribes */ }
  })();
  return () => { try { ctrl.abort(); } catch { /* */ } };
};

// REFCOUNTED, COALESCED cell streams: many widgets bound to the same ha:<handle> (across a turn AND across
// a re-hydrated transcript) share ONE stream + ONE grain. Acquire bumps the refcount; release drops it and
// closes the stream at zero. This is what stops the "one stream per persisted widget" + "streams accumulate
// every turn" leaks. cap is constant within a view (a chat-switch triggers disposeAllWidgets, clearing this).
const liveCells = new Map(); // id → { grain, refs, abort }
const acquireCell = (auth, id) => {
  let s = liveCells.get(id);
  if (!s) {
    if (liveCells.size >= MAX_LIVE_STREAMS) return { grain: makeGrain({ error: 'too many live widgets open' }), release: () => {} }; // ceiling: refuse new streams
    const grain = makeGrain(undefined);
    const abort = openCellStream(auth, id, msg => { if (msg && msg.id === id) grain.set(msg.value !== undefined ? msg.value : msg); });
    s = { grain, refs: 0, abort }; liveCells.set(id, s);
  }
  s.refs += 1;
  return { grain: s.grain, release: () => { s.refs -= 1; if (s.refs <= 0) { try { s.abort(); } catch { /* */ } liveCells.delete(id); } } };
};

// Track every live widget's teardown so a re-render / chat-switch can dispose streams + intervals.
const cleanups = new Set();
export const disposeAllWidgets = () => { for (const c of [...cleanups]) { try { c(); } catch { /* */ } cleanups.delete(c); } liveCells.clear(); };
const track = fn => { cleanups.add(fn); return fn; };

const STYLE = 'font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';

// ── countdown widgets: pure-client, tick against an absolute dueAt. No server, no polling. ──
const fmt = ms => { if (ms <= 0) return '✓ done'; const s = Math.round(ms / 1000); const m = Math.floor(s / 60), ss = s % 60; const h = Math.floor(m / 60); return h ? `${h}:${String(m % 60).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`; };
const renderCountdowns = spec => {
  const box = document.createElement('div'); box.className = 'gw gw-countdowns'; box.style.cssText = `${STYLE};margin:8px 0;display:flex;flex-direction:column;gap:6px`;
  const rows = (spec.items || []).slice(0, MAX_WIDGETS).map(it => {
    const due = Date.parse(it.dueAt); // NaN for a malformed dueAt — handled in the tick + skipped from the live set
    const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;gap:10px;background:#161b22;border:1px solid #30363d;border-radius:10px;padding:8px 12px';
    const name = document.createElement('span'); name.textContent = it.label; name.style.cssText = 'flex:1;font-weight:600;color:#e6edf3';
    const time = document.createElement('span'); time.style.cssText = 'font-variant-numeric:tabular-nums;font-weight:700;color:#7c5cff;min-width:62px;text-align:right';
    if (!Number.isFinite(due)) time.textContent = '—'; // bad/absent dueAt → static dash, never a NaN ticker
    row.append(name, time); box.appendChild(row);
    return { due, time };
  }).filter(r => Number.isFinite(r.due)); // only finite-due rows get the live ticker
  if (!rows.length) return box; // all static → no interval at all
  let iv = null;
  const tick = () => {
    const now = Date.now(); let allDone = true;
    for (const r of rows) { const left = r.due - now; if (left > 0) allDone = false; r.time.textContent = fmt(left); r.time.style.color = left <= 0 ? '#2ea043' : left < 60000 ? '#f85149' : '#7c5cff'; }
    if (allDone && iv) { clearInterval(iv); iv = null; } // self-dispose once every timer has elapsed
  };
  tick(); iv = setInterval(tick, 1000); track(() => { if (iv) clearInterval(iv); });
  return box;
};

// ── live entity-status widget: FOLLOWS the ha:<handle> grain (subscribe, never poll). ──
const stateView = st => { // map a HA state → {icon, text, color}
  const s = String(st || '').toLowerCase();
  if (s === 'open' || s === 'on' || s === 'unlocked' || s === 'detected') return { icon: s === 'unlocked' ? '🔓' : '⚠️', text: st, color: '#f0883e' };
  if (s === 'closed' || s === 'off' || s === 'locked' || s === 'clear') return { icon: s === 'locked' ? '🔒' : '✅', text: st, color: '#2ea043' };
  return { icon: '•', text: st || '…', color: '#8b949e' };
};
const renderEntityStatus = (spec, ctx) => {
  const box = document.createElement('div'); box.className = 'gw gw-status'; box.style.cssText = `${STYLE};margin:8px 0;display:inline-flex;align-items:center;gap:10px;background:#161b22;border:1px solid #30363d;border-radius:12px;padding:9px 14px`;
  const label = document.createElement('span'); label.textContent = spec.label || 'status'; label.style.cssText = 'font-weight:600;color:#e6edf3'; // textContent — agent/HA strings never become HTML
  const pill = document.createElement('span'); pill.style.cssText = 'display:inline-flex;align-items:center;gap:6px;font-weight:700';
  const ic = document.createElement('span'); ic.textContent = '•';
  const tx = document.createElement('span'); tx.textContent = 'connecting…'; tx.style.color = '#8b949e';
  const dot = document.createElement('span'); dot.title = 'live'; dot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:#2ea043;box-shadow:0 0 6px #2ea043;animation:gwpulse 1.6s infinite';
  pill.append(ic, tx); box.append(label, pill, dot);
  const grain = makeGrain(undefined);
  follow(grain, v => {
    if (v && v.error) { tx.textContent = v.error; tx.style.color = '#8b949e'; ic.textContent = '•'; dot.style.background = '#8b949e'; dot.style.boxShadow = 'none'; return; }
    const view = stateView(v && v.state); ic.textContent = view.icon; tx.textContent = view.text; tx.style.color = view.color;
    dot.style.background = '#2ea043'; dot.style.boxShadow = '0 0 6px #2ea043';
  });
  const auth = ctx && (ctx.shareToken ? { shareToken: ctx.shareToken } : ctx.cap); const id = spec.cell || `ha:${spec.handle}`;
  if (auth && spec.handle) { const { grain: g, release } = acquireCell(auth, id); follow(g, v => grain.set(v)); track(release); } // share ONE stream per entity
  else { tx.textContent = 'open this chat to see live status'; }
  return box;
};

// ── interactive choices: tapping sends the option back as the next message. ──
const renderChoices = (spec, ctx) => {
  const box = document.createElement('div'); box.className = 'gw gw-choices'; box.style.cssText = `${STYLE};margin:8px 0`;
  if (spec.prompt) { const p = document.createElement('div'); p.textContent = spec.prompt; p.style.cssText = 'color:#8b949e;margin-bottom:6px'; box.appendChild(p); } // textContent — safe
  const row = document.createElement('div'); row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px';
  for (const opt of (spec.options || []).slice(0, 8)) {
    const b = document.createElement('button'); b.textContent = opt; b.style.cssText = 'all:unset;cursor:pointer;background:#1f6feb22;border:1px solid #1f6feb88;color:#cfe2ff;border-radius:10px;padding:7px 14px;font:inherit;font-weight:600';
    b.onmouseenter = () => { b.style.background = '#1f6feb44'; }; b.onmouseleave = () => { b.style.background = '#1f6feb22'; };
    b.onclick = () => { if (ctx && typeof ctx.onChoice === 'function') ctx.onChoice(opt); };
    row.appendChild(b);
  }
  box.appendChild(row); return box;
};

// ── TIER 2: an ARBITRARY agent-authored component, rendered CONFINED in a sandboxed null-origin iframe
//    (confined.html runtime), fed by the SAME server grains over postMessage. The iframe is the hard
//    boundary (opaque origin + CSP no-network): it can render + ask to subscribe to DECLARED cells, nothing
//    else. The PARENT holds the cap and brokers each subscription through the same /cells/subscribe stream —
//    the cap NEVER crosses into the iframe; the iframe only names cell ids the agent declared (which the
//    server re-validates). So the agent writes free-form UI without gaining any authority. ──
const hashStr = s => { let h = 0; const t = String(s || ''); for (let i = 0; i < t.length; i++) { h = (h * 31 + t.charCodeAt(i)) | 0; } return `a${(h >>> 0).toString(36)}`; };
// a plausible DUMMY value for any declared cell, so a library component previews live without real data.
// Rich on purpose: whatever field the component reads (.state / .value / .label / …) gets something.
const dummyForCell = id => /^ha:/.test(String(id))
  ? { state: 'open', last_changed: new Date().toISOString(), attributes: { friendly_name: 'Demo entity' } }
  : { state: 'sample', value: 42, label: 'sample', on: true, name: 'Demo', text: 'sample data', count: 3 };

const renderComponent = (spec, ctx) => {
  const wrap = document.createElement('div'); wrap.className = 'gw gw-component'; wrap.style.cssText = `${STYLE};margin:8px 0;border:1px solid #30363d;border-radius:12px;overflow:hidden;background:#0d1117`;
  wrap.dataset.appletKey = hashStr(spec.source); // stable per-source key so an expanded applet can be re-found on re-render (retained view-state)
  // SELECTABLE for ⌥ Alt-click edit: tag the wrapper with the component's name (+ its project id when it is
  // already a saved component) and stash the full spec as a JS prop (NOT an attribute) so an Alt-click on an
  // id-less inline component can break it out into a project object and edit it. No cap/swissnum here — the
  // source is render-safe and a component id carries no authority.
  wrap.dataset.componentName = String(spec.name || spec.title || 'component').slice(0, 60);
  if (spec.componentId || spec.id) wrap.dataset.componentId = String(spec.componentId || spec.id);
  try { wrap.__componentSpec = spec; } catch { /* */ }
  // a slim header bar: EXPAND (fill the chat area) + BREAK OUT (versioned module) + SHARE (least-authority link).
  if (ctx && (typeof ctx.onExpand === 'function' || typeof ctx.onBreakOut === 'function' || typeof ctx.onShareOut === 'function')) {
    const bar = document.createElement('div'); bar.className = 'gw-bar'; bar.style.cssText = 'display:flex;justify-content:flex-end;gap:6px;padding:4px 6px;border-bottom:1px solid #21262d;background:#0b0e14';
    const mk = (label, title, fn) => { const b = document.createElement('button'); b.textContent = label; b.title = title; b.style.cssText = 'all:unset;cursor:pointer;color:#7c5cff;font-size:11px;font-weight:600;padding:2px 8px;border:1px solid #3a2f6a;border-radius:6px'; b.onclick = () => fn(spec, wrap); return b; };
    if (typeof ctx.onExpand === 'function') { const eb = mk('⤢ expand', 'Fill the chat area with this app (minimize to return to the conversation)', ctx.onExpand); eb.className = 'gw-expand'; bar.appendChild(eb); }
    if (typeof ctx.onBreakOut === 'function') bar.appendChild(mk('⤴ break out', 'Save this as a standalone, versioned module', ctx.onBreakOut));
    if (typeof ctx.onShareOut === 'function') bar.appendChild(mk('🔗 share', 'Copy a link that grants someone live, read-only access to ONLY this component’s data', ctx.onShareOut));
    wrap.appendChild(bar);
  }
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts'); // opaque origin: no allow-same-origin, no forms, no parent reach
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.style.cssText = `width:100%;height:${Math.min(2000, Math.max(40, Number(spec.height) || 120))}px;border:0;display:block`;
  wrap.appendChild(iframe);
  const allowedCells = new Set((Array.isArray(spec.cells) ? spec.cells : []).map(String)); // only cells the agent DECLARED
  // WRITABLE CELLS this component was GRANTED to drive (a propagator write, not a command). Today the one
  // local propagator cell offered is `theme` — the user's global style. A component WITHOUT the grant can read
  // theme (free) but its writes are ignored. (`spec.effects` kept as a legacy alias for the grant key.)
  const writableCells = new Set((Array.isArray(spec.writableCells) ? spec.writableCells : (Array.isArray(spec.effects) ? spec.effects : [])).map(String));
  // value allowlist: a confined component may only set STYLE-SHAPED values (hex / rgb()/rgba() / hsl()/hsla() /
  // named color / simple length). This blocks `url(...)` (off-origin fetch = exfil/beacon + image-overlay phishing),
  // `expression(...)`, and any `; } < @import` break-out — the cell carries pure presentation, never a fetch.
  const SAFE_VAL = /^(#[0-9a-f]{3,8}|rgba?\([\d.,\s%]+\)|hsla?\([\d.,\s%]+\)|[a-z-]+|-?[\d.]+(px|em|rem|%|vh|vw|fr)?)$/i;
  const cleanThemeVars = v => { if (!v || typeof v !== 'object' || Array.isArray(v)) return null; const c = {}; for (const k of Object.keys(v).slice(0, 64)) { const val = v[k]; if (/^--[\w-]+$/.test(k) && typeof val === 'string' && val.length <= 60 && SAFE_VAL.test(val.trim())) c[k] = val.trim(); } return Object.keys(c).length ? c : null; };
  const cap = ctx && ctx.cap; const shareToken = ctx && ctx.shareToken; const auth = shareToken ? { shareToken } : cap;
  const releases = []; const subscribed = new Set(); // dedup: one stream per declared cell, no matter how often it asks
  let port = null;
  // After the handshake, ALL traffic is over a private MessagePort (no shared/accumulating window listener).
  const onPort = e => {
    const m = e.data; if (!m || m.__cu !== 1) return;
    if (m.type === 'height') { const px = Math.min(2000, Math.max(40, Number(m.px) || 120)); if (iframe.style.height !== `${px}px`) iframe.style.height = `${px}px`; }
    else if (m.type === 'subscribe') {
      const id = String(m.cell || '');
      if (subscribed.has(id)) return;
      subscribed.add(id);
      if (id === 'theme') { // the LOCAL style PROPAGATOR cell: push the current theme + every change (read is free)
        const push = t => { try { port && port.postMessage({ __cu: 1, type: 'cell', id: 'theme', value: { name: t.name, mode: t.mode, vars: t.vars } }); } catch { /* */ } };
        push(theme.get()); releases.push(theme.subscribe(push)); return;
      }
      // SPLASH/SEED: a CANNED, cap-free value the caller pre-supplies for this exact cell id (the trace-view
      // gallery feeds each viz its own splash-example trace this way — no server cell, no cap, no stream). One
      // push, then done; the confined viz renders the offline example the instant it subscribes.
      if (ctx && ctx.seedCells && Object.prototype.hasOwnProperty.call(ctx.seedCells, id)) { try { port && port.postMessage({ __cu: 1, type: 'cell', id, value: ctx.seedCells[id] }); } catch { /* */ } return; }
      if (ctx && ctx.sample) { try { port && port.postMessage({ __cu: 1, type: 'cell', id, value: dummyForCell(id) }); } catch { /* */ } return; } // GALLERY preview: feed generated dummy data — no server cell, no cap
      if (!auth || !allowedCells.has(id)) return; // undeclared / no credential → ignore
      const { grain, release } = acquireCell(auth, id); releases.push(release);
      follow(grain, value => { try { port && port.postMessage({ __cu: 1, type: 'cell', id, value }); } catch { /* */ } }); // pipe live values IN (cap stays here)
    }
    else if (m.type === 'cell-set') {
      // a confined component WROTE a cell. We propagate the write ONLY for a cell it was granted writable +
      // validate the value. `theme` drives the global style propagator (theme.set → :root + every component).
      // Revert is just the component writing the prior value back — no special command (pure propagation).
      const id = String(m.cell || '');
      if (id === 'theme' && writableCells.has('theme')) {
        const val = (m.value && typeof m.value === 'object') ? m.value : {}; const v = cleanThemeVars(val.vars);
        if (v) applyTheme({ name: String(val.name || 'custom').slice(0, 40), mode: (val.mode === 'light' || val.mode === 'dark') ? val.mode : undefined, vars: v });
      }
    }
    else if (m.type === 'call') {
      // The ONE imperative seam a confined component may use (confined.html ui.call). The PARENT is the gate:
      // only NAMED, parent-chosen methods resolve; anything else is refused (so ui.call never HANGS — the
      // component path had no handler before, which silently stalled every call). `vizDiag` is a render-safe
      // telemetry echo (frame count + renderer mode) a live viz reports so the host + staging tests can see
      // the brokered cell reached the sandbox — it carries NO cap and NO swissnum.
      const method = String(m.method || ''); const args = (m.args && typeof m.args === 'object') ? m.args : {};
      if (method === 'vizDiag') {
        try { wrap.__vizFrames = Number(args.frames) || 0; wrap.__vizRev = Number(args.rev) || 0; wrap.__vizMode = String(args.mode || ''); wrap.__vizSteps = Number(args.steps) || 0; if (typeof wrap.__onVizFrame === 'function') wrap.__onVizFrame(wrap.__vizFrames, args); } catch { /* */ }
        try { port && port.postMessage({ __cu: 1, type: 'call-result', id: m.id, ok: true, value: {} }); } catch { /* */ }
      } else { try { port && port.postMessage({ __cu: 1, type: 'call-result', id: m.id, ok: false, error: 'method not exposed' }); } catch { /* */ } }
    }
    else if (m.type === 'error') { try { (window.__fieldReportError || (() => {}))(String(m.error || 'render failed'), String(spec.source || ''), { name: String(spec.name || spec.title || 'component'), componentId: String(spec.componentId || spec.id || '') }); } catch { /* */ } try { if (ctx && typeof ctx.onComponentError === 'function') ctx.onComponentError(String(m.error || 'render failed'), { runtime: !!m.runtime }); } catch { /* */ } } // a confined component failed (mount OR runtime) → queue it for the AUTHORING agent's next turn + the auto-fix loop AND let the caller (e.g. the trace island) run its fallback ladder. Forward the runtime flag so the caller can tell a POST-MOUNT runtime error (must NOT tear down a live view) from a MOUNT failure (fatal). The frame never had the source, the parent's spec does
    else if (m.type === 'render-smell') { try { (window.__fieldReportSmell || (() => {}))(Array.isArray(m.smells) ? m.smells : [], { componentId: String(spec.componentId || spec.id || ''), name: String(spec.name || spec.title || 'component'), source: spec.source }); } catch { /* */ } } // a value coerced to "[object Object]" on screen → route to feedback-loops + the renderer's re-author loop
  };
  // one-shot window listener JUST for the 'ready' handshake — removed the instant it fires (no accumulation).
  const onReady = e => {
    if (e.source !== iframe.contentWindow) return; const m = e.data; if (!m || m.__cu !== 1 || m.type !== 'ready') return;
    window.removeEventListener('message', onReady);
    const ch = new MessageChannel(); port = ch.port1; port.onmessage = onPort; try { port.start(); } catch { /* */ }
    try { iframe.contentWindow.postMessage({ __cu: 1, type: 'mount', source: String(spec.source || ''), theme: theme.get().vars, props: (spec.props && typeof spec.props === 'object' && !Array.isArray(spec.props)) ? spec.props : undefined, refs: (spec.refs && typeof spec.refs === 'object') ? spec.refs : undefined }, '*', [ch.port2]); } catch { /* */ } // forward render-safe props (never a cap) → confined.html UI.props; the trace-viz reads props.cell here
    // PROPAGATE the user's global theme DOWN into the confined widget (read-only style data, never a cap),
    // so it always matches the user's chosen style and re-themes live when they switch.
    releases.push(theme.subscribe(t => { try { port && port.postMessage({ __cu: 1, type: 'theme', vars: t.vars }); } catch { /* */ } }));
  };
  window.addEventListener('message', onReady);
  const disposeThis = track(() => { window.removeEventListener('message', onReady); try { port && port.close(); } catch { /* */ } for (const r of releases) { try { r(); } catch { /* */ } } });
  // Explicit teardown so a caller that removes THIS widget on its own (e.g. the trace island ending a turn)
  // closes its cell stream now instead of leaking it until the next chat-switch disposeAllWidgets.
  try { wrap.__dispose = () => { try { cleanups.delete(disposeThis); } catch { /* */ } try { disposeThis(); } catch { /* */ } }; } catch { /* */ }
  iframe.src = '/confined.html'; // the trusted runtime (own no-network CSP); source + a private port arrive on the 'ready' handshake
  return wrap;
}

// ── TRACE-VIZ ISLAND: mount the Tier-2 (sandboxed-iframe, WebGL-capable) trace visualization for `sid`.
//    It rides renderComponent — the SAME cell-brokering + component-identity + backlog path as any confined
//    component — so the iframe SUBSCRIBES to `trace:<sid>` and the PARENT brokers that cell IN over the
//    private MessagePort using the cap here (the cap NEVER crosses into the frame; the frame has no network
//    at all — confined.html's CSP is default-src 'none'). `componentId` is the seeded uicomp git id, which
//    makes the island alt-selectable → edit chat, forkable, and auto-files render errors onto ITS backlog.
//    Returns the wrapper (with .__dispose to tear the stream + iframe down); `onError` fires if the confined
//    viz fails to mount/throws so the caller can run its fallback ladder (→ chrome island → legacy pendant).
export const mountTraceViz = async (host, { cap, sid, componentId, name, source, height, onError, onVizFrame } = {}) => {
  if (!host || !sid) return null;
  const cellId = `trace:${sid}`;
  // LAZY-LOAD the reference source (kept out of grain-ui's top-level imports so this module always loads even
  // before the /trace-viz-3d.js route is up — the live app never hard-depends on it; Tier-2 is opt-in).
  // window.__traceVizSourceOverride is a TEST-ONLY seam (inject a throwing source to exercise the fallback).
  let src = source || (typeof window !== 'undefined' && window.__traceVizSourceOverride) || '';
  let vizName = name;
  if (!src) { try { const m = await import('./trace-viz-3d.js'); src = m.TRACE_VIZ_3D_SOURCE; vizName = vizName || m.TRACE_VIZ_NAME; } catch { return null; } }
  if (!src) return null;
  const spec = { type: 'component', source: src, cells: [cellId], componentId: componentId || undefined, name: vizName || 'Trace 3D', height: Number(height) || 300, props: { cell: cellId, sid: String(sid) } };
  let wrap;
  try { wrap = renderComponent(spec, { cap, onComponentError: onError }); } catch { return null; }
  if (!wrap) return null;
  if (typeof onVizFrame === 'function') { try { wrap.__onVizFrame = onVizFrame; } catch { /* */ } }
  try { host.appendChild(wrap); } catch { return null; }
  return wrap;
};

// ── THE TRACE-VIEW GALLERY SET ── the curated 5 "well-researched ways to view how a complicated task got
//    done". Each is a confined Tier-2 `(ui)=>element` on the SAME trace:<sid> cell contract — the live cell
//    is the interface, so ONE running turn feeds every one of them. This registry is the single source of
//    truth for the gallery cards AND the island's switchable view set. `caption` is the one-line "what
//    analysis this makes effective", distilled from each source's header/spec.
export const TRACE_VIZ_KINDS = ([
  { key: '3d', module: './trace-viz-3d.js', srcExport: 'TRACE_VIZ_3D_SOURCE', nameExport: 'TRACE_VIZ_NAME', splashExport: '', caption: 'Constellation — the shape of the reasoning: order and branching of every step, as a 3D force graph.' },
  { key: 'flamegraph', module: './trace-viz-flamegraph.js', srcExport: 'TRACE_VIZ_FLAMEGRAPH_SOURCE', nameExport: 'TRACE_VIZ_FLAMEGRAPH_NAME', splashExport: 'TRACE_VIZ_FLAMEGRAPH_SPLASH', caption: 'Flame / icicle — where the effort went: proportion of work and nesting depth (the long pole at a glance).' },
  { key: 'timeline', module: './trace-viz-timeline.js', srcExport: 'TRACE_VIZ_TIMELINE_SOURCE', nameExport: 'TRACE_VIZ_TIMELINE_NAME', splashExport: 'TRACE_VIZ_TIMELINE_SPLASH', caption: 'Critical Path — parallelism across agents and the one step that gated completion.' },
  { key: 'provenance', module: './trace-viz-provenance.js', srcExport: 'TRACE_VIZ_PROVENANCE_SOURCE', nameExport: 'TRACE_VIZ_PROVENANCE_NAME', splashExport: 'TRACE_VIZ_PROVENANCE_SPLASH', caption: 'Provenance DAG — why this answer: the evidence and the authority the conclusion actually rests on.' },
  { key: 'sankey', module: './trace-viz-sankey.js', srcExport: 'TRACE_VIZ_SANKEY_SOURCE', nameExport: 'TRACE_VIZ_SANKEY_NAME', splashExport: 'TRACE_VIZ_SANKEY_SPLASH', caption: 'Authority & data flow — least-authority as a narrowing silhouette (the ocap lens).' },
]);
// (client module — not SES-hardened, matching app.js/grain-ui.js convention; the shapes are read-only data)

// a shared, cap-free canonical splash (the trace-cell shape every viz understands) — the fallback the 3D
// reference uses (it ships no *_SPLASH export and no .splash.json), so its gallery card still renders offline.
const SHARED_TRACE_SPLASH = ({
  status: 'done', rev: 9, prompt: 'Compare 3 vector DBs → recommendation',
  steps: [
    { name: 'notes', ok: true, status: 'done' },
    { name: 'research', ok: true, status: 'done', granted: ['research'], children: [
      { name: '❓ pgvector at our scale?', status: 'done', children: [{ name: 'web', ok: true, status: 'done' }, { name: 'read', ok: true, status: 'done' }] },
      { name: '❓ Qdrant vs Weaviate?', status: 'done', children: [{ name: 'web', ok: false, status: 'done' }, { name: 'web', ok: true, status: 'done' }] },
    ] },
    { name: 'editNote', ok: true, status: 'done', granted: ['notes'] },
  ],
  nodes: [
    { key: 'root', state: 'done' }, { key: 'notes', parent: 'root', state: 'done' },
    { key: 'research', parent: 'root', state: 'done' }, { key: 'q1', parent: 'research', state: 'done' },
    { key: 'q2', parent: 'research', state: 'done' }, { key: 'editNote', parent: 'root', state: 'done' },
  ],
});

// LOAD the 5 viz (source + display name + splash + caption). Splash resolution HANDLES BOTH conventions:
// prefer the sibling `<basename>.splash.json` if it is served, else the module's `*_SPLASH` export, else the
// shared canonical splash. Best-effort per kind: a module that fails to import is dropped, never fatal.
export const loadTraceVizKinds = async () => {
  const out = [];
  for (const k of TRACE_VIZ_KINDS) {
    try {
      const mod = await import(k.module);
      const source = mod[k.srcExport];
      if (!source) continue;
      const name = mod[k.nameExport] || k.key;
      let splash = null;
      try { const r = await fetch(k.module.replace(/\.js$/, '.splash.json')); if (r && r.ok) splash = await r.json(); } catch { /* no json → fall through */ }
      if (!splash && k.splashExport && mod[k.splashExport]) splash = mod[k.splashExport];
      if (!splash) splash = SHARED_TRACE_SPLASH;
      out.push({ key: k.key, name, source, caption: k.caption, splash });
    } catch { /* a viz that won't import is simply absent from the gallery */ }
  }
  return out;
};

// ── mount ONE trace-viz splash card: a small confined instance of `source` rendering its OWN canned splash
//    trace, fed cap-free through the cell (seedCells) so it previews offline (no live cell, no cap). This is
//    the same confined runtime a live viz uses; only the data source differs (a canned value, not a stream).
export const mountVizSplash = (host, { source, splash, height, cellId } = {}) => {
  if (!host || !source) return null;
  const cid = cellId || 'trace:splash';
  const spec = { type: 'component', source: String(source), cells: [cid], height: Number(height) || 190, props: { cell: cid, splash } };
  let wrap;
  try { wrap = renderComponent(spec, { seedCells: { [cid]: splash } }); } catch { return null; }
  if (!wrap) return null;
  try { host.appendChild(wrap); } catch { return null; }
  return wrap;
};

// theme-preview — a BEFORE/AFTER preview of a proposed theme with Accept/Reject. Accept makes it the
// user's live global theme everywhere (it persists). The mini-mockups render with each theme's own vars
// scoped to the box, so you see the new style without changing the page until you accept.
const renderThemePreview = (spec) => {
  // Accept a GALLERY (spec.themes:[{name,vars,mode}]) OR a single legacy theme (spec.{name,vars,mode}) →
  // normalize to a list. With >1 you can "try them on": clicking a swatch applies it LIVE everywhere; Revert
  // restores the theme you started with. (dan's ask: an easy way to switch between themes to try them on.)
  const themes = (Array.isArray(spec.themes) && spec.themes.length ? spec.themes : [{ name: spec.name, vars: spec.vars, mode: spec.mode }])
    .filter(t => t && t.vars && typeof t.vars === 'object')
    .map(t => ({ name: String(t.name || 'custom').slice(0, 40), vars: t.vars, mode: (t.mode === 'light' || t.mode === 'dark') ? t.mode : undefined }))
    .slice(0, 12);
  const wrap = document.createElement('div'); wrap.className = 'gw gw-theme'; wrap.style.cssText = 'margin:8px 0;border:1px solid var(--edge);border-radius:12px;padding:11px 13px;background:var(--panel)';
  if (!themes.length) { wrap.textContent = '🎨 (no theme to preview)'; return wrap; }
  const original = theme.get(); // where Revert returns you
  const title = document.createElement('div'); title.style.cssText = 'font-size:13px;font-weight:600;margin-bottom:8px'; title.textContent = themes.length > 1 ? '🎨 Try on a theme' : `🎨 New theme: ${themes[0].name}`; wrap.appendChild(title);
  const mock = (vars, label) => {
    const box = document.createElement('div');
    box.style.cssText = Object.entries(vars || {}).map(([k, v]) => `${k}:${v}`).join(';') + ';flex:1;min-width:0;border:1px solid var(--edge);border-radius:9px;padding:9px;background:var(--bg);color:var(--ink)';
    const mk = (tag, css, text) => { const e = document.createElement(tag); e.style.cssText = css; if (text) e.textContent = text; box.appendChild(e); return e; };
    mk('div', 'font-size:9px;color:var(--mut);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px', label);
    mk('div', 'background:var(--panel);border:1px solid var(--edge);border-radius:8px;padding:6px 8px;font-size:11px;margin-bottom:6px', 'A sample message');
    mk('span', 'display:inline-block;background:var(--acc);color:#fff;border-radius:6px;padding:2px 8px;font-size:10px;margin-right:5px', 'Button');
    mk('span', 'display:inline-block;background:var(--panel);border:1px solid var(--edge);color:var(--mut);border-radius:6px;padding:2px 8px;font-size:10px', 'chip');
    return box;
  };
  let active = themes[0];
  const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;margin-bottom:9px';
  const curMock = mock(original.vars, 'current · ' + (original.name || 'theme'));
  let newMock = mock(active.vars, 'try-on · ' + active.name);
  row.append(curMock, newMock); wrap.appendChild(row);
  // SWATCH STRIP — one per theme; clicking tries it on LIVE (applies globally) + updates the try-on mock.
  if (themes.length > 1) {
    const strip = document.createElement('div'); strip.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:9px';
    const setActive = (t, chip) => {
      active = t; applyTheme({ name: t.name, mode: t.mode, vars: t.vars }); // try it on LIVE, everywhere
      const fresh = mock(t.vars, 'try-on · ' + t.name); newMock.replaceWith(fresh); newMock = fresh;
      [...strip.children].forEach(x => { x.style.borderColor = 'var(--edge)'; x.style.fontWeight = '400'; }); if (chip) { chip.style.borderColor = 'var(--acc)'; chip.style.fontWeight = '600'; }
    };
    themes.forEach((t, i) => {
      const chip = document.createElement('button'); chip.title = 'try on ' + t.name;
      chip.style.cssText = `all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:6px;border:1px solid ${i === 0 ? 'var(--acc)' : 'var(--edge)'};border-radius:8px;padding:3px 9px;font-size:11px;font-weight:${i === 0 ? 600 : 400}`;
      const sw = document.createElement('span'); sw.style.cssText = `width:13px;height:13px;border-radius:3px;background:${t.vars['--bg'] || '#000'};box-shadow:inset 0 0 0 4px ${t.vars['--acc'] || '#888'};flex:0 0 auto`;
      const nm = document.createElement('span'); nm.textContent = t.name;
      chip.append(sw, nm); chip.onclick = () => setActive(t, chip); strip.appendChild(chip);
    });
    wrap.appendChild(strip);
  }
  const btns = document.createElement('div'); btns.style.cssText = 'display:flex;gap:6px';
  const keep = document.createElement('button'); keep.textContent = themes.length > 1 ? '✓ Keep this one' : '✓ Use this theme'; keep.style.cssText = 'all:unset;cursor:pointer;background:var(--acc);color:#fff;border-radius:7px;padding:4px 11px;font-size:12px;font-weight:600';
  const revert = document.createElement('button'); revert.textContent = '↶ Revert'; revert.style.cssText = 'all:unset;cursor:pointer;color:var(--mut);border:1px solid var(--edge);border-radius:7px;padding:4px 11px;font-size:12px';
  keep.onclick = () => { applyTheme({ name: active.name, mode: active.mode, vars: active.vars }); title.textContent = `🎨 Applied: ${active.name}`; btns.remove(); };
  revert.onclick = () => { applyTheme(original); wrap.remove(); };
  btns.append(keep, revert); wrap.appendChild(btns);
  return wrap;
};

// ── site-preview: a "link preview" card for a site the agent just publishSite'd. Shows the title, its
//    address, an Open action, AND a LIVE thumbnail of the actual page (a sandboxed, non-interactive iframe
//    — the same opaque-origin boundary as a confined component, so the preview can't reach the chat's cap).
const hostLabel = url => { try { const u = new URL(url, location.origin); return (u.host || location.host) + (u.pathname && u.pathname !== '/' ? u.pathname.replace(/\/$/, '') : ''); } catch { return String(url || '').replace(/^https?:\/\//, '').slice(0, 60); } };
// publishSite() stamps URLs with the server's BASE_URL (the TAILNET host). A viewer on the PUBLIC
// origin (agentc.chu via ngrok, off-tailnet) can't reach that host → the iframe goes blank. The same
// /sites/<token>/ path is served on whatever origin the viewer is on, so resolve our own published
// sites SAME-ORIGIN (path only) — correct on both tailnet and public; also repairs already-published sites.
const localizeSiteUrl = url => { try { const u = new URL(url, location.origin); if (/^\/sites\//.test(u.pathname)) return u.pathname + u.search + u.hash; return url; } catch { return url; } };
const renderSitePreview = spec => {
  const url = localizeSiteUrl(String(spec.url || '')); const name = String(spec.name || spec.title || 'Published site');
  const wrap = document.createElement('div'); wrap.className = 'gw gw-site'; wrap.style.cssText = `${STYLE};margin:8px 0;border:1px solid var(--edge,#30363d);border-radius:12px;overflow:hidden;background:var(--panel,#161b22);cursor:pointer`;
  const head = document.createElement('div'); head.style.cssText = 'display:flex;align-items:center;gap:9px;padding:9px 12px';
  const ic = document.createElement('span'); ic.textContent = '🌐'; ic.style.fontSize = '16px';
  const meta = document.createElement('div'); meta.style.cssText = 'flex:1;min-width:0';
  const t = document.createElement('div'); t.textContent = name; t.style.cssText = 'font-weight:600;color:var(--ink,#e6edf3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap'; // textContent — agent string never becomes HTML
  const u = document.createElement('div'); u.textContent = hostLabel(url); u.style.cssText = 'font-size:11px;color:var(--mut,#8b949e);overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  meta.append(t, u);
  // the FULL absolute URL (public origin) for sharing OFF this device — the path-only `url` only resolves here.
  const shareUrl = (() => { try { return new URL(url, location.origin).href; } catch { return url; } })();
  const btn = (label, title) => { const b = document.createElement('button'); b.textContent = label; b.title = title; b.style.cssText = 'all:unset;cursor:pointer;color:var(--acc,#7c5cff);font-size:12px;font-weight:600;border:1px solid var(--edge,#30363d);border-radius:7px;padding:3px 9px'; return b; };
  // EXPAND: open the page full-screen + INTERACTIVE in an overlay (not just a thumbnail / a new tab) — the
  // natural "open it as a webpage" on mobile, where a new tab + a 404 fallback used to trigger a download.
  const expand = () => {
    const ov = document.createElement('div'); ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.88);display:flex;flex-direction:column';
    const bar = document.createElement('div'); bar.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 14px;color:#fff;font:600 14px system-ui';
    const tt = document.createElement('div'); tt.textContent = name; tt.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    const ob = btn('Open ↗', 'open in a new tab'); ob.style.color = '#fff'; ob.addEventListener('click', () => { try { window.open(url, '_blank', 'noopener'); } catch { /* */ } });
    const cl = btn('✕', 'close'); cl.style.color = '#fff'; cl.addEventListener('click', () => ov.remove());
    bar.append(tt, ob, cl);
    const fr = document.createElement('iframe'); fr.setAttribute('sandbox', 'allow-scripts allow-popups allow-forms'); fr.setAttribute('referrerpolicy', 'no-referrer'); fr.src = url; fr.style.cssText = 'flex:1;width:100%;border:0;background:#fff';
    ov.append(bar, fr); ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); }); document.body.appendChild(ov);
  };
  // SHARE: copy the off-device link (the site token IS the access credential — the standard copy hand-off).
  const share = async () => { try { await navigator.clipboard.writeText(shareUrl); u.textContent = '🔗 link copied'; setTimeout(() => { u.textContent = hostLabel(url); }, 1600); } catch { try { window.prompt('Copy this link', shareUrl); } catch { /* */ } } };
  const expandBtn = btn('⤢', 'expand'); const shareBtn = btn('Share', 'copy a link to this page'); const open = btn('Open ↗', 'open in a new tab');
  head.append(ic, meta, expandBtn, shareBtn, open); wrap.appendChild(head);
  if (url) {
    const prev = document.createElement('div'); prev.style.cssText = 'height:148px;border-top:1px solid var(--edge,#21262d);overflow:hidden;position:relative;background:#fff';
    const ifr = document.createElement('iframe'); ifr.setAttribute('sandbox', 'allow-scripts'); ifr.setAttribute('referrerpolicy', 'no-referrer'); ifr.setAttribute('loading', 'lazy');
    // render at 2× then scale to 0.5 → a crisp thumbnail of the real page; non-interactive (clicks expand it).
    ifr.style.cssText = 'width:200%;height:296px;border:0;transform:scale(.5);transform-origin:top left;pointer-events:none';
    ifr.src = url; prev.appendChild(ifr); wrap.appendChild(prev);
  }
  expandBtn.addEventListener('click', e => { e.stopPropagation(); expand(); });
  shareBtn.addEventListener('click', e => { e.stopPropagation(); share(); });
  open.addEventListener('click', e => { e.stopPropagation(); try { window.open(url, '_blank', 'noopener'); } catch { /* */ } });
  wrap.addEventListener('click', expand); // tapping the card opens it inline (mobile-friendly; no download fallback)
  return wrap;
};

// renderSpecialist — a persistent SPECIALIST ISLAND dropped where spawnSpecialist fired: its name + power-ring,
// EXPANDABLE in place to inspect it (instructions, standing nudges, recent runs — lazy-fetched), and a button to
// open its own thread. So a spawned specialist is visible + inspectable right in the chat, by its in-context name.
const renderSpecialist = (spec, ctx) => {
  const name = String(spec.name || 'specialist'); const domain = String(spec.domain || ''); const powers = Array.isArray(spec.powers) ? spec.powers : [];
  const escTxt = s => { const d = document.createElement('div'); d.textContent = String(s == null ? '' : s); return d.innerHTML; };
  // SEC-17: escTxt round-trips through textContent, which escapes < > & but NOT " or ' — unsafe in an
  // ATTRIBUTE context (a " breaks out of the attribute → XSS). escAttr escapes quotes too; use it whenever
  // a value is interpolated inside quotes of an HTML-string attribute.
  const escAttr = s => escTxt(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const wrap = document.createElement('div'); wrap.className = 'gw gw-spec'; wrap.style.cssText = `${STYLE};margin:8px 0;border:1px solid var(--edge,#30363d);border-radius:12px;overflow:hidden;background:var(--panel,#161b22)`;
  const head = document.createElement('div'); head.style.cssText = 'display:flex;align-items:center;gap:9px;padding:9px 12px';
  const ic = document.createElement('span'); ic.textContent = '🧑‍🔬'; ic.style.fontSize = '16px';
  const meta = document.createElement('div'); meta.style.cssText = 'flex:1;min-width:0';
  const t = document.createElement('div'); t.textContent = name; t.style.cssText = 'font-weight:600;color:var(--ink,#e6edf3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap'; // textContent — never HTML
  const d = document.createElement('div'); d.textContent = domain ? `specialist · ${domain}` : 'specialist sub-agent'; d.style.cssText = 'font-size:11px;color:var(--mut,#8b949e);overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  meta.append(t, d);
  const btn = (label, title) => { const b = document.createElement('button'); b.textContent = label; b.title = title || ''; b.style.cssText = 'all:unset;cursor:pointer;color:var(--acc,#7c5cff);font-size:12px;font-weight:600;border:1px solid var(--edge,#30363d);border-radius:7px;padding:3px 9px;white-space:nowrap'; return b; };
  const inspectBtn = btn('▸ Inspect', 'its ring, instructions, standing nudges + runs');
  const chatBtn = btn('💬 Chat', 'open a new chat as this specialist');
  head.append(ic, meta, inspectBtn, chatBtn); wrap.appendChild(head);
  if (powers.length) { const chips = document.createElement('div'); chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;padding:0 12px 9px'; powers.forEach(p => { const c = document.createElement('span'); c.textContent = p; c.style.cssText = 'font-size:10px;color:var(--mut,#8b949e);border:1px solid var(--edge,#30363d);border-radius:5px;padding:1px 6px'; chips.appendChild(c); }); wrap.appendChild(chips); }
  const panel = document.createElement('div'); panel.style.cssText = 'display:none;border-top:1px solid var(--edge,#21262d);padding:10px 12px;font-size:12px;color:var(--ink,#e6edf3);max-height:340px;overflow-y:auto'; wrap.appendChild(panel);
  let loaded = false;
  const loadInspect = async () => {
    panel.textContent = 'Loading…';
    try {
      const r = await (await fetch('/specialist/inspect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: ctx && ctx.cap, id: spec.id }) })).json();
      if (!r || !r.ok) { panel.textContent = (r && r.error) || 'could not load'; return; }
      panel.innerHTML = '';
      const sec = (label, html) => { const s = document.createElement('div'); s.style.cssText = 'margin-bottom:9px'; s.innerHTML = `<div style="color:var(--mut,#8b949e);font-size:10px;letter-spacing:.04em;margin-bottom:3px">${label}</div>${html}`; panel.appendChild(s); return s; };
      if (r.instructions) sec('INSTRUCTIONS', `<div style="white-space:pre-wrap">${escTxt(String(r.instructions).slice(0, 1400))}</div>`);
      if ((r.nudges || []).length) sec('STANDING NUDGES', r.nudges.map(n => `<div>⏰ ${escTxt(String(n.request).slice(0, 90))} — ${n.recurring ? 'recurring' : 'once'}${n.nextAt ? `, next ${escTxt(new Date(n.nextAt).toLocaleString())}` : ''} <span style="color:var(--mut,#8b949e)">(${n.runs} run${n.runs === 1 ? '' : 's'})</span></div>`).join(''));
      if ((r.runs || []).length) { const s = sec('RECENT RUNS', r.runs.map(run => `<div data-openrun="${escAttr(run.id)}" style="cursor:pointer;color:var(--acc,#7c5cff)">🔁 ${escTxt(run.title)} <span style="color:var(--mut,#8b949e)">— ${escTxt(new Date(run.at).toLocaleString())}</span></div>`).join('')); s.querySelectorAll('[data-openrun]').forEach(el => el.onclick = () => { if (ctx && ctx.onOpenRun) ctx.onOpenRun(el.getAttribute('data-openrun')); }); }
      if (!r.instructions && !(r.nudges || []).length && !(r.runs || []).length) panel.textContent = 'No instructions, standing nudges, or runs yet — chat with it or schedule one.';
      loaded = true;
    } catch (e) { panel.textContent = 'could not load: ' + e.message; }
  };
  inspectBtn.addEventListener('click', async e => { e.stopPropagation(); const open = panel.style.display === 'none'; panel.style.display = open ? 'block' : 'none'; inspectBtn.textContent = open ? '▾ Inspect' : '▸ Inspect'; if (open && !loaded) await loadInspect(); });
  chatBtn.addEventListener('click', e => { e.stopPropagation(); if (ctx && ctx.onOpenSpecialist) ctx.onOpenSpecialist(spec.id, name); });
  return wrap;
};

const RENDERERS = { countdowns: renderCountdowns, 'entity-status': renderEntityStatus, choices: renderChoices, component: renderComponent, 'theme-preview': renderThemePreview, 'site-preview': renderSitePreview, specialist: renderSpecialist };

// renderWidgets(container, specs, ctx): append each widget; ctx = { cap, onChoice }. Pure data in, DOM out.
export const renderWidgets = (container, specs, ctx) => {
  if (!container || !Array.isArray(specs)) return;
  for (const spec of specs.slice(0, MAX_WIDGETS)) { // hard cap mirrors the server bound
    const fn = spec && RENDERERS[spec.type]; if (!fn) continue;
    try { container.appendChild(fn(spec, ctx || {})); } catch { /* a bad spec never breaks the bubble */ }
  }
};

// one-time keyframes for the live dot
if (typeof document !== 'undefined' && !document.getElementById('gw-style')) {
  const s = document.createElement('style'); s.id = 'gw-style'; s.textContent = '@keyframes gwpulse{0%,100%{opacity:1}50%{opacity:.35}}';
  document.head.appendChild(s);
}
