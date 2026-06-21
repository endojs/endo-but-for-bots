// grain-ui.js — LIVE, INTERACTIVE chat widgets, grain-native.
//
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

// ── over-the-wire grain: subscribe to named server cells; the server PUSHES (no polling here). ──
// cap goes in the POST body (cap-hygiene — never a URL). Returns an unsubscribe that aborts the stream.
const subscribeCells = (cap, ids, onMsg) => {
  const ctrl = new AbortController();
  (async () => {
    try {
      const res = await fetch('/cells/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, cells: ids }), signal: ctrl.signal });
      if (!res.ok || !res.body) { onMsg({ id: ids[0], error: `subscribe failed (${res.status})` }); return; }
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
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

// Track every live widget's teardown so a re-render / chat-switch can dispose streams + intervals.
const cleanups = new Set();
export const disposeAllWidgets = () => { for (const c of [...cleanups]) { try { c(); } catch { /* */ } cleanups.delete(c); } };
const track = fn => { cleanups.add(fn); return fn; };

const esc = s => String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const STYLE = 'font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';

// ── countdown widgets: pure-client, tick against an absolute dueAt. No server, no polling. ──
const fmt = ms => { if (ms <= 0) return '✓ done'; const s = Math.round(ms / 1000); const m = Math.floor(s / 60), ss = s % 60; const h = Math.floor(m / 60); return h ? `${h}:${String(m % 60).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`; };
const renderCountdowns = spec => {
  const box = document.createElement('div'); box.className = 'gw gw-countdowns'; box.style.cssText = `${STYLE};margin:8px 0;display:flex;flex-direction:column;gap:6px`;
  const rows = (spec.items || []).map(it => {
    const due = Date.parse(it.dueAt);
    const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;gap:10px;background:#161b22;border:1px solid #30363d;border-radius:10px;padding:8px 12px';
    const name = document.createElement('span'); name.textContent = it.label; name.style.cssText = 'flex:1;font-weight:600;color:#e6edf3';
    const time = document.createElement('span'); time.style.cssText = 'font-variant-numeric:tabular-nums;font-weight:700;color:#7c5cff;min-width:62px;text-align:right';
    row.append(name, time); box.appendChild(row);
    return { due, time };
  });
  const tick = () => { const now = Date.now(); for (const r of rows) { const left = r.due - now; r.time.textContent = fmt(left); r.time.style.color = left <= 0 ? '#2ea043' : left < 60000 ? '#f85149' : '#7c5cff'; } };
  tick(); const iv = setInterval(tick, 1000); track(() => clearInterval(iv));
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
  const label = document.createElement('span'); label.textContent = spec.label || 'status'; label.style.cssText = 'font-weight:600;color:#e6edf3';
  const pill = document.createElement('span'); pill.style.cssText = 'display:inline-flex;align-items:center;gap:6px;font-weight:700';
  const dot = document.createElement('span'); dot.title = 'live'; dot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:#2ea043;box-shadow:0 0 6px #2ea043;animation:gwpulse 1.6s infinite';
  pill.innerHTML = '<span class="gw-ic">•</span> <span class="gw-tx" style="color:#8b949e">connecting…</span>';
  box.append(label, pill, dot);
  const grain = makeGrain(undefined);
  follow(grain, v => {
    if (v && v.error) { pill.querySelector('.gw-tx').textContent = v.error; pill.querySelector('.gw-tx').style.color = '#8b949e'; dot.style.background = '#8b949e'; dot.style.boxShadow = 'none'; return; }
    const view = stateView(v && v.state);
    pill.querySelector('.gw-ic').textContent = view.icon;
    const tx = pill.querySelector('.gw-tx'); tx.textContent = view.text; tx.style.color = view.color;
  });
  // wire the grain to the live cell over the chat's cap (only pushes if this chat holds the power).
  const cap = ctx && ctx.cap;
  if (cap) track(subscribeCells(cap, [spec.cell || `ha:${spec.handle}`], msg => { if (msg && (msg.id === (spec.cell || `ha:${spec.handle}`))) grain.set(msg.value || msg); }));
  else { pill.querySelector('.gw-tx').textContent = 'open this chat to see live status'; }
  return box;
};

// ── interactive choices: tapping sends the option back as the next message. ──
const renderChoices = (spec, ctx) => {
  const box = document.createElement('div'); box.className = 'gw gw-choices'; box.style.cssText = `${STYLE};margin:8px 0`;
  if (spec.prompt) { const p = document.createElement('div'); p.textContent = spec.prompt; p.style.cssText = 'color:#8b949e;margin-bottom:6px'; box.appendChild(p); }
  const row = document.createElement('div'); row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px';
  for (const opt of (spec.options || [])) {
    const b = document.createElement('button'); b.textContent = opt; b.style.cssText = 'all:unset;cursor:pointer;background:#1f6feb22;border:1px solid #1f6feb88;color:#cfe2ff;border-radius:10px;padding:7px 14px;font:inherit;font-weight:600';
    b.onmouseenter = () => { b.style.background = '#1f6feb44'; }; b.onmouseleave = () => { b.style.background = '#1f6feb22'; };
    b.onclick = () => { if (ctx && typeof ctx.onChoice === 'function') ctx.onChoice(opt); };
    row.appendChild(b);
  }
  box.appendChild(row); return box;
};

const RENDERERS = { countdowns: renderCountdowns, 'entity-status': renderEntityStatus, choices: renderChoices };

// renderWidgets(container, specs, ctx): append each widget; ctx = { cap, onChoice }. Pure data in, DOM out.
export const renderWidgets = (container, specs, ctx) => {
  if (!container || !Array.isArray(specs)) return;
  for (const spec of specs) {
    const fn = spec && RENDERERS[spec.type]; if (!fn) continue;
    try { container.appendChild(fn(spec, ctx || {})); } catch (e) { /* a bad spec never breaks the bubble */ }
  }
};

// one-time keyframes for the live dot
if (typeof document !== 'undefined' && !document.getElementById('gw-style')) {
  const s = document.createElement('style'); s.id = 'gw-style'; s.textContent = '@keyframes gwpulse{0%,100%{opacity:1}50%{opacity:.35}}';
  document.head.appendChild(s);
}
