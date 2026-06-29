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
      if (ctx && ctx.sample) { try { port && port.postMessage({ __cu: 1, type: 'cell', id, value: dummyForCell(id) }); } catch { /* */ } return; } // GALLERY preview: feed generated dummy data — no server cell, no cap
      if (!auth || !allowedCells.has(id)) return; // undeclared / no credential → ignore
      const { grain, release } = acquireCell(auth, id); releases.push(release);
      follow(grain, value => { try { port && port.postMessage({ __cu: 1, type: 'cell', id, value }); } catch { /* */ } }); // pipe live values IN (cap stays here)
    }
    else if (m.type === 'error') { try { (window.__fieldReportError || (() => {}))(String(m.error || 'render failed'), String(m.source || '')); } catch { /* */ } } // a confined component failed → route to the auto-fix loop
  };
  // one-shot window listener JUST for the 'ready' handshake — removed the instant it fires (no accumulation).
  const onReady = e => {
    if (e.source !== iframe.contentWindow) return; const m = e.data; if (!m || m.__cu !== 1 || m.type !== 'ready') return;
    window.removeEventListener('message', onReady);
    const ch = new MessageChannel(); port = ch.port1; port.onmessage = onPort; try { port.start(); } catch { /* */ }
    try { iframe.contentWindow.postMessage({ __cu: 1, type: 'mount', source: String(spec.source || ''), theme: theme.get().vars, refs: (spec.refs && typeof spec.refs === 'object') ? spec.refs : undefined }, '*', [ch.port2]); } catch { /* */ }
    // PROPAGATE the user's global theme DOWN into the confined widget (read-only style data, never a cap),
    // so it always matches the user's chosen style and re-themes live when they switch.
    releases.push(theme.subscribe(t => { try { port && port.postMessage({ __cu: 1, type: 'theme', vars: t.vars }); } catch { /* */ } }));
  };
  window.addEventListener('message', onReady);
  track(() => { window.removeEventListener('message', onReady); try { port && port.close(); } catch { /* */ } for (const r of releases) { try { r(); } catch { /* */ } } });
  iframe.src = '/confined.html'; // the trusted runtime (own no-network CSP); source + a private port arrive on the 'ready' handshake
  return wrap;
};

// theme-preview — a BEFORE/AFTER preview of a proposed theme with Accept/Reject. Accept makes it the
// user's live global theme everywhere (it persists). The mini-mockups render with each theme's own vars
// scoped to the box, so you see the new style without changing the page until you accept.
const renderThemePreview = (spec) => {
  const wrap = document.createElement('div'); wrap.className = 'gw'; wrap.style.cssText = 'margin:8px 0;border:1px solid var(--edge);border-radius:12px;padding:11px 13px;background:var(--panel)';
  const title = document.createElement('div'); title.style.cssText = 'font-size:13px;font-weight:600;margin-bottom:8px'; title.textContent = `🎨 New theme: ${spec.name || 'custom'}`; wrap.appendChild(title);
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
  const cur = theme.get();
  const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;margin-bottom:9px';
  row.append(mock(cur.vars, 'current · ' + (cur.name || 'theme')), mock(spec.vars, 'new · ' + (spec.name || 'theme')));
  wrap.appendChild(row);
  const btns = document.createElement('div'); btns.style.cssText = 'display:flex;gap:6px';
  const accept = document.createElement('button'); accept.textContent = '✓ Use this theme'; accept.style.cssText = 'all:unset;cursor:pointer;background:var(--acc);color:#fff;border-radius:7px;padding:4px 11px;font-size:12px;font-weight:600';
  const reject = document.createElement('button'); reject.textContent = 'Keep current'; reject.style.cssText = 'all:unset;cursor:pointer;color:var(--mut);border:1px solid var(--edge);border-radius:7px;padding:4px 11px;font-size:12px';
  accept.onclick = () => { applyTheme({ name: spec.name || 'custom', mode: spec.mode, vars: spec.vars }); title.textContent = `🎨 Applied: ${spec.name || 'custom'}`; btns.remove(); };
  reject.onclick = () => wrap.remove();
  btns.append(accept, reject); wrap.appendChild(btns);
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

const RENDERERS = { countdowns: renderCountdowns, 'entity-status': renderEntityStatus, choices: renderChoices, component: renderComponent, 'theme-preview': renderThemePreview, 'site-preview': renderSitePreview };

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
