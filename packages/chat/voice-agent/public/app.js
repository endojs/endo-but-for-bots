// app.js — cap-aware voice/text chat with Agent C + a Shares panel.
// (Agent C is the user-facing brand; the internal agent id stays 'field-agent'.)
//
// The hex after #cap= IS the credential. We lift it out of the address bar (cap
// hygiene), pass it to /chat (so the agent runs with exactly the powers this cap
// holds) and to /rpc (describe/share/listShares/revoke). No cap → the agent has
// no powers. A share() mint is NEVER rendered to screen — it's handed off only
// by copy or an on-demand local QR.
// The cap (#cap=…) is the credential. We keep it OUT of the address bar (cap
// hygiene), but persist it to origin-scoped localStorage so a reload doesn't drop
// the session. A fresh #cap link overwrites the stored one; otherwise we restore.
import { renderWidgets, disposeAllWidgets } from './grain-ui.js'; // live/interactive response widgets (grain-native)
import { theme, cycleTheme, initTheme } from './theme.js'; // the user's global style as a read-only propagator (dark/light MVP)
import { forkRetry, forkPage, forkCount, forkIndex } from './fork-model.js'; // retry-as-fork data-model (pure, unit-tested)
import { renderMarkdown } from './md.js'; // safe Markdown→DOM for agent replies + the notification modal
import { mountForkInto } from './fork-widget.js'; // mount a confined FORK (in-tree, no-iframe) inline in a chat
initTheme(); // restore the saved theme + start applying it to :root as CSS vars
(() => { // a header toggle for light/dark (the first control of the userspace-extensible style framework)
  try {
    const hdr = document.querySelector('header'); if (!hdr) return;
    const b = document.createElement('button'); b.id = 'theme-toggle'; b.className = 'hdr-sel'; b.style.cssText = 'cursor:pointer;max-width:none;width:auto'; b.title = 'Switch light / dark theme';
    theme.subscribe(t => { b.textContent = t.mode === 'light' ? '☀️' : '🌙'; });
    b.onclick = () => cycleTheme();
    const anchor = document.getElementById('budget');
    if (anchor && anchor.parentNode === hdr) hdr.insertBefore(b, anchor); else hdr.appendChild(b);
  } catch { /* enhancement-only */ }
})();
const CAP_KEY = 'field-agent-cap';
const _hashParams = new URLSearchParams(location.hash.slice(1));
let cap = _hashParams.get('cap');
// deep-link: #chat=<id> opens that chat once it resolves. The cap is read from
// localStorage (already there from the initial #cap link), so a notification's
// chat link carries NO swissnum — cap-hygiene preserved.
let pendingChat = _hashParams.get('chat') || null;
const pendingShare = _hashParams.get('chatshare') || null; // Feature B: opened via a chat-share link
const pendingMinimizeApp = _hashParams.get('minimize-app') || null; // handoff from /apps/<name> → minimize into a fresh chat (cap restored from localStorage)
const pendingForkToken = _hashParams.get('fork') || null; // a shared FORK link (#fork=<token>): open it inline so the recipient can use, adopt + re-share
if (cap) { try { localStorage.setItem(CAP_KEY, cap); } catch {} }
if (location.hash) { try { history.replaceState(null, '', location.pathname + location.search); } catch {} } // strip the fragment (cap and/or chat)
if (!cap) { try { cap = localStorage.getItem(CAP_KEY) || null; } catch {} }
// A confined component (or other surface) failed to render → route the error to the self-improvement loop
// so the developer agent fixes it automatically (server de-dupes + files a backlog item). Cap-gated; the
// source snippet is render-safe (a widget's (ui)=>element body, never a swissnum).
window.__fieldReportError = (error, source) => { try { if (!cap || !error) return; fetch('/error/flag', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, kind: 'component-render', error: String(error).slice(0, 300), source: String(source || '').slice(0, 500) }) }).catch(() => {}); } catch { /* */ } };
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random())).slice(0, 36);
let sessionId = '';     // active chat id (set by initChats)
let activeTx = [];      // active chat transcript (persisted for restore across reloads)
let greetingText = '';  // set after describe()

// ── cap hand-off helpers (copy / QR / reveal) — shared with the rest of the stack ──
const writeClipboard = async text => {
  if (navigator.clipboard && window.isSecureContext) { try { await navigator.clipboard.writeText(text); return true; } catch {} }
  try {
    const ta = document.createElement('textarea'); ta.value = text; ta.readOnly = true;
    ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    document.body.appendChild(ta); ta.focus(); ta.select(); try { ta.setSelectionRange(0, text.length); } catch {}
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch { return false; }
};
const flashBtn = (btn, msg) => { if (!btn) return; const t = btn.dataset.label || btn.textContent; btn.dataset.label = t; btn.textContent = msg; setTimeout(() => { btn.textContent = t; }, 1500); };
const closeModal = () => { const m = $('qrmodal'); m.classList.add('hide'); m.innerHTML = ''; };
const showModal = html => { const m = $('qrmodal'); m.innerHTML = `<div class="qrcard">${html}<br><button class="mini" id="qrclose">close</button></div>`; m.classList.remove('hide'); m.onclick = e => { if (e.target === m) closeModal(); }; $('qrclose').onclick = closeModal; };
// Server-minted share links bake in the server's PUBLIC_BASE_URL (the tailnet host). Rebuild them onto
// the origin the user is actually on, so "copy link" / QR match the current page (chu, localhost, …).
const localizeUrl = u => { try { const x = new URL(u, location.origin); return location.origin + x.pathname + x.search + x.hash; } catch { return u; } };
const revealLink = (s, note) => { showModal(`<div class="qrlabel">${esc(note || 'copy this link')}</div><input class="reveal-in" id="reveal-in" readonly value="${esc(localizeUrl(s.url))}"><span class="qrwarn">contains the credential — copy it, don't screen-share it</span>`); const inp = $('reveal-in'); if (inp) { inp.focus(); inp.select(); try { inp.setSelectionRange(0, inp.value.length); } catch {} } };
const copyLink = async (s, btn) => { if (await writeClipboard(localizeUrl(s.url))) flashBtn(btn, 'copied ✓'); else revealLink(s, 'auto-copy was blocked — select & copy (⌘/Ctrl-C):'); };
const showQr = s => { let body; try { const qr = window.qrcode(0, 'M'); qr.addData(localizeUrl(s.url)); qr.make(); body = qr.createImgTag(6, 6); } catch (e) { body = `<div class="err">QR unavailable: ${esc(e.message)}</div>`; } showModal(`<div class="qrlabel">scan to open “${esc(s.label || 'link')}”</div>${body}<span class="qrwarn">contains the credential — scan it, don't screen-share it</span>`); };

const rpc = async (method, args = []) => {
  const r = await fetch('/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ swissnum: cap, method, args }) });
  const j = await r.json(); if (!j.ok) throw new Error(j.error); return j.result;
};

// ── chat transcript ───────────────────────────────────────────────────────────
const log = $('log'), mic = $('mic'), status = $('status');
const setStatus = t => { status.textContent = t; };
const setMic = c => { mic.className = c || ''; };
// per-agent SECURITY FRAME: each agent's bubbles get a 1px border in its own colour so
// you can always see WHICH agent is talking (entry agent vs the Blacksmith dev vs a
// specialist). Known kinds get fixed colours; unknown agents get a stable hashed hue.
const AGENT_FRAME = { you: '#1f6feb', 'field-agent': '#7c5cff', root: '#7c5cff', agent: '#7c5cff', blacksmith: '#d2691e', dev: '#d2691e' };
const ENTRY_AGENTS = new Set(['field-agent', 'root', 'agent', '']);
const frameColor = id => {
  if (!id) return AGENT_FRAME['field-agent'];
  if (AGENT_FRAME[id]) return AGENT_FRAME[id];
  let h = 0; for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 62% 60%)`;
};
// Render `text` into `el` with clickable links. Links are built as <a> DOM nodes
// (the URL is set via the .href *property* and shown via textContent — never via
// innerHTML), and the scheme is forced to http(s) by the regex, so no markup- or
// javascript:-injection is possible from agent/user text. Non-link text is plain.
const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>]+)/gi;
const linkify = (el, text) => {
  el.textContent = '';
  const s = text == null ? '' : String(text);
  let i = 0; let m; URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(s))) {
    if (m.index > i) el.appendChild(document.createTextNode(s.slice(i, m.index)));
    let url = m[0]; let trail = '';
    const punct = url.match(/[.,;:!?'"]+$/); // trailing sentence punctuation isn't part of the URL
    if (punct) { trail = punct[0]; url = url.slice(0, -trail.length); }
    while (url.endsWith(')') && !url.includes('(')) { trail = `)${trail}`; url = url.slice(0, -1); } // unbalanced )
    if (url) {
      const a = document.createElement('a');
      a.href = /^www\./i.test(url) ? `https://${url}` : url;
      a.textContent = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      el.appendChild(a);
    } else { trail = m[0]; } // was all punctuation; emit verbatim
    if (trail) el.appendChild(document.createTextNode(trail));
    i = m.index + m[0].length;
  }
  if (i < s.length) el.appendChild(document.createTextNode(s.slice(i)));
  return el;
};
// a per-message timestamp: time-only for today, "Mon D, h:mm" otherwise; full date/time on hover.
const fmtMsgTime = ms => { if (!ms) return ''; const d = new Date(ms); return (d.toDateString() === new Date().toDateString()) ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
const bubble = (who, text, agent, at) => {
  const d = document.createElement('div'); d.className = `msg ${who === 'you' ? 'user' : ''}`;
  const id = who === 'you' ? 'you' : (agent || 'field-agent');
  const col = frameColor(id);
  d.style.borderColor = col; // the 1px security-frame
  const named = who !== 'you' && !ENTRY_AGENTS.has(id);
  const label = who === 'you' ? 'you' : (named ? id : 'agent');
  d.innerHTML = `<div class="who"></div><div class="body"></div>`;
  const w = d.querySelector('.who'); w.textContent = label; if (named) w.style.color = col;
  if (at) { const ts = document.createElement('span'); ts.className = 'msg-time'; ts.style.cssText = 'margin-left:7px;font-size:10px;font-weight:400;color:var(--mut);opacity:.65'; ts.textContent = fmtMsgTime(at); ts.title = new Date(at).toLocaleString(); w.appendChild(ts); }
  // agent replies are Markdown (agents format even unprompted) → render it; user text stays literal (linkify only)
  const bodyEl = d.querySelector('.body');
  if (who === 'you') { linkify(bodyEl, text || '…'); } else { bodyEl.classList.add('md'); renderMarkdown(bodyEl, text || '…'); }
  log.appendChild(d); window.scrollTo(0, document.body.scrollHeight);
  return d.querySelector('.body');
};

// ── action-proposal cards: a destructive action the agent PROPOSED. Rendered by
//    type; only the operator (root cap) sees Confirm/Reject. Confirm fires the
//    real (operator-held) action; the agent never could. ────────────────────────
let isRoot = false;
let heldPowers = new Set(); // the powers this cap holds — gates who may confirm a proposal
const ICON = { 'note-edit': '📝', 'home-assistant': '🏠', email: '✉️', subagent: '🤖', 'system-prompt': '🧠', 'contact-add': '👤', 'contact-edit': '👤', 'spawn-specialist': '🧑‍🔬', 'give-kazputer': '📱', 'kazputer-setting': '📱', 'kazputer-coins': '🪙', 'accept-invite': '🎟️' };
// per-power glyphs for the consent (scope-approval) card; 🔑 is the generic fallback.
const POWER_ICON = { notes: '📓', reference: '📚', web: '🌐', research: '🔎', youtube: '📺', images: '🎨', feed: '📣', phone: '📱', timers: '⏰', browser: '🧭', home: '🏠', vm: '🖥️', host: '🖥️', agents: '🛰️', delegate: '🤝', roles: '🧑‍🔬', homeassistant: '🏠', email: '✉️', subagent: '🤖', contacts: '👥', contact: '📨', specialists: '🧑‍🔬', kazputer: '📱', dietician: '🥗', app: '🧩' };
const powerIcon = p => POWER_ICON[p] || '🔑';
// power → human description, for hover tooltips on every power chip/checkbox. Loaded once from /powers
// (the server POWERS catalog = single source of truth); falls back to the bare name until loaded.
let powerLabels = {};
const loadPowerLabels = async () => { try { const r = await (await fetch('/powers')).json(); for (const c of (r.powers || [])) powerLabels[c.power] = c.label; } catch { /* tooltips fall back to the name */ } };
loadPowerLabels();
const powerTip = p => `${p} — ${powerLabels[p] || 'capability'}`;
// FOLDER-like powers: ones that hold a navigable list of sub-items (the same trees the object-navigator
// browses — see TREE_RPC below). In a powers picker these can be granted WHOLE, or drilled into to SEE
// what's inside; `contacts` additionally lets you mint a single-item read-only share (shareContacts) so
// you can hand off just one contact instead of the whole address book. (`homeassistant`→the `ha` tree.)
const FOLDER_TREE = { contacts: 'contacts', home: 'home', agents: 'agents', timers: 'timers', notes: 'notes', homeassistant: 'ha' };
const isFolderPower = p => Object.hasOwn(FOLDER_TREE, p);
// ── renderPowersPicker — the ONE powers chooser used by every grant surface (chat-add, invite, sub-chat,
// scheduled-agent ring). Default view = only the GRANTED powers as removable chips; "+ Add more" reveals a
// searchable picker of the rest. Folder powers (Contacts, Files, …) are marked 📂 and can be drilled into.
// Reads/writes through a hidden checkbox per power kept in the host (value=power, checked⇔granted) so the
// existing read-sites — querySelectorAll('input:checked'), the ✨ propose-into, the template prefill — all
// keep working unchanged. Cap-hygiene: deals in power NAMES + item handles only; never a swissnum.
//   host: the container element. opts.all: string[] of grantable power names. opts.granted: string[] (or a
//   Set) currently-on. opts.onChange?(grantedNames): called after any add/remove. opts.lockGranted?: keep a
//   power from being removed (true ⇒ no × on chips). opts.itemShare?: true ⇒ offer per-item share when drilling.
const renderPowersPicker = (host, opts) => {
  const all = (opts.all || []).filter((p, i, a) => a.indexOf(p) === i);
  const grantedSet = new Set(opts.granted instanceof Set ? [...opts.granted] : (opts.granted || []));
  const lock = !!opts.lockGranted;
  const fire = () => { if (opts.onChange) try { opts.onChange([...host.querySelectorAll('input[type=checkbox]:checked')].map(x => x.value)); } catch {} };
  // hidden source-of-truth checkboxes (one per power) — what every read-site queries
  let store = host.querySelector('.pp-store');
  host.innerHTML = `<div class="pp-store" style="display:none">${all.map(p => `<input type="checkbox" value="${esc(p)}"${grantedSet.has(p) ? ' checked' : ''}>`).join('')}</div>
    <div class="pp-chips" style="display:flex;flex-wrap:wrap;gap:5px;align-items:center"></div>
    <div class="pp-add" style="display:none;margin-top:7px;border:1px solid var(--edge);border-radius:9px;padding:8px"></div>`;
  store = host.querySelector('.pp-store');
  const chk = p => host.querySelector(`.pp-store input[value="${CSS.escape(p)}"]`);
  const grantedNow = () => all.filter(p => { const c = chk(p); return c && c.checked; });
  const setGranted = (p, on) => { const c = chk(p); if (c) c.checked = on; };
  const chips = host.querySelector('.pp-chips');
  const add = host.querySelector('.pp-add');
  const renderChips = () => {
    const g = grantedNow();
    chips.innerHTML = (g.length ? g.map(p => `<span class="pp-chip" title="${esc(powerTip(p))}">${powerIcon(p)} ${esc(p)}${isFolderPower(p) ? ' 📂' : ''}${lock ? '' : `<button type="button" class="pp-x" data-pprm="${esc(p)}" title="remove ${esc(p)}">×</button>`}</span>`).join('')
      : `<span style="font-size:11px;color:var(--mut)">no powers yet — add some →</span>`)
      + `<button type="button" class="pp-more" title="grant another power">+ Add more</button>`;
    chips.querySelectorAll('[data-pprm]').forEach(b => b.onclick = () => { setGranted(b.dataset.pprm, false); renderChips(); fire(); });
    chips.querySelector('.pp-more').onclick = () => { const open = add.style.display !== 'none'; add.style.display = open ? 'none' : 'block'; if (!open) renderAdd(''); };
  };
  // the "+ Add more" picker: a filter box + the remaining (not-yet-granted) powers, folders flagged + drillable.
  const renderAdd = (q) => {
    const remaining = all.filter(p => !chk(p).checked);
    const f = (q || '').toLowerCase();
    const matches = remaining.filter(p => !f || p.toLowerCase().includes(f) || (powerLabels[p] || '').toLowerCase().includes(f));
    add.innerHTML = `<input class="hdr-sel pp-search" style="max-width:none;width:100%;margin-bottom:7px" placeholder="search powers…" value="${esc(q || '')}">
      <div class="pp-pick" style="display:flex;flex-direction:column;gap:3px;max-height:34vh;overflow:auto">${matches.length ? matches.map(p => `<div class="pp-opt" style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px;border:1px solid var(--edge);border-radius:7px;padding:4px 8px"><span title="${esc(powerTip(p))}">${powerIcon(p)} ${esc(p)}${isFolderPower(p) ? ' <span style="color:var(--mut);font-size:11px">📂 folder</span>' : ''}</span><span style="white-space:nowrap"><button type="button" class="mini" data-ppadd="${esc(p)}">+ grant</button>${isFolderPower(p) ? ` <button type="button" class="mini" data-ppdrill="${esc(p)}">open ›</button>` : ''}</span></div>`).join('') : `<div style="font-size:12px;color:var(--mut)">${remaining.length ? 'no match' : 'every power is already granted'}</div>`}</div>`;
    const s = add.querySelector('.pp-search'); if (s) { s.oninput = () => renderAdd(s.value); if (q !== undefined && q !== '') { s.focus(); s.setSelectionRange(q.length, q.length); } }
    add.querySelectorAll('[data-ppadd]').forEach(b => b.onclick = () => { setGranted(b.dataset.ppadd, true); renderChips(); fire(); renderAdd(s ? s.value : ''); });
    add.querySelectorAll('[data-ppdrill]').forEach(b => b.onclick = () => drillFolder(b.dataset.ppdrill));
  };
  // drill INTO a folder power: list its items (the same tree the object-navigator uses). The user can grant
  // the WHOLE power, or — for contacts — mint a single-item read-only share. (Other folders are grant-whole
  // here: the scoped-cap/ring data model is power-name-granular, and only contacts has a per-item share verb.)
  const drillFolder = async (p) => {
    add.innerHTML = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><button type="button" class="mini pp-back">‹ back</button><b>${powerIcon(p)} ${esc(p)}</b><span style="flex:1"></span><button type="button" class="mini go" data-ppwhole="${esc(p)}">+ grant whole ${esc(p)}</button></div>
      <div class="pp-items" style="font-size:12px;color:var(--mut)">loading…</div>`;
    add.querySelector('.pp-back').onclick = () => renderAdd('');
    add.querySelector('[data-ppwhole]').onclick = () => { setGranted(p, true); renderChips(); fire(); renderAdd(''); };
    const itemsEl = add.querySelector('.pp-items');
    let n; try { n = await treeRpc(FOLDER_TREE[p]); } catch (e) { itemsEl.innerHTML = `<div class="err">${esc(e.message || 'could not list items')}</div>`; return; }
    const kids = (n && (n.children || n.agents || n.entities || n.rooms || n.types)) || [];
    const canShareItem = opts.itemShare && p === 'contacts'; // only contacts has a single-item share verb today
    itemsEl.innerHTML = `<div style="margin-bottom:6px">${kids.length ? `${kids.length} item(s)${canShareItem ? ' — “share one” mints a read-only link to just that contact' : ' inside (grant the whole power above to include them)'}` : 'nothing here'}</div>`
      + `<div style="display:flex;flex-direction:column;gap:3px;max-height:30vh;overflow:auto">${kids.slice(0, 200).map((k, i) => `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;border:1px solid var(--edge);border-radius:7px;padding:3px 8px;color:var(--ink)"><span>${esc(k.label || k.name || k.handle || 'item')}</span>${canShareItem ? `<button type="button" class="mini" data-ppshare="${i}">share one</button>` : ''}</div>`).join('')}</div>`;
    if (canShareItem) itemsEl.querySelectorAll('[data-ppshare]').forEach(b => b.onclick = () => { const k = kids[+b.dataset.ppshare]; mintNode('contacts', k.handle, k.label || k.name || 'contact', true); });
  };
  // external code (the ✨ propose-from-prompt, the garden-scan template prefill) sets .checked on the hidden
  // store inputs directly, then calls this to re-sync the visible chips. Returns the now-granted names.
  host._ppRefresh = () => { renderChips(); return grantedNow(); };
  renderChips();
};
// minimal LCS line-diff for note edits
const renderDiff = (a, b) => {
  const A = String(a).split('\n'), B = String(b).split('\n'), n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) { if (A[i] === B[j]) { out.push(['ctx', A[i]]); i += 1; j += 1; } else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(['del', A[i]]); i += 1; } else { out.push(['add', B[j]]); j += 1; } }
  while (i < n) out.push(['del', A[i++]]); while (j < m) out.push(['add', B[j++]]);
  const sym = { add: '+', del: '-', ctx: ' ' };
  return `<div class="diff">${out.map(([k, l]) => `<span class="${k}">${sym[k]} ${esc(l)}</span>`).join('\n')}</div>`;
};
// FACTORED: a proposal renders through the ProposalCard island (per-type body + security frame + the
// don't-ask toggle live in the island). The HOST owns the per-card state (dontAsk, resolved) + the
// confirm/reject fetch flow, re-rendering via renderInto on each change. mayConfirm gates the buttons.
const renderProposal = p => {
  const card = document.createElement('div'); log.appendChild(card);
  const mayConfirm = isRoot || heldPowers.has(p.power); // confirm only what you hold authority for (typo guard)
  let dontAsk = false; let resolved = '';
  const draw = () => {
    if (window.__fieldIslands && window.__fieldIslands.renderInto) {
      window.__fieldIslands.renderInto('ProposalCard', card, {
        proposal: { id: p.id, type: p.type, title: p.title, detail: p.detail, summary: p.summary },
        icon: ICON[p.type] || '⚠️', accent: frameColor(p.agent), mayConfirm, dontAsk, resolved,
        onConfirm: (id, da) => resolve('/confirm', da),
        onReject: () => resolve('/reject', false),
        onToggleDontAsk: v => { dontAsk = v; draw(); },
      });
    } else { card.className = 'prop msg'; card.innerHTML = `<div class="ptitle">${ICON[p.type] || '⚠️'} <span>${esc(p.title || 'Proposed action')}</span></div><div class="kv">${esc(p.summary || '')}</div>`; }
  };
  const resolve = async (path, da) => {
    resolved = '…'; draw();
    const body = { cap, id: p.id }; if (path === '/confirm' && da) body.dontAskAgain = true;
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json()).catch(e => ({ ok: false, error: e.message }));
    if (r.ok) {
      const extra = r.result?.savedTo ? ' · ' + String(r.result.savedTo).split('/').pop() : (r.result?.drafted ? ' · drafted' : '');
      const rem = r.remembered ? " · won't ask again for this" : '';
      resolved = `✓ ${path === '/confirm' ? 'confirmed' : 'rejected'}${extra}${rem}`;
      if (path === '/confirm') speak('Done.');
    } else { resolved = `⚠ ${r.error || 'failed'}`; setStatus('proposal: ' + (r.error || 'failed')); } // show WHY in the card, don't silently re-flash the buttons
    draw();
  };
  draw(); window.scrollTo(0, document.body.scrollHeight);
};

// requestAccess → an ACTIONABLE Grant card. The agent asked for a capability it lacks; the owner grants
// it to THIS chat in place (rescope, same swiss) with one click — replacing the old passive "I asked the
// owner" notification that had nothing to act on. Server already resolved a verb name → its grantable power.
const renderAccessRequest = a => {
  const cc = curChatObj() || {};
  const card = document.createElement('div'); card.className = 'prop msg';
  card.innerHTML = `<div class="ptitle">🔓 <span>Grant the “${esc(a.power)}” capability to this chat?</span></div><div class="pmeta">${esc(a.label || a.power)}${a.why ? ' — ' + esc(a.why) : ''}</div><div class="pbtns"></div>`;
  const btns = card.querySelector('.pbtns');
  if (!isRoot || !cc.scopedCap) { btns.innerHTML = '<span class="pmeta">only the owner can grant powers (open this chat with your root link)</span>'; }
  else {
    const g = document.createElement('button'); g.className = 'confirm'; g.textContent = 'Grant';
    const d = document.createElement('button'); d.className = 'reject'; d.textContent = 'Not now';
    g.onclick = async () => {
      g.disabled = d.disabled = true;
      const cur = cc.scopedPowers || [];
      await rescopeChat(cc, [...new Set([...cur, a.power])]);
      const granted = (cc.scopedPowers || []).includes(a.power);
      btns.innerHTML = granted
        ? `<span style="color:var(--acc2);font-size:13px">✓ granted “${esc(a.power)}” — ask me again and I’ll continue</span>`
        : '<span style="color:var(--bad);font-size:12px">grant failed — try the powers banner (+ Add)</span>';
      if (granted) renderChatBar();
    };
    d.onclick = () => { card.remove(); };
    btns.append(g, d);
  }
  log.appendChild(card); window.scrollTo(0, document.body.scrollHeight);
};

// ── ASKS: the inline feedback loop. A STRUCTURED, TYPED question an agent raised,
//    answered with type-appropriate controls right here — chat-inline or in the 🔔
//    inbox. Answering a chat-origin ask continues that chat; an off-app ask stages
//    for the single "Done — process my answers" flush to the off-app drain. ────────
let openAsks = [];          // open (unanswered) asks across all origins
let pendingFlushAsks = [];  // off-app asks answered but not yet flushed to the drain
const loadAsks = async () => {
  if (!cap) return;
  try { const r = await (await fetch('/asks/load', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) })).json();
    openAsks = r.asks || []; pendingFlushAsks = r.answeredPending || [];
    renderChatList(); // refresh sidebar red-dot markers for chats awaiting interaction
    // surface (or refresh) inline chat-origin asks for the current chat after load
    if (curTab === 'talk' && openAsks.some(a => a.origin && a.origin.kind === 'chat' && a.origin.chatId === sessionId)) renderTx();
  } catch {}
};
// FACTORED: an ask renders through the AskCard island (typed controls + secret hygiene live in the island).
// The HOST owns the in-progress answers (per ask id) + the answered status, re-rendering via renderInto on
// each change. On submit it POSTs, drops secrets, marks answered, and continues the chat (or stages the
// off-app flush) — exactly as before. The secret answer lives only in askAnswers (JS) + the island's
// masked, uncontrolled password field; on submit it's POSTed then cleared, and the field becomes a chip.
const askAnswers = {}; // askId → { qid: value } (host-owned; secrets cleared on submit)
const buildAskCard = ask => {
  const card = document.createElement('div');
  if (!askAnswers[ask.id]) askAnswers[ask.id] = {};
  let status = '';
  const o = ask.origin || {};
  const hasOrigin = (o.kind === 'chat' && o.chatId && o.chatId !== sessionId) || !!o.doc;
  const openOrigin = () => { if (o.kind === 'chat' && o.chatId) switchChat(o.chatId); else if (o.doc) window.open(`obsidian://open?path=${encodeURIComponent(o.doc)}`, '_blank', 'noopener'); };
  const submit = async () => {
    const answers = { ...askAnswers[ask.id] };
    const r = await fetch('/asks/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, id: ask.id, answers }) }).then(x => x.json()).catch(e => ({ ok: false, error: e.message }));
    if (!r.ok) { setStatus('ask: ' + (r.error || 'failed')); return; }
    for (const q of (ask.questions || [])) if (q.type === 'secret') askAnswers[ask.id][q.id] = ''; // drop secrets from the host map
    status = 'answered'; draw(); // re-render → controls disabled, each secret becomes a "stored securely" chip
    openAsks = openAsks.filter(x => x.id !== ask.id);
    if (o.kind === 'chat' && o.chatId === sessionId) {
      const summary = (ask.questions || []).map(q => `${q.q} → ${q.type === 'secret' ? '(secret provided)' : (Array.isArray(answers[q.id]) ? answers[q.id].join(', ') : (answers[q.id] ?? ''))}`).join('; ');
      sendChat(`Answering your question — ${summary}`);
    } else { await loadAsks(); } // off-app ask staged for the "Done" flush
    refreshBadge();
  };
  const draw = () => {
    if (window.__fieldIslands && window.__fieldIslands.renderInto) {
      window.__fieldIslands.renderInto('AskCard', card, {
        ask: { id: ask.id, title: ask.title, body: ask.body, requestedBy: ask.requestedBy, questions: ask.questions },
        answers: askAnswers[ask.id], status, accent: frameColor(ask.requestedBy),
        onChange: (qid, v) => { askAnswers[ask.id][qid] = v; draw(); },
        onSubmit: submit,
        onOpenOrigin: hasOrigin ? openOrigin : undefined,
      });
    } else { card.className = 'ask msg'; card.innerHTML = `<div class="ask-title">❓ <span>${esc(ask.title || '')}</span></div>`; }
  };
  draw();
  return card;
};
const renderAskCard = ask => { log.appendChild(buildAskCard(ask)); window.scrollTo(0, document.body.scrollHeight); };

// ── DEV VISIBILITY: tasks the agent routed to the Blacksmith show as persistent,
//    dev-framed cards in the chat (so the dev is not opaque) — pending → done+result. ─
let devTasks = [];
const loadDevUpdates = async () => {
  if (!cap || !sessionId) return;
  try { const r = await (await fetch('/dev/updates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, chatId: sessionId }) })).json();
    const next = r.tasks || [];
    if (JSON.stringify(next) !== JSON.stringify(devTasks)) { devTasks = next; renderTx(); } } catch {}
};
const devThreadOpen = {}; // taskId → expanded? (so a thread stays open across re-renders)
const devCard = t => {
  const who = t.to || 'blacksmith'; const col = frameColor(who);
  const d = document.createElement('div'); d.className = 'msg'; d.style.borderColor = col;
  const status = t.status === 'done' ? '✓ done' : t.status === 'error' ? '⚠ error' : '⏳ working…';
  d.innerHTML = `<div class="who"></div><div class="body"></div><div class="dev-thread"></div>`;
  const w = d.querySelector('.who'); w.textContent = `🔨 ${who} · ${status}`; w.style.color = col;
  linkify(d.querySelector('.body'), `${t.task || ''}${t.result ? `\n\n→ ${t.result}` : ''}`);
  const thread = t.thread || [];
  const expanded = !!devThreadOpen[t.id];
  const tc = d.querySelector('.dev-thread');
  // collapsible "↳ reply in thread" — dip into the dev's thread WITHOUT touching the
  // top-level conversation or its context (replies route only to the dev task).
  const toggle = document.createElement('button'); toggle.className = 'dev-thread-toggle'; toggle.style.color = col;
  toggle.textContent = `${expanded ? '▾' : '▸'} reply in thread${thread.length ? ` (${thread.length})` : ''}`;
  toggle.onclick = () => { devThreadOpen[t.id] = !devThreadOpen[t.id]; renderTx(); };
  tc.appendChild(toggle);
  if (expanded) {
    const body = document.createElement('div'); body.className = 'dev-thread-body'; body.style.borderColor = col;
    for (const m of thread) { const mm = document.createElement('div'); mm.className = 'dev-thread-msg'; mm.innerHTML = `<b style="color:${m.role === 'you' ? 'var(--you)' : col}">${m.role === 'you' ? 'you' : esc(who)}</b> `; const sp = document.createElement('span'); linkify(sp, m.text || ''); mm.appendChild(sp); body.appendChild(mm); }
    const row = document.createElement('div'); row.className = 'dev-thread-row';
    const inp = document.createElement('input'); inp.className = 'ask-in'; inp.placeholder = `reply to ${who}…`;
    const send = document.createElement('button'); send.className = 'mini'; send.textContent = 'Send';
    const doReply = async () => { const v = inp.value.trim(); if (!v) return; send.disabled = true; await fetch('/thread/reply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, parent: t.id, chatId: sessionId, text: v }) }).catch(() => {}); inp.value = ''; await loadDevUpdates(); };
    send.onclick = doReply; inp.onkeydown = e => { if (e.key === 'Enter') doReply(); };
    row.append(inp, send); body.appendChild(row); tc.appendChild(body);
  }
  log.appendChild(d);
};

// ── VAD continuous listening + barge-in (unchanged design, now carries the cap) ──
let on = false, mediaStream, audioCtx, analyser, rec, chunks = [], speaking = false;
let voiceFrames = 0, silenceFrames = 0, bargeFrames = 0, capturing = false, busy = false, turn = 0;

const speak = text => new Promise(res => {
  if (!window.speechSynthesis || !text) return res();
  speaking = true; setMic('thinking');
  const u = new SpeechSynthesisUtterance(text);
  u.onend = () => { speaking = false; res(); }; u.onerror = () => { speaking = false; res(); };
  speechSynthesis.cancel(); speechSynthesis.speak(u);
});
const bargeIn = () => {
  bargeFrames = 0; turn += 1;
  try { speechSynthesis.cancel(); } catch {}
  speaking = false; busy = false; capturing = false; voiceFrames = 0; silenceFrames = 0;
  fetch('/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }) }).catch(() => {});
  setStatus('… go ahead'); setMic('listening');
};

// ── persistent per-response trace strip (E6): a full-width neon row of THIS turn's tool
//    calls, shown ABOVE each agent response; click → the full 3D trace. (roadmap §7 E6) ──
const STEP_ICON = { research: '🔎', delegateTask: '🤝', employ: '🧑‍🔬', askSpecialist: '🧑‍🔬', generateImage: '🎨', searchNotes: '📓', readNote: '📓', fetchUrl: '🌐', browse: '🌐', consult: '📚', pushFeed: '📣', pushPhone: '📱', transcribeYoutube: '📺' };
// one step in the expanded "reasoning signature" — name + (failed?) + ▸ call / ◂ result, children indented.
// All step data is set via textContent (never innerHTML) — the call/result is agent/tool output (untrusted).
const SIG_MAX = 500;
// defense-in-depth cap scrub at render (the server safeText-scrubs the main path, but the scoper trace
// stringifies separately — never render a #cap / share token / bare swissnum that slipped through).
const scrubCap = s => String(s == null ? '' : s).replace(/#cap=[0-9a-fA-F]{16,}/g, '#cap=«redacted»').replace(/#k=[\w-]{16,}/g, '#k=«redacted»').replace(/#agent=[\w-]{8,}/g, '#agent=«redacted»').replace(/\b[0-9a-f]{32}\b/g, '«swissnum»');
const stepRow = (s, depth) => {
  const row = document.createElement('div'); row.style.cssText = `margin:3px 0;padding-left:${depth * 14}px`;
  const head = document.createElement('div'); head.style.cssText = `font:600 12px ui-monospace,Menlo,Consolas,monospace;color:${s.ok === false ? 'var(--trace-bad)' : 'var(--trace-ok)'}`;
  head.textContent = `${STEP_ICON[s.name] || '⚙'} ${s.name}${s.ok === false ? '  ✗ failed' : ''}`;
  row.appendChild(head);
  const call = s.call || s.detail || '';
  if (call) { const d = document.createElement('div'); d.style.cssText = 'font-size:11px;color:var(--trace-call);white-space:pre-wrap;word-break:break-word;margin:1px 0 0 16px;max-height:64px;overflow:auto'; d.textContent = '▸ ' + scrubCap(call).slice(0, SIG_MAX); row.appendChild(d); }
  if (s.result) { const r = document.createElement('div'); r.style.cssText = 'font-size:11px;color:var(--trace-result);white-space:pre-wrap;word-break:break-word;margin:1px 0 0 16px;max-height:64px;overflow:auto'; r.textContent = '◂ ' + scrubCap(s.result).slice(0, SIG_MAX); row.appendChild(r); }
  (Array.isArray(s.children) ? s.children : []).forEach(c => row.appendChild(stepRow(c, depth + 1)));
  return row;
};
// the per-message trace. Collapsed = a compact glyph strip (with a tiny symbol KEY on hover). Clicking it
// (or its message — see wireMsgTrace) GROWS it inline into the full reasoning SIGNATURE above the answer.
const traceStrip = steps => {
  const wrap = document.createElement('div'); wrap.className = 'trace-strip'; wrap.setAttribute('data-component-id', 'island-trace'); wrap.setAttribute('data-component-name', 'Trace view (3D)');
  let expanded = false;
  const legend = 'Symbols: ' + [...new Set(steps.map(s => `${STEP_ICON[s.name] || '⚙'} ${s.name}`))].slice(0, 12).join(' · ');
  const draw = () => {
    wrap.replaceChildren();
    const lbl = document.createElement('span'); lbl.className = 'ts-label'; lbl.style.cursor = 'pointer';
    lbl.textContent = `⊿ trace · ${steps.length} ${expanded ? '▾' : '▸'}`;
    lbl.title = `Reasoning signature for this answer. ${legend}\n(click to ${expanded ? 'collapse' : 'grow it inline'}; ⊿3D opens the 3D trace)`;
    lbl.onclick = e => { e.stopPropagation(); toggle(); };
    wrap.appendChild(lbl);
    const d3 = document.createElement('span'); d3.className = 'tn'; d3.textContent = '⊿3D'; d3.title = 'Open the 3D trace'; d3.style.cursor = 'pointer'; d3.onclick = e => { e.stopPropagation(); togglePendantFs(); };
    wrap.appendChild(d3);
    if (!expanded) {
      for (const s of steps) { const n = document.createElement('span'); n.className = 'tn' + (s.ok === false ? ' bad' : ''); const kids = Array.isArray(s.children) && s.children.length ? ` ·${s.children.length}` : ''; n.textContent = `${STEP_ICON[s.name] || '⚙'} ${s.name}${kids}`; n.title = `${s.name}${s.ok === false ? ' (failed)' : ''}${s.detail ? ' — ' + scrubCap(s.detail).slice(0, 200) : ''}`; wrap.appendChild(n); }
    } else {
      const sig = document.createElement('div'); sig.className = 'trace-sig'; sig.style.cssText = 'flex-basis:100%;width:100%;margin-top:6px;padding:8px 10px;background:var(--trace-bg);border:1px solid var(--trace-edge);border-radius:8px;max-height:44vh;overflow:auto';
      steps.forEach(s => sig.appendChild(stepRow(s, 0)));
      wrap.appendChild(sig);
    }
  };
  const toggle = () => { expanded = !expanded; draw(); };
  wrap.toggleSig = toggle;
  draw();
  return wrap;
};
// A compact, per-message TRACE GEOMETRY: the reasoning trace as a neon node-TREE (the agent root octahedron
// + each tool call as a labeled node, coloured by success). A node with children (research, delegate, …) is
// collapsed by default and FANS OUT VERTICALLY on hover: its constituent sub-steps slide in as their own
// labeled, clickable rows, each itself hover-expandable + tap-to-inspect (recursive). Tap a node → its call &
// result modal; tap an expandable node to fan it out (tap again to inspect); tap the core → the full 3D trace.
// Lightweight SVG (no per-message WebGL); shown under EVERY agent message. Hover state is re-rendered via
// event delegation on the stable <svg>, so it survives the per-hover relayout.
const NS_SVG = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => { const e = document.createElementNS(NS_SVG, tag); for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]); return e; };
// REUSABLE tool-call content viz: name + the EXACT call (cyan) and result (amber) — the same two facets the 3D
// renderer unfurls as satellites (SAT.call/SAT.result), but as a DOM modal. Clicking one tool in the SVG trace
// opens this for THAT step (no longer all-or-nothing into the WebGL view).
const fmtTrace = v => { if (v == null || v === '') return ''; if (typeof v === 'string') { try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; } } try { return JSON.stringify(v, null, 2); } catch { return String(v); } };
const toolCallDetailHtml = s => {
  const call = fmtTrace(s.call != null ? s.call : s.detail);
  const result = fmtTrace(s.result != null ? s.result : (s.resultText != null ? s.resultText : s.info));
  const kids = _arr(s.children);
  const pre = (txt, col) => `<pre style="white-space:pre-wrap;word-break:break-word;max-height:38vh;overflow:auto;background:rgba(0,0,0,.25);border:1px solid var(--edge);border-left:3px solid ${col};border-radius:7px;padding:8px 10px;margin:4px 0 10px;font:12px ui-monospace,Menlo,Consolas,monospace;color:var(--ink)">${esc(txt)}</pre>`;
  return `<div style="text-align:left;width:520px;max-width:88vw">
    <div style="font-weight:600;font-size:14px;margin-bottom:8px;font-family:ui-monospace,Menlo,Consolas,monospace;color:${s.ok === false ? 'var(--bad,#ff9e9e)' : 'var(--acc,#7c5cff)'}">${s.ok === false ? '⚠️' : '⚙'} ${esc(s.name || 'tool')}${s.ok === false ? ' · failed' : ''}</div>
    <div style="font-size:11px;color:#39c5cf;letter-spacing:.04em">CALL</div>${call ? pre(call, '#39c5cf') : '<div class="pmeta" style="margin-bottom:8px">no call args recorded</div>'}
    <div style="font-size:11px;color:#d29922;letter-spacing:.04em">RESULT</div>${result ? pre(result, '#d29922') : '<div class="pmeta" style="margin-bottom:8px">no result recorded</div>'}
    ${kids.length ? `<div style="font-size:11px;color:var(--mut);letter-spacing:.04em">SUB-CALLS (${kids.length})</div><div style="font-size:12px;margin-top:3px">${kids.map(c => `• ${esc(c.name || 'call')}${c.ok === false ? ' ⚠️' : ''}`).join('<br>')}</div>` : ''}</div>`;
};
const openToolModal = s => { try { showModal(toolCallDetailHtml(s)); } catch { /* */ } };
const traceGeometry = steps => {
  const cv = (n, d) => (getComputedStyle(document.documentElement).getPropertyValue(n).trim() || d);
  const acc = cv('--acc', '#7c5cff'), ok = cv('--trace-ok', '#8fd0a8'), bad = cv('--trace-bad', '#ff9e9e'), edge = cv('--edge', '#30363d');
  const W = 460, uid = 'tg' + Math.random().toString(36).slice(2, 8);
  const svg = svgEl('svg', { viewBox: '0 0 460 80', class: 'trace-geo', preserveAspectRatio: 'xMidYMin meet', width: '100%' });
  svg.style.cssText = 'display:block;width:100%;height:auto';
  const defs = svgEl('defs', {}); const f = svgEl('filter', { id: uid, x: '-60%', y: '-60%', width: '220%', height: '220%' });
  f.appendChild(svgEl('feGaussianBlur', { stdDeviation: '1.5', result: 'b' }));
  const mg = svgEl('feMerge', {}); mg.appendChild(svgEl('feMergeNode', { in: 'b' })); mg.appendChild(svgEl('feMergeNode', { in: 'SourceGraphic' })); f.appendChild(mg);
  defs.appendChild(f); svg.appendChild(defs);
  const content = svgEl('g', {}); svg.appendChild(content);
  const clip = (s, n) => { s = String(s || ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
  const diamond = (cx, cy, r, col, glow) => svgEl('polygon', { points: `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`, fill: 'none', stroke: col, 'stroke-width': glow ? 1.5 : 1, filter: glow ? `url(#${uid})` : null });

  // ── the trace as a TREE: each step + its (possibly nested) children, with stable index-path keys ──
  const build = (list, prefix) => _arr(list).map((s, i) => { const key = prefix ? `${prefix}.${i}` : `${i}`; return { key, step: s, kids: build(s.children, key) }; });
  const tree = build(steps, '');
  const nodeByKey = {}; (function walk(ns) { ns.forEach(n => { nodeByKey[n.key] = n; walk(n.kids); }); })(tree);

  // open = the path of keys currently REVEALED (the hovered node + its ancestors). Children fan out
  // VERTICALLY only for nodes on this path → hovering research expands its searches, hovering a search
  // expands its children, and so on. A single mouseleave collapses back to the top-level row.
  const open = new Set();
  let prevVisible = new Set(); // for the reveal animation (fade + slide in newly-shown rows)
  const ancestorsOf = key => { const p = key.split('.'), out = []; for (let i = 1; i < p.length; i += 1) out.push(p.slice(0, i).join('.')); return out; };
  const setHover = key => { open.clear(); if (key) { open.add(key); ancestorsOf(key).forEach(k => open.add(k)); } render(); };

  const ROW = 18, rootX = 22, topPad = 15, nodeX = depth => 60 + depth * 22;
  const layout = () => {
    const rows = []; const rootPos = { x: rootX, y: 0 };
    const add = (n, depth, parentPos) => { const pos = { x: nodeX(depth), y: 0 }; rows.push({ n, depth, pos, parentPos }); if (open.has(n.key)) n.kids.forEach(k => add(k, depth + 1, pos)); };
    tree.forEach(n => add(n, 0, rootPos));
    rows.forEach((r, i) => { r.pos.y = topPad + i * ROW; });
    rootPos.y = rows.length ? (rows[0].pos.y + rows[rows.length - 1].pos.y) / 2 : topPad + 8;
    return { rows, rootPos, H: Math.max(60, topPad * 2 + rows.length * ROW) };
  };

  function render() {
    const { rows, rootPos, H } = layout();
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    content.replaceChildren();
    const nowVisible = new Set(rows.map(r => r.n.key));
    const firstPaint = prevVisible.size === 0;

    // root octahedron — tapping the CORE opens the full 3D trace
    const rootG = svgEl('g', { 'data-root': '1', style: 'cursor:pointer' });
    const rt = svgEl('title', {}); rt.textContent = 'Open the full 3D trace'; rootG.appendChild(rt);
    rootG.appendChild(diamond(rootPos.x, rootPos.y, 11, acc, true));
    rootG.appendChild(diamond(rootPos.x, rootPos.y, 5, acc, false));
    content.appendChild(rootG);

    rows.forEach(r => {
      const { n, depth } = r, { x, y } = r.pos, p = r.parentPos, s = n.step, hasKids = n.kids.length;
      const col = s.ok === false ? bad : (hasKids ? acc : ok);
      const g = svgEl('g', { 'data-nodekey': n.key, class: 'tg-node', style: 'cursor:pointer' });
      const tt = svgEl('title', {}); tt.textContent = `${s.name || 'tool'}${s.ok === false ? ' (failed)' : ''}${hasKids ? ` — ${n.kids.length} sub-step(s); hover to fan out` : ' — tap for its call & result'}${s.detail ? '\n' + scrubCap(s.detail).slice(0, 160) : ''}`; g.appendChild(tt);
      // connector from the parent (root or the parent node) — a smooth cubic so children "fan" off it
      g.appendChild(svgEl('path', { d: `M ${p.x} ${p.y} C ${(p.x + x) / 2} ${p.y}, ${(p.x + x) / 2} ${y}, ${x} ${y}`, fill: 'none', stroke: edge, 'stroke-width': 0.9, opacity: 0.6 }));
      // wide invisible hit target across the row → easy hover + tap
      g.appendChild(svgEl('rect', { x: x - 9, y: y - 8.5, width: W - (x - 9) - 4, height: 17, fill: 'transparent' }));
      g.appendChild(diamond(x, y, hasKids ? 5.2 : 4.3, col, true));
      const lbl = svgEl('text', { x: x + 9, y: y + 3.3, 'font-size': 9.5, fill: col, 'font-family': 'ui-monospace,Menlo,Consolas,monospace' });
      lbl.textContent = `${hasKids ? (open.has(n.key) ? '▾ ' : '▸ ') : ''}${STEP_ICON[s.name] || '⚙'} ${clip(s.name, 32)}${hasKids ? ` ·${n.kids.length}` : ''}`;
      g.appendChild(lbl);
      // reveal animation: a newly-shown row fades + slides in, staggered by sibling index → a fan-out
      if (!firstPaint && !prevVisible.has(n.key)) {
        g.style.opacity = '0'; g.style.transition = 'opacity .24s ease, transform .24s cubic-bezier(.2,.8,.2,1)'; g.style.transform = 'translateX(-7px)';
        const sib = Number(n.key.split('.').pop()) || 0;
        setTimeout(() => { g.style.opacity = '1'; g.style.transform = 'none'; }, 25 + sib * 42);
      }
      content.appendChild(g);
    });
    prevVisible = nowVisible;
  }

  // event delegation on the stable <svg> (survives every re-render): hover opens the node's path;
  // tap an expandable node fans it out, tap again (or tap a leaf) inspects it; tap the core → 3D.
  let lastHover = null;
  svg.addEventListener('mouseover', e => { const g = e.target.closest('[data-nodekey]'); if (!g) return; const k = g.getAttribute('data-nodekey'); if (k === lastHover) return; lastHover = k; setHover(k); });
  svg.addEventListener('mouseleave', () => { lastHover = null; setHover(null); });
  svg.addEventListener('click', e => {
    const gn = e.target.closest('[data-nodekey]');
    if (gn) { e.stopPropagation(); const n = nodeByKey[gn.getAttribute('data-nodekey')]; if (!n) return; if (n.kids.length && !open.has(n.key)) setHover(n.key); else openToolModal(n.step); return; }
    if (e.target.closest('[data-root]')) { e.stopPropagation(); ensurePendant().then(p => { try { pendantWrap.classList.remove('hide'); p.setVisible(true); p.showSteps(_arr(steps)); if (!pendantFs) togglePendantFs(); } catch { /* */ } }).catch(() => {}); }
  });

  render();
  return svg;
};
// test seam: exercise the REAL trace renderer headlessly (pure view fn — renders public trace data, holds no
// authority). Off in production; only bound when the page is opened with ?tracetest=1 (see shape/trace tests).
if (typeof location !== 'undefined' && /[?&]tracetest=1\b/.test(location.search)) {
  window.__traceGeometry = traceGeometry;
  // open the 3D pendant on synthetic steps (no LLM turn) so the hyper-octahedron body can be screenshotted.
  window.__openPendant = async (steps, fs) => { try { const p = await ensurePendant(); if (pendantWrap) { pendantWrap.classList.remove('hide'); if (fs) pendantWrap.classList.add('fs'); } p.setVisible(true); if (fs && p.resize) p.resize(); p.showSteps(Array.isArray(steps) ? steps : []); return true; } catch (e) { return String((e && e.message) || e); } };
}
// clicking an agent MESSAGE grows its reasoning signature (without clobbering links/controls/text-selection).
const wireMsgTrace = (b, trace) => {
  if (!b || !trace) return; b.style.cursor = 'pointer'; if (!b.title) b.title = 'Click to grow the reasoning signature';
  b.addEventListener('click', e => {
    if (e.target.closest && e.target.closest('a,button,img,input,textarea,select,label,.gw,iframe')) return; // don't clobber interactive content
    try { if (window.getSelection && String(window.getSelection()).trim()) return; } catch { /* */ } // don't clobber a text selection
    trace.toggleSig();
  });
};

// render an agent reply (answer + tools + images + proposal cards)
// BREAK OUT a custom component into a standalone, versioned module: save its source + declared cells to
// component-git, then open its own page (/c/<id>). "Sharing converts a message into a module."
const breakOutComponent = async spec => {
  if (!spec || spec.type !== 'component') return;
  const name = (window.prompt('Name this component (it becomes a versioned, standalone module):', '') || '').trim();
  if (!name) return;
  setStatus('saving component…');
  let r; try { r = await (await fetch('/components/break-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, name, source: spec.source, cells: spec.cells || [] }) })).json(); }
  catch (e) { setStatus('break out: ' + e.message); return; }
  if (!r || !r.ok) { setStatus('break out: ' + ((r && r.error) || 'failed')); return; }
  setStatus(`🧩 “${r.name}” saved as a component — opening its own page`);
  try { window.open(r.url, '_blank', 'noopener'); } catch { /* */ } // its standalone home (reads your cap from this origin)
};
// SHARE a component with someone else: save it (get an id), mint a LEAST-AUTHORITY token (subscribe-only to
// its declared cells, read-only — not a cap), and COPY the recipient link. cap-hygiene: the token rides in
// the link's fragment; we copy it (never render it to the page).
const schemeLabel = (s, c) => s === 'expires' ? `${c.hours}h time-boxed` : s === 'allowance' ? `$${(c.total / 1e6).toFixed(2)} allowance` : 'free';
const shareOutComponent = async spec => {
  if (!spec || spec.type !== 'component') return;
  const inp = 'background:#0a0c16;color:#e6edf3;border:1px solid #2b3350;border-radius:6px;padding:4px 6px;font:inherit';
  showModal(`<div style="text-align:left;min-width:300px">
    <b>🔗 Share this component</b>
    <div style="font-size:12px;color:var(--mut);margin:6px 0">The link grants live, read-only access to ONLY this component’s declared data — it isn’t a cap (can’t open a chat or reach anything else), and it’s revocable.</div>
    <input id="shr-name" placeholder="name (e.g. Front door)" style="width:100%;margin:6px 0;${inp}">
    <div style="margin:10px 0 4px;font-weight:600;font-size:12px">Access / charge</div>
    <label style="display:block;font-size:13px;margin:3px 0"><input type="radio" name="shr-scheme" value="free" checked> Free — anyone with the link</label>
    <label style="display:block;font-size:13px;margin:3px 0"><input type="radio" name="shr-scheme" value="expires"> Time-boxed — expires after <input id="shr-hours" type="number" value="24" min="1" style="width:54px;${inp}"> hours</label>
    <label style="display:block;font-size:13px;margin:3px 0"><input type="radio" name="shr-scheme" value="allowance"> Allowance — $<input id="shr-total" type="number" value="1.00" step="0.10" min="0.01" style="width:62px;${inp}"> total, $<input id="shr-per" type="number" value="0.01" step="0.01" min="0.001" style="width:62px;${inp}"> per open</label>
    <button class="mini" id="shr-go" style="margin-top:10px">Create share link</button>
    <div id="shr-msg" style="font-size:12px;color:var(--mut);margin-top:6px"></div>
  </div>`);
  $('shr-go').onclick = async () => {
    const name = ($('shr-name').value || '').trim(); const msg = $('shr-msg'); if (!name) { msg.textContent = 'name it first'; return; }
    const scheme = (document.querySelector('input[name=shr-scheme]:checked') || {}).value || 'free';
    const charge = { scheme };
    if (scheme === 'expires') charge.hours = Math.max(1, Number($('shr-hours').value) || 24);
    if (scheme === 'allowance') { charge.total = Math.max(10000, Math.round((Number($('shr-total').value) || 1) * 1e6)); charge.perOpen = Math.max(1000, Math.round((Number($('shr-per').value) || 0.01) * 1e6)); }
    $('shr-go').disabled = true; msg.textContent = 'creating…';
    let bo; try { bo = await (await fetch('/components/break-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, name, source: spec.source, cells: spec.cells || [] }) })).json(); } catch (e) { msg.textContent = 'error: ' + e.message; $('shr-go').disabled = false; return; }
    if (!bo || !bo.ok) { msg.textContent = (bo && bo.error) || 'failed'; $('shr-go').disabled = false; return; }
    let sh; try { sh = await (await fetch('/components/share', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, id: bo.id, charge }) })).json(); } catch (e) { msg.textContent = 'error: ' + e.message; $('shr-go').disabled = false; return; }
    if (!sh || !sh.ok) { msg.textContent = (sh && sh.error) || 'failed'; $('shr-go').disabled = false; return; }
    const ok = await copyToClipboard(location.origin + sh.url); // cap-hygiene: copy the link (token in fragment), never render it
    closeModal();
    setStatus(ok ? `🔗 ${schemeLabel(scheme, charge)} share link copied — live, read-only, revocable` : 'minted the share, but copy failed (check clipboard permission)');
  };
};
// copy without rendering the secret to the DOM (works on insecure-context http via an off-screen textarea).
const copyToClipboard = async t => {
  try { if (navigator.clipboard && location.protocol === 'https:') { await navigator.clipboard.writeText(t); return true; } } catch { /* */ }
  try { const ta = document.createElement('textarea'); ta.value = t; ta.style.cssText = 'position:fixed;left:-9999px;opacity:0'; document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok; } catch { return false; }
};
// ── APPLET WINDOW-MANAGER (W1): the field UI as an OS. An interactive component can EXPAND to fill the
//    chat area (replacing the transcript) and MINIMIZE back to its inline widget — the minimize IS the
//    re-entry to the conversation. FLIP animation (no iframe reparent → no reload → in-app state preserved);
//    a placeholder holds the inline slot; the expanded state is RETAINED per chat (re-applied on return).
let expandedApplet = {}; // sessionId → appletKey (the component currently filling this chat's area)
const chatAreaRect = () => {
  const header = document.querySelector('header'), composer = $('composer'), lg = $('log');
  const top = (header ? header.getBoundingClientRect().bottom : 0) + 6;
  const bottom = composer ? composer.getBoundingClientRect().top : innerHeight;
  const lr = lg.getBoundingClientRect();
  return { left: lr.left, top, width: lr.width, height: Math.max(180, bottom - top - 6) };
};
const setExpandBtn = (wrap, expanded) => { const b = wrap.querySelector('.gw-expand'); if (!b) return; b.textContent = expanded ? '⤡ minimize' : '⤢ expand'; b.title = expanded ? 'Minimize back into the conversation' : 'Fill the chat area with this app'; };
const expandApplet = (wrap, opts = {}) => {
  if (!wrap || wrap.classList.contains('applet-expanded')) return;
  const first = wrap.getBoundingClientRect();
  const ph = document.createElement('div'); ph.className = 'applet-ph'; ph.style.cssText = `height:${first.height}px;margin:8px 0`; wrap._ph = ph; wrap.parentNode.insertBefore(ph, wrap);
  const t = chatAreaRect();
  wrap.classList.add('applet-expanded');
  Object.assign(wrap.style, { position: 'fixed', zIndex: '8000', margin: '0', left: `${t.left}px`, top: `${t.top}px`, width: `${t.width}px`, height: `${t.height}px`, display: 'flex', flexDirection: 'column' });
  const iframe = wrap.querySelector('iframe'); if (iframe) { iframe.dataset.h0 = iframe.style.height; iframe.style.flex = '1'; iframe.style.height = 'auto'; }
  setExpandBtn(wrap, true); expandedApplet[sessionId] = wrap.dataset.appletKey;
  if (opts.instant) return;
  wrap.style.transformOrigin = 'top left';
  wrap.style.transform = `translate(${first.left - t.left}px,${first.top - t.top}px) scale(${first.width / t.width},${first.height / t.height})`;
  wrap.getBoundingClientRect(); // reflow
  requestAnimationFrame(() => { wrap.style.transition = 'transform .3s cubic-bezier(.22,1,.36,1)'; wrap.style.transform = 'none'; });
  const done = () => { wrap.removeEventListener('transitionend', done); wrap.style.transition = ''; }; wrap.addEventListener('transitionend', done); setTimeout(done, 360);
};
const minimizeApplet = wrap => {
  if (!wrap || !wrap.classList.contains('applet-expanded')) return;
  const ph = wrap._ph; const back = ph ? ph.getBoundingClientRect() : wrap.getBoundingClientRect(); const cur = wrap.getBoundingClientRect();
  delete expandedApplet[sessionId];
  wrap.style.transformOrigin = 'top left'; wrap.style.transition = 'transform .3s cubic-bezier(.22,1,.36,1)';
  requestAnimationFrame(() => { wrap.style.transform = `translate(${back.left - cur.left}px,${back.top - cur.top}px) scale(${back.width / cur.width},${back.height / cur.height})`; });
  const restore = () => {
    wrap.removeEventListener('transitionend', restore);
    wrap.classList.remove('applet-expanded');
    for (const p of ['position', 'zIndex', 'margin', 'left', 'top', 'width', 'height', 'display', 'flexDirection', 'transform', 'transition', 'transformOrigin']) wrap.style[p] = '';
    const iframe = wrap.querySelector('iframe'); if (iframe) { iframe.style.flex = ''; iframe.style.height = iframe.dataset.h0 || ''; }
    if (ph) ph.remove(); wrap._ph = null; setExpandBtn(wrap, false);
  };
  wrap.addEventListener('transitionend', restore); setTimeout(restore, 360);
};
const toggleApplet = (spec, wrap) => { if (wrap.classList.contains('applet-expanded')) minimizeApplet(wrap); else expandApplet(wrap); };
// after a transcript (re)render: re-apply this chat's retained expanded applet (instantly, no animation).
const reapplyExpanded = () => { const key = expandedApplet[sessionId]; if (!key) return; const wrap = log.querySelector(`.gw-component[data-applet-key="${key}"]`); if (wrap && !wrap.classList.contains('applet-expanded')) expandApplet(wrap, { instant: true }); };
addEventListener('keydown', e => { if (e.key === 'Escape') { const w = log.querySelector('.gw-component.applet-expanded'); if (w) minimizeApplet(w); } }); // Esc minimizes

const renderAgentResponse = r => {
  if (_arr(r.steps).length) log.appendChild(traceGeometry(r.steps)); // the SVG trace sits ABOVE the message (tap it for the 3D); the 3D pendant is reserved for the live "working" animation
  const body = bubble('agent', r.answer || '…', r.agentId, Date.now());
  if (r.toolsUsed?.length) { const e = document.createElement('div'); e.className = 'tools'; e.textContent = '⚙ ' + r.toolsUsed.join(', '); body.parentNode.appendChild(e); }
  ((r.images && r.images.length ? r.images : (r.imageUrls || [])) || []).forEach(src => { const im = document.createElement('img'); im.src = src; body.appendChild(im); }); // data-URLs in the moment; durable /uploads urls as fallback (e.g. the share-post path)
  if (Array.isArray(r.ui) && r.ui.length) renderWidgets(body, r.ui, { cap: chatCap(), onChoice: t => sendChat(t), onBreakOut: breakOutComponent, onShareOut: shareOutComponent, onExpand: toggleApplet }); // live/interactive widgets (countdowns, live status, choices, custom components)
  (r.autoFired || []).forEach(a => { const e = document.createElement('div'); e.className = 'autofired'; e.textContent = `✓ auto-confirmed: ${a.title}${a.ok === false ? ' (failed)' : ''}`; body.parentNode.appendChild(e); }); // fired via a "don't ask again" rule
  (r.proposals || []).forEach(renderProposal); // destructive actions show as confirmable cards
  (r.accessRequests || []).forEach(renderAccessRequest); // requestAccess → an actionable Grant card
  (r.asks || []).forEach(a => { openAsks.unshift(a); renderAskCard(a); }); // typed questions → answerable cards
  if (r.asks?.length) refreshBadge();
  refreshTraceApp(); // push the new turn to the iframe trace app if it's open
  window.scrollTo(0, document.body.scrollHeight);
  schedulePendantPosition(); // the answer bubble shifted layout — re-anchor the pendant
};

// ── prepaid inference budget (toll-bridge, Inc 1) ─────────────────────────────
// The header chip shows THIS conversation's remaining allowance; it updates from every
// /chat response + on chat switch. When the server returns { exhausted:true } it did so
// WITHOUT calling the model — we render a static Top-up / Abandon card (no agent message).
const fmtUSD = micro => { const usd = Math.max(0, micro || 0) / 1e6; return usd >= 1 ? '$' + usd.toFixed(2) : usd >= 0.01 ? '$' + usd.toFixed(3) : '$' + usd.toFixed(5); };
const budgetChip = $('budget');
const updateBudgetChip = (remaining, allowance) => {
  if (!budgetChip) return;
  if (remaining == null) { budgetChip.classList.add('hide'); return; }
  budgetChip.classList.remove('hide');
  budgetChip.textContent = `🪙 ${fmtUSD(remaining)}`;
  budgetChip.title = `Inference allowance left in this conversation: ${fmtUSD(remaining)} of ${fmtUSD(allowance)}. Tap to top up.`;
  budgetChip.classList.toggle('low', remaining <= 0 || (allowance > 0 && remaining / allowance < 0.1));
};
const refreshBudget = async () => {
  if (!cap || !budgetChip) return;
  try { const b = await (await fetch('/budget', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, purseCap: chatCap(), sessionId }) })).json(); if (b && !b.error) updateBudgetChip(b.remaining, b.allowance); } catch {}
};
if (budgetChip) budgetChip.onclick = async () => {
  const v = window.prompt('Top up this conversation by how many dollars?', '1.00');
  if (v == null) return;
  const amount = Math.round(parseFloat(v) * 1e6);
  if (!(amount > 0)) return;
  try {
    const b = await (await fetch('/budget/topup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, purseCap: chatCap(), sessionId, amount }) })).json();
    if (b && !b.error) { updateBudgetChip(b.remaining, b.allowance); await resumeIfPending(sessionId); } // top up AND resume a stalled turn
    else if (b && b.error) setStatus('top-up: ' + b.error);
  } catch (e) { setStatus('top-up failed: ' + e.message); }
};
// retry the SAME turn after a top-up (no new user bubble — the user's message is already shown)
const retryTurn = async (payload, spoken, opts = {}) => {
  setStatus(opts.resume ? 'resuming…' : 'thinking…');
  try {
    await pendantBegin(payload.text || '');
    // resume:true → the server CONTINUES the topped-up turn from its saved in-flight transcript (it does NOT
    // re-run the reasoning/tool-use already done); if the server no longer has it, it transparently full-reruns.
    const body = opts.resume ? { ...payload, resume: true } : payload;
    const r = await (await fetch('/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    if (r.error) { if (r.retryable || r.llmError) renderRetryableError(r.error, payload, spoken); else setStatus('chat: ' + r.error); return; } // provider error → transient retry card, not a stuck status
    if (r.exhausted) { updateBudgetChip(r.remaining, r.allowance); renderExhausted(payload, spoken); return; }
    renderAgentResponse(r);
    pushTx('agent', r.answer || '', { tools: r.toolsUsed || [], images: r.images || [], imageUrls: r.imageUrls || [], steps: r.steps || [], agent: r.agentId, ui: r.ui || [] });
    pendantEnd(r.steps || []);
    updateBudgetChip(r.remaining, r.allowance);
    if (spoken) await speak(r.answer || '');
  } catch (e) { setStatus('error: ' + e.message); }
  finally { try { pendantES && pendantES.close(); } catch {} pendantLive = false; if (pendant) pendant.finish(); setStatus(on ? 'listening…' : ''); }
};
// A chat that ran out of allowance retains its UNANSWERED turn so that ANY top-up path — the
// exhausted card, the 🪙 chip, or a payment — RESUMES it (not just the card button). Keyed by the
// turn's own sessionId so switching chats can't resume the wrong one. If nothing is retained in
// memory (e.g. after a page reload) but the visible chat's last entry is an unanswered user message,
// we reconstruct the turn from the transcript — so a chat stalled in a PRIOR session also resumes.
const pendingResume = {}; // sessionId → { payload, spoken }
const INTERRUPT_RE = /^⚠️ The run was interrupted/; // a drop left this marker as the (agent) tail — the user turn beneath it still needs answering
const stalledTurnFromTx = () => {
  let i = activeTx.length - 1;
  if (activeTx[i] && activeTx[i].who === 'agent' && INTERRUPT_RE.test(activeTx[i].text || '')) i -= 1; // look PAST a dead interrupt marker to the unanswered user turn it buried
  const m = activeTx[i];
  if (!(m && m.who === 'you' && (m.text || '').trim())) return null; // nothing pending
  const history = activeTx.slice(0, i).filter(x => x && (x.text || '').trim()).map(x => ({ role: x.who === 'you' ? 'user' : 'assistant', content: String(x.text) })).slice(-24);
  return { payload: { sessionId, text: (m.text || '').trim(), cap: chatCap(), model: chatModel(), agent: chatAgent(), history }, spoken: false };
};
const resumeIfPending = async (sid, { reconstruct = false } = {}) => {
  let pend = pendingResume[sid];
  // Rebuilding a "stalled" turn from the transcript is ONLY safe for reload/reconnect recovery (no live run).
  // On a TOP-UP path the agent may still be RUNNING — its in-flight user message is the transcript tail, and
  // reconstructing+retrying it would fire a second /chat that ABORTS the live run (the "topping up resets the
  // task" bug). So topup/payment pass reconstruct=false: they resume ONLY an explicitly-exhausted turn
  // (renderExhausted records pendingResume[sid]); a still-running turn is left completely untouched.
  if (!pend && reconstruct && sid === sessionId) pend = stalledTurnFromTx();
  if (!pend) return false;
  if (sid !== sessionId) { pendingResume[sid] = pend; return false; } // not the chat in view — keep it for when it is
  delete pendingResume[sid];
  [...document.querySelectorAll('.exhausted-card')].forEach(c => { if (c.dataset.sid === sid) c.remove(); }); // clear the stale card
  await retryTurn(pend.payload, pend.spoken, { resume: true }); // CONTINUE the stalled turn server-side (falls back to a full run if the transcript is gone)
  return true;
};
// RE-ATTACH to a run that's happening (or already finished) SERVER-SIDE. The agent run does NOT depend on
// the tab staying open — so if you ask a question then close the tab, on reopen we render its result, or
// wait for a still-running research to finish, instead of losing it or wastefully re-running it. We only
// fall back to a re-run when the server has no record (e.g. it restarted). Hooked into switchChat.
let reattaching = '';
const fetchRunResult = async sid => {
  try { return await (await fetch('/chat/result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: sid, cap: chatCap() }) })).json(); }
  catch { return null; }
};
const renderReattached = (r, sid) => {
  if (sid !== sessionId || !r) return;
  if (r.exhausted) { const p = stalledTurnFromTx(); if (p) renderExhausted(p.payload, false); return; }
  renderAgentResponse(r);
  pushTx('agent', r.answer || '', { tools: r.toolsUsed || [], images: r.images || [], imageUrls: r.imageUrls || [], steps: r.steps || [], agent: r.agentId, ui: r.ui || [] });
  try { pendantEnd(r.steps || []); } catch {}
  if (r.remaining != null) updateBudgetChip(r.remaining, r.allowance);
  refreshBadge();
};
const reattachRun = async sid => {
  if (busy || reattaching === sid || sid !== sessionId) return false; // a live send (or another re-attach) owns rendering
  if (!stalledTurnFromTx()) return false;                              // last entry isn't an unanswered question → nothing pending
  // a prior drop may have persisted a dead "interrupted" marker as the tail — strip it so it doesn't linger,
  // then resume the buried user turn (this auto-heals chats stuck on the old "send again to retry" bubble).
  const last = activeTx[activeTx.length - 1];
  if (last && last.who === 'agent' && INTERRUPT_RE.test(last.text || '')) { activeTx.pop(); saveTx(); renderTx(); }
  const rr = await fetchRunResult(sid);
  if (sid !== sessionId) return false;
  if (!rr || rr.state === 'none') return resumeIfPending(sid, { reconstruct: true }); // server has no record (it restarted) → re-run
  if (rr.state === 'running') {
    reattaching = sid; busy = true; if (sendBtn) sendBtn.disabled = true;
    setStatus('🔎 still working on this on the server — watch it live; safe to leave, the answer will be here when you return');
    // JUMP INTO the running trace: open the live pendant on this session. The server replays the steps so
    // far over the SSE stream, then streams new ones — so you see the fan-out IN ACTION, not a blank pendant.
    try { await pendantBegin(rr.text || (stalledTurnFromTx() || {}).payload?.text || '', sid); } catch { /* pendant is enhancement-only */ }
    try {
      for (;;) {
        await new Promise(res => setTimeout(res, 3000));
        if (sid !== sessionId) { try { pendantES && pendantES.close(); } catch {} pendantLive = false; return false; } // navigated away — stop the live trace; pick it up next time
        const cur = await fetchRunResult(sid);
        if (!cur || cur.state === 'running') continue;
        if (cur.result) renderReattached(cur.result, sid); else { try { pendantEnd([]); } catch {} await resumeIfPending(sid, { reconstruct: true }); } // renderReattached calls pendantEnd → reconciles the full trace
        return true;
      }
    } finally { busy = false; if (sendBtn) sendBtn.disabled = false; setStatus(''); reattaching = ''; }
  }
  if (rr.result) { renderReattached(rr.result, sid); return true; }   // finished while the tab was gone
  return resumeIfPending(sid, { reconstruct: true });                  // cancelled with no payload → re-run
};
// deterministic exhaustion card — NO model produced this; the user tops up or abandons.
// A provider error (429/overload/unreachable) → a TRANSIENT retry card. It is NOT pushed into the
// transcript, so it disappears on the next turn or reload (the Opus-429 string no longer sticks as a
// permanent bubble). The user's message stays; ↻ Retry re-runs with the CURRENT model — so switching the
// model dropdown then retrying actually uses the new model.
const renderRetryableError = (msg, payload, spoken) => {
  setStatus('');
  const card = document.createElement('div'); card.className = 'prop msg';
  card.innerHTML = `<div class="ptitle">⚠️ <span>Model unavailable — not applied</span></div><div class="pmeta">${esc(msg)}</div><div class="sub" style="font-size:12px;margin:2px 0 6px">Your message is kept. Switch the model in the header if you like, then retry.</div><div class="pbtns"></div>`;
  const btns = card.querySelector('.pbtns');
  const retry = document.createElement('button'); retry.className = 'confirm'; retry.textContent = '↻ Retry';
  const dismiss = document.createElement('button'); dismiss.className = 'reject'; dismiss.textContent = 'Dismiss';
  retry.onclick = () => { card.remove(); retryTurn({ ...payload, model: chatModel() }, spoken); };
  dismiss.onclick = () => card.remove();
  btns.append(retry, dismiss);
  log.appendChild(card); window.scrollTo(0, document.body.scrollHeight);
};
const renderExhausted = (payload, spoken) => {
  pendingResume[payload.sessionId] = { payload, spoken }; // retain the stalled turn so ANY top-up resumes it
  const card = document.createElement('div'); card.className = 'prop msg exhausted-card'; card.dataset.sid = payload.sessionId;
  // OWNER (root) comps credit for free; a non-root invitee PAYS to add credit (Phase 2 billing).
  const blurb = isRoot ? 'This conversation has used up its budget. Top it up to keep going, or abandon the thread.'
    : 'You\'ve used up the credit you were given. Add more to keep going — or abandon the thread.';
  card.innerHTML = `<div class="ptitle">🪙 <span>Out of inference allowance</span></div><div class="pmeta">${blurb}</div><div class="pbtns"></div>`;
  const btns = card.querySelector('.pbtns');
  const top = document.createElement('button'); top.className = 'confirm'; top.textContent = isRoot ? 'Top up $0.50 & continue' : 'Add $5 credit';
  const aband = document.createElement('button'); aband.className = 'reject'; aband.textContent = 'Abandon thread';
  top.onclick = async () => {
    top.disabled = aband.disabled = true;
    try {
      if (isRoot) { // owner comp: free top-up
        const b = await (await fetch('/budget/topup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, purseCap: chatCap(), sessionId, amount: 500000 }) })).json();
        if (b.error) throw new Error(b.error);
        updateBudgetChip(b.remaining, b.allowance); await resumeIfPending(payload.sessionId);
      } else { // invitee: pay via Stripe Checkout (purse is credited on the webhook, then reload to continue)
        const r = await (await fetch('/pay/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: chatCap(), sessionId, amountUsd: 5 }) })).json();
        if (r.url) { window.open(r.url, '_blank'); btns.insertAdjacentHTML('beforeend', '<span style="color:var(--mut);font-size:12px">Opening secure checkout… your credit is added once payment completes — then send your message again.</span>'); }
        else if (r.needsOwner) { btns.insertAdjacentHTML('beforeend', '<span style="color:var(--mut);font-size:12px">Paid top-ups aren\'t set up yet — the owner has been notified.</span>'); }
        else throw new Error(r.error || 'checkout failed');
      }
    } catch (e) { top.disabled = aband.disabled = false; btns.insertAdjacentHTML('beforeend', `<span style="color:var(--bad);font-size:12px">${esc(e.message)}</span>`); }
  };
  aband.onclick = () => { card.remove(); newChat(); };
  btns.append(top, aband);
  // BILLING RAIL #3 (invitees): pay on-chain with a MetaMask ERC-7715 delegation. Shown only when the
  // gator-pay settlement service is configured + the wallet supports advanced permissions.
  if (!isRoot) (async () => {
    try { const s = await (await fetch('/pay/delegation/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: chatCap() }) })).json(); if (!s.available) return; } catch { return; }
    const mm = document.createElement('button'); mm.className = 'confirm'; mm.textContent = '⛓️ Pay with MetaMask';
    mm.onclick = async () => {
      mm.disabled = true;
      try {
        const eth = window.ethereum;
        if (!eth || !eth.request) throw new Error('No Ethereum wallet found — install MetaMask (advanced permissions).');
        // ERC-7715: ask the wallet to GRANT a capped, time-boxed spending allowance (a delegation).
        const grant = await eth.request({ method: 'wallet_grantPermissions', params: [{ expiry: Math.floor(Date.now() / 1000) + 86400, permissions: [{ type: 'native-token-stream', data: { amount: '0x2386f26fc10000' } }] }] }).catch(e => { throw new Error('Your wallet declined or lacks ERC-7715 advanced permissions (MetaMask Flask). ' + (e.message || '')); });
        await fetch('/pay/delegation/grant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: chatCap(), sessionId, delegation: grant }) });
        const r = await (await fetch('/pay/delegation/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: chatCap(), sessionId, amountUsd: 5 }) })).json();
        if (r.ok) { updateBudgetChip(r.remaining, r.allowance); await resumeIfPending(payload.sessionId); }
        else throw new Error(r.error || 'on-chain settlement failed');
      } catch (e) { mm.disabled = false; btns.insertAdjacentHTML('beforeend', `<span style="color:var(--bad);font-size:12px">${esc(e.message)}</span>`); }
    };
    btns.insertBefore(mm, aband);
  })();
  log.appendChild(card); window.scrollTo(0, document.body.scrollHeight);
};

// tap an attached/generated image to view it full-screen. src is set via the DOM
// (never interpolated into innerHTML) — defensive even though src is app-controlled.
const showImage = src => { showModal('<div id="imgview"></div>'); const v = $('imgview'); if (v) { const img = document.createElement('img'); img.src = src; img.style.cssText = 'max-width:86vw;max-height:80vh;border-radius:8px;display:block'; v.appendChild(img); } };
// append attached images (urls) + file names to a message body
const appendAtt = (body, imgUrls = [], fileNames = []) => {
  if (!imgUrls.length && !fileNames.length) return;
  const wrap = document.createElement('div'); wrap.className = 'att';
  imgUrls.forEach(src => { const im = document.createElement('img'); im.src = src; im.onclick = () => showImage(src); wrap.appendChild(im); });
  fileNames.forEach(n => { const s = document.createElement('span'); s.className = 'fname'; s.textContent = '📄 ' + n; wrap.appendChild(s); });
  body.appendChild(wrap);
};
// render the user's outgoing message bubble, with any attached image thumbnails
const renderUserBubble = (text, attachments = []) => {
  const body = bubble('you', text, null, Date.now()); if (!text) body.textContent = '';
  appendAtt(body, attachments.filter(a => a.kind === 'image').map(a => a.dataUrl), attachments.filter(a => a.kind === 'text' || a.kind === 'file').map(a => a.name));
  window.scrollTo(0, document.body.scrollHeight);
  return body;
};

// Send a user message to the agent (typed OR transcribed). spoken=true → speak the
// reply (voice mode). Owns the busy/turn guard so typing and voice can't overlap.
// returns true if the turn was sent + answered (or superseded); false on a real
// failure (busy/empty/error) so the caller can restore the composer for a retry.
// ── Feature A: plan-then-confine. The chat runs under a cap holding ONLY the user-approved powers
// (lexically confined — it can't reach an ungranted tool). chatCap() resolves the active chat's
// scoped cap, falling back to root for legacy/unscoped chats. ──
const chatCap = () => (chats.find(c => c.id === sessionId) || {}).scopedCap || cap;
// Scoping gate: ask the scoper for the minimal powers, let the user approve/adjust, mint a per-chat
// cap. Returns the scoped cap, or null if the user cancels (→ caller aborts the send).
const scopeChat = async prompt => {
  setStatus('figuring out what this needs…'); // the scoper researches privately first (notes/wiki/agent docs)
  // Show the PERMISSIONING trace — a DODECAHEDRON (distinct from the working octahedron) animating the
  // scoper's private round-trips live. Enhancement-only; wrapped so it never blocks the scope flow.
  let scopeES;
  try {
    await ensurePendant();
    scoping = true; pendantWrap.classList.remove('hide'); pendant.setVisible(true); pendant.scopeBegin('permissioning'); schedulePendantPosition();
    scopeES = new EventSource('/chat/steps?sid=' + encodeURIComponent(sessionId));
    scopeES.onmessage = e => { try { const m = JSON.parse(e.data); if (m.t === 'start') pendant.toolStart(m.name, m.detail, m.call); else if (m.t === 'done') pendant.toolDone(m.name, m.ok, m.detail, m.children, m.call, m.result, m.granted); else if (m.t === 'end') { try { scopeES.close(); } catch {} } } catch {} };
    scopeES.onerror = () => {};
  } catch { /* pendant is enhancement-only */ }
  const endScopeTrace = () => { scoping = false; try { scopeES && scopeES.close(); } catch {} try { pendant && pendant.finish(); } catch {} };
  // Mint a confined cap for `powers`; returns null only if minting is unavailable. A scoped chat must
  // NEVER silently fall back to the full root cap (that would hand it delegate/write/etc.) — when scoping
  // can't complete we fall back to a READ-ONLY scope so a read still works but can't delegate or act.
  const mintScope = async powers => { pendingScopePowers = powers; try { const mm = await (await fetch('/scope/mint', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, powers, label: String(prompt).slice(0, 32) }) })).json(); return (mm && mm.scopedCap) || null; } catch { return null; } };
  const SAFE_FALLBACK = ['homeassistant', 'notes', 'reference', 'web', 'app']; // read-only — no delegate/write/act
  let sc;
  try { sc = await (await fetch('/scope', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, prompt, sessionId }) })).json(); }
  catch { setStatus(''); endScopeTrace(); const s = await mintScope(SAFE_FALLBACK); hidePendant(); return s || cap; } // scoper unreachable → read-only scope, not root
  setStatus(''); endScopeTrace();
  if (!sc || sc.error || !Array.isArray(sc.catalog)) { const s = await mintScope(SAFE_FALLBACK); hidePendant(); return s || cap; }
  // FAST-PATH: a trivial read-only scope (server said autoApprove) skips the consent sheet — mint the
  // confined cap straight away and run. The granted powers still render at the top of the chat (and root
  // can re-scope), so it stays visible; we just don't make you click for "is the front door open?".
  if (sc.autoApprove && Array.isArray(sc.proposed) && sc.proposed.length) {
    const s = await mintScope(sc.proposed);
    hidePendant();
    return s || cap;
  }
  const proposed = sc.proposed || [];
  const pset = new Set(proposed);
  const labelOf = {}; for (const c of sc.catalog) labelOf[c.power] = c.label;
  const rest = sc.catalog.filter(c => !pset.has(c.power)); // the non-proposed ones, hidden until "Add more"
  // an OAuth-consent-style scope row: icon · name · description · toggle.
  const row = (p, label, checked) => `<label class="scope"><span class="scope-ic">${powerIcon(p)}</span><span class="scope-txt"><span class="scope-name">${esc(p)}</span><span class="scope-desc">${esc(label || '')}</span></span><input type="checkbox" class="scope-chk" value="${esc(p)}"${checked ? ' checked' : ''}></label>`;
  const taskName = String(prompt || '').trim().replace(/\s+/g, ' ').slice(0, 90);
  return new Promise(resolve => {
    // A clean OAuth-style consent sheet rendered straight into the dim backdrop (no white card wrapper).
    // Shows ONLY the proposed powers; "Add more" reveals the rest. Approve mints the per-chat cap.
    const m = $('qrmodal');
    m.innerHTML = `<div class="consent" role="dialog" aria-label="Approve this chat’s powers">
      <div class="consent-head"><div class="consent-badge">🔐</div><div style="min-width:0"><div class="consent-title">Approve this chat’s powers</div>${taskName ? `<div class="consent-sub">“${esc(taskName)}”</div>` : ''}</div></div>
      <div class="consent-note">This chat will be able to use <b>only</b> the powers you approve — nothing else is reachable to it.</div>
      <div class="consent-scopes">
        ${proposed.length ? `<div id="sc-list">${proposed.map(p => row(p, labelOf[p], true)).join('')}</div>` : '<div class="consent-empty" id="sc-list">Nothing was auto-detected — add the powers this chat needs below.</div>'}
        ${rest.length ? `<div id="sc-rest" style="display:none">${rest.map(c => row(c.power, c.label, false)).join('')}</div>` : ''}
      </div>
      ${rest.length ? `<button class="consent-more" id="sc-more">+ Add ${rest.length} more power${rest.length > 1 ? 's' : ''}</button>` : ''}
      <div class="consent-actions"><button class="consent-btn ghost" id="sc-cancel">Cancel</button><button class="consent-btn primary" id="sc-go">Approve &amp; send</button></div>
    </div>`;
    m.classList.remove('hide');
    const fin = v => { closeModal(); if (v === null) hidePendant(); resolve(v); }; // cancel → drop the permissioning trace
    m.onclick = e => { if (e.target === m) fin(null); };              // backdrop dismiss = cancel (never hang the send)
    const more = $('sc-more'); if (more) more.onclick = () => { const r = $('sc-rest'); const open = r.style.display !== 'none'; r.style.display = open ? 'none' : 'block'; more.textContent = open ? `+ Add ${rest.length} more power${rest.length > 1 ? 's' : ''}` : '– Hide extra powers'; };
    $('sc-cancel').onclick = () => fin(null);
    $('sc-go').onclick = async () => {
      const powers = [...m.querySelectorAll('input.scope-chk:checked')].map(x => x.value);
      $('sc-go').disabled = true;
      const s = await mintScope(powers); // mints + remembers the approved grant (never silent root)
      fin(s || cap);
    };
  });
};

const sendChat = async (text, { spoken = false, audio = null, attachments = [], model = null } = {}) => {
  const t = (text || '').trim(); if ((!t && !attachments.length) || busy) return false;
  busy = true; if (sendBtn) sendBtn.disabled = true;
  const myTurn = ++turn; const stale = () => myTurn !== turn;
  let ok = false;
  // EVERYTHING runs inside try/finally so `busy` + the send button can NEVER get wedged:
  // a throw, a stale turn, or a mic toggle mid-send always releases the composer.
  try {
    // Feature B: posting INTO a shared chat → /share/post (the agent runs under the chat's confined
    // cap; metered against the share's allowance). No scoping gate / no /chat here.
    const activeChat = chats.find(c => c.id === sessionId);
    if (activeChat && activeChat.shareToken) {
      if (activeChat.shareMode !== 'write') { setStatus('this is a read-only shared chat'); return false; }
      renderUserBubble(t, attachments); document.body.classList.remove('landing'); activeTx.push({ who: 'you', text: t, at: Date.now() }); saveTx(); setStatus('thinking…');
      let r; try { r = await (await fetch('/share/post', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: activeChat.shareToken, text: t }) })).json(); } catch (e) { r = { error: e.message }; }
      if (stale()) return true;
      if (r.error) { setStatus('share: ' + r.error); return false; }
      if (r.exhausted) { renderAgentResponse({ answer: 'The shared spend allowance for this chat is used up.' }); pushTx('agent', '(allowance spent)'); setStatus(''); ok = true; return true; }
      renderAgentResponse(r); pushTx('agent', r.answer || '', { tools: r.toolsUsed || [], images: r.images || [], imageUrls: r.imageUrls || [], ui: r.ui || [] }); setStatus(''); ok = true;
      if (typeof r.len === 'number') shareCursor[sessionId] = r.len; // we already rendered our 2 turns → advance the live-poll cursor past them
      return true; // keep imageUrls so a recipient-generated image survives reload
    }
    const isFirst = !activeTx.length;               // first turn of this chat → land → drop animation
    let ub = null;
    // commit the ephemeral "New chat" to the list on its first message (until now a blank
    // chat never persists — so reloads / "+ New" don't accumulate empty rows in the sidebar).
    if (isFirst && !chats.some(c => c.id === sessionId)) {
      // Feature A (plan-then-confine): scope this chat to the minimal approved powers BEFORE anything
      // runs; the chat then executes under a confined cap. Cancel here aborts the send entirely.
      // Dock NOW: the moment the scope agent (the dodecahedron) starts working, convert the centred
      // landing search box into the normal docked composer + show the prompt as a bubble at the top.
      ub = renderUserBubble(t, attachments); document.body.classList.remove('landing'); ub.parentNode.classList.add('pop');
      // A non-Agent-C entrypoint agent (a specialist) has a FIXED ring — its powers ARE the scope, so
      // we skip the consent scoper and run the chat AS that specialist (server confines to its node).
      const entryAgent = chatAgent();
      const asSpecialist = entryAgent && entryAgent !== 'field-agent';
      let sc = null;
      if (!asSpecialist) {
        sc = await scopeChat(t || (attachments[0] && attachments[0].name) || 'this task');
        if (stale()) return true;
        if (sc === null) { renderTx(); syncLanding(); setStatus(''); return false; } // cancelled → restore the landing box
      }
      const pid = pendingProjectId[sessionId]; // set if this chat was started from the agent menu's project list
      const chat = { id: sessionId, title: 'New chat', ts: Date.now() };
      if (sc) chat.scopedCap = sc; // Agent C path: a minted confined cap. Specialist path: none — runs as the spec node.
      if (Array.isArray(pendingScopePowers)) { chat.scopedPowers = pendingScopePowers; pendingScopePowers = null; } // the granted powers → shown at the top of the chat
      if (pendingAgent[sessionId]) { chat.agent = pendingAgent[sessionId]; delete pendingAgent[sessionId]; } // carry the chosen entrypoint agent onto the committed chat
      else if (asSpecialist) chat.agent = entryAgent;
      if (chat.agent && specialistSpawnedFrom[chat.agent]) { // a specialist chat → link back to the chat that spawned the specialist
        chat.parentId = specialistSpawnedFrom[chat.agent];
        chat.parentTitle = (chats.find(x => x.id === chat.parentId) || {}).title || 'where it was spawned';
      }
      if (pid) chat.projectId = pid;
      chats.unshift(chat); saveChats();
      setChatUrl(); // the chat is now committed (known) → reflect it in the bookmarkable URL
      // file the now-committed chat under its project (shared home folder + grouping) — fire-and-forget
      if (pid) { fetch('/projects/attach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, id: pid, chatId: sessionId }) }).catch(() => {}); delete pendingProjectId[sessionId]; }
    }
    if (!ub) ub = renderUserBubble(t, attachments);
    if (isFirst) { document.body.classList.remove('landing'); ub.parentNode.classList.add('pop'); } // composer drops to the bottom; the message pops in as a bubble
    // build the persisted tx entry (kept by reference so we can swap data-URLs → durable /uploads URLs)
    const tx = { who: 'you', text: t, at: Date.now() };
    if (audio) tx.audio = audio;
    const imgAtts = attachments.filter(a => a.kind === 'image');
    const fileAtts = attachments.filter(a => a.kind === 'text' || a.kind === 'file');
    if (imgAtts.length) tx.attachImgs = imgAtts.map(a => a.dataUrl);           // session-only (stripped before persist)
    if (fileAtts.length) tx.attachFiles = fileAtts.map(a => a.name);
    activeTx.push(tx); saveTx();
    { const cc = chats.find(c => c.id === sessionId); if (cc) { cc.lastMsgAt = Date.now(); saveChats(); } } // baseline for the in-chat run indicator ("since your last message")
    try { userBubbleControls(activeTx.length - 1, tx, ub); } catch { /* control row: ↻ retry / ✎ edit / 🔊 audio — appears live INSIDE the bubble */ }
    titleFrom(t || (attachments[0] && attachments[0].name) || 'photo'); setStatus('thinking…'); if (spoken) setMic('thinking');
    await pendantBegin(t); // descend the live 3D pendant + open the step stream BEFORE the turn starts
    const payload = { sessionId, text: t, cap: chatCap(), model: model || chatModel(), agent: chatAgent() }; // chatCap() = this chat's CONFINED cap (Feature A); agent = run AS this entrypoint specialist (server confines)
    // Send the DURABLE transcript as history so the agent's memory of this chat survives a server
    // restart (the server's in-memory history is volatile + wiped on restart). Exclude the current
    // user turn (just pushed above) — the server appends it from `text`. Plain text per turn.
    payload.history = activeTx.slice(0, -1).filter(m => m && (m.text || '').trim()).map(m => ({ role: m.who === 'you' ? 'user' : 'assistant', content: String(m.text) })).slice(-24);
    if (attachments.length) payload.attachments = attachments.map(a => ({ kind: a.kind, name: a.name, mediaType: a.mediaType, url: a.dataUrl, text: a.text }));
    const cr = await fetch('/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if (stale()) return true;        // superseded by a newer turn — composer already moved on
    // A long turn (e.g. a big dietician evaluate) can outlive the PUBLIC PROXY's request timeout — /chat is a
    // single blocking POST that sends nothing until the turn finishes, so ngrok times out the edge and returns
    // its own HTML error page. Don't feed that to JSON.parse (the "Unexpected token '<', <!DOCTYPE…" bug): the
    // turn is still running server-side, so treat a non-JSON/!ok response exactly like a dropped connection and
    // let the resume machinery reattach + deliver the answer when it lands.
    if (!cr.ok || !/application\/json/i.test(cr.headers.get('content-type') || '')) throw new Error('gateway-timeout: the proxy returned a non-JSON response (the turn is likely still running) — resuming');
    const r = await cr.json();
    if (stale() || r.cancelled) return true;
    // PROVIDER ERROR (429/overload/unreachable): a TRANSIENT retry card, NOT a persisted answer — so it
    // clears on the next turn/reload (fixes the Opus-429 string that used to stick as a permanent bubble).
    if (r.error) { if (r.retryable || r.llmError) { renderRetryableError(r.error, payload, spoken); ok = true; return true; } setStatus('chat: ' + r.error); return false; }
    // prepaid allowance spent — server refused WITHOUT a model call. Static Top-up/Abandon card.
    if (r.exhausted) { updateBudgetChip(r.remaining, r.allowance); renderExhausted(payload, spoken); ok = true; return true; }
    // durable server URLs for the attached images → persist these (survive reload + cross-device sync)
    const urls = (r.attachments || []).filter(a => a.kind === 'image' && a.url).map(a => a.url);
    if (urls.length) { tx.attachUrls = urls; saveTx(); }
    renderAgentResponse(r); pushTx('agent', r.answer || '', { tools: r.toolsUsed || [], images: r.images || [], imageUrls: r.imageUrls || [], steps: r.steps || [], agent: r.agentId, ui: r.ui || [], vmodel: payload.model, vagent: payload.agent }); // ui = widget specs; vmodel/vagent = the params of this attempt (fork 0) for W2 fork/retry
    pendantEnd(r.steps || []); // settle the pendant + reconcile any steps the live stream missed
    updateBudgetChip(r.remaining, r.allowance); // toll-bridge: reflect this turn's spend in the budget chip
    refreshBadge(); // the turn may have posted a notification
    if ((r.toolsUsed || []).includes('routeToDev')) loadDevUpdates(); // surface the dev hand-off immediately
    if ((r.toolsUsed || []).includes('retitleChat')) { loadMemos(); loadSeedChats(); syncLoad(); } // the agent renamed conversations → pull the new titles now (before the debounced save reverts them)
    if (spoken && !stale()) await speak(r.answer || '');
    ok = true;
  } catch (e) {
    // The /chat request failed mid-turn — most often the connection dropped because the server
    // restarted. Render a PERSISTENT, legible bubble (not just a transient status) so the run never
    // stalls silently; the user's message is already saved, so a re-send retries it.
    if (!stale()) {
      const dropped = /Failed to fetch|NetworkError|load failed|aborted|gateway-timeout/i.test(e.message || '');
      if (dropped) {
        // The connection dropped mid-run (usually a server restart). Do NOT persist a dead agent turn —
        // that would bury the user turn and block auto-resume. Leave the user turn unanswered, show a
        // transient status, and auto-retry shortly; reattachRun also re-runs it the next time the chat opens.
        setStatus('⚠️ interrupted (the server may have restarted) — resuming…'); try { pendantEnd([]); } catch {}
        const sidAtDrop = sessionId;
        setTimeout(() => { if (!busy && sessionId === sidAtDrop) resumeIfPending(sidAtDrop, { reconstruct: true }).catch(() => {}); }, 2200);
      } else {
        const msg = '⚠️ Something went wrong: ' + e.message;
        setStatus(''); try { renderAgentResponse({ answer: msg }); } catch {} pushTx('agent', msg, {}); try { pendantEnd([]); } catch {}
      }
    }
    ok = false;
  }
  finally {
    busy = false; if (sendBtn) sendBtn.disabled = false;        // ALWAYS release — the bug was leaving this wedged on a stale turn
    if (myTurn === turn) { setStatus(on ? 'listening…' : ''); setMic(on ? 'listening' : ''); }
    try { pendantES && pendantES.close(); } catch {} pendantLive = false; if (pendant) pendant.finish(); // never leave the step stream open
    if (queuedSend) setTimeout(flushQueued, 0); // a message typed mid-turn was queued → send it now the turn is done
  }
  return ok;
};

// voice path: transcribe an utterance, then hand it to sendChat (spoken reply)
const handleUtterance = async blob => {
  if (busy) return;
  busy = true; const snap = turn; // snapshot so a barge-in during STT discards it
  setStatus('transcribing…'); setMic('thinking');
  let heard = '', err = '';
  try {
    const sr = await fetch('/stt', { method: 'POST', headers: { 'content-type': blob.type || 'audio/webm' }, body: blob });
    const j = await sr.json();
    if (j.error) err = j.error; else heard = (j.text || '').trim();
  } catch (e) { err = e.message; }
  busy = false;
  if (turn !== snap) return;                                   // user barged in → discard
  if (err) { setStatus('stt: ' + err); if (on) setMic('listening'); return; }
  if (!heard || heard.length < 2) { setStatus(on ? 'listening…' : ''); if (on) setMic('listening'); return; }
  // attach the recorded audio (in-memory blob URL) so the trace can scrub/replay it
  let audio = null; try { audio = URL.createObjectURL(blob); } catch {}
  sendChat(heard, { spoken: true, audio });
};

const startUtterance = () => {
  chunks = [];
  rec = new MediaRecorder(mediaStream, { mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '' });
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  rec.onstop = () => { const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' }); if (blob.size > 2200) handleUtterance(blob); };
  rec.start();
};
// ── Siri orb: live mic-volume feedback hovering over the text input (CSS: #siri-orb).
//    feedOrb() runs every animation frame from tick(); throttles to <=10Hz, drives
//    --orb-lvl (0..1) from the input RMS (peak over the window), and re-anchors over #text. ──
const orbEl = $('siri-orb'); if (orbEl) orbEl.style.display = 'none'; // retired: the trace octahedron (pendant) IS the voice indicator now — one continuous identity
const placeOrb = () => {
  if (!orbEl) return;
  const r = $('text').getBoundingClientRect();
  if (!r.width) return;
  orbEl.style.left = (r.left + r.width / 2) + 'px';
  orbEl.style.top = r.top + 'px'; // octagon straddles the input's top edge — hovering right over it
};
addEventListener('resize', placeOrb);
let orbLast = 0, orbPeak = 0;
const feedOrb = rms => {
  if (orbPeak < rms) orbPeak = rms;
  const now = performance.now();
  if (now - orbLast < 90) return;                                // <=~10Hz: pulse maxes ~1/10s
  orbLast = now;
  const lvl = Math.max(0, Math.min(1, (orbPeak - 0.015) / 0.2)); // speech RMS → 0..1
  orbPeak = 0;
  // Drive the agent's trace octahedron (the pendant root), NOT a separate orb — one continuous
  // visual identity for listening + working. The turn owns the viz while it runs (!pendantLive).
  if (pendant && !pendantLive) pendant.setListen(lvl);
};
const tick = () => {
  if (!on) return;
  const buf = new Uint8Array(analyser.fftSize); analyser.getByteTimeDomainData(buf);
  let sum = 0; for (let i = 0; i < buf.length; i += 1) { const v = (buf[i] - 128) / 128; sum += v * v; }
  const rms = Math.sqrt(sum / buf.length);
  feedOrb(rms); // live input volume → the Siri orb pulsing over the text input
  const SPEAK = 0.05, HANG = 55, BARGE = 0.09, BARGE_FRAMES = 6;
  if (speaking || busy) {
    if (rms > BARGE) { bargeFrames += 1; if (bargeFrames > BARGE_FRAMES) bargeIn(); } else { bargeFrames = Math.max(0, bargeFrames - 1); }
  } else {
    if (rms > SPEAK) { voiceFrames += 1; silenceFrames = 0; if (!capturing && voiceFrames > 2) { capturing = true; startUtterance(); } }
    else { silenceFrames += 1; if (capturing && silenceFrames > HANG) { capturing = false; voiceFrames = 0; try { rec.state !== 'inactive' && rec.stop(); } catch {} } }
  }
  requestAnimationFrame(tick);
};
const startMic = async () => {
  if (!cap) { setStatus('no capability — open your #cap= link'); return; }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(mediaStream);
    analyser = audioCtx.createAnalyser(); analyser.fftSize = 1024; src.connect(analyser);
    on = true; setMic('listening'); document.body.classList.add('voice-live'); setStatus('🎤 voice on — just talk (you can talk over me). Tap the mic to stop.'); tick();
    // The 3D trace is reserved for ACTIVE WORK only (a running turn / permissioning) — NOT for idle listening.
    // Pre-create it so a turn starts instantly, but leave it HIDDEN; pendantBegin reveals it when work starts.
    ensurePendant().catch(() => {});
  } catch (e) { setStatus('mic error: ' + e.message); }
};
const stopMic = () => { on = false; capturing = false; turn += 1; try { rec?.state !== 'inactive' && rec.stop(); } catch {}; try { speechSynthesis.cancel(); } catch {}; mediaStream?.getTracks().forEach(t => t.stop()); audioCtx?.close(); setMic(''); document.body.classList.remove('voice-live'); setStatus(''); if (pendant) pendant.setListen(-1); schedulePendantPosition(); };
mic.onclick = () => (on ? stopMic() : startMic());

// ── attachments: photos + files picked/pasted into the composer ───────────────
// Images are downscaled in-browser (≤1600px JPEG) — smaller payloads, and on iOS
// canvas decodes HEIC → JPEG for free. Each becomes an inline vision input the
// (multimodal) agent SEES directly. Text files are read + inlined.
let pendingAtt = []; // [{ id, kind:'image'|'text', name, mediaType, dataUrl?, text? }]
const fileInput = $('file'), attachBtn = $('attach'), attachRow = $('attachrow');
const readAsDataURL = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error || new Error('read failed')); r.readAsDataURL(f); });
const readAsText = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error || new Error('read failed')); r.readAsText(f); });
const downscaleImage = (file, max = 1600, quality = 0.85) => new Promise(resolve => {
  const url = URL.createObjectURL(file); const img = new Image();
  img.onload = () => {
    let { width: w, height: h } = img; const scale = Math.min(1, max / Math.max(w, h || 1));
    w = Math.max(1, Math.round(w * scale)); h = Math.max(1, Math.round(h * scale));
    try { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(img, 0, 0, w, h); const out = c.toDataURL('image/jpeg', quality); URL.revokeObjectURL(url); resolve(out && out.length > 40 ? out : null); }
    catch { URL.revokeObjectURL(url); resolve(null); }
  };
  img.onerror = () => { URL.revokeObjectURL(url); resolve(null); }; // e.g. HEIC on a non-decoding browser → fall back
  img.src = url;
});
const renderAttachRow = () => {
  if (!pendingAtt.length) { attachRow.classList.add('hide'); attachRow.innerHTML = ''; return; }
  attachRow.classList.remove('hide');
  attachRow.innerHTML = pendingAtt.map((a, i) => `<div class="attach-chip">${a.kind === 'image' ? `<img src="${a.dataUrl}" alt="">` : `<span class="fname">📄 ${esc(a.name)}</span>`}<button class="rm" data-rm="${i}" title="remove">×</button></div>`).join('');
  attachRow.querySelectorAll('[data-rm]').forEach(b => { b.onclick = () => { pendingAtt.splice(+b.dataset.rm, 1); renderAttachRow(); }; });
};
const addFiles = async files => {
  for (const f of Array.from(files || [])) {
    if (pendingAtt.length >= 4) { setStatus('up to 4 attachments at a time'); break; }
    if (f.size > 25 * 1024 * 1024) { setStatus(`"${f.name}" is too large (max 25MB)`); continue; }
    try {
      if (/^image\//i.test(f.type) || /\.(jpe?g|png|gif|webp|heic|heif)$/i.test(f.name)) {
        let dataUrl = await downscaleImage(f); let mediaType = 'image/jpeg';
        if (!dataUrl) { dataUrl = await readAsDataURL(f); mediaType = f.type || 'image/jpeg'; } // couldn't canvas-decode (HEIC) → send raw, server transcodes
        pendingAtt.push({ id: newId(), kind: 'image', name: f.name || 'image', mediaType, dataUrl });
      } else if (/^text\//i.test(f.type) || /\.(txt|md|markdown|csv|json|log)$/i.test(f.name)) {
        const text = await readAsText(f);
        pendingAtt.push({ id: newId(), kind: 'text', name: f.name || 'file', text: String(text).slice(0, 40000) });
      } else {
        // arbitrary file → send its bytes; the server drops it into the agent's (project) home folder.
        const dataUrl = await readAsDataURL(f);
        pendingAtt.push({ id: newId(), kind: 'file', name: f.name || 'file', mediaType: f.type || 'application/octet-stream', dataUrl });
      }
    } catch (e) { setStatus('attach error: ' + e.message); }
  }
  renderAttachRow();
};
if (attachBtn) attachBtn.onclick = () => fileInput.click();
if (fileInput) fileInput.onchange = () => { addFiles(fileInput.files); fileInput.value = ''; };

// text composer: send on click / Enter (carries any pending attachments)
const input = $('text'), sendBtn = $('send');
// A message the user composed WHILE a turn was still in flight. Rather than silently dropping the
// Enter/click (the old behaviour — sendChat returns false when busy, so the text just got restored and
// nothing happened), we stash it here and auto-send it the instant the current turn finishes. So Enter
// always "takes". Only one is held (a second queued message replaces it — last-typed wins).
let queuedSend = null;
const flushQueued = () => {
  if (!queuedSend || busy) return;
  const q = queuedSend; queuedSend = null;
  sendChat(q.t, { spoken: false, attachments: q.atts, model: q.model }).then(ok => {
    if (ok === false) { input.value = q.t; pendingAtt = q.atts; renderAttachRow(); } // couldn't send → hand it back to the composer
  });
};
const doSend = async (modelOverride) => {
  const t = input.value; const atts = pendingAtt;
  if (busy) { // a turn is running
    if (!t.trim() && !atts.length) return;
    // TEXT-only → INTERJECT into the running turn: the server folds it into the agent's context at its next
    // step boundary, so you re-steer a long fan-out without aborting it. (Attachments can't be folded into a
    // mid-turn program, so those still QUEUE for a fresh turn.) If no turn is actually running (a race), fall
    // back to queuing so the message is never lost.
    if (t.trim() && !atts.length) {
      const sidAt = sessionId; input.value = '';
      fetch('/chat/interject', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: sidAt, text: t }) })
        .then(r => (r.ok ? r.json() : null))
        .then(r => { if (r && r.ok) setStatus('↪ interjected — the agent will fold it in at its next step'); else { queuedSend = { t, atts: [], model: modelOverride || null }; setStatus('⏳ queued — sending when the current turn finishes'); } })
        .catch(() => { queuedSend = { t, atts: [], model: modelOverride || null }; });
      return;
    }
    queuedSend = { t, atts, model: modelOverride || null };
    pendingAtt = []; input.value = ''; renderAttachRow();
    setStatus('⏳ queued — sending when the current turn finishes');
    return;
  }
  pendingAtt = []; input.value = ''; renderAttachRow(); input.focus();
  const ok = await sendChat(t, { spoken: false, attachments: atts, model: modelOverride || null });
  if (ok === false) { pendingAtt = atts; input.value = t; renderAttachRow(); } // failed send → restore composer for retry
};
// HOLD-TO-ESCALATE: a quick tap sends with the chosen model; holding the send button climbs to the
// NEXT BIGGEST model — first bump at ~1s, then ~3 more per second — and sends with whatever it
// reached on release. (Per-request only; it doesn't change the chat's default model.)
const ladderIdx = id => { const i = MODEL_LADDER.findIndex(m => m.id === id); return i < 0 ? 0 : i; };
let holdRaf = 0, holdStart = 0, holdActive = false, holdTarget = null, holdLastName = '', lastPointerUp = 0;
const holdTick = () => {
  if (!holdActive) return;
  const base = ladderIdx(chatModel());
  const el = performance.now() - holdStart;
  const advances = el <= 1000 ? 0 : 1 + Math.floor((el - 1000) / 333); // first bump at 1s, ~3/s after
  const idx = Math.min(base + advances, MODEL_LADDER.length - 1);
  holdTarget = idx > base ? MODEL_LADDER[idx] : null;
  const nm = holdTarget ? holdTarget.name : '';
  if (nm !== holdLastName) { holdLastName = nm; if (nm) setStatus(`⏫ ${nm} — release to send (${idx}/${MODEL_LADDER.length - 1})`); else setStatus(''); }
  holdRaf = requestAnimationFrame(holdTick);
};
const startHold = e => { if (busy) return; if (e.cancelable) e.preventDefault(); try { sendBtn.setPointerCapture(e.pointerId); } catch {} holdActive = true; holdStart = performance.now(); holdTarget = null; holdLastName = ''; cancelAnimationFrame(holdRaf); holdRaf = requestAnimationFrame(holdTick); };
const endHold = send => { if (!holdActive) return; holdActive = false; cancelAnimationFrame(holdRaf); const target = holdTarget; holdTarget = null; if (!busy) setStatus(''); if (send) doSend(target ? target.id : undefined); };
if (sendBtn) {
  sendBtn.addEventListener('pointerdown', startHold);
  sendBtn.addEventListener('pointerup', () => { lastPointerUp = performance.now(); endHold(true); });
  sendBtn.addEventListener('pointercancel', () => endHold(false));
  sendBtn.addEventListener('click', () => { if (performance.now() - lastPointerUp < 600) return; doSend(); }); // keyboard/non-pointer activation only (pointer path already sent)
}
if (input) {
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); doSend(); } });
  input.addEventListener('paste', e => {
    const imgs = [...(e.clipboardData?.files || [])].filter(f => /^image\//i.test(f.type));
    if (imgs.length) { e.preventDefault(); addFiles(imgs); return; }
    maybeEmbedPastedSite(e); // a pasted full HTML doc or site/#cap link → render inline as a widget (else normal paste)
  });
}

// ── Shares panel ────────────────────────────────────────────────────────────
let sharesCache = [];
// Display tag for one share (kept identical between the island + DOM paths).
const shareTag = s => (s.ha ? `${s.ha.kind.replace('ha-', '')}: ${s.ha.name}${s.ha.readOnly ? ' · read-only' : ''}` : s.power);
const refreshShares = async () => {
  try { sharesCache = await rpc('listShares'); } catch { return; }
  const el = $('shares');
  // Also fetch shared COMPONENTS (custom tools shared as factory/instance), root only. The token stays
  // here in compCache (for copy/revoke) and is NEVER passed into the island — render-safe rows only.
  let compCache = [];
  if (isRoot) {
    try {
      const cr = await (await fetch('/tools/shares', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) })).json();
      compCache = (cr.shares || []).filter(s => !s.revoked);
      window.__toolEarned = cr.earnings || 0;
    } catch { compCache = []; }
  }
  const attenSummary = a => { if (!a) return ''; const p = []; if (a.methods) p.push(a.methods.join('/')); if (a.ratePerMin) p.push(`${a.ratePerMin}/min`); if (a.quota) p.push(`quota ${a.quota}`); if (a.expiresAt) p.push('expires'); return p.join(', '); };
  const priceStr = u => (u ? `${(u / 1e6).toFixed(u >= 10000 ? 2 : 6)} USD/${'use'}` : '');

  // Confined-Preact ISLAND, propagator-style: push render-safe rows into the island's data CELL; its
  // stateless render propagator re-paints SharesPanel. Secrets (swissnum, share token) never leave here
  // (sharesCache / compCache) — handlers index back into them. renderConfined hands a frozen SafeEvent.
  if (window.__fieldIslands) {
    const items = sharesCache.map(s => ({ label: s.label, tag: shareTag(s) }));
    const components = compCache.map(c => ({ toolName: c.toolName, mode: c.mode === 'git' ? `git (${c.access || 'read'})` : c.mode, price: priceStr(c.priceUsd), used: c.used, atten: attenSummary(c.attenuation), revoked: c.revoked }));
    const earned = window.__toolEarned ? `${(window.__toolEarned / 1e6).toFixed(2)} USD` : '';
    window.__fieldIslands.renderShares(el, { items, components, earned }, {
      onCopy: i => copyLink(sharesCache[i], null),
      onQr: i => showQr(sharesCache[i]),
      onRevoke: async i => { await rpc('revoke', [sharesCache[i].swiss]); refreshShares(); },
      onCopyComp: i => copyLink({ url: `${location.origin}/tools/shared/${compCache[i].mode === 'factory' ? 'import' : compCache[i].mode === 'git' ? 'git' : 'call'}#token=${compCache[i].token}`, label: compCache[i].toolName }, null),
      onRevokeComp: async i => { await fetch('/tools/share/revoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, token: compCache[i].id }) }); refreshShares(); },
    });
    return;
  }
  // DOM fallback (until the island bundle is present).
  if (!sharesCache.length) { el.innerHTML = '<div class="pill">no active invite links</div>'; return; }
  el.innerHTML = sharesCache.map((s, i) => {
    const tag = esc(shareTag(s));
    return `<div class="share">
      <div><b>${esc(s.label)}</b> <span class="pill">${tag}</span></div>
      <div><button class="mini" data-copy="${i}">copy link</button> <button class="mini" data-qr="${i}">QR</button> <button class="mini bad" data-revoke="${i}">revoke</button></div>
    </div>`;
  }).join('');
  document.querySelectorAll('[data-copy]').forEach(b => { b.onclick = () => copyLink(sharesCache[+b.dataset.copy], b); });
  document.querySelectorAll('[data-qr]').forEach(b => { b.onclick = () => showQr(sharesCache[+b.dataset.qr]); });
  document.querySelectorAll('[data-revoke]').forEach(b => { b.onclick = async () => { await rpc('revoke', [sharesCache[+b.dataset.revoke].swiss]); refreshShares(); }; });
};

// ── auto-confirm ("don't ask again") rules for this agent — the inventory control ──
const refreshAutoRules = async () => {
  let rules = [];
  try { rules = await rpc('listAutoConfirm'); } catch { return; }
  const wrap = $('autorules-wrap');
  if (!wrap) return;
  if (!rules.length) { wrap.classList.add('hide'); $('autorules').innerHTML = ''; return; }
  wrap.classList.remove('hide');
  $('autorules').innerHTML = rules.map((r, i) => `<div class="share"><div><b>${esc(r.kind)}</b> <span class="pill">auto since ${esc(String(r.since || '').slice(0, 10))}</span></div><div><button class="mini bad" data-revauto="${i}">revoke</button></div></div>`).join('');
  document.querySelectorAll('#autorules [data-revauto]').forEach(b => { b.onclick = async () => { await rpc('revokeAutoConfirm', [rules[+b.dataset.revauto].kind]); refreshAutoRules(); }; });
};

// ── specialists inventory (Shares): the entry agent's persistent sub-agents ──
const refreshSpecialists = async () => {
  const wrap = $('specialists-wrap'); if (!wrap) return;
  if (!heldPowers.has('specialists')) { wrap.classList.add('hide'); return; }
  let specs = [];
  try { specs = await rpc('listSpecialists'); } catch { return; }
  if (!specs.length) { wrap.classList.add('hide'); $('specialists-list').innerHTML = ''; return; }
  wrap.classList.remove('hide');
  $('specialists-list').innerHTML = specs.map((s, i) => `<div class="share"><div><b>${esc(s.name)}</b> <span class="pill">${esc(s.domain || '')}${s.powers && s.powers.length ? ' · ' + esc(s.powers.join(', ')) : ''}${s.autonomy && s.autonomy.length ? ' · auto: ' + esc(s.autonomy.join(', ')) : ''}</span></div><div><button class="mini bad" data-retire="${i}">retire</button></div></div>`).join('');
  document.querySelectorAll('#specialists-list [data-retire]').forEach(b => { b.onclick = async () => { const s = specs[+b.dataset.retire]; if (window.confirm(`Retire specialist "${s.name}"? It will be removed from your inventory.`)) { await rpc('removeSpecialist', [s.id]); refreshSpecialists(); } }; });
};

// ── object navigator (Shares): a FILE-SYSTEM-style browser over the object trees
//    this cap holds (HomeAssistant, Agents). HomeAssistant + Agents are top-level
//    "folders" under one root. Browser back/forward works (history); breadcrumb
//    path; find-as-you-type filter. Each node is shareable as a web-key. ─────────
let navStack = [];   // [{ ns:'ha'|'agents', handle, label }]   (empty = root folder list)
let navNode = null;  // currently-fetched node (filter without refetch)

const TREE_RPC = { agents: 'agentsTree', contacts: 'contactsTree', home: 'homeTree', timers: 'timersTree', notes: 'notesTree', ha: 'haTree' };
const treeRpc = (ns, handle) => rpc(TREE_RPC[ns] || 'haTree', handle ? [handle] : []);
const rootFolders = () => {
  const r = [];
  if (heldPowers.has('homeassistant')) r.push({ ns: 'ha', label: 'HomeAssistant', sub: 'devices' });
  if (heldPowers.has('agents')) r.push({ ns: 'agents', label: 'Agents', sub: 'personas' });
  if (heldPowers.has('contacts')) r.push({ ns: 'contacts', label: 'Contacts', sub: 'address book' });
  if (heldPowers.has('home')) r.push({ ns: 'home', label: 'Files', sub: 'home folder' });
  if (heldPowers.has('timers')) r.push({ ns: 'timers', label: 'Timers', sub: 'wake-ups' });
  if (heldPowers.has('notes')) r.push({ ns: 'notes', label: 'Notes', sub: 'your vault' });
  return r;
};
const mintNode = async (ns, handle, label, readOnly) => {
  const name = prompt(`Name this ${readOnly ? 'read-only ' : ''}share (so you can revoke it):`, label || '');
  if (!name) return;
  try {
    const r = ns === 'contacts' ? await rpc('shareContacts', [handle, name])
      : ns === 'home' ? await rpc('shareHome', [handle, name])
      : ns === 'timers' ? await rpc('shareTimers', [handle, name])
      : ns === 'notes' ? await rpc('shareNotes', [handle, name])
      : await rpc(ns === 'agents' ? 'shareAgent' : 'shareHa', [handle, name, { readOnly }]);
    showQr(r); await refreshShares();
  } catch (e) { alert(e.message); }
};
const navGo = (stack, { push = true } = {}) => {
  navStack = stack;
  try { if (push) history.pushState({ nav: stack }, ''); else history.replaceState({ nav: stack }, ''); } catch {}
  renderNav();
};
// render just the child list (also used by the filter, without refetching)
const renderNavList = () => {
  const loc = navStack[navStack.length - 1];
  const f = ($('obj-filter').value || '').toLowerCase();
  let kids;
  if (!loc) kids = rootFolders().map(r => ({ root: true, ns: r.ns, label: r.label, sub: r.sub }));
  else {
    const n = navNode || {};
    kids = (n.rooms || []).map(r => ({ handle: r.handle, label: r.name, sub: `${r.entities} entities` }))
      .concat((n.types || []).map(t => ({ handle: t.handle, label: t.domain, sub: `${t.count}` })))
      .concat((n.agents || []).map(a => ({ handle: a.handle, label: a.name, sub: a.role || a.ip, leaf: true })))
      .concat((n.entities || []).map(e => ({ handle: e.handle, label: e.name, sub: e.entity_id, leaf: true })))
      .concat((n.children || []).map(c => ({ handle: c.handle, label: c.label, sub: c.sub || 'contact', leaf: c.leaf !== undefined ? c.leaf : true }))); // contacts/home/(future) tree children — folders (leaf:false) drill, files/contacts are leaves
  }
  const roOnly = !!loc && (loc.ns === 'contacts' || loc.ns === 'home' || loc.ns === 'timers' || loc.ns === 'notes'); // contacts/files/timers/notes share as single granules
  const shareBtns = (k, i) => k.root ? '' : (roOnly ? ` <button class="mini" data-shro="${i}">🔗 share</button>` : ` <button class="mini" data-shro="${i}">RO</button><button class="mini" data-shfull="${i}">full</button>`);
  const shown = f ? kids.filter(k => k.label.toLowerCase().includes(f) || (k.sub || '').toLowerCase().includes(f)) : kids;
  $('obj-list').innerHTML = shown.length ? shown.map((k, i) => `<div class="share"><div>${k.leaf ? '' : '📂 '}<b>${esc(k.label)}</b> <span class="pill">${esc(k.sub || '')}</span></div><div>${k.leaf ? '' : `<button class="mini" data-drill="${i}">open</button>`}${shareBtns(k, i)}</div></div>`).join('') : '<div class="pill">(nothing here)</div>';
  document.querySelectorAll('#obj-list [data-drill]').forEach(b => { b.onclick = () => { const k = shown[+b.dataset.drill]; navGo([...navStack, { ns: k.root ? k.ns : loc.ns, handle: k.root ? null : k.handle, label: k.label }]); }; });
  document.querySelectorAll('#obj-list [data-shro]').forEach(b => { b.onclick = () => { const k = shown[+b.dataset.shro]; mintNode(loc.ns, k.handle, k.label, true); }; });
  document.querySelectorAll('#obj-list [data-shfull]').forEach(b => { b.onclick = () => { const k = shown[+b.dataset.shfull]; mintNode(loc.ns, k.handle, k.label, false); }; });
};
const renderNav = async () => {
  const loc = navStack[navStack.length - 1];
  $('obj-crumbs').innerHTML = ['<a href="#" data-crumb="-1">Home</a>'].concat(navStack.map((l, i) => `<a href="#" data-crumb="${i}">${esc(l.label)}</a>`)).join(' › ');
  document.querySelectorAll('#obj-crumbs [data-crumb]').forEach(a => { a.onclick = e => { e.preventDefault(); navGo(navStack.slice(0, +a.dataset.crumb + 1)); }; });
  $('obj-filter').value = '';
  if (!loc) { navNode = null; $('obj-node').innerHTML = '<div class="pmeta">Choose a tree to browse:</div>'; renderNavList(); return; }
  let n; try { n = await treeRpc(loc.ns, loc.handle); } catch (e) { $('obj-node').innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  navNode = n;
  const curName = n.name || n.entity_id || n.label || (loc.ns === 'ha' ? 'Home Assistant' : 'Agents');
  if (loc.ns === 'contacts') { // contact view — a single contact can be SHARED as a read-only granule
    if (n.kind === 'contacts') { $('obj-node').innerHTML = `<div class="kv"><b>👥 Contacts</b> <span class="pill">${(n.children || []).length}</span></div>`; }
    else {
      const det = [n.org && `🏢 ${n.org}`, ...(n.emails || []).map(e => `✉️ ${e}`), ...(n.tels || []).map(t => `📞 ${t}`), n.note && `📝 ${n.note}`].filter(Boolean);
      $('obj-node').innerHTML = `<div class="kv" style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span><b>👤 ${esc(curName)}</b></span><button class="mini" id="sh-contact">🔗 share this contact</button></div>${det.length ? `<div style="font-size:13px;margin-top:6px;white-space:pre-wrap">${det.map(esc).join('<br>')}</div>` : '<div class="pmeta">contact</div>'}`;
      const sb = $('sh-contact'); if (sb) sb.onclick = () => mintNode('contacts', n.handle, curName, true);
    }
    renderNavList(); return;
  }
  if (loc.ns === 'timers') { // timers root → count; each timer is a leaf shared (view+cancel) from the list
    $('obj-node').innerHTML = `<div class="kv"><b>⏰ Timers</b> <span class="pill">${(n.children || []).length}</span></div><div class="pmeta" style="margin-top:4px">share one → the holder can view + cancel that timer (not schedule new ones)</div>`;
    renderNavList(); return;
  }
  const kind = String(n.kind || '').replace(/^ha-/, '').replace(/^agent-roster$/, 'agents').replace(/^agent$/, 'agent').replace(/^home(-folder)?$/, 'files').replace(/^notes(-folder)?$/, 'notes');
  const roNs = loc.ns === 'home' || loc.ns === 'notes'; // these share as read-only granules (no "full")
  const noFull = n.readOnly || roNs;
  $('obj-node').innerHTML = `<div class="kv" style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span><b>${esc(kind)}</b> ${esc(curName)}${n.readOnly ? ' · read-only' : ''}</span><span><button class="mini" id="sh-ro">share${roNs ? '' : ' read-only'}</button>${noFull ? '' : '<button class="mini" id="sh-full">share full</button>'}</span></div>${n.truncated ? `<div class="pmeta" style="margin-top:4px">+${n.truncated} more not shown — drill into a subfolder or use the filter</div>` : ''}`;
  $('sh-ro').onclick = () => mintNode(loc.ns, n.handle, curName, true);
  if ($('sh-full')) $('sh-full').onclick = () => mintNode(loc.ns, n.handle, curName, false);
  renderNavList();
};
const mint = async () => {
  $('minted').innerHTML = ''; const btn = $('mint'); btn.disabled = true;
  try {
    const r = await rpc('share', [$('sh-power').value, $('sh-label').value]);
    // r.url carries the cap → never render it; keep it in this closure, offer copy/QR only.
    $('minted').innerHTML = `<span class="pill">✓ “${esc(r.label)}” · ${esc(r.power)}</span> <button class="mini" id="copy">copy link</button> <button class="mini" id="qr">QR</button>`;
    $('copy').onclick = e => copyLink(r, e.currentTarget);
    $('qr').onclick = () => showQr(r);
    $('sh-label').value = '';
    await refreshShares();
  } catch (e) { $('minted').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  finally { btn.disabled = false; }
};

// ── chats / projects (left drawer) ──────────────────────────────────────────
const CHATS_KEY = 'field-agent-chats', ACTIVE_KEY = 'field-agent-active';
const txKey = id => `field-agent-tx-${id}`;
let chats = [];
// Deletion tombstones — the sync MERGES (never drops a local chat) to prevent the "chats vanished"
// data loss; tombstones let a delete still propagate across devices instead of resurrecting.
const DELETED_KEY = 'field-agent-deleted';
let deletedIds = (() => { try { return new Set(JSON.parse(localStorage.getItem(DELETED_KEY)) || []); } catch { return new Set(); } })();
const saveDeleted = () => { try { localStorage.setItem(DELETED_KEY, JSON.stringify([...deletedIds].slice(-2000))); } catch {} };
// Chat-list overflow: filter + paginate so a long history is searchable, never hidden/lost.
let chatFilter = '';
const CHAT_PAGE = 40;
let chatShowN = CHAT_PAGE;
let memoRuns = []; // server-owned traceable runs, one per incoming voice memo (versioned)
let seedChats = []; // ingested voice-note chats (full objects incl. versions) — the harness applies here too
let memoVersion = 0; // which version of the active run (memo OR seed-chat) is shown
// a "run" = anything with a versions[] harness: a memo run or an ingested seed-chat
const runFor = id => memoRuns.find(r => r.id === id) || seedChats.find(r => r.id === id) || null;
const loadMemos = async () => { if (!cap) return; try { const r = await (await fetch('/memos/load', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) })).json(); memoRuns = r.runs || []; renderChatList(); tryOpenPendingChat(); } catch {} };
// seed-chats: voice notes (etc.) ingested server-side as first-class chats. Adopt
// each ONCE into our own chat list (additive — never clobbers unsynced local edits);
// the adopted-set means a chat we later delete won't keep re-appearing.
const SEEDED_KEY = 'field-agent-seeded';
const loadSeedChats = async () => {
  if (!cap) return;
  try {
    const r = await (await fetch('/seed-chats/load', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) })).json();
    const seeds = r.chats || [];
    seedChats = seeds; // keep the full objects (with versions) for the re-run/scrub harness
    let seen; try { seen = new Set(JSON.parse(localStorage.getItem(SEEDED_KEY) || '[]')); } catch { seen = new Set(); }
    let added = false;
    for (const s of seeds.slice().reverse()) { // oldest first → newest ends up on top
      if (s.source === 'scheduled') { seen.add(s.id); continue; } // ⏰ timer-agent runs stay out of the sidebar (kept in seedChats, viewable per-agent, GC'd after a week)
      if (seen.has(s.id) || chats.some(c => c.id === s.id)) { seen.add(s.id); continue; }
      chats.unshift({ id: s.id, title: s.title || 'voice note', ts: s.ts || Date.now() });
      try { localStorage.setItem(txKey(s.id), JSON.stringify(s.tx || [])); } catch {}
      seen.add(s.id); added = true;
    }
    try { localStorage.setItem(SEEDED_KEY, JSON.stringify([...seen])); } catch {}
    if (added) { saveChats(); renderChatList(); tryOpenPendingChat(); }
  } catch {}
};
// ── per-chat top-level agent + model-provider selectors. The model choice is
//    remembered PER AGENT and applied to new chats with that agent. ───────────────────
const MODELS_KEY = 'field-agent-model-by-agent';
// Curated OpenRouter providers for the model menu. The id carries an `openrouter:` prefix so the
// backend (tool-bridge callLLM) routes it to OpenRouter; the rest is the real OpenRouter slug. Each
// label shows a compact cost · size · speed hint. Authored small→big = the hold-to-escalate ladder.
const OPENROUTER_MODELS = [
  { slug: 'openai/gpt-4o-mini',                name: 'GPT-4o mini',    cost: '$',   size: 'S',  speed: '⚡⚡⚡' },
  { slug: 'google/gemini-2.0-flash-001',       name: 'Gemini Flash',   cost: '$',   size: 'M',  speed: '⚡⚡⚡' },
  { slug: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B',  cost: '$',   size: 'L',  speed: '⚡⚡' },
  { slug: 'deepseek/deepseek-chat',            name: 'DeepSeek V3',    cost: '$',   size: 'L',  speed: '⚡⚡' },
  { slug: 'openai/gpt-4o',                     name: 'GPT-4o',         cost: '$$',  size: 'L',  speed: '⚡⚡' },
  { slug: 'moonshotai/kimi-k2.7-code',         name: 'Kimi K2.7 Code', cost: '$$',  size: 'XL', speed: '⚡⚡' },
].map(m => ({ id: `openrouter:${m.slug}`, name: m.name, size: m.size, label: `${m.name} · ${m.cost} · ${m.size} · ${m.speed}` }));
// Anthropic models go DIRECT to the Anthropic API (ANTHROPIC_API_KEY from ~/.env), NOT OpenRouter — id
// `anthropic:<model-id>`, which tool-bridge callLLM dispatches to api.anthropic.com and costModel prices.
const ANTHROPIC_MODELS = [
  { id: 'anthropic:claude-haiku-4-5',  name: 'Claude Haiku',  cost: '$',   size: 'M',  speed: '⚡⚡⚡' },
  { id: 'anthropic:claude-sonnet-4-6', name: 'Claude Sonnet', cost: '$$',  size: 'L',  speed: '⚡⚡' },
  { id: 'anthropic:claude-opus-4-8',   name: 'Claude Opus',   cost: '$$$', size: 'XL', speed: '⚡' },
].map(m => ({ id: m.id, name: m.name, size: m.size, label: `${m.name} · ${m.cost} · ${m.size} · ${m.speed}` }));
const LOCAL_DEFAULT = { id: 'default', name: 'Gemma (local)', size: 'M', label: 'Gemma · local · free · ⚡⚡⚡' };
// size→big ladder for "hold the send button to escalate to the next biggest model"
const MODEL_LADDER = [LOCAL_DEFAULT, ...OPENROUTER_MODELS, ...ANTHROPIC_MODELS];
let modelList = [LOCAL_DEFAULT, ...OPENROUTER_MODELS, ...ANTHROPIC_MODELS];
let agentList = ['field-agent'];
let agentMeta = {}; // id → { name, builtin } — drives the grouped agent menu + the Settings agent picker
let projectList = []; // defined projects, surfaced in the agent menu so a project-scoped chat is one tap away
const pendingProjectId = {}; // sessionId → projectId for an ephemeral chat not yet committed to a project
let pendingScopePowers = null; // the powers approved in the consent gate, stashed until the chat commits
const rememberedModels = () => { try { return JSON.parse(localStorage.getItem(MODELS_KEY) || '{}'); } catch { return {}; } };
const rememberModel = (agent, model) => { try { const m = rememberedModels(); m[agent] = model; localStorage.setItem(MODELS_KEY, JSON.stringify(m)); } catch {} };
const curChatObj = () => chats.find(c => c.id === sessionId) || null;
// id → powers[] for each entrypoint specialist (so a chat can show its agent's ring up front).
let specialistPowers = {};
let specialistSpawnedFrom = {}; // specialist id → the chatId it was spawned from (for the "↑ from" link)
// sessionId → selected entrypoint agent for an EPHEMERAL chat (not yet committed to chats[]).
const pendingAgent = {};
const chatAgent = () => (curChatObj() || {}).agent || pendingAgent[sessionId] || 'field-agent';
// the powers to show at the top of a chat: a handed-off chat's granted ring, else (for a non-Agent-C
// entrypoint specialist) that agent's ring. Agent C (the setup agent) shows none — it "reads all".
const chatBannerPowers = () => {
  const cc = curChatObj() || {};
  if (Array.isArray(cc.scopedPowers) && cc.scopedPowers.length) return cc.scopedPowers;
  const ag = chatAgent();
  return ag && ag !== 'field-agent' ? (specialistPowers[ag] || []) : [];
};
const chatModel = () => (curChatObj() || {}).model || rememberedModels()[chatAgent()] || 'default';
// the agent menu's option groups: Agent C · the built-in domain agents (Dietician, …) · your spawned
// specialists. Reused by the Settings shape picker. Built-ins carry builtin:true (from listSpecialists).
const agentGroupsHtml = () => {
  const builtin = agentList.filter(a => a !== 'field-agent' && agentMeta[a] && agentMeta[a].builtin);
  const mine = agentList.filter(a => a !== 'field-agent' && !(agentMeta[a] && agentMeta[a].builtin));
  const opt = a => `<option value="${esc(a)}">${esc((agentMeta[a] && agentMeta[a].name) || a)}</option>`;
  let h = `<option value="field-agent">🗣️ Agent C</option>`;
  if (builtin.length) h += `<optgroup label="Agents">${builtin.map(opt).join('')}</optgroup>`;
  if (mine.length) h += `<optgroup label="Your specialists">${mine.map(opt).join('')}</optgroup>`;
  return h;
};
const populateAgentSel = () => {
  const s = $('agent-sel'); if (!s) return;
  // every defined project gets an entry — picking one starts a fresh chat filed under that project
  const projs = projectList.length
    ? `<optgroup label="New chat in project…">${projectList.map(p => `<option value="project:${esc(p.id)}">📁 ${esc(p.name)}</option>`).join('')}</optgroup>`
    : '';
  s.innerHTML = agentGroupsHtml() + projs;
};
const populateModelSel = () => { const s = $('model-sel'); if (s) s.innerHTML = modelList.map(m => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join(''); };
const syncSelectors = () => {
  const as = $('agent-sel'), ms = $('model-sel'); if (!as || !ms) return;
  const show = curTab === 'talk' && !!cap;
  as.classList.toggle('hide', !show); ms.classList.toggle('hide', !show);
  as.value = chatAgent(); ms.value = chatModel();
};
const loadModels = async () => { if (!cap) return; try { const r = await (await fetch('/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) })).json(); const local = (r.models && r.models.length) ? r.models : [LOCAL_DEFAULT]; modelList = [...local, ...OPENROUTER_MODELS, ...ANTHROPIC_MODELS]; populateModelSel(); syncSelectors(); } catch {} };
const loadAgentList = async () => {
  agentList = ['field-agent']; specialistPowers = {}; specialistSpawnedFrom = {}; agentMeta = {};
  if (heldPowers.has('specialists')) { try { const specs = await rpc('listSpecialists'); for (const s of (specs || [])) if (s && s.id) { agentList.push(s.id); specialistPowers[s.id] = Array.isArray(s.powers) ? s.powers : []; if (s.spawnedFrom) specialistSpawnedFrom[s.id] = s.spawnedFrom; agentMeta[s.id] = { name: s.name || s.id, builtin: !!s.builtin }; } } catch {} }
  populateAgentSel(); syncSelectors();
};
// Defined projects feed the agent menu's "New chat in project…" group. /projects/list is
// root-gated, so a shared/sub cap simply gets an empty list (no project entries) — graceful.
const loadProjectList = async () => {
  if (!cap) return;
  try {
    const r = await (await fetch('/projects/list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) })).json();
    projectList = (r && Array.isArray(r.projects)) ? r.projects.map(p => ({ id: p.id, name: p.name })) : [];
  } catch { projectList = []; }
  populateAgentSel(); syncSelectors();
};
// Start a fresh chat filed under a project. The chat is ephemeral (see newChat) until its first
// message; we remember the project against its sessionId and attach it on commit (in sendChat) so
// the project's grouping + shared home folder apply without leaving empty rows behind.
const startProjectChat = pid => {
  newChat();                          // mint a fresh ephemeral chat (sessionId set, not yet persisted)
  pendingProjectId[sessionId] = pid;  // remember its project until the first message commits the chat
  syncSelectors();                    // a project is an action, not a sticky value → revert the menu to the chat's agent
  const i = $('text'); if (i) i.focus();
  const p = projectList.find(x => x.id === pid);
  if (p) setStatus(`new chat in 📁 ${p.name}`);
};
// scrub to a version of the active run (memo run OR ingested seed-chat) — the history bar
const selectVersion = idx => {
  const r = runFor(sessionId); if (!r || !r.versions) return;
  memoVersion = Math.max(0, Math.min(idx, r.versions.length - 1));
  const ver = r.versions[memoVersion] || {};
  activeTx = [{ who: 'you', text: r.transcript }, { who: 'agent', text: ver.answer || '', tools: ver.toolsUsed || [], steps: ver.steps || [] }];
  renderTx(); renderChatBar();
  if (traceInst && !$('trace-overlay').classList.contains('hide')) { traceInst.render(activeTx); renderTraceVersions(); } // scrubbing a version updates the open trace + its scrubber
  refreshTraceApp();
};
// per-chat top bar: version scrubber + re-run (any run with versions[])
const renderChatBar = () => {
  const bar = $('chat-bar'); if (!bar) return;
  if (!sessionId || curTab !== 'talk') { bar.classList.add('hide'); return; }
  bar.classList.remove('hide');
  const run = runFor(sessionId); // memo run or ingested seed-chat: both carry the versions[] eval harness
  if (run) {
    const vs = run.versions || [];
    const icon = String(sessionId).startsWith('memo-') ? '🎙 ' : '🎙 ';
    const scrub = vs.length > 1 ? `<span class="cb-scrub"><button class="mini" data-vprev ${memoVersion <= 0 ? 'disabled' : ''}>◀</button> <b>${esc((vs[memoVersion] || {}).label || ('v' + memoVersion))}</b> <span class="pill">${memoVersion + 1}/${vs.length}</span> <button class="mini" data-vnext ${memoVersion >= vs.length - 1 ? 'disabled' : ''}>▶</button></span>` : '';
    bar.innerHTML = `<span class="cb-title">${icon}${esc(run.title || 'chat')}</span>${scrub}<span style="flex:1"></span><button class="mini" id="cb-rerun">↻ Re-run / change env</button>`;
    const pv = bar.querySelector('[data-vprev]'); const nx = bar.querySelector('[data-vnext]');
    if (pv) pv.onclick = () => selectVersion(memoVersion - 1);
    if (nx) nx.onclick = () => selectVersion(memoVersion + 1);
    $('cb-rerun').onclick = () => openRerun(run);
  } else {
    const c = chats.find(x => x.id === sessionId) || {};
    let badge = '';
    if (c.shared && c.shareToken) { // make the holder's rights on a shared-chat capability obvious
      badge = c.shareMode === 'write'
        ? `<span class="cb-right write">✍️ live room · you can post${c.shareAllowance ? ' · metered allowance' : ''}</span>`
        : `<span class="cb-right ro">🔒 live room · read-only — view, can't post</span>`;
    }
    let projChip = '';
    if (c.projectId) { // chat filed under a project → surface its shared home folder at the top
      const pj = projectList.find(x => x.id === c.projectId);
      projChip = `<button class="mini cb-proj" data-openproj="${esc(c.projectId)}" title="open this project's shared files">📂 ${esc((pj && pj.name) || 'project')}</button>`;
    }
    let parentChip = '';
    if (c.parentId) { // a delegate / attenuated sub-chat → link back to the chat it was created from
      const par = chats.find(x => x.id === c.parentId);
      parentChip = par
        ? `<button class="mini cb-parent" data-openparent="${esc(c.parentId)}" title="open the chat this was created from">↑ from: ${esc(par.title || 'parent chat')}</button>`
        : `<span class="mini" style="opacity:.6" title="the originating chat is no longer available">↑ from: ${esc(c.parentTitle || 'parent chat')}</span>`;
    }
    bar.innerHTML = `<span class="cb-title">${esc(c.title || 'chat')}</span>${parentChip}${projChip}<span style="flex:1"></span>${badge}`;
    const pb = bar.querySelector('[data-openproj]');
    if (pb) pb.onclick = () => { openProjectId = pb.dataset.openproj; renderProjects(); };
    const pp = bar.querySelector('[data-openparent]');
    if (pp) pp.onclick = () => switchChat(pp.dataset.openparent);
  }
  applyShareMode();
};
// Gate the composer to the holder's actual rights: a read-only shared chat disables posting + says why,
// instead of letting you type and silently failing on send.
const applyShareMode = () => {
  const c = chats.find(x => x.id === sessionId) || {};
  const ro = !!(c.shared && c.shareToken && c.shareMode !== 'write');
  const input = $('text'), sendBtn = $('send'), mic = $('mic-btn') || $('mic');
  if (input) { input.disabled = ro; input.placeholder = ro ? '🔒 read-only link — you can view this chat but not post' : 'Message Agent C…'; }
  if (sendBtn) sendBtn.disabled = ro;
  if (mic) mic.disabled = ro;
};
// re-run the SAME transcript under changed instructions → a new version. Works for
// memo runs (/memo/rerun) and ingested seed-chats (/chat/rerun).
const openRerun = r => {
  if (!r) return; const cur = ((r.versions || [])[memoVersion] || {}).env || {};
  const endpoint = String(r.id).startsWith('memo-') ? '/memo/rerun' : '/chat/rerun';
  const refresh = String(r.id).startsWith('memo-') ? loadMemos : loadSeedChats;
  showModal(`<div class="qrlabel">↻ Re-run "${esc(r.title)}" under changed instructions</div><span class="qrwarn">Edit the agent's instructions, then re-run the same transcript to see how the trace changes.</span><textarea id="rr-persona" rows="5" style="width:340px;max-width:84vw" placeholder="(agent instructions — blank = default)">${esc(cur.persona || '')}</textarea><div id="rr-status" class="pill"></div><button class="mini" id="rr-go">Re-run</button>`);
  $('rr-go').onclick = async () => {
    $('rr-go').disabled = true; $('rr-status').textContent = 'running…';
    const res = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, id: r.id, persona: $('rr-persona').value }) }).then(x => x.json()).catch(e => ({ ok: false, error: e.message }));
    if (res.ok) { closeModal(); await refresh(); const nr = runFor(r.id); memoVersion = nr && nr.versions ? nr.versions.length - 1 : memoVersion; selectVersion(memoVersion); }
    else { $('rr-status').textContent = 'error: ' + (res.error || ''); $('rr-go').disabled = false; }
  };
};
const loadChats = () => { try { return JSON.parse(localStorage.getItem(CHATS_KEY)) || []; } catch { return []; } };
const saveChats = () => { try { localStorage.setItem(CHATS_KEY, JSON.stringify(chats)); } catch {} scheduleSync(); };
const loadTx = id => { try { return JSON.parse(localStorage.getItem(txKey(id))) || []; } catch { return []; } };
// drop heavy/ephemeral media (image data-URLs, audio blob-URLs) before persisting;
// they live only in the in-memory activeTx so the 3D trace can show/play them this session.
const stripImg = tx => tx.map(m => {
  let n = (m.images || m.audio || m.attachImgs) ? { ...m, images: undefined, audio: undefined, attachImgs: undefined } : m;
  if (m.forks) n = { ...n, forks: m.forks.map(f => (f && f.tail) ? { ...f, tail: stripImg(f.tail) } : f) }; // strip stashed-fork tails too (no data-URL bloat in inactive branches)
  return n;
});
// persist transcript WITHOUT image data URLs (they'd blow the localStorage quota);
// images stay in the in-memory activeTx so the 3D trace can render them this session.
const saveTx = () => { try { localStorage.setItem(txKey(sessionId), JSON.stringify(stripImg(activeTx).slice(-120))); } catch {} scheduleSync(); };

// ── cross-device sync: the chat list + transcripts live server-side keyed by the
//    cap, so the same root link shows the same chats on phone + laptop. localStorage
//    is the fast/offline cache; the server is the shared source of truth. ──────────
const UPD_KEY = 'field-agent-updated';
let syncTimer = null;
function bundleAll(updated) {
  const b = { chats, active: sessionId, updated, deleted: [...deletedIds].slice(-2000),
    tx: Object.fromEntries(chats.map(c => [c.id, stripImg(loadTx(c.id)).slice(-200)])) };
  // Keep the payload under the server limit by trimming the OLDEST chats' transcripts first (chats[0] is
  // newest). The LIST — which must never be lost — always rides; only old transcripts drop from the sync.
  const order = chats.map(c => c.id);
  for (let i = order.length - 1; i >= 0 && JSON.stringify(b).length > 5 * 1024 * 1024; i -= 1) delete b.tx[order[i]];
  return b;
}
let initialSyncDone = false; // true once the first syncLoad has talked to the server
function scheduleSync() {
  if (!cap) return;
  // SAFETY: a fresh/empty client must NOT push (nor stamp itself "freshest") before it has loaded the
  // server's bundle — that race let an empty profile overwrite a populated server bundle (chats lost).
  // Once we've synced at least once, an empty list IS legitimate (e.g. the user deleted all their chats).
  if (!chats.length && !initialSyncDone) return;
  const now = Date.now(); try { localStorage.setItem(UPD_KEY, String(now)); } catch {} // mark local as freshest
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { fetch('/chats/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, data: bundleAll(now) }) }).catch(() => {}); }, 1500);
}
function adoptBundle(b, { keepActive = false } = {}) {
  if (!b || !Array.isArray(b.chats)) return false;
  // MERGE, never replace — a stale/partial server bundle (e.g. one frozen because transcript bloat once
  // exceeded the save limit) must NEVER delete a local chat. Union by id; tombstoned ids stay deleted.
  for (const id of (Array.isArray(b.deleted) ? b.deleted : [])) deletedIds.add(id);
  const byId = new Map(chats.map(c => [c.id, c]));
  for (const sc of b.chats) {
    if (!sc || !sc.id) continue;
    const ex = byId.get(sc.id);
    if (!ex) { byId.set(sc.id, sc); continue; }
    const merged = { ...ex, ...sc, ts: Math.max(ex.ts || 0, sc.ts || 0) };
    if (ex.title && ex.title !== 'New chat' && (!sc.title || sc.title === 'New chat')) merged.title = ex.title; // keep a real title over a placeholder
    byId.set(sc.id, merged);
  }
  chats = [...byId.values()].filter(c => !deletedIds.has(c.id)).sort((a, c) => (c.ts || 0) - (a.ts || 0));
  saveDeleted();
  try { localStorage.setItem(CHATS_KEY, JSON.stringify(chats)); } catch {}
  // tx: only adopt a server transcript if it's non-empty AND we don't already hold a longer local one —
  // never clobber a richer local transcript with a trimmed/empty server copy.
  for (const [id, tx] of Object.entries(b.tx || {})) {
    if (!Array.isArray(tx) || !tx.length || deletedIds.has(id)) continue;
    if (loadTx(id).length <= tx.length) { try { localStorage.setItem(txKey(id), JSON.stringify(tx)); } catch {} }
  }
  try { localStorage.setItem(UPD_KEY, String(b.updated || 0)); } catch {}
  // keepActive: adopt the shared chat LIST but stay on the current (blank boot) chat, so
  // the cross-device load never yanks focus to the most-recent chat on page load.
  if (!keepActive) {
    const active = (b.active && chats.find(c => c.id === b.active)) ? b.active : (chats[0] || {}).id;
    if (active) { sessionId = active; try { localStorage.setItem(ACTIVE_KEY, active); } catch {} activeTx = loadTx(active); }
  }
  return true;
}
async function syncLoad({ keepActive = false } = {}) {
  if (!cap) return;
  try {
    const r = await fetch('/chats/load', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) });
    const { data } = await r.json();
    initialSyncDone = true; // we've now seen the server's bundle — pushes (incl. a legit empty list) are safe from here
    const localUpdated = +(localStorage.getItem(UPD_KEY) || 0);
    // adopt the server's chats only if they're at least as fresh as our last local edit
    if (data && Array.isArray(data.chats) && data.chats.length && (data.updated || 0) >= localUpdated) {
      if (adoptBundle(data, { keepActive })) { renderChatList(); if (!keepActive) renderTx(); tryOpenPendingChat(); }
    } else { scheduleSync(); } // server empty/older → push our local state up
  } catch {}
}
const pushTx = (who, text, extra = {}) => { activeTx.push({ who, text, at: Date.now(), ...extra }); saveTx(); };

// ── apps minimized into a chat ───────────────────────────────────────────────
// Mount an APP (an island + its host controller) INLINE, authorized by the CHAT's cap — so a standalone
// /apps page can be "minimized" into a chat as a live, interactive widget, and a scoped recipient gets the
// same view, attenuated to their grant. (Reuses the FileBrowser island + /files; chatCap() = root for the
// owner, or the scoped app-share cap for a recipient.)
const mountAppInto = async (el, app) => {
  if (app !== 'file-browser') { el.textContent = `unknown app: ${app}`; return; }
  const apf = (p, b = {}) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: chatCap(), ...b }) }).then(r => r.json()).catch(e => ({ error: e.message }));
  const roots = ((await apf('/files/roots')).roots) || [];
  if (!roots.length) { el.textContent = '(this capability has no access to this app)'; return; }
  const st = { root: (roots[0] && roots[0].key) || 'vault', path: '', entries: [], file: null, busy: false, error: '' };
  const rel = n => (st.path ? `${st.path}/${n}` : n);
  const draw = () => { if (window.__fieldIslands && window.__fieldIslands.renderInto) window.__fieldIslands.renderInto('FileBrowser', el, { roots, root: st.root, path: st.path, entries: st.entries, file: st.file, busy: st.busy, error: st.error, onRoot, onOpen, onCrumb, onAdd, onDownload, onRemove, onCloseFile }); };
  const list = async () => { st.busy = true; st.error = ''; st.file = null; draw(); const r = await apf('/files/list', { root: st.root, path: st.path }); st.busy = false; if (r.error) { st.error = r.error; st.entries = []; } else st.entries = r.entries || []; draw(); };
  const onRoot = k => { st.root = k; st.path = ''; st.file = null; list(); };
  const onCrumb = i => { const s = st.path.split('/').filter(Boolean); st.path = i < 0 ? '' : s.slice(0, i + 1).join('/'); st.file = null; list(); };
  const onOpen = async (n, isDir) => { if (isDir) { st.path = rel(n); list(); return; } st.busy = true; draw(); const r = await apf('/files/get', { root: st.root, path: rel(n) }); st.busy = false; if (r.error) st.error = r.error; else st.file = { name: r.name, text: r.text, size: r.size, b64: r.b64 }; draw(); };
  const onCloseFile = () => { st.file = null; draw(); };
  const onDownload = () => { const f = st.file; if (f && f.b64) dlB64(f.name, f.b64); };
  const onRemove = async n => { if (!confirm(`Delete ${n}?`)) return; const r = await apf('/files/rm', { root: st.root, path: rel(n) }); if (r.error) { st.error = r.error; draw(); } else { st.file = null; list(); } };
  const onAdd = () => { const inp = document.createElement('input'); inp.type = 'file'; inp.onchange = async () => { const f = inp.files && inp.files[0]; if (!f) return; if (f.size > 25 * 1024 * 1024) { st.error = `${f.name} over 25MB`; draw(); return; } st.busy = true; draw(); const b64 = await fileToB64(f); const r = await apf('/files/put', { root: st.root, path: rel(f.name), b64 }); st.busy = false; if (r.error) st.error = r.error; list(); }; inp.click(); };
  list();
};
// minimize an app into a fresh chat as a persistent inline widget, then open it.
const minimizeAppToChat = app => {
  newChat(); // mint a fresh ephemeral chat (sessionId set)
  if (!chats.some(c => c.id === sessionId)) { chats.unshift({ id: sessionId, title: `🧩 ${app}`, ts: Date.now(), lastMsgAt: Date.now() }); saveChats(); } // commit it (no first message would otherwise persist it)
  pushTx('widget', '', { app }); // the minimized app, rendered inline by renderTx
  document.body.classList.remove('landing'); showTab('talk'); renderTx(); renderChatList();
};
// Open a confined FORK inline in a chat. `fork` = { id?, shareToken?, name? } — owner mounts by id, a
// recipient (shared link) mounts by shareToken. Mirrors minimizeAppToChat: a fresh chat, the fork widget.
const openForkInChat = (fork, title) => {
  newChat();
  if (!chats.some(c => c.id === sessionId)) { chats.unshift({ id: sessionId, title: title || `⑂ ${fork.name || 'fork'}`, ts: Date.now(), lastMsgAt: Date.now() }); saveChats(); }
  pushTx('widget', '', { fork });
  document.body.classList.remove('landing'); showTab('talk'); renderTx(); renderChatList();
};
// Fork an island/app: snapshot its source server-side into a NEW user fork, then open it inline to edit.
// `source` is the (endowments,props)=>vnode text; for islands we seed from a minimal wrapper the agent edits.
const forkIntoChat = async ({ source, name, baseId }) => {
  const r = await fetch('/forks/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: chatCap(), source, name, baseId }) }).then(x => x.json()).catch(e => ({ ok: false, error: e.message }));
  if (!r.ok) { alert(r.error || 'could not fork'); return; }
  openForkInChat({ id: r.id, name }, `⑂ ${name || 'fork'}`);
};
window.forkIntoChat = forkIntoChat; // reachable from the components/apps surfaces
const titleFrom = t => { const ch = chats.find(c => c.id === sessionId); if (ch && (!ch.title || ch.title === 'New chat')) { ch.title = t.slice(0, 40); saveChats(); renderChatList(); } };

// Google-style landing: an empty chat centres the composer in mid-screen (with a
// tagline); the first message drops it to the bottom. Driven off the active tab + cap +
// whether the transcript is still empty, so it stays correct across chat switches/reloads.
const syncLanding = () => document.body.classList.toggle('landing', curTab === 'talk' && !!cap && !activeTx.length);

// Re-grant/revoke this chat's powers in place (banner + Add / ×). Root-only; recovers an orphaned cap.
const rescopeChat = async (cc, newPowers) => {
  const r = await pf('/chat/rescope', { swiss: cc.scopedCap || '', powers: newPowers, label: cc.title });
  if (!r || r.error) { alert((r && r.error) || 'could not change powers'); return; }
  cc.scopedCap = r.scopedCap; cc.scopedPowers = r.powers; saveChats();
  setStatus(r.recovered ? 'powers re-granted — chat recovered' : 'powers updated');
  renderTx();
};
function wirePowerBanner(b, cc, ps) {
  b.querySelectorAll('[data-revoke]').forEach(x => { x.onclick = async () => {
    const p = x.dataset.revoke;
    if (!confirm(`Revoke “${p}” from this chat? The agent will lose that ability here.`)) return;
    await rescopeChat(cc, ps.filter(q => q !== p));
  }; });
  const add = b.querySelector('[data-addpower]');
  if (add) add.onclick = () => {
    const avail = [...(heldPowers || [])].filter(p => !ps.includes(p));
    if (!avail.length) { alert('this chat already holds every power you can grant'); return; }
    showModal(`<div class="dkm" style="text-align:left;max-width:420px;margin:-18px -18px 8px;padding:16px;border-radius:12px 12px 0 0"><b>+ Add a power to this chat</b>
      <div style="font-size:13px;color:var(--mut);margin:6px 0">Grant the agent in THIS chat another ability. Revocable any time (×).</div>
      <div id="ap-list"></div>
      <button class="mini" id="ap-go" style="margin-top:10px">Grant</button></div>`);
    renderPowersPicker($('ap-list'), { all: avail, granted: [] }); // add-only: the chat's current ring is shown (with ×) in the banner above
    $('ap-go').onclick = async () => { const add2 = [...document.querySelectorAll('#ap-list input:checked')].map(x => x.value); if (!add2.length) return; closeModal(); await rescopeChat(cc, [...ps, ...add2]); };
  };
}
// ── W2: PROMPT FORK / RETRY — each user turn's answer can hold model/param VARIANTS (forks). A ↻ retry
//    ↻ re-runs the prompt (clears everything below + forks a new branch from that point); ◀/▶ pages this
//    user turn's forks (each a {prompt, tail} continuation); ✎ edits the prompt + retries; 🔊 plays a voice
//    message's original audio. Forks live on the USER tx entry (m.forks/m.forkIx) — see runRetry/pageFork. ──
const _arr = v => (Array.isArray(v) ? v : (v ? [v] : []));
// activeVariant keeps backward-compat with OLD answer-variant data: a plain agent entry reads as its own
// base variant; an entry that still carries .variants (pre-fork-redesign chats) renders the active one.
const baseVariant = am => ({ answer: am.text || '', steps: _arr(am.steps), ui: _arr(am.ui), tools: _arr(am.tools), agentId: am.agent, model: am.vmodel || 'default', agent: am.vagent || 'field-agent', prompt: null, ts: am.ts || 0 });
const activeVariant = am => (am && am.variants && am.variants.length) ? am.variants[Math.max(0, Math.min(am.varIx || 0, am.variants.length - 1))] : baseVariant(am);
const histUpTo = uIx => activeTx.slice(0, uIx).filter(m => m && m.who).map(m => ({ role: m.who === 'you' ? 'user' : 'assistant', content: String(m.who === 'you' ? (m.text || '') : (activeVariant(m).answer || '')) })).filter(x => x.content.trim()).slice(-24);
// Retry FORKS the conversation at this user turn: stash the current branch (its prompt + everything below
// it), then start a fresh empty branch carrying the (maybe edited) prompt and re-run from here. Retrying
// CLEARS everything below the bubble. Each fork keeps its own continuation (tail), pageable from the bubble.
const runRetry = async (uIx, prompt) => {
  if (busy) { setStatus('finish the current turn first'); return; } // share the live-turn interlock — no mid-flight retry
  if (!forkRetry(activeTx, uIx, prompt)) return; // stash the live branch, start a fresh one, clear below
  saveTx(); renderTx(); // show the cleared transcript + the new prompt before the answer streams in
  busy = true; if (sendBtn) sendBtn.disabled = true;
  try { await retryTurn({ sessionId, text: prompt, cap: chatCap(), model: chatModel(), agent: chatAgent(), history: histUpTo(uIx) }, false); }
  finally { busy = false; if (sendBtn) sendBtn.disabled = false; }
};
// page between this user turn's forks: swap in the chosen branch's prompt + its whole continuation (tail).
const pageFork = (uIx, delta) => {
  if (busy) { setStatus('finish the current turn first'); return; }
  if (forkPage(activeTx, uIx, delta)) { saveTx(); renderTx(); }
};
// edit + retry: the edited prompt rides on a NEW fork (the base prompt + every fork stays recoverable).
// Edit a prompt INLINE inside its bubble (no browser prompt()): the bubble becomes a textarea prefilled with
// the message; Enter (or ✓) saves + retries from here (forks), Shift+Enter = newline, Esc (or ✕) cancels.
// runRetry → renderTx rebuilds the transcript, so the editor is ephemeral; cancel just re-renders the bubble.
const editPrompt = (uIx, bodyEl) => {
  if (busy) { setStatus('finish the current turn first'); return; }
  const m = activeTx[uIx]; if (!m) return;
  const host = bodyEl || (log.querySelectorAll('.msg.user')[uIx]);
  if (!host || host.querySelector('.msg-edit')) return; // no host, or already editing
  const orig = m.text || '';
  host.innerHTML = '';
  const ta = document.createElement('textarea');
  ta.className = 'msg-edit';
  ta.value = orig;
  ta.setAttribute('style', 'width:100%;box-sizing:border-box;font:inherit;color:inherit;background:rgba(0,0,0,.18);border:1px solid var(--acc,#7c5cff);border-radius:8px;padding:7px 9px;resize:none;overflow:hidden;line-height:1.4');
  const bar = document.createElement('div');
  bar.setAttribute('style', 'display:flex;gap:6px;justify-content:flex-end;margin-top:6px');
  const mkb = (label, title, fn) => { const b = document.createElement('button'); b.className = 'mc-btn'; b.textContent = label; b.title = title; b.onclick = fn; return b; };
  const grow = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(360, ta.scrollHeight)}px`; };
  const cancel = () => renderTx(); // rebuild → restores the original bubble
  const commit = () => { const v = ta.value.trim(); if (!v) { setStatus('empty — edit cancelled'); return cancel(); } runRetry(uIx, v); };
  bar.append(mkb('✕ Cancel', 'Discard the edit (Esc)', cancel), mkb('✓ Save & retry', 'Retry with this edited prompt (Enter)', commit));
  host.append(ta, bar);
  ta.oninput = grow; grow();
  ta.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); } else if (e.key === 'Escape') { e.preventDefault(); cancel(); } };
  ta.focus(); ta.setSelectionRange(orig.length, orig.length);
};
// the retry / edit / audio + fork-pager controls, rendered INSIDE the user prompt bubble they act on.
const userBubbleControls = (uIx, m, bodyEl) => {
  const fc = forkCount(m), fi = forkIndex(m);
  const row = document.createElement('div'); row.className = 'msg-ctrl';
  const mk = (label, title, fn) => { const b = document.createElement('button'); b.className = 'mc-btn'; b.textContent = label; b.title = title; b.onclick = fn; return b; };
  row.appendChild(mk('↻', 'Retry this prompt — clears everything below + forks a new branch from here', () => runRetry(uIx, m.text || '')));
  row.appendChild(mk('✎', 'Edit + retry this prompt (forks from here)', () => editPrompt(uIx, bodyEl)));
  if (m.audio) row.appendChild(mk('🔊', 'Play the original audio', () => { try { new Audio(m.audio).play(); } catch { /* */ } }));
  if (fc > 1) {
    const nav = document.createElement('span'); nav.className = 'mc-nav';
    nav.appendChild(mk('◀', 'Previous fork of this prompt', () => pageFork(uIx, -1)));
    const c = document.createElement('span'); c.className = 'mc-count'; c.textContent = `${fi + 1}/${fc}`; nav.appendChild(c);
    nav.appendChild(mk('▶', 'Next fork of this prompt', () => pageFork(uIx, 1)));
    row.appendChild(nav);
  }
  bodyEl.appendChild(row); // INSIDE the bubble — the controls visibly belong to the prompt they fork
};
const renderTx = () => {
  syncLanding();
  disposeAllWidgets(); // tear down any live widget streams/intervals from the previous render before rebuilding
  log.innerHTML = '';
  // Powers banner at the TOP of the chat — shown even before the first message: a handed-off chat's
  // granted ring, or (for a non-Agent-C entrypoint agent) that agent's powers. Agent C itself (the
  // setup agent) gets a DESCRIPTIVE banner: it reads everything but can only propose new agents.
  { const ps = chatBannerPowers();
    const cc = curChatObj() || {};
    const manageable = isRoot && !!cc.scopedCap; // the OWNER can re-grant/revoke THIS chat's powers in place
    const xbtn = p => manageable ? ` <button class="chip-x" data-revoke="${esc(p)}" title="revoke ${esc(p)}">×</button>` : '';
    const b = document.createElement('div'); b.className = 'powers-banner'; let show = true;
    if (Array.isArray(ps) && ps.length) {
      b.innerHTML = `<span class="pb-label">🔑 this chat can</span>${ps.map(p => `<span class="chip" title="${esc(powerTip(p))}">${powerIcon(p)} ${esc(p)}${xbtn(p)}</span>`).join('')}${manageable ? '<button class="chip chip-add" data-addpower title="grant another power">+ Add</button>' : ''}`;
    } else if (isRoot && chatAgent() === 'field-agent' && !cc.shareToken) {
      b.innerHTML = '<span class="pb-label">🔑 Agent C can</span><span class="chip">📖 read everything</span><span class="chip">🧑‍🔬 only propose new agents</span>';
    } else { show = false; }
    if (show) { log.appendChild(b); if (manageable) wirePowerBanner(b, cc, ps); } }
  if (!activeTx.length) return; // a new chat starts empty — no agent greeting (the banner above still shows)
  const asArr = v => (Array.isArray(v) ? v : (v ? [v] : [])); // coerce: a malformed (non-array) field must never throw + abort the whole render
  for (let i = 0; i < activeTx.length; i++) {
    const m = activeTx[i];
    try { // one bad message must not stop the rest of the transcript from rendering
      if (m.who === 'widget' && m.site) { log.appendChild(makeInlineWidget(m.site, m.id)); continue; } // a pasted site, rendered inline as a live widget
      if (m.who === 'widget' && m.app) { // an app minimized into this chat — mount the island + its controller inline (authorized by the chat's cap)
        const wrap = document.createElement('div'); wrap.className = 'msg';
        wrap.innerHTML = `<div class="who">🧩 <span>${esc(m.app)}</span> <span style="font-size:10px;color:var(--mut);opacity:.7;margin-left:6px">minimized app</span></div><div class="app-mount" style="margin-top:4px"></div>`;
        log.appendChild(wrap); try { mountAppInto(wrap.querySelector('.app-mount'), m.app); } catch { /* mount best-effort */ }
        continue;
      }
      if (m.who === 'widget' && m.fork) { // a confined FORK mounted inline (owner via id, recipient via shareToken)
        const wrap = document.createElement('div'); wrap.className = 'msg';
        wrap.innerHTML = `<div class="who">⑂ <span>${esc(m.fork.name || 'fork')}</span> <span style="font-size:10px;color:var(--mut);opacity:.7;margin-left:6px">${m.fork.shareToken ? 'shared fork' : 'your fork'}</span></div><div class="fork-mount" style="margin-top:4px"></div>`;
        log.appendChild(wrap);
        try { mountForkInto(wrap.querySelector('.fork-mount'), { cap: chatCap(), id: m.fork.id, shareToken: m.fork.shareToken, name: m.fork.name, onAdopt: fid => { m.fork = { id: fid, name: (m.fork.name || 'fork') + ' (mine)' }; saveTx(); } }); } catch { /* best-effort */ }
        continue;
      }
      if (m.who === 'agent') { // render the ACTIVE fork (model/param variant) of this answer
        const v = activeVariant(m);
        if (_arr(v.steps).length) log.appendChild(traceGeometry(_arr(v.steps))); // the SVG trace sits ABOVE the message (tap it for the 3D)
        const b = bubble('agent', v.answer, v.agentId || m.agent, m.at);
        const imgs = asArr(m.imageUrls).length ? asArr(m.imageUrls) : asArr(m.images).filter(s => typeof s === 'string' && s.startsWith('data:')); imgs.forEach(src => { const im = document.createElement('img'); im.src = src; b.appendChild(im); });
        if (_arr(v.ui).length) renderWidgets(b, _arr(v.ui), { cap: chatCap(), onChoice: t => sendChat(t), onBreakOut: breakOutComponent, onShareOut: shareOutComponent, onExpand: toggleApplet }); // re-hydrate live widgets
        if (_arr(v.tools).length) { const e = document.createElement('div'); e.className = 'tools'; e.textContent = '⚙ ' + _arr(v.tools).join(', '); b.parentNode.appendChild(e); }
        continue;
      }
      // a user message → its (active fork's) prompt, with the ↻/✎/🔊 + fork-pager controls INSIDE the bubble
      const b = bubble('you', m.text, m.agent, m.at);
      if (!m.text) b.textContent = '';
      appendAtt(b, asArr(m.attachUrls).length ? asArr(m.attachUrls) : asArr(m.attachImgs), asArr(m.attachFiles));
      userBubbleControls(i, m, b); // ↻ retry · ✎ edit · 🔊 audio · ◀ k/n ▶ forks — all inside the prompt bubble
    } catch (e) { console.error('renderTx message', e); }
  }
  // re-show any still-open typed asks the agent raised in THIS chat (persist across reloads)
  openAsks.filter(a => a.origin && a.origin.kind === 'chat' && a.origin.chatId === sessionId).forEach(a => log.appendChild(buildAskCard(a)));
  // dev (Blacksmith) tasks routed from THIS chat — visible, dev-framed, pending→done
  devTasks.filter(t => t.chatId === sessionId).forEach(devCard);
  schedulePendantPosition(); // re-anchor the live pendant after the log was rebuilt
  reapplyExpanded(); // an applet expanded in this chat stays expanded when you return to it (retained view-state)
  renderRunIndicator(); // ⏰ coalesced badge: this chat's scheduled watcher(s) ran N× since your last message
};

// ── in-chat run indicator ───────────────────────────────────────────────────
// A scheduled watcher created from a chat (originChat) runs silently in the
// background. Instead of N "it ran" messages, show ONE coalesced badge at the
// foot of the chat: how many times it ran since your last message + the most
// recent run time. NOT part of the model's context — just a visible marker.
let _chatWatchers = { sid: null, agents: [], at: 0 };
const _WATCHER_TTL = 45000;
const _relTime = ms => { const s = Math.max(0, (Date.now() - ms) / 1000); if (s < 90) return 'just now'; if (s < 5400) return `${Math.round(s / 60)}m ago`; if (s < 129600) return `${Math.round(s / 3600)}h ago`; return new Date(ms).toLocaleString(); };
const refreshChatWatchers = async sid => {
  if (!isRoot) return;
  try { const r = await pf('/projects/agents/by-chat', { chatId: sid }); if (sessionId === sid) { _chatWatchers = { sid, agents: (r && r.agents) || [], at: Date.now() }; renderRunIndicator(); } } catch { /* best-effort */ }
};
function renderRunIndicator() {
  const old = log.querySelector('#run-indicator'); if (old) old.remove();
  if (!isRoot) return;
  if (_chatWatchers.sid !== sessionId || Date.now() - _chatWatchers.at > _WATCHER_TTL) refreshChatWatchers(sessionId); // refresh stale/other-chat cache (async → re-renders)
  if (_chatWatchers.sid !== sessionId) return; // no cache for this chat yet
  const agents = _chatWatchers.agents || []; if (!agents.length) return;
  const cc = curChatObj() || {}; const since = cc.lastMsgAt || cc.ts || 0;
  const rows = agents.map(a => {
    const runs = a.runs || []; const latest = runs[0];
    const nNew = runs.filter(r => new Date(r.at).getTime() > since).length;
    const last = latest ? _relTime(new Date(latest.at).getTime()) : '';
    const head = nNew > 0 ? `ran ${nNew}× since your last message` : (latest ? `last checked ${last}` : 'scheduled — no runs yet');
    const tip = latest && latest.summary ? esc(String(latest.summary).slice(0, 200)) : '';
    return `<div style="padding:1px 0" title="${tip}">⏰ <b>${esc(a.name)}</b> · ${esc(head)}${nNew > 0 && latest ? ` · last ${esc(last)}` : ''}</div>`;
  }).join('');
  const el = document.createElement('div'); el.id = 'run-indicator';
  el.style.cssText = 'margin:12px auto;max-width:680px;padding:6px 11px;border:1px dashed var(--edge,#262c3d);border-radius:9px;color:var(--mut,#8b949e);font-size:12px;background:rgba(124,92,255,0.05);cursor:pointer';
  el.innerHTML = rows;
  el.onclick = () => { settingsSection = 'timers'; openSettings(); }; // open the full run log
  log.appendChild(el);
}

const SIDEBAR_KEY = 'field-agent-sidebar';
const setSidebar = open => { document.body.classList.toggle('sidebar-open', open); if (open) document.body.classList.remove('sidebar-peek'); /* pinning open supersedes a transient hover-peek */ try { localStorage.setItem(SIDEBAR_KEY, open ? '1' : '0'); } catch {} if (!$('trace-overlay').classList.contains('hide')) traceInst?.resize(); };
const openDrawer = () => setSidebar(true);
const closeDrawer = () => setSidebar(false);
const toggleDrawer = () => setSidebar(!document.body.classList.contains('sidebar-open'));
const renderChatList = () => {
  const host = $('chat-list'); if (!host) return;
  // a PERSISTENT search box (created once so typing keeps focus) above a re-rendered items container,
  // so a long history is searchable + paginated — never silently dropped.
  if (!host.querySelector('#chat-search')) {
    host.innerHTML = '<input id="chat-search" placeholder="search chats…" autocomplete="off" style="width:100%;box-sizing:border-box;margin:0 0 6px;padding:5px 8px;font:inherit;background:#11141f;border:1px solid #262c3d;border-radius:7px;color:inherit"><div id="chat-items"></div>';
    const si = host.querySelector('#chat-search'); si.value = chatFilter;
    si.oninput = () => { chatFilter = si.value; chatShowN = CHAT_PAGE; renderChatItems(); };
  }
  renderChatItems();
};
// ONE recency-sorted list (voice memos are provenance, marked 🎙, not a category). Filtered by the
// search box + paginated to chatShowN with a "show more" — so nothing is ever hidden permanently.
const scheduledSeedIds = () => new Set(seedChats.filter(s => s.source === 'scheduled').map(s => s.id));
const renderChatItems = () => {
  const box = $('chat-items'); if (!box) return;
  // Scheduled-agent runs (⏰ timer chats) are kept OUT of the sidebar — too noisy. They live in seedChats,
  // are openable via the project/feed deep-link, and GC server-side after a week. Filter both newly-arrived
  // and any already-adopted ones (older clients folded them into `chats`).
  const sched = scheduledSeedIds();
  const all = [
    ...chats.filter(c => !sched.has(c.id)).map(c => ({ id: c.id, title: c.title || 'New chat', ts: c.ts || 0, voice: false, shared: !!(c.shared && c.shareToken), shareMode: c.shareMode })),
    ...memoRuns.map(r => ({ id: r.id, title: r.title || 'voice note', ts: Date.parse(r.date) || 0, voice: true })),
  ].sort((a, b) => b.ts - a.ts);
  const f = chatFilter.trim().toLowerCase();
  const items = f ? all.filter(it => (it.title || '').toLowerCase().includes(f)) : all;
  const shown = items.slice(0, chatShowN);
  box.innerHTML = items.length
    ? shown.map(it => {
        const needs = openAsks.some(a => a.origin && a.origin.kind === 'chat' && a.origin.chatId === it.id);
        const perm = it.shared ? (it.shareMode === 'write' ? '<span class="ci-perm" title="shared link · you can post">✍️ </span>' : '<span class="ci-perm" title="shared link · read-only">🔒 </span>') : '';
        return `<div class="chat-item ${it.id === sessionId ? 'on' : ''}" data-id="${esc(it.id)}"><span class="ci-title"${it.voice ? '' : ' title="double-click to rename"'}>${needs ? '<span class="ci-dot" title="awaiting your reply"></span>' : ''}${perm}${it.voice ? '🎙 ' : ''}${esc(it.title)}</span><button class="ci-del mini" data-del="${esc(it.id)}" title="delete">×</button></div>`;
      }).join('') + (items.length > shown.length ? `<button class="ci-more mini" style="width:100%;margin-top:4px;opacity:.85">show ${items.length - shown.length} more</button>` : '')
    : `<div class="pill">${f ? 'no matches' : 'no chats'}</div>`;
  box.querySelectorAll('.chat-item .ci-title').forEach(s => {
    s.onclick = () => switchChat(s.parentElement.dataset.id);
    s.ondblclick = e => { e.stopPropagation(); startRename(s); };
  });
  box.querySelectorAll('[data-del]').forEach(b => { b.onclick = e => { e.stopPropagation(); deleteChat(b.dataset.del); }; });
  const more = box.querySelector('.ci-more'); if (more) more.onclick = () => { chatShowN += CHAT_PAGE; renderChatItems(); };
};
// double-click a chat title → inline editable input; Enter commits, Esc/blur cancels-commit.
const startRename = span => {
  const id = span.parentElement.dataset.id;
  const c = chats.find(x => x.id === id);
  if (!c) return; // only your own chats rename here (voice memos are retitled by the agent)
  const inp = document.createElement('input'); inp.type = 'text'; inp.value = c.title && c.title !== 'New chat' ? c.title : '';
  inp.style.cssText = 'width:100%;box-sizing:border-box;font:inherit;background:#0a0c14;border:1px solid #7c5cff;border-radius:5px;color:inherit;padding:1px 5px';
  span.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const commit = save => { if (done) return; done = true; if (save) { const v = inp.value.trim(); if (v) { c.title = v.slice(0, 80); saveChats(); } } renderChatItems(); };
  inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); commit(true); } else if (e.key === 'Escape') { e.preventDefault(); commit(false); } };
  inp.onblur = () => commit(true);
};
// A scoped (handed-off) chat created before the powers-banner feature has no cached powers — fetch its
// endowment via /skill and show it. Root-cap chats + shared chats are skipped (they're not sub-agents).
const ensureChatPowers = async id => {
  const c = chats.find(x => x.id === id);
  if (!c || c.scopedPowers || c.shared || !c.scopedCap || c.scopedCap === cap) return;
  try {
    const r = await (await fetch('/skill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: c.scopedCap }) })).json();
    if (Array.isArray(r.powers)) { c.scopedPowers = r.powers; saveChats(); if (sessionId === id) renderTx(); }
  } catch { /* skill unavailable → no banner */ }
};
const switchChat = id => {
  if (on) stopMic();
  sessionId = id; try { localStorage.setItem(ACTIVE_KEY, id); } catch {}
  const run = runFor(id); // memo run or ingested seed-chat (carries versions[])
  const liveTx = loadTx(id);
  // An UN-continued intake run (voice memo or ingested note) renders its LATEST version
  // (so the displayed conversation matches the version scrubber). Once continued (>2
  // turns) it shows its live transcript — every intake is capable of moving forward.
  if (run && run.versions && run.versions.length && liveTx.length <= 2) {
    memoVersion = run.versions.length - 1; const ver = run.versions[memoVersion] || {};
    activeTx = [{ who: 'you', text: run.transcript }, { who: 'agent', text: ver.answer || '', tools: ver.toolsUsed || [], steps: ver.steps || [] }];
  } else { activeTx = liveTx; memoVersion = run && run.versions ? run.versions.length - 1 : 0; }
  showTab('talk'); renderTx(); renderChatList(); renderChatBar();
  ensureChatPowers(id); // a scoped chat created before this feature has no stored powers — fetch + show them
  if (traceInst && !$('trace-overlay').classList.contains('hide')) { traceInst.render(activeTx); renderTraceVersions(); } // live-update the open 3D trace + version scrubber for the newly selected chat
  refreshTraceApp(); // if the iframe trace app is open, tell it to re-pull
  syncSelectors(); // reflect this chat's agent + model in the header dropdowns
  devTasks = []; loadDevUpdates(); // surface any Blacksmith tasks routed from this chat
  pendantShowFor(id); // re-render this chat's latest trace (persists across navigation)
  refreshBudget(); // reflect this chat's inference allowance in the header chip
  if (window.innerWidth <= 640) closeDrawer(); // on phones the drawer overlays, so dismiss it
  { const sc = chats.find(x => x.id === id); // LIVE ROOM: poll a shared chat for others' turns
    if (sc && sc.shareToken) { if (typeof shareCursor[id] !== 'number') shareCursor[id] = activeTx.length; startSharePoll(id, sc.shareToken); } else stopSharePoll(); }
  setChatUrl(); // bookmarkable: put a NON-secret #chat=<id> hint in the URL (cap stays in localStorage)
  reattachRun(id); // if this chat's last turn is unanswered, re-attach to its SERVER-SIDE run (render it / wait) — asking then closing the tab is safe
};
// Keep a NON-secret chat hint in the address bar so reload/bookmark returns to THIS chat. Never the
// cap (that stays in localStorage — a screenshot/bookmark must not leak authority). Ephemeral landing
// chats (not yet committed) clear the hint.
const setChatUrl = () => {
  try {
    const id = sessionId;
    const known = chats.some(c => c.id === id) || memoRuns.some(r => r.id === id);
    history.replaceState(null, '', known ? `#chat=${encodeURIComponent(id)}` : (location.pathname + location.search));
  } catch { /* history API unavailable */ }
};
// deep-link target (from a notification's #chat=<id>): open it once it's present
// in the chat list / memo runs / adopted seed-chats. Retried at each load point.
const tryOpenPendingChat = () => {
  if (!pendingChat) return;
  const id = pendingChat;
  // Also match seedChats: scheduled-agent runs aren't adopted into the sidebar `chats` (kept out as noise),
  // but switchChat renders them via runFor()/versions — so a project/feed deep-link to a run must open here.
  const exists = chats.some(c => c.id === id) || seedChats.some(r => r.id === id) || (String(id).startsWith('memo-') && memoRuns.some(r => r.id === id));
  if (exists) { pendingChat = null; switchChat(id); }
};
// Open a fresh, EPHEMERAL chat = the empty "landing" screen. It is NOT added to the
// chat list (or synced) until the FIRST message is sent (see sendChat's isFirst branch).
// So booting into it — or tapping "+ New" repeatedly — never leaves a trail of empty
// "New chat" rows in the sidebar or across devices.
const newChat = () => { switchChat(newId()); };
const deleteChat = id => {
  const wasMemo = memoRuns.some(r => r.id === id);
  if (wasMemo) { // a voice-memo run lives server-side — remove it there too
    memoRuns = memoRuns.filter(r => r.id !== id);
    fetch('/memos/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, id }) }).catch(() => {});
  }
  chats = chats.filter(c => c.id !== id); deletedIds.add(id); saveDeleted(); saveChats(); try { localStorage.removeItem(txKey(id)); } catch {}
  if (id === sessionId) { const rest = [...chats, ...memoRuns]; if (!rest.length) newChat(); else switchChat(rest[0].id); } else renderChatList();
};
const initChats = () => {
  chats = loadChats();
  // dan: BOOT INTO A FRESH "New chat" landing screen — don't resume the most-recent /
  // last-active chat. The blank chat is ephemeral (see newChat + sendChat), so this never
  // leaves an empty row behind. switchChat() (via newChat) does the initial render.
  newChat();
  tryOpenPendingChat(); // …unless a #chat= deep-link matches a locally-cached chat → open that
  syncLoad({ keepActive: true }); // pull the shared (cross-device) chat list WITHOUT stealing focus from the blank chat
  loadMemos(); setInterval(loadMemos, 60000); // surface incoming voice memos as traceable runs
  loadSeedChats(); setInterval(loadSeedChats, 60000); // adopt ingested voice-note chats into the list
  loadDevUpdates(); setInterval(loadDevUpdates, 20000); // surface Blacksmith dev-task status in the chat
};
$('hamburger').onclick = toggleDrawer;
$('drawer-close').onclick = closeDrawer;
$('scrim').onclick = closeDrawer;
// New-chat buttons (drawer "+ New" and the header pencil) + desktop shortcut
// (Ctrl/⌘+Shift+O — the ChatGPT/Claude new-chat combo). All focus the composer
// so the cursor lands in the chat input box, ready to type.
const startNewChat = () => { newChat(); const i = $('text'); if (i) i.focus(); };
$('new-chat').onclick = startNewChat;
$('new-chat-top').onclick = startNewChat;
// 🗑️ throw away the CURRENT chat (deleteChat handles switching away + tombstoning so it won't re-adopt).
const trashCurrentChat = () => { if (!sessionId) return; const c = curChatObj(); const name = (c && c.title && c.title !== 'New chat') ? `"${c.title}"` : 'this chat'; if (window.confirm(`Throw away ${name}? This can't be undone.`)) deleteChat(sessionId); };
if ($('trash-chat-top')) $('trash-chat-top').onclick = trashCurrentChat;
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); startNewChat(); }
});

// ── 3D conversation-trace viz (lazy-loads Three.js on first open) ────────────
let traceInst = null;
// version scrubber + "what changed" note AT THE TOP OF THE TRACE VIEW, so traces over
// time can be compared in 3D. Mirrors the chat-bar scrubber; both share memoVersion.
const renderTraceVersions = () => {
  const wrap = $('trace-vers'); const note = $('trace-note'); if (!wrap || !note) return;
  const run = runFor(sessionId); const vs = (run && run.versions) || [];
  if (!run || vs.length < 1) { wrap.classList.add('hide'); note.classList.add('hide'); wrap.innerHTML = ''; note.innerHTML = ''; return; }
  wrap.classList.remove('hide'); note.classList.remove('hide');
  wrap.innerHTML = vs.length > 1
    ? `<button class="mini" data-tprev ${memoVersion <= 0 ? 'disabled' : ''}>◀</button> <b>${esc((vs[memoVersion] || {}).label || ('v' + memoVersion))}</b> <span class="pill">${memoVersion + 1}/${vs.length}</span> <button class="mini" data-tnext ${memoVersion >= vs.length - 1 ? 'disabled' : ''}>▶</button>`
    : `<span class="pill">v0 · ${esc((vs[0] || {}).label || 'original')}</span>`;
  const pv = wrap.querySelector('[data-tprev]'); const nx = wrap.querySelector('[data-tnext]');
  if (pv) pv.onclick = () => selectVersion(memoVersion - 1);
  if (nx) nx.onclick = () => selectVersion(memoVersion + 1);
  // what changed between this version and the previous one (env/persona diff, else the label)
  const cur = vs[memoVersion] || {}; const prev = memoVersion > 0 ? (vs[memoVersion - 1] || {}) : null;
  if (!prev) { note.textContent = `⊿ original capture${cur.at ? ' · ' + fmtAgo(cur.at) : ''}`; }
  else {
    const a = (prev.env && prev.env.persona) || ''; const b = (cur.env && cur.env.persona) || '';
    const changed = a !== b
      ? `instructions ${a && b ? 'changed' : (b ? 'set' : 'cleared')}${b ? `: “${b.slice(0, 90)}${b.length > 90 ? '…' : ''}”` : ''}`
      : 'same env (a code / base-prompt change between runs)';
    note.textContent = `⊿ ${cur.label || ('v' + memoVersion)} — what changed: ${changed}`;
  }
};
const openTrace = async () => {
  $('trace-overlay').classList.remove('hide');
  try {
    if (!traceInst) { const { makeTrace } = await import('./trace.js'); traceInst = makeTrace($('trace-canvas')); }
    $('trace-vr').classList.toggle('hide', !traceInst.hasVR());
    traceInst.render(activeTx); // the current conversation = the trace
    renderTraceVersions(); // show the version scrubber for a versioned run
  } catch (e) { $('trace-overlay').innerHTML = `<div style="color:#f85149;padding:24px">3D trace failed: ${esc(e.message)}</div><button class="mini" onclick="location.reload()">reload</button>`; }
};
const closeTrace = () => $('trace-overlay').classList.add('hide');
// (🧊 trace icon removed from the top bar — the inline pendant trace is the one trace; tap it to expand.)
$('trace-close').onclick = closeTrace;
$('trace-vr').onclick = () => traceInst?.enterVR().catch(e => alert(e.message));
window.addEventListener('resize', () => { if (!$('trace-overlay').classList.contains('hide')) traceInst?.resize(); });

// ── inline real-time 3D "pendant": descends from the latest prompt and animates the
//    live fan-out (tool uses → delegates → sub-agents) as the turn runs. Lives as a
//    body-anchored overlay (renderTx wipes #log mid-turn), tracking the latest .msg.user
//    and reserving space beneath it so it never covers the answer. One reused WebGL
//    context. Fed by the SSE step stream; reconciled from the final steps[]. ──
let pendant = null, pendantWrap = null, pendantCanvas = null, pendantES = null, pendantRaf = 0, pendantInit = null;
let pendantLive = false, liveChatId = ''; // a turn is mid-stream → don't clobber it with a saved-trace re-render
let scoping = false; // the permissioning (scope) agent is researching → show its dodecahedron trace
let pendantFs = false; // 🧊 expands the pendant fullscreen (the retired ice-cube's best bit, folded in)
let pendantShapeMode = false; // the pendant is showing an AGENT SHAPE (from Settings), not a chat trace — guards pendantShowFor from reclaiming it
// D4: the pendant is the ONE trace. 🧊 / tapping the trace expands it fullscreen instead of opening the
// separate ice-cube viewer (trace.js / #trace-overlay), which is now retired.
async function togglePendantFs() { // hoisted — wired eagerly by trace-btn before this line executes
  try { await ensurePendant(); } catch { return; }
  pendantFs = !pendantFs;
  pendantWrap.classList.toggle('fs', pendantFs);
  const fsx = $('pendant-fsx'); if (fsx) fsx.classList.toggle('hide', !pendantFs);
  if (pendantFs) { pendantWrap.classList.remove('hide'); pendant.setVisible(true); if (!pendantLive && !scoping) pendantShowFor(sessionId); }
  else if (pendantShapeMode) { pendantShapeMode = false; hidePendant(); } // exiting a Settings agent-shape view → just put it away
  else { schedulePendantPosition(); }
  setTimeout(() => { try { pendant.resize(); } catch {} }, 40);
}

// ── D3: embed any SPWA as a widget, granting it EXACTLY a scoped cap's powers ──────────────
// The host relays the cap's surface over the cap-channel; the iframe never sees the swissnum
// (cap-hygiene) — its authority IS these bootstrap methods. `embedWidget(iframe, url, scopedCap)`
// loads the SPWA and hands it the grant. Reusable; wire to a UI when there's a widget to embed.
const capWidgetBootstrap = scopedCap => ({
  ask: async text => (await (await fetch('/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: scopedCap, text, sessionId: 'widget-' + String(scopedCap).slice(0, 8) }) })).json()),
  skill: async () => (await (await fetch('/skill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: scopedCap }) })).json()),
  rpc: async (method, args = []) => (await (await fetch('/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ swissnum: scopedCap, method, args }) })).json()),
});
// `src` is either a URL string (same-origin SPWA → full cap-channel + module imports) or `{ srcdoc }`
// for pasted HTML (rendered in a sandboxed, opaque-origin iframe → targetOrigin '*' so a site that
// speaks the raw {t:'__capport'} protocol still receives the grant; it can't reach our origin).
const embedWidget = async (iframe, src, scopedCap, { targetOrigin } = {}) => {
  const { makeCapHost } = await import('./cap-channel.js');
  return new Promise(resolve => {
    iframe.onload = () => { try { resolve(makeCapHost(iframe, capWidgetBootstrap(scopedCap), targetOrigin ? { targetOrigin } : {})); } catch (e) { console.error('embedWidget', e); resolve(null); } };
    if (src && src.srcdoc != null) iframe.srcdoc = src.srcdoc; else iframe.src = src;
  });
};
// Open a widget in the fullscreen overlay, granted EXACTLY `scopedCap`'s powers over the cap-channel.
// `site` defaults to the built-in /widget.html SPWA; pass { url } or { html } to open a pasted site.
// The iframe reaches only the bootstrap (ask/skill/rpc); it never sees the swissnum (cap-hygiene).
let widgetRemote = null;
const openWidget = async (scopedCap, site) => {
  const overlay = $('widget-overlay'); const iframe = $('widget-frame');
  if (!overlay || !iframe) return;
  closeModal();
  overlay.classList.remove('hide');
  if (widgetRemote && widgetRemote.dispose) { widgetRemote.dispose(); widgetRemote = null; }
  if (site && site.html != null) { iframe.setAttribute('sandbox', 'allow-scripts allow-forms'); widgetRemote = await embedWidget(iframe, { srcdoc: site.html }, scopedCap, { targetOrigin: '*' }); }
  else { iframe.removeAttribute('sandbox'); widgetRemote = await embedWidget(iframe, (site && site.url) || ('/widget.html?' + Date.now()), scopedCap); } // cache-bust so dev edits load
};
const closeWidget = () => { $('widget-overlay').classList.add('hide'); $('widget-frame').src = 'about:blank'; if (widgetRemote && widgetRemote.dispose) widgetRemote.dispose(); widgetRemote = null; };
if ($('widget-close')) $('widget-close').onclick = closeWidget;

// ── Paste a site → render it inline in the transcript as a live widget ──────────────────────────
// Stored as a `widget` message in activeTx so it survives re-render/reload/sync. cap-hygiene: if the
// pasted URL carries a #cap=<swissnum>, the swissnum is NEVER persisted — only the cap-stripped base
// URL goes into the message; the full cap-bearing URL is kept SESSION-ONLY (sessionWidgetCaps) so the
// live iframe/link works now but reload/sync never carry the secret. SAME-ORIGIN sites embed inline
// (full cap-channel + grant); a pasted full HTML doc renders sandboxed (opaque origin, can't reach our
// APIs). FLEET SPWAs (tailnet/loopback, other ports) now allow framing from agentc (their CSP
// frame-ancestors lists our origins) — so a fleet link embeds INLINE, authenticating via its own #cap
// fragment in the iframe URL (no postMessage grant). Any OTHER cross-origin link (no XFO relaxation we
// control) falls back to a "tap to open ↗" card rather than a dead blank iframe.
const sessionWidgetCaps = new Map(); // msgId -> full cap-bearing URL (in-memory only, never persisted/synced)
const isSameOriginSite = u => typeof u === 'string' && (u.startsWith('/') || u.startsWith(location.origin));
// hosts whose SPWAs we've granted frame-ancestors for (the loopback/tailnet fleet) → safe to inline.
const FLEET_HOSTS = /^(127\.0\.0\.1|localhost|100\.83\.80\.102|.*\.taildd002\.ts\.net)$/;
const isFramableFleetSite = u => { try { return FLEET_HOSTS.test(new URL(u, location.origin).hostname); } catch { return false; } };
const liveSiteUrl = (site, id) => (id && sessionWidgetCaps.get(id)) || site.url;
const makeInlineWidget = (site, id) => {
  const wrap = document.createElement('div'); wrap.className = 'msg widget';
  const card = document.createElement('div'); card.className = 'inwidget';
  const bar = document.createElement('div'); bar.className = 'inwidget-bar';
  const url = liveSiteUrl(site, id);
  const crossOrigin = site.url != null && !isSameOriginSite(site.url);
  // CROSS-ORIGIN and NOT a framable fleet host → can't iframe (XFO). Render an open-in-new-tab card.
  if (crossOrigin && !isFramableFleetSite(site.url)) {
    let host = site.url; try { host = new URL(site.url).host; } catch { /* keep raw */ }
    const capLost = site.hadCap && !(id && sessionWidgetCaps.has(id)); // post-reload: the session cap is gone
    bar.innerHTML = `<span>🧩 ${esc(host)} · another origin — opens in a new tab${capLost ? ' (link is now cap-less)' : ''}</span>`;
    const open = document.createElement('button'); open.className = 'mini'; open.textContent = 'open ↗';
    open.onclick = () => { try { window.open(url, '_blank', 'noopener'); } catch {} };
    bar.appendChild(open); card.appendChild(bar); wrap.appendChild(card);
    return wrap;
  }
  bar.innerHTML = `<span>🧩 ${crossOrigin ? 'embedded fleet app · authenticates via its own cap link' : "embedded widget · this chat's powers"}</span>`;
  const exp = document.createElement('button'); exp.className = 'mini'; exp.textContent = '⤢ open';
  bar.appendChild(exp);
  const iframe = document.createElement('iframe'); iframe.className = 'inwidget-frame'; iframe.title = 'embedded widget'; iframe.setAttribute('referrerpolicy', 'no-referrer');
  card.append(bar, iframe); wrap.appendChild(card);
  if (site.html != null) { iframe.setAttribute('sandbox', 'allow-scripts allow-forms'); embedWidget(iframe, { srcdoc: site.html }, chatCap(), { targetOrigin: '*' }); }
  else if (crossOrigin) iframe.src = url; // fleet SPWA: cap is in the URL fragment (client-side only); no postMessage grant
  else embedWidget(iframe, url, chatCap()); // same-origin: full cap-channel grant
  exp.onclick = () => openWidget(chatCap(), site.html != null ? site : { url });
  return wrap;
};
const embedSiteInline = site => {
  document.body.classList.remove('landing');
  const id = newId();
  let stored = site;
  if (site.url && isCapLink(site.url)) { // cap-hygiene: keep the swissnum out of persisted/synced state
    const h = site.url.indexOf('#');
    sessionWidgetCaps.set(id, site.url);            // full cap-bearing URL: this session only
    stored = { url: site.url.slice(0, h), hadCap: true }; // persisted form is cap-stripped
  }
  activeTx.push({ who: 'widget', id, site: stored }); saveTx(); renderTx();
  const inlined = site.html != null || isSameOriginSite(stored.url ?? '/') || isFramableFleetSite(stored.url || '');
  setStatus(inlined ? '🧩 site embedded inline' : '🧩 cross-origin app linked — tap “open ↗”');
};
// detect a "pasted site": a full HTML document, or a single same-origin / .html / #cap link.
const looksLikeHtmlDoc = s => /<!doctype html|<html[\s>]|<body[\s>]/i.test(s) && /<\/(html|body|div|p|main)>/i.test(s);
const looksLikeSiteUrl = s => /^\S+$/.test(s) && (s.startsWith(location.origin) || /^\/[^\s]*\.html(\?|#|$)/.test(s) || s.includes('#cap=') || /^https?:\/\/\S+\.html(\?|#|$)/.test(s));
const maybeEmbedPastedSite = e => {
  const txt = ((e.clipboardData && e.clipboardData.getData('text/plain')) || '').trim();
  if (!txt) return false;
  if (looksLikeHtmlDoc(txt)) { e.preventDefault(); embedSiteInline({ html: txt }); return true; }
  if (looksLikeSiteUrl(txt)) { e.preventDefault(); embedSiteInline({ url: txt }); return true; }
  return false;
};
const ensurePendant = () => pendantInit || (pendantInit = (async () => {
  pendantWrap = document.createElement('div'); pendantWrap.id = 'pendant-wrap'; pendantWrap.className = 'hide';
  pendantCanvas = document.createElement('canvas'); pendantCanvas.id = 'pendant-canvas';
  const capn = document.createElement('div'); capn.className = 'pendant-cap'; capn.textContent = '⊿ trace — scroll/pinch to zoom · drag to pan · click a node to read · tap empty to expand';
  const fsx = document.createElement('button'); fsx.id = 'pendant-fsx'; fsx.className = 'mini hide'; fsx.textContent = '✕ exit'; fsx.style.cssText = 'position:absolute;top:max(10px,env(safe-area-inset-top));right:max(12px,env(safe-area-inset-right));z-index:2;background:#161b22';
  fsx.onclick = e => { e.stopPropagation(); if (pendantFs) togglePendantFs(); };
  pendantWrap.append(pendantCanvas, capn, fsx);
  pendantWrap.onclick = () => { if (!pendantFs) togglePendantFs(); }; // tap the trace → fullscreen the pendant (the ice-cube viewer is retired)
  document.body.appendChild(pendantWrap);
  const { makePendant } = await import('./pendant.js');
  pendant = makePendant(pendantCanvas);
  return pendant;
})());
const positionPendant = () => {
  if (!pendant || !pendantWrap || pendantWrap.classList.contains('hide')) return;
  if (curTab !== 'talk') { pendantWrap.classList.add('hide'); return; }
  const users = log.querySelectorAll('.msg.user');
  const anchor = users[users.length - 1];
  if (!anchor) {
    // listening on a FRESH chat (no prompt yet): center the octahedron over the composer, like the
    // old Siri orb — so "make a new chat + talk" shows the SAME agent octahedron breathing to you.
    if ((on || scoping) && !pendantLive) {
      const lr = log.getBoundingClientRect();
      // Anchor to the INPUT BOX (not the whole composer/tagline) and FIT the pendant into the space
      // ABOVE it, so on mobile's landing view (composer floated up via -42vh) it can never overflow
      // the top of the screen — it hugs just over the input box, shrinking if room is tight.
      const box = ($('text') || $('composer')).getBoundingClientRect();
      const avail = Math.max(80, box.top - 16);            // usable height above the input
      const h = Math.max(110, Math.min(200, avail));        // fit within it
      const w = Math.max(180, Math.min(360, lr.width - 16));
      pendantCanvas.style.height = h + 'px';
      pendantWrap.style.width = w + 'px';
      pendantWrap.style.left = Math.max(8, lr.left + window.scrollX + (lr.width - w) / 2) + 'px';
      pendantWrap.style.top = (window.scrollY + Math.max(8, box.top - h - 10)) + 'px'; // bottom hugs ~10px above the input
      pendant.resize();
      return;
    }
    pendantWrap.classList.add('hide'); return;
  }
  log.querySelectorAll('.msg.user').forEach(el => { if (el !== anchor) el.style.marginBottom = ''; });
  // dynamic sizing: the FIRST turn's trace is a big, CENTRED "show"; every later turn's
  // trace shrinks toward a compact pendant tucked under its (right-aligned) prompt, so the
  // viz stays prominent on a fresh chat but gets out of the way as the conversation grows.
  const isFirst = users.length === 1;
  const grown = Math.min(1, Math.max(0, users.length - 2) / 6); // 0 at the 2nd turn → 1 once the convo is long
  const h = isFirst ? 248 : Math.round(168 - 48 * grown);       // show big, then 168px → 120px as it grows
  anchor.style.marginBottom = (h + 26) + 'px'; // reserve the gap so the pendant never covers the answer
  pendantCanvas.style.height = h + 'px';
  const r = anchor.getBoundingClientRect();
  if (isFirst) { // "show" mode — large + centred under the chat column (Google-landing feel)
    const lr = log.getBoundingClientRect();
    const w = Math.max(220, Math.min(440, lr.width - 16));
    pendantWrap.style.width = w + 'px';
    pendantWrap.style.left = Math.max(8, lr.left + window.scrollX + (lr.width - w) / 2) + 'px';
  } else { // compact, right-aligned beneath the prompt; width shrinks as the convo grows
    const w = Math.round(Math.max(132, Math.min(240, r.width + 30)) * (1 - 0.2 * grown));
    pendantWrap.style.width = w + 'px';
    pendantWrap.style.left = Math.max(8, r.right + window.scrollX - w) + 'px';
  }
  pendantWrap.style.top = (r.bottom + window.scrollY + 8) + 'px';
  pendant.resize();
};
const schedulePendantPosition = () => { if (pendantRaf) return; pendantRaf = requestAnimationFrame(() => { pendantRaf = 0; positionPendant(); }); };
const hidePendant = () => { if (pendantWrap) pendantWrap.classList.add('hide'); if (pendant) pendant.setVisible(false); log.querySelectorAll('.msg.user').forEach(el => { el.style.marginBottom = ''; }); try { pendantES && pendantES.close(); } catch {} };
const pendantBegin = async (promptText, sid = sessionId) => {
  pendantLive = true; liveChatId = sid; pendantShapeMode = false; // a real turn reclaims the pendant from any Settings shape view
  try {
    const p = await ensurePendant();
    pendantWrap.classList.remove('hide'); p.setVisible(true);
    positionPendant(); p.reset(promptText);
    try { pendantES && pendantES.close(); } catch {}
    pendantES = new EventSource('/chat/steps?sid=' + encodeURIComponent(sid)); // tool NAMES + queries/urls only — never the cap (cap-hygiene). The server replays the trace so far → joining mid-run shows it live.
    pendantES.onmessage = e => { try { const m = JSON.parse(e.data); if (m.t === 'start') p.toolStart(m.name, m.detail, m.call); else if (m.t === 'done') p.toolDone(m.name, m.ok, m.detail, m.children, m.call, m.result, m.granted); else if (m.t === 'rnode') p.rnode(m); else if (m.t === 'child-done') p.childDone(m.parent, m.name, m.ok); else if (m.t === 'end') { try { pendantES.close(); } catch {} } } catch {} };
    pendantES.onerror = () => {}; // degrade silently — applyFinal reconciles from the final steps[]
  } catch { /* pendant is enhancement-only; never block the turn */ }
};
const pendantEnd = steps => { try { pendantES && pendantES.close(); } catch {} pendantLive = false; if (pendant) { pendant.finish(); pendant.applyFinal(steps || []); } hidePendant(); }; // done WORKING → hide the live 3D animation; the per-message SVG trace (above the message) becomes the record. Tap an SVG to reopen the 3D on demand.
// re-render the latest turn's SAVED trace when opening/returning to a chat (persistence across navigation)
const pendantShowFor = async id => {
  if (pendantShapeMode) return; // a Settings agent-shape graph is up — don't reclaim the pendant with a chat trace
  if (pendantLive && id === liveChatId) { schedulePendantPosition(); return; } // a turn is mid-stream here — leave the live animation
  if (!pendantFs) { hidePendant(); return; } // completed chat + 3D not opened on demand → no persistent 3D; the per-message SVG traces ARE the record (tap one to open the 3D)
  // the 3D is open on demand (fullscreen) → keep it rendering the latest saved trace across navigation/resize
  let withSteps = null;
  for (let i = activeTx.length - 1; i >= 0; i -= 1) { const m = activeTx[i]; if (m && m.who === 'agent' && Array.isArray(m.steps) && m.steps.length) { withSteps = m; break; } }
  if (!withSteps) { hidePendant(); return; }
  try { const p = await ensurePendant(); pendantWrap.classList.remove('hide'); p.setVisible(true); p.showSteps(withSteps.steps); positionPendant(); } catch { /* enhancement-only */ }
};
window.addEventListener('scroll', schedulePendantPosition, { passive: true });
window.addEventListener('resize', schedulePendantPosition);

// ── trace AS AN APP (opt-in): the trace view as a STATELESS iframe that receives the
//    chat as a CAPABILITY over a postMessage MessagePort (the port IS the capability).
//    The iframe is a pure function of that object — no other access to the parent. A dev
//    agent owns trace-app.js. The inline 🧊 trace stays the default (zero-regression). ──
const traceModelForApp = () => activeTx.map(m => { const o = { who: m.who, text: m.text }; if (m.tools) o.tools = m.tools; if (m.steps) o.steps = m.steps; if (Array.isArray(m.images)) o.images = m.images.filter(s => typeof s === 'string' && s.startsWith('data:')); return o; }); // data-URL images cross structured clone; blob audio dropped
const chatCapForApp = () => ({
  getTrace: () => traceModelForApp(),
  getInfo: () => {
    const run = runFor(sessionId); const vs = (run && run.versions) || [];
    let note = '';
    if (vs.length) { const cur = vs[memoVersion] || {}; const prev = memoVersion > 0 ? (vs[memoVersion - 1] || {}) : null;
      note = !prev ? 'original capture' : ((((prev.env && prev.env.persona) || '') !== ((cur.env && cur.env.persona) || '')) ? 'what changed: instructions changed' : 'what changed: code / base-prompt change'); }
    return { title: (chats.find(c => c.id === sessionId) || {}).title || (run && run.title) || 'trace', versions: vs.map(v => ({ label: v.label })), index: memoVersion, note };
  },
  selectVersion: i => { selectVersion(i); return true; },
});
let traceAppRemote = null;
const refreshTraceApp = () => { if (traceAppRemote && traceAppRemote.refresh) traceAppRemote.refresh().catch(() => {}); };
const openTraceApp = async () => {
  const overlay = $('trace-app-overlay'); const iframe = $('trace-app-frame');
  overlay.classList.remove('hide');
  const { makeCapChannel } = await import('./cap-channel.js');
  iframe.onload = () => {
    try {
      const mc = new MessageChannel();
      const ch = makeCapChannel(mc.port1, chatCapForApp()); // parent EXPORTS the chat cap; remote = the iframe's {refresh}
      traceAppRemote = ch.remote;
      iframe.contentWindow.postMessage({ t: '__capport' }, location.origin, [mc.port2]); // hand the iframe the port = the capability
    } catch (e) { console.error('trace-app handshake', e); }
  };
  iframe.src = '/trace-app.html?' + Date.now(); // cache-bust so a dev's edits load
};
const closeTraceApp = () => { $('trace-app-overlay').classList.add('hide'); $('trace-app-frame').src = 'about:blank'; traceAppRemote = null; };
if ($('trace-appbtn')) $('trace-appbtn').onclick = openTraceApp;
if ($('trace-app-close')) $('trace-app-close').onclick = closeTraceApp;
// dan: boot with the sidebar CLOSED (land on the New-chat screen, chrome out of the way).
setSidebar(false);
// desktop-only hover-peek: hovering the thin left-edge hot-zone (or the drawer) slides it
// in as an OVERLAY (no content shift); leaving the drawer collapses it — unless it's
// pinned open via ☰. Touch has no hover, so phones keep the hamburger + overlay behavior.
if (window.matchMedia && window.matchMedia('(hover:hover) and (pointer:fine)').matches) {
  const peek = open => { if (!document.body.classList.contains('sidebar-open')) document.body.classList.toggle('sidebar-peek', open); };
  const hot = $('sidebar-hot'), dr = $('drawer');
  if (hot) hot.addEventListener('pointerenter', () => peek(true));
  if (dr) { dr.addEventListener('pointerenter', () => peek(true)); dr.addEventListener('pointerleave', () => peek(false)); }
}

// ── notification inbox (🔔 bell): reads the shared dashboard feed (data endowment) ──
const setBellBadge = n => { const b = $('bell-badge'); if (!b) return; if (n > 0) { b.textContent = n > 99 ? '99+' : String(n); b.classList.remove('hide'); } else b.classList.add('hide'); };
const fmtAgo = iso => { const t = Date.parse(iso); if (!t) return ''; const s = Math.floor((Date.now() - t) / 1000); if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago'; };
// share links carry a #cap= swissnum; per cap-hygiene we keep it OUT of the DOM. The real
// URL is stashed in a render-scoped registry and opened programmatically on click — the
// destination SPWA strips its own cap from the address bar. Plain links stay as anchors.
const isCapLink = u => typeof u === 'string' && u.includes('#cap=');
// a notification link back to one of THIS app's chats (a same-origin #chat=<id> deep-link).
// Returns the chat id, or '' for anything else. We route these IN-APP via switchChat(id) so
// they land on the SPECIFIC chat — opening them as a fresh tab strips the hash and falls back
// to the most recent chat (initChats' chats[0] default).
const chatIdFromLink = u => {
  if (typeof u !== 'string') return '';
  try { const url = new URL(u, location.href); if (url.origin !== location.origin) return ''; return new URLSearchParams(url.hash.slice(1)).get('chat') || ''; }
  catch { return ''; }
};
const capLinkReg = new Map();
const notifCard = (it, withDone) => {
  const meta = [it.agent ? esc((it.avatar ? it.avatar + ' ' : '') + it.agent) : '', it.status ? esc(it.status) : '', ...(it.links || []).map(l => {
    const raw = (l && (l.url || l.href)) || '';
    const cap = isCapLink(raw) || isCapLink(l && l.href);
    // a deep-link back to one of THIS app's chats → route IN-APP to that exact chat id.
    const chatId = chatIdFromLink(l && l.href);
    if (chatId) return `<a class="nlink" href="#" data-openchat="${esc(chatId)}">💬 open chat</a>`;
    // never let a swissnum become visible text: cap links fall back to a generic label, never the URL.
    const label = '📎 ' + esc((l && l.label) || (cap ? 'Open link' : raw));
    if (!l || !l.href) return label;
    // href is resolved + scheme-checked server-side (vault→obsidian://, web→url, else '').
    if (cap) { const id = 'cl' + capLinkReg.size; capLinkReg.set(id, l.href); return `<a class="nlink" href="#" data-capopen="${id}">${label}</a>`; }
    return `<a class="nlink" href="${esc(l.href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  })].filter(Boolean).join(' · ');
  return `<div class="notif card-open ${it.attention ? 'att' : ''}" data-nopen="${esc(it.id)}"><div class="ntitle"><span>${esc(it.title)}</span><span class="ntime">${esc(fmtAgo(it.date))}</span></div>${it.body ? `<div class="nbody">${esc(it.body)}</div>` : ''}<div class="nmeta"><span>${meta}</span>${withDone ? `<button class="ndone" data-done="${esc(it.id)}">Done</button>` : ''}</div></div>`;
};
// A feed link → a render-safe { label } + an `open` closure that holds the real href/cap (never the DOM).
// Used by the NotificationCard island (rec-list): the island shows the label, onOpenLink calls `open`.
let recLinkResolvers = []; // [itemIdx][linkIdx] → () => open
const notifLinkInfo = l => {
  const raw = (l && (l.url || l.href)) || '';
  const chatId = chatIdFromLink(l && l.href);
  if (chatId) return { label: '💬 open chat', open: () => switchChat(chatId) };
  const cap = isCapLink(raw) || isCapLink(l && l.href);
  const label = '📎 ' + ((l && l.label) || (cap ? 'Open link' : raw));
  const href = l && l.href;
  return { label, open: href ? () => window.open(href, '_blank', 'noopener,noreferrer') : null };
};
// Click a notification → a big modal with the FULL text (Markdown-rendered, since the card truncates) and,
// when the notification came from a chat, a button to OPEN THAT CHAT and resume the conversation there.
let notifById = {};
const showNotifModal = it => {
  if (!it) return;
  const back = document.createElement('div'); back.className = 'nmodal-back';
  const onKey = e => { if (e.key === 'Escape') close(); };
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  back.onclick = e => { if (e.target === back) close(); };
  const card = document.createElement('div'); card.className = 'nmodal';
  const head = document.createElement('div'); head.className = 'nmodal-head';
  const ttl = document.createElement('div'); ttl.className = 'nmodal-title'; ttl.textContent = it.title || 'Notification';
  const xb = document.createElement('button'); xb.className = 'mini'; xb.textContent = '✕'; xb.title = 'Close'; xb.onclick = close;
  head.append(ttl, xb);
  const body = document.createElement('div'); body.className = 'body md nmodal-body'; renderMarkdown(body, it.body || it.title || '');
  // the list /feed/load truncates body for the card — fetch the FULL text on open + re-render so the modal isn't cut off
  (async () => { try { const r = await (await fetch('/feed/item', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, id: it.id }) })).json(); if (r && r.ok && r.item && String(r.item.body || '').length > String(it.body || '').length) renderMarkdown(body, r.item.body); } catch { /* keep the cached preview */ } })();
  const acts = document.createElement('div'); acts.className = 'nmodal-acts';
  // the source chat: notifications carry it as chatId (run notifications) OR an in-app chat link
  const chatId = it.chatId || (it.links || []).map(l => chatIdFromLink(l && l.href)).find(Boolean);
  if (chatId) { const b = document.createElement('button'); b.className = 'mini primary'; b.textContent = '💬 Open chat & resume'; b.onclick = () => { close(); showTab('talk'); switchChat(chatId); }; acts.appendChild(b); }
  (it.links || []).forEach(l => { if (chatIdFromLink(l && l.href)) return; const info = notifLinkInfo(l); if (info.open) { const b = document.createElement('button'); b.className = 'mini'; b.textContent = info.label; b.onclick = () => info.open(); acts.appendChild(b); } });
  const cl = document.createElement('button'); cl.className = 'mini'; cl.textContent = 'Close'; cl.onclick = close; acts.appendChild(cl);
  card.append(head, body, acts); back.appendChild(card); document.body.appendChild(back);
  document.addEventListener('keydown', onKey);
};
const loadFeed = async () => { try { return await (await fetch('/feed/load', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) })).json(); } catch { return null; } };
const refreshBadge = async () => { if (!cap) return; await loadAsks(); const d = await loadFeed(); const attN = d ? (d.items || []).filter(i => i.attention && !i.dismissed).length : 0; setBellBadge(openAsks.length + attN); };
const renderInbox = async () => {
  await loadAsks();
  const d = await loadFeed(); if (!d) return;
  capLinkReg.clear();
  const items = d.items || [];
  notifById = {}; items.forEach(it => { if (it && it.id) notifById[it.id] = it; }); // for the click-to-expand modal
  const att = items.filter(i => i.attention && !i.dismissed);
  const rec = items.filter(i => !(i.attention && !i.dismissed)).slice(0, 40);
  const attList = $('att-list'); attList.innerHTML = '';
  // click a notification (not its inner Done/link) → full-text modal. One delegated listener (survives re-renders).
  if (!attList.__nopenWired) { attList.addEventListener('click', e => { const c = e.target.closest && e.target.closest('.notif[data-nopen]'); if (c && !e.target.closest('button,a')) showNotifModal(notifById[c.dataset.nopen]); }); attList.__nopenWired = true; }
  // 0) how to receive these on your phone (ntfy) — collapsible setup instructions
  try {
    const ni = await (await fetch('/notify/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) })).json();
    if (ni && (ni.server || ni.topic)) {
      const d = document.createElement('details'); d.style.cssText = 'margin-bottom:10px;border:1px solid var(--edge);border-radius:8px;padding:8px;background:var(--panel)';
      d.innerHTML = `<summary style="cursor:pointer;font-size:13px">📱 Get these notifications on your phone</summary>
        <ol style="font-size:12px;color:var(--mut);margin:8px 0 0;padding-left:18px;line-height:1.7">
          <li>Install the <b>ntfy</b> app (iOS App Store · Android Play/F-Droid).</li>
          <li>App <b>Settings → Default server</b> → <code style="user-select:all">${esc(ni.server)}</code></li>
          <li>Tap <b>＋ → Subscribe to topic</b>, enter <code style="user-select:all">${esc(ni.topic)}</code> (your own private feed).</li>
          <li>Allow notifications. Done — your agent's pushes arrive on your phone, even off your home network.</li>
        </ol>`;
      attList.appendChild(d);
    }
  } catch { /* ntfy info unavailable — skip */ }
  // 1) "Done — process my answers" flush button for staged off-app asks
  if (pendingFlushAsks.length) {
    const done = document.createElement('button'); done.className = 'ask-submit'; done.style.marginBottom = '10px';
    done.textContent = `Done — process my ${pendingFlushAsks.length} answer${pendingFlushAsks.length > 1 ? 's' : ''}`;
    done.onclick = async () => { done.disabled = true; await fetch('/asks/flush', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) }).catch(() => {}); renderInbox(); };
    attList.appendChild(done);
  }
  // 2) answerable typed asks (the inline feedback loop), then 3) the feed attention items
  openAsks.forEach(a => attList.appendChild(buildAskCard(a)));
  if (att.length) attList.insertAdjacentHTML('beforeend', att.map(i => notifCard(i, true)).join(''));
  if (!openAsks.length && !att.length && !pendingFlushAsks.length) attList.innerHTML = '<div class="pill">nothing needs your attention 🎉</div>';
  // FACTORED: render Recent activity through the NotificationCard island. Links carry only a LABEL; their
  // real href/cap stays in `recLinkResolvers` (a host closure) — onOpenLink(itemIdx, linkIdx) resolves it,
  // so a swissnum never enters the DOM. (att-list keeps its imperative path — it interleaves asks + ntfy.)
  const recList = $('rec-list');
  if (!rec.length) { recList.innerHTML = '<div class="pill">no recent activity</div>'; recLinkResolvers = []; }
  else if (window.__fieldIslands && window.__fieldIslands.renderNotifications) {
    const prepared = rec.map(it => {
      const infos = (it.links || []).map(notifLinkInfo);
      return { item: { id: it.id, title: it.title, time: fmtAgo(it.date), body: it.body || '', agent: it.agent || '', avatar: it.avatar || '', status: it.status || '', links: infos.map(x => ({ label: x.label })), attention: false }, resolvers: infos.map(x => x.open) };
    });
    recLinkResolvers = prepared.map(p => p.resolvers);
    window.__fieldIslands.renderNotifications(recList, { items: prepared.map(p => p.item), withDone: false }, {
      onDone() {},
      onOpenLink: (ii, li) => { const r = recLinkResolvers[ii] && recLinkResolvers[ii][li]; if (r) r(); },
      onOpen: id => showNotifModal(notifById[id]),
    });
  } else recList.innerHTML = rec.map(i => notifCard(i, false)).join('');
  $('att-count').textContent = (openAsks.length + att.length) ? String(openAsks.length + att.length) : '';
  setBellBadge(openAsks.length + att.length);
  document.querySelectorAll('#att-list [data-done]').forEach(b => { b.onclick = async () => { b.disabled = true; await fetch('/feed/dismiss', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, id: b.dataset.done }) }); renderInbox(); }; });
  // cap-link anchors carry only an opaque id; open the real (out-of-DOM) URL programmatically so the swissnum never lands in the DOM.
  document.querySelectorAll('#att-list [data-capopen], #rec-list [data-capopen]').forEach(a => { a.onclick = e => { e.preventDefault(); const u = capLinkReg.get(a.dataset.capopen); if (u) window.open(u, '_blank', 'noopener,noreferrer'); }; });
  // chat deep-links route IN-APP to the specific chat id (not a fresh tab that re-resolves to the most recent chat).
  document.querySelectorAll('#att-list .nlink[data-openchat], #rec-list .nlink[data-openchat]').forEach(a => { a.onclick = e => { e.preventDefault(); switchChat(a.dataset.openchat); }; });
  renderChangelog();
};
// 🔧 the CHANGELOG of self-applied (auto-merged) improvements, each with a one-click Revert. Root-only;
// the section hides itself for non-root caps or when nothing has been auto-applied yet.
const renderChangelog = async () => {
  const section = $('chg-section'), list = $('chg-list'), count = $('chg-count');
  if (!section || !list) return;
  let merges = [];
  try { const r = await (await fetch('/changelog/load', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) })).json(); merges = (r && r.merges) || []; } catch { /* not root / unavailable */ }
  if (!merges.length) { section.classList.add('hide'); return; }
  section.classList.remove('hide');
  const live = merges.filter(m => !m.rolledBack).length;
  count.textContent = live ? String(live) : '';
  // render-safe rows for the ChangelogList island — labels + a SHORT sha only, never a commit object/cap.
  const rows = merges.map(m => ({
    id: m.id,
    goal: String(m.goal || '(improvement)').slice(0, 160),
    when: m.mergedAt ? new Date(m.mergedAt).toLocaleString() : '',
    sha: String(m.mergeCommit || '').slice(0, 8),
    rolledBack: !!m.rolledBack,
    revertedWhen: m.rolledBack && m.rolledBackAt ? new Date(m.rolledBackAt).toLocaleString() : '',
  }));
  const onRevert = async id => {
    if (!confirm('Revert this self-applied change? This runs a history-preserving git revert on the live branch. Restart the service afterward to load the reverted code.')) return;
    try {
      const r = await (await fetch('/changelog/revert', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, id }) })).json();
      if (!r.ok) { alert(`Revert failed: ${r.error || 'unknown'}${r.brokenMergeLive ? ' — the broken merge is still live; revert manually.' : ''}`); return; }
      alert('Reverted. Restart the voice-agent service to run the reverted code.');
    } catch (e) { alert(`Revert error: ${e.message}`); return; }
    renderChangelog();
  };
  // FACTORED: render through the ChangelogList island (consistent + tested). Fall back to plain DOM only
  // if the islands bundle isn't loaded.
  if (window.__fieldIslands && window.__fieldIslands.renderChangelogList) {
    window.__fieldIslands.renderChangelogList(list, { merges: rows }, { onRevert });
    return;
  }
  list.innerHTML = rows.map(m =>
    `<div class="ncard" style="display:flex;gap:8px;align-items:flex-start"><div style="flex:1;min-width:0"><div style="font-size:13px">${esc(m.goal)}</div><div class="sub" style="font-size:11px;color:var(--mut)">${esc(m.when)}${m.sha ? ` · ${esc(m.sha)}` : ''}${m.rolledBack && m.revertedWhen ? ` · reverted ${esc(m.revertedWhen)}` : ''}</div></div>${m.rolledBack ? '<span class="pill">↩ reverted</span>' : `<button class="mini chg-revert" data-revert="${esc(m.id)}">↩ Revert</button>`}</div>`).join('');
  list.querySelectorAll('[data-revert]').forEach(b => { b.onclick = () => onRevert(b.dataset.revert); });
};
const toggleSection = (headId, listId) => { const list = $(listId), head = $(headId); list.classList.toggle('hide'); head.querySelector('.caret').textContent = list.classList.contains('hide') ? '▸' : '▾'; };
if ($('bell-btn')) $('bell-btn').onclick = () => showTab('inbox');
if ($('att-head')) $('att-head').onclick = () => toggleSection('att-head', 'att-list');
if ($('rec-head')) $('rec-head').onclick = () => toggleSection('rec-head', 'rec-list');
if ($('chg-head')) $('chg-head').onclick = () => toggleSection('chg-head', 'chg-list');

// ── 🧩 Components studio (root): each component's source is a git-as-Endo object — view history,
//    revert to a version (non-destructive), or fork it (own lineage + a copy of its data). ─────────
const updateComponentsBadge = n => { const t = $('tab-components'); if (t) t.textContent = n > 0 ? `Components (${n})` : 'Components'; };
// Shared component actions (used by both the Studio buttons and the Alt-click overlay).
const editComponent = async (id, name) => {
  const change = window.prompt(`✎ Edit "${name}" — describe the change. A focused agent edits JUST this component's source, commits a new version (revertable), and applies it live:`);
  if (!change) return;
  setStatus(`✎ editing "${name}"…`);
  const r = await (await fetch('/components/edit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, id, prompt: change }) })).json();
  setStatus(r.ok ? `Edited "${name}" → new version${r.review && r.review.worst !== 'none' ? ` (panel: ${r.review.worst})` : ''}. Revert in the Components tab if needed.` : `edit: ${r.error || 'failed'}`);
  if (curTab === 'components') refreshComponents();
};
const forkComponentAct = async (id, name) => {
  const fname = window.prompt(`Fork "${name}" — name your fork:`, `${name}-fork`); if (!fname) return;
  const r = await (await fetch('/components/fork', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, id, name: fname }) })).json();
  setStatus(r.ok ? `Forked → "${fname}" — queued for review; admit it in the Components tab.` : `fork: ${r.error || 'failed'}`);
  if (curTab === 'components') refreshComponents();
};
// ── live FORK actions (Alt-click on a mounted [data-fork-id] fork → edit/fork). Available to ANY cap-holder
//    (forks are owner-gated by the cap, not root). Distinct from forkComponentAct (the /components git path).
const forkEditAct = async (id, name) => {
  const change = window.prompt(`✎ Edit fork "${name}" — describe the change. The fork's agent rewrites its (endowments,props)=>vnode source (a new version), applied live:`);
  if (!change) return;
  setStatus(`✎ editing "${name}"…`);
  const r = await (await fetch('/forks/edit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: chatCap(), id, prompt: change }) })).json();
  setStatus(r.ok ? `Edited "${name}" → v${r.version}. Revert in the fork's history.` : `edit: ${r.error || 'failed'}`);
  renderTx(); // re-render so the mounted fork widget re-fetches + repaints the new source
};
const forkForkAct = async (id, name) => {
  const r = await (await fetch('/forks/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: chatCap(), id }) })).json();
  if (!r.ok) { setStatus(`fork: ${r.error || 'failed'}`); return; }
  const fname = window.prompt(`⑂ Fork "${name}" — name your new fork:`, `${name} copy`); if (!fname) return;
  forkIntoChat({ source: r.source, name: fname, baseId: id }); // new independent fork, opened inline to edit
};

// ── ⌥ Alt/Option-click to SELECT a component + edit it with its agent ───────────────────────────────
// Hold Alt/Option → hovering outlines the lowest-level element tagged with its component id; click →
// a chip offers ✎ edit (a focused agent for THAT component) / 🍴 fork. Works on any [data-component-id]
// element, so it lights up wherever a component is rendered (the Components tab today; mounted UI
// component-projects as the trie grows). Owner-only.
const componentSelect = () => {
  let altHeld = false, hoverEl = null;
  // While Alt is held, drop pointer-events on confined-component iframes so the PARENT receives the hover
  // and click (a sandboxed iframe otherwise swallows them — the reason in-chat components were unselectable).
  // pointer-events:none grants the frame nothing: the sandbox/CSP boundary is untouched; it only routes the
  // OWNER's pointer to the wrapper while Alt is down, and restores normal interaction the instant Alt lifts.
  const sstyle = document.createElement('style'); sstyle.textContent = '.comp-select .gw-component iframe{pointer-events:none!important}.comp-select .gw-component{cursor:pointer}'; document.head.appendChild(sstyle);
  const outline = document.createElement('div');
  outline.style.cssText = 'position:fixed;z-index:9000;pointer-events:none;border:1px solid var(--bad,#f85149);box-shadow:0 0 7px var(--bad,#f85149);display:none;transition:all .05s ease;'; // 1px impact-colour line (themes via --bad)
  const label = document.createElement('div');
  label.style.cssText = 'position:absolute;top:0;left:0;color:var(--bad,#f85149);background:rgba(0,0,0,.6);font:600 11px ui-monospace,Menlo,Consolas,monospace;padding:1px 5px;white-space:nowrap;';
  outline.appendChild(label);
  const hint = document.createElement('div');
  hint.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:9001;background:#0d1117f2;border:1px solid var(--acc,#39d3ff);color:#e6edf3;font:12px -apple-system,sans-serif;padding:6px 13px;border-radius:20px;display:none;pointer-events:none;';
  hint.textContent = '⌥ Alt-click a component to edit it with its agent';
  const chip = document.createElement('div');
  chip.style.cssText = 'position:fixed;z-index:9002;display:none;gap:6px;background:#0d1117f7;border:1px solid var(--acc,#39d3ff);border-radius:10px;padding:6px 7px;box-shadow:0 10px 34px rgba(0,0,0,.6);font:12px -apple-system,sans-serif;align-items:center;';
  document.body.append(outline, hint, chip);
  // a "component" = any element carrying its project id (the Studio) OR a live in-chat confined component
  // OR a live mounted FORK ([data-fork-id]). Forks select for any cap-holder; components stay root-only.
  const tagOf = el => (el && el.closest ? el.closest('[data-fork-id], [data-component-id], .gw-component') : null);
  const isForkEl = el => !!(el && el.closest && el.closest('[data-fork-id]'));
  const hasForks = () => !!document.querySelector('[data-fork-id]');
  const canEngage = () => isRoot || hasForks(); // forks are alt-selectable even without the root cap
  const setAlt = on => { altHeld = on; hint.style.display = on ? 'block' : 'none'; document.documentElement.classList.toggle('comp-select', on); if (!on && (!chip.style.display || chip.style.display === 'none')) { outline.style.display = 'none'; hoverEl = null; } };
  const place = el => { if (!el) { outline.style.display = 'none'; return; } const r = el.getBoundingClientRect(); outline.style.display = 'block'; outline.style.left = `${r.left - 1}px`; outline.style.top = `${r.top - 1}px`; outline.style.width = `${r.width}px`; outline.style.height = `${r.height}px`; label.textContent = (el.closest && el.closest('[data-fork-id]') ? `⑂ ${el.closest('[data-fork-id]').getAttribute('data-fork-name') || 'fork'}` : '') || el.getAttribute('data-component-name') || el.getAttribute('data-component-id') || 'component'; }; // formal name, impact-colour monospace, top-left
  const clearChip = () => { chip.style.display = 'none'; outline.style.display = 'none'; };
  // Break out an id-less inline component into a project object, then edit it — so click-to-edit works on
  // freshly-generated chat components too (breaking out IS minting the editable, versioned project).
  const breakOutThenEdit = async (spec, name) => {
    if (!spec || !spec.source) { setStatus('this component has no editable source'); return; }
    const nm = (name && name !== 'component') ? name : (window.prompt('Name this component to make it editable:', '') || '').trim();
    if (!nm) return;
    setStatus(`saving “${nm}” as an editable component…`);
    let r; try { r = await (await fetch('/components/break-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, name: nm, source: spec.source, cells: spec.cells || [] }) })).json(); }
    catch (e) { setStatus('break out: ' + e.message); return; }
    if (!r || !r.ok || !r.id) { setStatus('break out: ' + ((r && r.error) || 'failed')); return; }
    editComponent(r.id, r.name || nm); // now it's a project object → edit it with its focused agent
  };
  addEventListener('keydown', e => { if ((e.key === 'Alt' || e.altKey) && canEngage()) setAlt(true); });
  addEventListener('keyup', e => { if (e.key === 'Alt' || !e.altKey) setAlt(false); });
  addEventListener('blur', () => setAlt(false)); // alt-tab / focus loss → never leave iframes disabled
  // Drive selection off EACH event's own altKey, not just a captured Alt keydown. The keydown frequently never
  // reaches the window — focus sits inside a sandboxed component iframe, or the OS/browser swallows Alt — which
  // is why holding Alt did nothing. mousemove/click both carry altKey regardless of focus, so any Alt-move
  // engages select mode (which disables the iframes' pointer-events, letting the rest of the gesture land).
  addEventListener('mousemove', e => {
    if (!canEngage()) return;
    if (e.altKey) { if (!altHeld) setAlt(true); const el = tagOf(e.target); if (el !== hoverEl) { hoverEl = el; place(el); } else if (el) place(el); }
    else if (altHeld) setAlt(false);
  }, true);
  addEventListener('click', e => {
    if (!e.altKey || !canEngage()) return; const el = tagOf(e.target); if (!el) return;
    // LIVE FORK ([data-fork-id]): editable by any cap-holder via the /forks/* path. Takes priority over the
    // component branch (a fork mount is never also a Studio component).
    const forkEl = el.closest ? el.closest('[data-fork-id]') : null;
    if (forkEl) {
      e.preventDefault(); e.stopPropagation();
      const fid = forkEl.getAttribute('data-fork-id'); const fname = forkEl.getAttribute('data-fork-name') || 'fork';
      const r = el.getBoundingClientRect();
      chip.innerHTML = `<span style="color:var(--mut)">⑂ ${esc(fname)}</span> <button class="mini" data-act="fedit">✎ edit</button> <button class="mini" data-act="ffork">⑂ fork</button> <button class="mini" data-act="x">✕</button>`;
      chip.style.display = 'flex'; chip.style.left = `${Math.min(r.left, innerWidth - 240)}px`; chip.style.top = `${Math.min(r.bottom + 6, innerHeight - 44)}px`; place(el);
      chip.querySelector('[data-act=fedit]').onclick = () => { clearChip(); forkEditAct(fid, fname); };
      chip.querySelector('[data-act=ffork]').onclick = () => { clearChip(); forkForkAct(fid, fname); };
      chip.querySelector('[data-act=x]').onclick = clearChip;
      return;
    }
    if (!isRoot) return; // component selection (Studio + in-chat components) stays owner-only
    e.preventDefault(); e.stopPropagation();
    const id = el.getAttribute('data-component-id'); const name = el.getAttribute('data-component-name') || 'component'; const spec = el.__componentSpec;
    const r = el.getBoundingClientRect();
    const editLabel = id ? '✎ edit' : '⤴ edit (break out)';
    chip.innerHTML = `<span style="color:var(--mut)">🧩 ${esc(name)}</span> <button class="mini" data-act="edit">${editLabel}</button> ${id ? '<button class="mini" data-act="fork">🍴 fork</button>' : ''} <button class="mini" data-act="x">✕</button>`;
    chip.style.display = 'flex'; chip.style.left = `${Math.min(r.left, innerWidth - 240)}px`; chip.style.top = `${Math.min(r.bottom + 6, innerHeight - 44)}px`; place(el);
    chip.querySelector('[data-act=edit]').onclick = () => { clearChip(); if (id) editComponent(id, name); else breakOutThenEdit(spec, name); };
    const fk = chip.querySelector('[data-act=fork]'); if (fk) fk.onclick = () => { clearChip(); forkComponentAct(id, name); };
    chip.querySelector('[data-act=x]').onclick = clearChip;
  }, true);
  addEventListener('keydown', e => { if (e.key === 'Escape') clearChip(); });
  addEventListener('scroll', () => { if (chip.style.display === 'flex') clearChip(); }, true);
};
componentSelect();
// ── 🖼 the component GALLERY — every UI component rendered live with DUMMY sample data, in a grid, so you
//    (and agents) can see the framework's vocabulary at a glance. It reflects the active theme (the same
//    propagator feeds these previews), so it doubles as a live style reference. Self-contained samples
//    (ui.local / local time) — no real cap or live data needed. ──
const GALLERY_COUNTER = "(ui) => { const n = ui.local(0); const box = ui.create('div').style({padding:'10px',font:'14px sans-serif',color:'var(--ink)'}); const out = ui.create('div').style({fontSize:'26px',fontWeight:'700',marginBottom:'8px'}).follow(n, v => 'count: ' + v); const btn = ui.create('button').text('+1').style({background:'var(--acc)',color:'#fff',border:'0',borderRadius:'8px',padding:'5px 13px',cursor:'pointer'}).on('click', () => n.set(n.get() + 1)); return box.push([out, btn]); }";
const GALLERY_STATUS = "(ui) => { const open = ui.local(true); const box = ui.create('div').style({padding:'10px',font:'14px sans-serif',color:'var(--ink)',display:'flex',alignItems:'center',gap:'8px'}); const dot = ui.create('div').style({fontSize:'14px'}).follow(open, v => v ? '🟢' : '⚪'); const lbl = ui.create('div').follow(open, v => v ? 'Front door: OPEN' : 'Front door: closed'); const btn = ui.create('button').text('toggle').style({marginLeft:'auto',background:'var(--panel)',color:'var(--mut)',border:'1px solid var(--edge)',borderRadius:'7px',padding:'3px 9px',cursor:'pointer'}).on('click', () => open.set(!open.get())); box.push([dot, lbl, btn]); return box; }";
const GALLERY_SEPIA = { '--bg': '#1c160f', '--panel': '#2a2014', '--edge': '#473826', '--ink': '#f0e6d2', '--mut': '#b0a085', '--acc': '#c98a3a', '--acc2': '#8a9a4a', '--bad': '#cf6a4a', '--you': '#5a7a9a' };
const gallerySamples = () => [
  { title: '⏲ Countdown', sub: 'a live timer ticking toward a due time', spec: { type: 'countdowns', timers: [{ label: 'Pasta', dueAt: new Date(Date.now() + 8 * 60000).toISOString() }] } },
  { title: '☑ Choices', sub: 'tappable options sent back as the next message', spec: { type: 'choices', prompt: 'Pick a side', options: ['Fries', 'Salad', 'Rice'] } },
  { title: '🟢 Live status', sub: 'a status widget (here: a sample door)', spec: { type: 'component', cells: [], height: 64, source: GALLERY_STATUS } },
  { title: '🧩 Confined component', sub: 'arbitrary agent-authored UI, sandboxed', spec: { type: 'component', cells: [], height: 96, source: GALLERY_COUNTER } },
  { title: '🎨 Theme preview', sub: 'before/after a proposed theme, with accept', spec: { type: 'theme-preview', name: 'Sepia', mode: 'dark', vars: GALLERY_SEPIA } },
];
const GALLERY_GRID = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(232px,1fr));gap:12px';
const galleryCard = (title, subtext, render) => {
  const card = document.createElement('div'); card.style.cssText = 'border:1px solid var(--edge);border-radius:12px;padding:10px;background:var(--bg);overflow:hidden';
  const h = document.createElement('div'); h.style.cssText = 'font-size:12px;font-weight:600'; h.textContent = title;
  const sub = document.createElement('div'); sub.className = 'sub'; sub.style.cssText = 'font-size:11px;margin:1px 0 8px'; sub.textContent = subtext;
  const slot = document.createElement('div'); card.append(h, sub, slot);
  try { render(slot); } catch { slot.textContent = 'preview unavailable'; }
  return card;
};
const renderGallery = () => {
  const host = $('component-gallery'); if (!host) return;
  host.innerHTML = ''; // fresh each time the tab is opened (showTab fires once per navigation)
  // 1) the built-in component VOCABULARY (self-contained samples).
  const grid = document.createElement('div'); grid.style.cssText = GALLERY_GRID;
  for (const s of gallerySamples()) grid.appendChild(galleryCard(s.title, s.sub, slot => renderWidgets(slot, [s.spec], { cap, onChoice: t => setStatus(`(gallery sample) you'd choose: ${t}`) })));
  host.appendChild(grid);
  (async () => {
    // 2) YOUR library's broken-out components, each rendered live with GENERATED dummy data.
    let comps = [];
    try { comps = ((await (await fetch('/components/list-ui', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) })).json()).components) || []; } catch { /* */ }
    if (comps.length && $('component-gallery')) {
      const hd = document.createElement('div'); hd.className = 'shares-sec'; hd.style.cssText = 'margin:16px 0 8px'; hd.textContent = `Your components (${comps.length}) · sample data`;
      host.appendChild(hd);
      const g2 = document.createElement('div'); g2.style.cssText = GALLERY_GRID;
      for (const c of comps) {
        const card = galleryCard(c.name, c.cells && c.cells.length ? `cells: ${c.cells.join(', ')}` : 'no live cells', slot => renderWidgets(slot, [{ type: 'component', source: c.source, cells: c.cells || [], height: 120 }], { cap, sample: true }));
        if (isRoot) { const del = document.createElement('button'); del.className = 'mini'; del.textContent = '🗑'; del.title = 'Delete this component from the gallery'; del.style.cssText = 'position:absolute;top:6px;right:6px;z-index:2'; del.onclick = async e => { e.stopPropagation(); if (!window.confirm(`Delete "${c.name}" from the gallery?`)) return; await pf('/components/delete-ui', { id: c.id }); renderGallery(); }; card.style.position = 'relative'; card.appendChild(del); }
        g2.appendChild(card);
      }
      host.appendChild(g2);
    }
    // 3) ISLANDS — the framework's own confined-Preact chrome, rendered through the real islands bundle
    //    (renderConfined) with dummy data. New islands self-register here as they ship a preview shape.
    let islands = [];
    try { islands = ((await (await fetch('/components/islands', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) })).json()).islands) || []; } catch { /* */ }
    if (islands.length && $('component-gallery')) {
      const hd = document.createElement('div'); hd.className = 'shares-sec'; hd.style.cssText = 'margin:16px 0 8px'; hd.textContent = `Islands · framework chrome (sample data)`;
      host.appendChild(hd);
      const g3 = document.createElement('div'); g3.style.cssText = GALLERY_GRID;
      for (const isl of islands) g3.appendChild(galleryCard(isl.name, 'confined-Preact island', slot => {
        const prev = ISLAND_PREVIEW[isl.id];
        if (prev && window.__fieldIslands) { prev(slot); return; }
        slot.className = 'sub'; slot.style.cssText = 'font-size:11px;padding:6px 2px';
        slot.textContent = isl.id === 'island-trace' ? '🧊 3D conversation trace — appears live under each agent response' : 'no sample preview yet';
      }));
      host.appendChild(g3);
    }
  })();
};
// each island previews with its OWN dummy data through the real islands bundle (renderConfined). Keyed by
// island id so a new island just adds an entry (toward islands shipping their own sample data in-bundle).
const ISLAND_PREVIEW = {
  'island-shares-panel': slot => window.__fieldIslands.renderShares(slot, {
    items: [{ label: 'Front door', tag: 'ha-lock: Front door · read-only' }, { label: 'Research team', tag: 'web' }],
    components: [{ toolName: 'GPU image-gen', mode: 'instance', price: '0.05 USD/use', used: 3, atten: 'rate 10/min', revoked: false }],
    earned: '1.20 USD',
  }, { onCopy() {}, onQr() {}, onRevoke() {}, onCopyComp() {}, onRevokeComp() {} }),
  'island-notifications': slot => window.__fieldIslands.renderNotifications(slot, {
    items: [
      { id: 'n1', title: '🎙 Voice note → proposed actions', time: '2m', body: 'Book Lufthansa to Berlin; find a hotel near Mitte.', agent: '🤖 capture', status: 'needs your input', links: [{ label: '💬 open chat' }], attention: true },
      { id: 'n2', title: 'GPU render complete', time: '1h', body: 'Stylized 4 images.', agent: '🎨 studio', status: 'done', links: [{ label: '📎 gallery' }] },
    ],
    withDone: true,
  }, { onDone() {}, onOpenLink() {} }),
  'island-changelog': slot => window.__fieldIslands.renderChangelogList(slot, {
    merges: [
      { id: 'm1', goal: 'add clearResolved() to prune merged/staged backlog items', when: 'today', sha: 'a1b2c3d4', rolledBack: false },
      { id: 'm2', goal: 'add backlogStats() observability helper', when: 'yesterday', sha: '9f8e7d6c', rolledBack: true, revertedWhen: 'today' },
    ],
  }, { onRevert() {} }),
  'island-powers-banner': slot => window.__fieldIslands.renderPowersBanner(slot, {
    items: [
      { power: 'notes', icon: '📓', tip: 'notes — read/append your vault' },
      { power: 'web', icon: '🌐', tip: 'web — fetch a page' },
      { power: 'images', icon: '🎨', tip: 'images — generate an image' },
    ],
    manageable: true,
  }, { onRevoke() {}, onAddPowers() {} }),
  'island-ui-kit': slot => window.__fieldIslands.renderKitSampler(slot), // a living style guide of every primitive
  'island-ask-card': slot => window.__fieldIslands.renderAskCard(slot, {
    ask: { id: 'a1', title: 'Confirm the Berlin trip dates', body: 'I found two viable windows.', requestedBy: 'travel-agent', questions: [
      { id: 'q1', q: 'Which window?', type: 'choice', options: ['Jun 3–7', 'Jun 10–14'] },
      { id: 'q2', q: 'Add a Potsdam day trip?', type: 'bool' },
      { id: 'q3', q: 'Anything to note?', type: 'text' },
    ] },
    answers: { q1: 'Jun 3–7', q2: 'yes' }, status: '',
  }, { onChange() {}, onSubmit() {}, onOpenOrigin() {} }),
  'island-proposal-card': slot => window.__fieldIslands.renderProposalCard(slot, {
    proposal: { id: 'p1', type: 'email', title: 'Send the follow-up email', detail: { to: 'alex@example.com', subject: 'Re: Berlin dates', body: 'Booked Jun 3–7. Hotel near Mitte.' } },
    icon: '✉️', accent: '#7c5cff', mayConfirm: true, dontAsk: false,
  }, { onConfirm() {}, onReject() {}, onToggleDontAsk() {} }),
  'island-chat-list': slot => window.__fieldIslands.renderChatList(slot, {
    items: [
      { id: 'c1', title: 'Berlin trip planning', active: true, needs: true },
      { id: 'c2', title: 'GPU studio session', perm: 'write' },
      { id: 'c3', title: 'voice note — groceries', voice: true },
      { id: 'c4', title: 'Shared: rover telemetry', perm: 'read' },
    ],
    more: 3,
  }, { onSelect() {}, onDelete() {}, onMore() {}, onRenameStart() {}, onRenameChange() {}, onRenameCommit() {} }),
  'island-message-controls': slot => window.__fieldIslands.renderMessageControls(slot, { hasAudio: true, varIx: 1, varCount: 3 }, { onRetry() {}, onEdit() {}, onPlayAudio() {}, onFork() {} }),
  'island-chat-meta-bar': slot => window.__fieldIslands.renderChatMetaBar(slot, {
    mode: 'chat', title: 'Berlin trip planning', shareMode: 'write', metered: true,
    parent: { id: 'p0', title: 'Travel research', available: true }, project: { id: 'pr0', name: 'Europe 2026' },
  }, { onVersionPrev() {}, onVersionNext() {}, onRerun() {}, onOpenParent() {}, onOpenProject() {} }),
  'island-dev-task-card': slot => window.__fieldIslands.renderDevTaskCard(slot, {
    task: { id: 'd1', to: 'blacksmith', status: 'working', task: 'Add a CSV export button to the rover dashboard', thread: [{ role: 'you', text: 'use the existing toolbar styles' }, { role: 'blacksmith', text: 'on it — wiring the export now' }] },
    accent: '#2ea043', expanded: true, draft: '',
  }, { onToggle() {}, onReplyChange() {}, onReplySend() {} }),
  'island-exhausted-card': slot => window.__fieldIslands.renderExhaustedCard(slot, { isRoot: true }, { onTopUp() {}, onAbandon() {} }),
  'island-trace-signature': slot => window.__fieldIslands.renderTraceSignature(slot, {
    steps: [
      { name: 'research', icon: '🔎', childCount: 3 },
      { name: 'delegateTask', icon: '🤝', childCount: 2, children: [{ name: 'fetchUrl', icon: '🌐' }, { name: 'searchNotes', icon: '📓' }] },
      { name: 'generateImage', icon: '🎨', ok: false, detail: 'GPU busy' },
    ], expanded: true, legend: 'Symbols: 🔎 research · 🤝 delegateTask · 🎨 generateImage',
  }, { onToggle() {}, onOpen3D() {} }),
  'island-object-browser': slot => window.__fieldIslands.renderObjectBrowser(slot, {
    crumbs: [{ label: 'Home Assistant' }, { label: 'Kitchen' }],
    items: [
      { label: 'Lights', sub: '4 entities' }, { label: 'Front door', sub: 'lock.front', leaf: true },
      { label: 'Thermostat', sub: 'climate.main', leaf: true },
    ], roOnly: false,
  }, { onCrumb() {}, onDrill() {}, onShareRO() {}, onShareFull() {} }),
  'island-share-link-manager': slot => window.__fieldIslands.renderShareLinkManager(slot, {
    title: 'Berlin trip planning',
    links: [
      { token: 't1', name: 'kumavis · read-only', mode: 'read' },
      { token: 't2', name: 'team room', mode: 'write', allowanceUsd: 5, adjusting: true, draftName: 'team room', draftMode: 'write', draftAllow: 5 },
    ], newName: '', newMode: 'read', newAllow: '',
  }, { onCopy() {}, onQr() {}, onAdjustToggle() {}, onAdjustField() {}, onSave() {}, onRevoke() {}, onNewField() {}, onCreate() {} }),
};

const refreshComponents = async () => {
  const list = $('components-list'); if (!list) return;
  let all = [];
  try { const r = await (await fetch('/tools/review', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) })).json(); all = r.tools || []; }
  catch { list.innerHTML = '<div class="pill">could not load components</div>'; return; }
  const pending = all.filter(t => t.status === 'pending');
  const tools = all.filter(t => t.status === 'admitted');
  updateComponentsBadge(pending.length);
  if (!pending.length && !tools.length) { list.innerHTML = '<div class="pill">no components yet — ask the agent in chat to build a tool (proposeTool); it shows up here to review + admit</div>'; return; }
  // 🆕 PENDING REVIEW — agent-proposed tools awaiting your admit (the discipline panel ran on each).
  let html = '';
  if (pending.length) {
    html += `<div class="shares-sec">🆕 Pending review (${pending.length})</div>`;
    html += pending.map(t => {
      const rv = t.review; const sev = rv ? rv.worst : 'reviewing…';
      const findings = rv ? rv.findings.map(f => `${esc(f.discipline)}: ${esc(f.severity)}`).join(' · ') : 'running the discipline panel…';
      const code = t.code || (t.files ? Object.entries(t.files).map(([k, v]) => `// ${k}\n${v}`).join('\n\n') : '');
      const sevClass = sev === 'critical' ? ' bad' : '';
      // the review→revise DIALOGUE: each round shows how the panel's criticisms were integrated/noted/unified.
      const rl = t.reviseLog;
      const dialogue = rl ? `<details style="margin:6px 0 0 6px" open><summary class="mini" style="display:inline-block">🔧 revise dialogue · ${rl.converged ? '✓ converged' : `${esc(String(rl.rounds || 0))} round(s) · worst ${esc(rl.worst || '?')}`}</summary>${(rl.log || []).map(r => r.error
        ? `<div class="sub" style="margin:3px 0 0 8px;color:var(--bad)">round ${esc(String(r.round))}: ${esc(r.error)}</div>`
        : `<div class="sub" style="margin:5px 0 0 8px"><b>round ${esc(String(r.round))}</b> · ${esc(r.worstBefore || '?')} → ${esc(r.worstAfter || '?')}</div>${(r.resolutions || []).map(x => `<div class="sub" style="margin:1px 0 0 16px">• ${esc(x.finding || '')} ${x.action ? `<span class="pill">${esc(x.action)}</span>` : ''} ${esc(x.how || '')}</div>`).join('')}`).join('')}</details>` : '';
      return `<div class="comp"><div class="comp-head"><b>${esc(t.name)}</b> <span class="pill${sevClass}">by ${esc(t.proposedBy || '?')} · panel: ${esc(sev)}</span> <button class="mini" data-admit="${esc(t.id)}" data-name="${esc(t.name)}" data-worst="${esc(rv ? rv.worst : '')}">admit</button> <button class="mini" data-revise="${esc(t.id)}" data-name="${esc(t.name)}" title="Hand the panel's findings back to the developer to integrate / note / unify into an elegant solution, then re-review">✨ revise</button> <button class="mini bad" data-reject="${esc(t.id)}" data-name="${esc(t.name)}">reject</button></div><div class="sub" style="margin:4px 0 0 6px">${findings}</div>${dialogue}<details style="margin:5px 0 0 6px"><summary class="mini" style="display:inline-block">view code</summary><pre class="codeview">${esc(code)}</pre></details></div>`;
    }).join('');
    // PAINT THE PENDING NOW — don't make the badge's count diverge from an empty list while the slower
    // islands + per-tool history fetches below run (the "Components (7) but nothing listed" bug). The
    // final innerHTML at the end replaces this with everything (pending + admitted + islands).
    list.innerHTML = html; wireComponentActions();
  }
  // ISLANDS (confined-Preact UI components — their source is a client file, rebuilt on edit).
  let islandsHtml = '';
  try {
    const ir = await (await fetch('/components/islands', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) })).json();
    const islands = ir.islands || [];
    if (islands.length) {
      const ih = {};
      await Promise.all(islands.map(async i => { try { const h = await (await fetch('/components/history', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, id: i.id }) })).json(); ih[i.id] = h.versions || []; } catch { ih[i.id] = []; } }));
      islandsHtml = `<div class="shares-sec">Islands (live UI · rebuilt on edit)</div>` + islands.map(i => {
        const vs = ih[i.id] || []; const cur = vs[0];
        const rows = vs.map((v, k) => `<div class="cver"><span class="vmono">${esc(String(v.version).slice(0, 8))}</span> <span class="sub">${esc(v.summary || '')}</span>${k === 0 ? ' <span class="pill">current</span>' : ` <button class="mini" data-revert="${esc(i.id)}" data-ver="${esc(v.version)}">revert</button>`}</div>`).join('');
        return `<div class="comp" data-component-id="${esc(i.id)}" data-component-name="${esc(i.name)}"><div class="comp-head"><b>${esc(i.name)}</b> <span class="pill">island${cur ? ` · v ${esc(String(cur.version).slice(0, 8))}` : ''}</span> <button class="mini" data-edit="${esc(i.id)}" data-name="${esc(i.name)}">✎ edit</button></div><div class="cvers">${rows || '<span class="sub">no versions yet</span>'}</div></div>`;
      }).join('');
    }
  } catch { /* ignore */ }
  if (!tools.length) { list.innerHTML = (html + islandsHtml) || '<div class="pill">no components yet</div>'; wireComponentActions(); return; }
  const hists = {}; const grains = {};
  await Promise.all(tools.map(async t => { try { const h = await (await fetch('/components/history', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, id: t.id }) })).json(); hists[t.id] = h.versions || []; grains[t.id] = h.grains || {}; } catch { hists[t.id] = []; grains[t.id] = {}; } }));
  if (pending.length) html += `<div class="shares-sec">Admitted</div>`;
  html += tools.map(t => {
    const vs = hists[t.id] || []; const cur = vs[0];
    const rows = vs.map((v, i) => `<div class="cver"><span class="vmono">${esc(String(v.version).slice(0, 8))}</span> <span class="sub">${esc(v.summary || '')}</span>${i === 0 ? ' <span class="pill">current</span>' : ` <button class="mini" data-revert="${esc(t.id)}" data-ver="${esc(v.version)}">revert</button>`}</div>`).join('');
    const gks = Object.keys(grains[t.id] || {});
    const gview = gks.length ? `<div class="cgrains sub">🌱 data: ${gks.map(k => `${esc(k)}=${esc(JSON.stringify(grains[t.id][k]))}`).join(' · ')} <span style="opacity:.6">(survives edits/reverts)</span></div>` : '';
    return `<div class="comp" data-component-id="${esc(t.id)}" data-component-name="${esc(t.name)}"><div class="comp-head"><b>${esc(t.name)}</b> <span class="pill">${esc(t.kind || 'instance')}${cur ? ` · v ${esc(String(cur.version).slice(0, 8))}` : ''}</span> <button class="mini" data-edit="${esc(t.id)}" data-name="${esc(t.name)}">✎ edit</button> <button class="mini" data-fork="${esc(t.id)}" data-name="${esc(t.name)}">fork</button></div>${gview}<div class="cvers">${rows || '<span class="sub">no versions recorded yet</span>'}</div></div>`;
  }).join('');
  list.innerHTML = html + islandsHtml;
  wireComponentActions();
};
// admit / reject the pending proposals + the admitted-component actions
const wireComponentActions = () => {
  const list = $('components-list'); if (!list) return;
  list.querySelectorAll('[data-admit]').forEach(b => { b.onclick = async () => { b.disabled = true; let r = await (await fetch('/tools/admit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, id: b.dataset.admit }) })).json(); if (r.blocked === 'critical' && !window.confirm(`The review panel flagged a CRITICAL issue in "${b.dataset.name}". Admit anyway?`)) { b.disabled = false; return; } if (r.blocked === 'critical') { r = await (await fetch('/tools/admit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, id: b.dataset.admit, override: true }) })).json(); } setStatus(r.ok ? `Admitted "${b.dataset.name}" — it's now a live component.` : `admit: ${r.error || 'failed'}`); refreshComponents(); }; });
  list.querySelectorAll('[data-reject]').forEach(b => { b.onclick = async () => { if (!window.confirm(`Reject "${b.dataset.name}"? It's discarded.`)) return; b.disabled = true; await fetch('/tools/reject', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, id: b.dataset.reject }) }); refreshComponents(); }; });
  // ✨ revise — hand the panel's findings back to the developer to integrate/note/unify, then re-review.
  list.querySelectorAll('[data-revise]').forEach(b => { b.onclick = async () => { b.disabled = true; const t0 = b.textContent; b.textContent = '✨ revising…'; setStatus(`Revising "${b.dataset.name}" against the review panel…`); try { const r = await (await fetch('/tools/revise', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, id: b.dataset.revise }) })).json(); setStatus(r.ok ? `Revised "${b.dataset.name}" — ${r.converged ? '✓ converged (clean)' : `${r.rounds} round(s), worst now ${r.worst}`}.` : `revise: ${r.error || 'failed'}`); } catch (e) { setStatus('revise failed: ' + e.message); b.textContent = t0; b.disabled = false; } refreshComponents(); }; });
  list.querySelectorAll('[data-edit]').forEach(b => { b.onclick = () => editComponent(b.dataset.edit, b.dataset.name); });
  list.querySelectorAll('[data-revert]').forEach(b => { b.onclick = async () => { if (!window.confirm('Revert the LIVE component to this version? Non-destructive — it makes a new version; the live tool then runs it.')) return; b.disabled = true; await fetch('/components/revert', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, id: b.dataset.revert, version: b.dataset.ver }) }); refreshComponents(); }; });
  list.querySelectorAll('[data-fork]').forEach(b => { b.onclick = () => forkComponentAct(b.dataset.fork, b.dataset.name); });
};

// ── tabs + boot ─────────────────────────────────────────────────────────────
const showTab = which => {
  $('tab-talk').classList.toggle('on', which === 'talk');
  $('tab-shares').classList.toggle('on', which === 'shares');
  $('tab-components').classList.toggle('on', which === 'components');
  $('talk').classList.toggle('hide', which !== 'talk');
  $('composer').classList.toggle('hide', which !== 'talk');
  $('shares-view').classList.toggle('hide', which !== 'shares');
  $('components-view').classList.toggle('hide', which !== 'components');
  $('inbox-view').classList.toggle('hide', which !== 'inbox');
  curTab = which;
  // the live 3D pendant is position:absolute (z-index 25); without this it floats OVER the
  // shares/inbox cards and bleeds through, hurting readability. Hide it off the talk tab.
  if (pendantWrap && which !== 'talk') pendantWrap.classList.add('hide');
  else if (which === 'talk') schedulePendantPosition(); // back on chat → re-anchor (shows only if there's a trace)
  syncLanding(); // centre the composer only on an empty talk view
  renderChatBar(); // per-chat top bar shows only in the talk view
  syncSelectors(); // agent + model dropdowns show only in the talk view
  if (which === 'inbox') renderInbox();
  if (which === 'components') { renderGallery(); refreshComponents(); }
  if (which === 'shares') {
    refreshShares();
    refreshAutoRules();
    refreshSpecialists();
    const hasObjs = heldPowers.has('homeassistant') || heldPowers.has('agents') || heldPowers.has('contacts') || heldPowers.has('home') || heldPowers.has('timers') || heldPowers.has('notes');
    $('obj-browser').classList.toggle('hide', !hasObjs);
    if (hasObjs) navGo([], { push: false }); // root folder list (history baseline)
  }
};
let curTab = 'talk';
$('obj-filter').oninput = renderNavList;
// browser back/forward walks the object-navigator path (filesystem-style)
window.addEventListener('popstate', e => {
  if (!(e.state && e.state.nav)) return;
  if (curTab !== 'shares') showTab('shares'); // may reset navStack; restore it next
  navStack = e.state.nav;
  renderNav();
});
$('tab-talk').onclick = () => showTab('talk');
$('tab-shares').onclick = () => showTab('shares');
$('tab-components').onclick = () => showTab('components');
$('mint').onclick = mint;
// 👤 Invite a new user (Phase 1): mint a confined STARTER cap + hand over the link (copy/QR only).
const INVITE_STARTER = new Set(['reference', 'research', 'images', 'contact']);
const INVITE_HIDE = new Set(['delegate', 'subagent', 'specialists', 'roles', 'app', 'host', 'vm']); // meta + coarse host: not in a starter picker
const fillInviteBox = () => {
  const box = $('invite-box'); if (!box) return;
  if (!isRoot) { box.classList.add('hide'); return; } // only the owner issues invites
  box.classList.remove('hide');
  const grantable = [...(heldPowers || [])].filter(p => !INVITE_HIDE.has(p));
  // default view = just the least-privilege STARTER ring as chips; "+ Add more" grants the rest of grantable.
  renderPowersPicker($('inv-powers'), { all: grantable, granted: grantable.filter(p => INVITE_STARTER.has(p)), itemShare: true });
};
// 🔌 Connectors (Phase 3 Lane A) — owner wires up API-service tools; key → vault, injected server-side.
const fillConnectorsBox = async () => {
  const box = $('connectors-box'); if (!box) return;
  if (!isRoot) { box.classList.add('hide'); return; }
  box.classList.remove('hide');
  let cs = []; try { cs = (await (await fetch('/connectors/list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) })).json()).connectors || []; } catch {}
  const list = $('conn-list');
  const priceTag = c => c.costUusd ? ` · 💲${(c.costUusd / 1e6 * (1 + (c.commissionPct || 0) / 100)).toFixed(4)}/call (${c.commissionPct || 0}% comm)` : ' · free';
  list.innerHTML = cs.length ? cs.map(c => `<div class="share"><div>🔌 <b>${esc(c.name)}</b> <span style="color:var(--mut);font-size:11px">${esc(c.baseUrl)}${c.readOnly ? ' · read-only' : ''}${c.needsKey ? (c.hasKey ? ' · 🔑✓' : ' · ⚠️ no key') : ''}${esc(priceTag(c))}${c.resale && c.resale !== 'unknown' ? ` · ${esc(c.resale)}` : ''}</span></div><div><button class="mini" data-connrm="${esc(c.id)}">×</button></div></div>`).join('') : '<div class="sub">No connectors yet.</div>';
  list.querySelectorAll('[data-connrm]').forEach(b => b.onclick = async () => { if (!confirm('Remove this connector?')) return; await fetch('/connectors/remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, id: b.dataset.connrm }) }); fillConnectorsBox(); });
};
{ const ca = $('conn-add'); if (ca) ca.onclick = async () => {
  const body = { cap, name: $('conn-name').value.trim(), baseUrl: $('conn-url').value.trim(), header: $('conn-header').value.trim() || 'Authorization', valueTemplate: $('conn-tmpl').value.trim() || 'Bearer {{secret}}', secretName: $('conn-secname').value.trim(), secret: $('conn-secval').value, readOnly: $('conn-ro').checked, costUusd: Math.round((Number($('conn-cost').value) || 0) * 1e6), commissionPct: Number($('conn-comm').value) || 0, resale: $('conn-resale').value };
  if (!body.name || !body.baseUrl) { alert('name + base URL are required'); return; }
  ca.disabled = true;
  let r; try { r = await (await fetch('/connectors/add', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json(); } catch (e) { r = { error: e.message }; }
  ca.disabled = false;
  if (r.error) { $('conn-out').textContent = 'error: ' + r.error; return; }
  $('conn-out').textContent = `✓ added "${r.name}"`;
  ['conn-name', 'conn-url', 'conn-header', 'conn-tmpl', 'conn-secname', 'conn-secval'].forEach(id => { const el = $(id); if (el) el.value = ''; }); // clear (incl. the secret field)
  fillConnectorsBox();
}; }
{ const im = $('inv-make'); if (im) im.onclick = async () => {
  const label = ($('inv-label').value || '').trim() || 'guest';
  const powers = [...document.querySelectorAll('#inv-powers input:checked')].map(x => x.value);
  if (!powers.length) { alert('pick at least one starter tool'); return; }
  im.disabled = true;
  let r; try { r = await (await fetch('/invite', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, powers, label }) })).json(); } catch (e) { r = { error: e.message }; }
  im.disabled = false;
  if (!r || r.error || !r.scopedCap) { alert((r && r.error) || 'invite failed'); return; }
  const link = { url: `${location.origin}/#cap=${r.scopedCap}`, label: `invite · ${label}` };
  $('inv-out').innerHTML = `<div class="sub" style="margin-bottom:6px">✓ Invite for <b>${esc(label)}</b> — tools: ${(r.powers || []).map(p => esc(p)).join(', ')}. Hand them this link (copy or QR — don't screenshot it):</div><div style="display:flex;gap:6px"><button class="mini" id="inv-copy">copy link</button><button class="mini" id="inv-qr">show QR</button></div>`;
  $('inv-copy').onclick = e => copyLink(link, e.currentTarget);
  $('inv-qr').onclick = () => showQr(link);
}; }
if ($('agent-sel')) $('agent-sel').onchange = e => {
  const v = e.target.value;
  if (v.startsWith('project:')) { startProjectChat(v.slice('project:'.length)); return; }
  const c = curChatObj();
  if (c) { c.agent = v; c.model = rememberedModels()[c.agent] || 'default'; saveChats(); }
  else { pendingAgent[sessionId] = v; } // ephemeral new chat → remember the entrypoint agent until it commits
  syncSelectors();
  renderTx(); // show (or clear) the chosen entrypoint agent's powers banner immediately, even before the first message
};
if ($('model-sel')) $('model-sel').onchange = e => { const c = curChatObj(); if (!c) return; c.model = e.target.value; rememberModel(c.agent || 'field-agent', c.model); saveChats(); };

// ── Feature B: share THIS chat as a link (read-only default / write) + an optional recipient
// spend allowance. Anyone with the link gets the chat in their bar (even a brand-new user, no cap).
const shareChat = async () => {
  const c = chats.find(x => x.id === sessionId);
  if (!c) { setStatus('open a chat to share it'); return; }
  // Holder of a shared link: they can FORWARD the same link (the token IS the access — passing it on is
  // delegation; minting a new share needs the owner's root cap, so we re-offer the link they already hold).
  if (c.shared && c.shareToken) {
    const url = location.origin + '/#chatshare=' + c.shareToken;
    let qr = ''; try { const q = window.qrcode(0, 'M'); q.addData(url); q.make(); qr = q.createImgTag(5, 6); } catch {}
    showModal(`<div class="dkm" style="text-align:left;max-width:420px;margin:-18px -18px 8px;padding:16px;border-radius:12px 12px 0 0"><b>📤 Forward “${esc(c.title || 'chat')}”</b>
      <div style="font-size:12px;color:var(--mut);margin:8px 0">You hold a ${c.shareMode === 'write' ? 'WRITE' : 'read-only'} link to this chat — pass it on. Anyone with it gets the same access.</div>
      <div style="display:flex;gap:6px;align-items:center"><input class="hdr-sel" style="flex:1;max-width:none" id="fwd-url" value="${esc(url)}" readonly onclick="this.select()"><button class="mini" id="fwd-copy">copy</button></div>
      <div style="text-align:center;margin-top:10px">${qr}</div></div>`);
    const cp = $('fwd-copy'); if (cp) cp.onclick = () => { try { navigator.clipboard.writeText(url); cp.textContent = 'copied'; } catch {} };
    return;
  }
  await renderShareManager(c);
};
// Share MANAGER: list the named links you've created for this chat (each independent — own permission +
// allowance), adjust/copy/QR/revoke any of them, and create a NEW named link (name required; the URL is
// shown only after you create it). Selecting "adjust" edits an existing link's permission in place.
const shareUrl = token => location.origin + '/#chatshare=' + token;
const shareApi = (p, body) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, ...body }) }).then(r => r.json()).catch(e => ({ error: e.message }));
const renderShareManager = async (c) => {
  const d = await shareApi('/share/list', { chatId: sessionId });
  const list = (d && d.shares) || [];
  const badge = m => m === 'write' ? '<span class="cb-right write" style="font-size:10px;padding:1px 6px">✍️ write</span>' : '<span class="cb-right ro" style="font-size:10px;padding:1px 6px">🔒 read</span>';
  const row = s => `<div class="share" style="flex-direction:column;align-items:stretch;gap:6px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <span><b>${esc(s.name || '(unnamed)')}</b> ${badge(s.mode)}${s.allowanceUsd ? ` <span class="pill">$${s.allowanceUsd}</span>` : ''}</span>
        <span style="white-space:nowrap"><button class="mini" data-scopy="${esc(s.token)}">copy</button> <button class="mini" data-sqr="${esc(s.token)}">QR</button> <button class="mini" data-sadj="${esc(s.token)}">adjust</button> <button class="mini bad" data-srev="${esc(s.token)}">revoke</button></span>
      </div>
      <div class="sadj-form" data-stok="${esc(s.token)}" style="display:none;gap:6px;flex-wrap:wrap;align-items:center;border-top:1px solid var(--edge);padding-top:6px">
        <input class="hdr-sel" style="max-width:none;flex:1;min-width:120px" data-sname="${esc(s.token)}" value="${esc(s.name || '')}" placeholder="name">
        <select class="hdr-sel" style="max-width:none;width:auto" data-smode="${esc(s.token)}"><option value="read"${s.mode !== 'write' ? ' selected' : ''}>read-only</option><option value="write"${s.mode === 'write' ? ' selected' : ''}>write</option></select>
        <input class="hdr-sel" style="width:80px;max-width:none" type="number" min="0" step="0.25" data-sallow="${esc(s.token)}" value="${s.allowanceUsd || ''}" placeholder="$0">
        <button class="mini go" data-ssave="${esc(s.token)}">save</button>
      </div>
      <div data-sout="${esc(s.token)}"></div>
    </div>`;
  showModal(`<div class="dkm" style="text-align:left;width:480px;max-width:88vw;margin:-18px -18px 8px;padding:16px;border-radius:12px 12px 0 0;max-height:74vh;overflow-y:auto"><b>📤 Share “${esc(c.title || 'chat')}”</b>
    <div style="color:var(--mut);font-size:12px;margin:6px 0 8px">Your links for this chat — each is independent (its own permission + allowance).</div>
    <div id="sh-list">${list.length ? list.map(row).join('') : '<div class="pill">no links yet — create one below</div>'}</div>
    <div style="border-top:1px solid var(--edge);margin-top:12px;padding-top:10px"><div style="font-weight:600;font-size:13px;margin-bottom:6px">Create a new link</div>
      <input class="hdr-sel" style="max-width:none;width:100%;margin-bottom:6px" id="sh-name" placeholder="name this link (e.g. kumavis · read-only)">
      <label style="font-size:13px;display:block"><input type="radio" name="shmode" value="read" checked> Read-only — view only</label>
      <label style="font-size:13px;display:block"><input type="radio" name="shmode" value="write"> Write — can post + drive the agent (this chat's powers)</label>
      <label style="font-size:13px;color:var(--mut);display:block;margin-top:4px">Spend allowance (USD, optional): <input id="sh-allow" class="hdr-sel" style="width:84px;max-width:none" type="number" min="0" step="0.25" placeholder="0"></label>
      <button class="mini go" id="sh-make" style="margin-top:8px">Create link</button><div id="sh-out" style="margin-top:8px"></div></div>
    <div style="border-top:1px solid var(--edge);margin-top:12px;padding-top:10px;display:flex;flex-direction:column;gap:8px"><button class="mini" id="sub-open">✂️ …or create an attenuated sub-chat (subset of powers)</button><button class="mini" id="widget-open">🧩 …or open this chat as an embedded widget</button></div></div>`);
  const m = $('qrmodal');
  { const so = $('sub-open'); if (so) so.onclick = newSubChat; }
  { const wo = $('widget-open'); if (wo) wo.onclick = () => openWidget(c.scopedCap || cap); }
  const showUrlInto = (el, token, prefix = '') => { const url = shareUrl(token); let qr = ''; try { const q = window.qrcode(0, 'M'); q.addData(url); q.make(); qr = q.createImgTag(4, 5); } catch {} el.innerHTML = prefix + `<div style="display:flex;gap:6px;align-items:center;margin-top:4px"><input class="hdr-sel" style="flex:1;max-width:none" value="${esc(url)}" readonly onclick="this.select()"><button class="mini">copy</button></div><div style="text-align:center">${qr}</div>`; const cp = el.querySelector('button'); if (cp) cp.onclick = () => { try { navigator.clipboard.writeText(url); cp.textContent = 'copied'; } catch {} }; };
  m.querySelectorAll('[data-scopy]').forEach(b => b.onclick = () => { try { navigator.clipboard.writeText(shareUrl(b.dataset.scopy)); b.textContent = 'copied'; } catch { showUrlInto(m.querySelector(`[data-sout="${b.dataset.scopy}"]`), b.dataset.scopy); } });
  m.querySelectorAll('[data-sqr]').forEach(b => b.onclick = () => showUrlInto(m.querySelector(`[data-sout="${b.dataset.sqr}"]`), b.dataset.sqr));
  m.querySelectorAll('[data-sadj]').forEach(b => b.onclick = () => { const f = m.querySelector(`.sadj-form[data-stok="${b.dataset.sadj}"]`); if (f) f.style.display = f.style.display === 'none' ? 'flex' : 'none'; });
  m.querySelectorAll('[data-ssave]').forEach(b => b.onclick = async () => { const t = b.dataset.ssave; b.disabled = true; await shareApi('/share/update', { token: t, name: m.querySelector(`[data-sname="${t}"]`).value.trim(), mode: m.querySelector(`[data-smode="${t}"]`).value, allowanceUsd: parseFloat(m.querySelector(`[data-sallow="${t}"]`).value) || 0 }); renderShareManager(c); });
  m.querySelectorAll('[data-srev]').forEach(b => b.onclick = async () => { await shareApi('/share/revoke', { token: b.dataset.srev }); renderShareManager(c); });
  $('sh-make').onclick = async () => {
    const name = $('sh-name').value.trim();
    if (!name) { $('sh-out').innerHTML = `<div class="err">name this link first</div>`; $('sh-name').focus(); return; }
    const mode = (document.querySelector('input[name=shmode]:checked') || {}).value || 'read';
    const allowanceUsd = parseFloat($('sh-allow').value) || 0;
    $('sh-make').disabled = true;
    const tx = stripImg(activeTx).slice(-200).map(x => ({ who: x.who, text: x.text, tools: x.tools, imageUrls: x.imageUrls, attachUrls: x.attachUrls, attachFiles: x.attachFiles }));
    const r = await shareApi('/share/create', { chatId: sessionId, title: c.title, tx, scopedCap: c.scopedCap || cap, mode, allowanceUsd, name });
    if (!r || r.error) { $('sh-out').innerHTML = `<div class="err">${esc((r && r.error) || 'failed')}</div>`; $('sh-make').disabled = false; return; }
    showUrlInto($('sh-out'), r.token, `<div style="font-size:12px;color:var(--mut);margin-bottom:4px">✓ “${esc(name)}” · ${r.mode === 'write' ? 'WRITE' : 'read-only'}${r.allowanceUsd ? ` · $${r.allowanceUsd}` : ''} — share this link:</div>`);
  };
};
// open a chat someone shared with me (no cap needed — the token IS the access).
const mapShareTx = m => ({ who: m.who === 'you' ? 'you' : 'agent', text: m.text || '', tools: m.tools || [], imageUrls: m.imageUrls || [], attachUrls: m.attachUrls || [], attachFiles: m.attachFiles || [] });
const openSharedChat = async token => {
  let d; try { d = await (await fetch('/share/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })).json(); } catch { return false; }
  if (!d || d.error) { setStatus('share: ' + ((d && d.error) || 'unavailable')); return false; }
  const id = 'shared-' + String(token).slice(0, 16);
  if (!chats.some(x => x.id === id)) chats.unshift({ id, title: '🔗 ' + (d.title || 'Shared chat'), ts: Date.now(), shareToken: token, shareMode: d.mode, shareAllowance: !!d.hasAllowance, shared: true });
  const tx = (d.tx || []).map(mapShareTx); // keep durable image/attachment urls so the recipient sees previous images
  try { localStorage.setItem(txKey(id), JSON.stringify(tx)); } catch {}
  saveChats(); sessionId = id; try { localStorage.setItem(ACTIVE_KEY, id); } catch {}
  activeTx = tx;
  shareCursor[id] = (typeof d.len === 'number') ? d.len : tx.length; // baseline for live polling
  return true;
};
// ── LIVE ROOM: an open shared chat polls /share/open for turns posted by OTHER participants
//    (the owner or another holder), appending them so everyone converges on the one canonical
//    transcript. The token IS the room; posting (/share/post) and polling share rec.tx. ──
let sharePollTimer = null;
const shareCursor = {}; // chatId → server-side tx length the client has consumed (dedup vs own posts)
const stopSharePoll = () => { if (sharePollTimer) { clearInterval(sharePollTimer); sharePollTimer = null; } };
const startSharePoll = (id, token) => {
  stopSharePoll();
  sharePollTimer = setInterval(async () => {
    if (sessionId !== id) return stopSharePoll();   // navigated away
    if (busy) return;                                // our own turn is mid-flight; don't interleave
    let d; try { d = await (await fetch('/share/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, since: shareCursor[id] || 0 }) })).json(); } catch { return; }
    if (!d || d.error || !Array.isArray(d.tx) || !d.tx.length) { if (d && typeof d.len === 'number') shareCursor[id] = d.len; return; }
    activeTx.push(...d.tx.map(mapShareTx));
    shareCursor[id] = (typeof d.len === 'number') ? d.len : (shareCursor[id] || 0) + d.tx.length;
    saveTx(); renderTx(); window.scrollTo(0, document.body.scrollHeight);
  }, 4000);
};
// Right to Create an Attenuated Agent Chat: spin up a fresh chat granted only a SUBSET of your
// powers — usable now, shareable (🔗). Monotonic (server clamps to what you hold).
const newSubChat = () => {
  const avail = [...(heldPowers || [])];
  if (!avail.length) { setStatus('this cap holds no delegable powers'); return; }
  showModal(`<div class="dkm" style="text-align:left;max-width:440px;margin:-18px -18px 8px;padding:16px;border-radius:12px 12px 0 0"><b>✂️ Create an attenuated sub-chat</b>
    <div style="font-size:13px;color:var(--mut);margin:8px 0">A fresh chat granted only the powers you tick — usable now, shareable via 🔗. It can't act outside them.</div>
    <input class="hdr-sel" style="max-width:none;width:100%;margin-bottom:8px" id="sub-title" placeholder="name (e.g. camera control)">
    <div id="sub-powers"></div>
    <button class="mini" id="sub-make" style="margin-top:10px">Create sub-chat</button></div>`);
  renderPowersPicker($('sub-powers'), { all: avail, granted: [], itemShare: true }); // start empty — tick only the subset to delegate
  $('sub-make').onclick = async () => {
    const powers = [...document.querySelectorAll('#sub-powers input:checked')].map(x => x.value);
    const title = $('sub-title').value.trim() || 'sub-chat';
    if (!powers.length) { alert('tick at least one power'); return; }
    $('sub-make').disabled = true;
    let r; try { r = await (await fetch('/subchat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: chatCap(), powers, title }) })).json(); } catch (e) { r = { error: e.message }; }
    if (!r || r.error || !r.scopedCap) { alert((r && r.error) || 'failed'); $('sub-make').disabled = false; return; }
    closeModal();
    const id = 'chat-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    chats.unshift({ id, title: '✂️ ' + title, ts: Date.now(), scopedCap: r.scopedCap, attenuated: true, parentId: sessionId, parentTitle: (chats.find(x => x.id === sessionId) || {}).title || 'parent chat' }); saveChats();
    switchChat(id);
    setStatus('sub-chat created · powers: ' + (r.powers || []).join(', '));
  };
};
{ const b = $('chatshare-btn'); if (b) b.onclick = shareChat; }

// ── 🪝 Hooks: how to push custom media (image / text / voice) to this agent headlessly. The cap
// is shown only as a placeholder — never the real swissnum (cap-hygiene: don't render a cap). ──
const showHooks = () => {
  const o = location.origin;
  showModal(`<div class="dkm" style="text-align:left;max-width:540px;margin:-18px -18px 8px;padding:16px;border-radius:12px 12px 0 0"><b>🪝 Hooks — push custom media to your agent</b>
    <div style="font-size:13px;color:var(--mut);margin:8px 0">Send an image, file, or text to this agent from anything (an iOS Shortcut, a script, another app) — headlessly, no browser. The hex after <code>#cap=</code> in your invite link is the credential; keep it secret.</div>
    <div style="font-size:12px;font-weight:600;margin-top:10px">Image / text → <code>/chat</code> (the agent sees images directly)</div>
    <pre style="background:#010409;border:1px solid var(--edge);border-radius:8px;padding:8px;overflow:auto;font:11px ui-monospace,Menlo,monospace;color:#c9d1d9;white-space:pre">curl -X POST ${esc(o)}/chat -H 'content-type: application/json' -d '{
  "cap": "&lt;your #cap hex&gt;",
  "text": "look at this",
  "attachments": [
    {"kind":"image","name":"p.jpg","mediaType":"image/jpeg","url":"data:image/jpeg;base64,&lt;BASE64&gt;"},
    {"kind":"text","name":"notes.md","text":"any text"}
  ]
}'</pre>
    <div style="font-size:12px;font-weight:600;margin-top:10px">Voice note / longer input → <code>/ingest</code> (becomes a propose-only chat + a phone push)</div>
    <pre style="background:#010409;border:1px solid var(--edge);border-radius:8px;padding:8px;overflow:auto;font:11px ui-monospace,Menlo,monospace;color:#c9d1d9;white-space:pre">curl -X POST ${esc(o)}/ingest -H 'content-type: application/json' -d '{
  "cap":"&lt;your #cap hex&gt;", "transcript":"...", "source":"shortcut"
}'</pre></div>`);
};
{ const h = $('hooks-btn'); if (h) h.onclick = showHooks; }

// ── ⚙ Global Settings — the sidebar-footer foothold (owner-only). Per-chat things live in the header; THIS
//    is for GLOBAL config: the default allowance for NEW conversations, a spend leaderboard, model providers,
//    and (next) a gallery of the agents you've built as 3D Granovetter diagrams. A foothold to grow into.
const fmtUsd = u => '$' + (Math.max(0, Number(u) || 0) / 1e6).toFixed(2);
const fmtEvery = ms => { const n = Number(ms) || 0; const h = n / 3600000; if (h >= 24 && Number.isInteger(h / 24)) return `${h / 24}d`; if (h >= 1) return `${Math.round(h)}h`; return `${Math.round(n / 60000)}m`; };
const SETTINGS_SECTIONS = [{ key: 'usage', label: '📊 Usage' }, { key: 'providers', label: '🧠 Providers' }, { key: 'agents', label: '🕸️ Agents' }, { key: 'specialists', label: '🧑‍🔬 Specialists' }, { key: 'files', label: '📂 Files' }, { key: 'timers', label: '⏰ Timers' }, { key: 'internal', label: '📨 Internal' }];
let settingsSection = 'usage';
const openSettings = async () => {
  if (!isRoot) { setStatus('settings are owner-only — open with your root link'); return; }
  showModal(`<div class="setwrap"><div class="setnav">${SETTINGS_SECTIONS.map(s => `<button class="setnav-item${s.key === settingsSection ? ' on' : ''}" data-sec="${s.key}">${s.label}</button>`).join('')}</div><div class="setbody" id="setbody"></div></div>`);
  document.querySelectorAll('.setnav-item').forEach(btn => { btn.onclick = () => { settingsSection = btn.getAttribute('data-sec'); document.querySelectorAll('.setnav-item').forEach(b => b.classList.toggle('on', b === btn)); renderSettingsSection(); }; });
  renderSettingsSection();
};
const renderSettingsSection = () => {
  const body = $('setbody'); if (!body) return;
  if (settingsSection === 'providers') { body.innerHTML = '<div class="set-h">🧠 Model providers</div><div class="pmeta">Pick a per-chat model from the header selector. Add a provider key by asking the agent (it stores it in the key vault). A dedicated provider-management form is coming next.</div>'; return; }
  if (settingsSection === 'agents') return renderSettingsShape(body);
  if (settingsSection === 'specialists') return renderSettingsSpecialists(body);
  if (settingsSection === 'files') return renderSettingsFiles(body);
  if (settingsSection === 'timers') return renderSettingsTimers(body);
  if (settingsSection === 'internal') return renderSettingsInternal(body);
  return renderSettingsUsage(body);
};
// The agent↔Agent C "internal messages" chat: what the fleet is building + how Agent C organizes it
// (tools proposed → reviewed → admitted to the library), so dan can watch without a proposal card per tool.
const IM_KIND = { 'tool-proposed': '🧩', 'tool-reviewed': '🔎', 'tool-admitted': '✅' };
const renderSettingsInternal = async body => {
  body.innerHTML = '<div class="set-h">📨 Internal messages</div><div class="pmeta" style="margin-bottom:9px">Agent C\'s back-channel: tools your agents build flow through here (proposed → reviewed → organized → admitted to the library), so you can see what\'s happening without being interrupted by a proposal for each one.</div><div id="im-list" class="pmeta">loading…</div>';
  let msgs = [];
  try { msgs = ((await (await fetch('/internal-messages/load', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) })).json()).messages) || []; } catch { /* */ }
  const list = $('im-list'); if (!list) return;
  if (!msgs.length) { list.innerHTML = '<div class="pill">no internal messages yet — they appear as agents build tools</div>'; return; }
  list.innerHTML = msgs.slice().reverse().map(m => `<div class="share" style="display:block;padding:7px 9px;margin:4px 0">
      <div style="font-size:13px">${IM_KIND[m.kind] || '•'} ${esc(m.title || m.kind || 'note')}</div>
      ${m.body ? `<div style="color:var(--mut);font-size:12px;margin-top:2px;white-space:pre-wrap">${esc(String(m.body).slice(0, 300))}</div>` : ''}
      <div style="color:var(--mut);font-size:11px;margin-top:3px">${m.by ? `from ${esc(String(m.by).slice(0, 24))} · ` : ''}${esc(new Date(m.ts || 0).toLocaleString())}${m.status ? ` · ${esc(m.status)}` : ''}</div>
    </div>`).join('');
};
const renderSettingsUsage = async body => {
  body.innerHTML = `<div class="set-sec"><div class="set-h">Default allowance for new conversations</div>
    <div class="set-row">$ <input id="set-allow" type="number" step="0.10" min="0" style="width:88px"> <button class="mini" id="set-allow-save">Save</button> <span id="set-allow-msg" class="pmeta"></span></div>
    <div class="pmeta">Every new chat starts prepaid with this much inference budget.</div></div>
    <div class="set-sec"><div class="set-h">💸 Most expensive conversations <span class="pmeta">· by allowance used</span></div><div id="set-costs" class="pmeta">loading…</div></div>`;
  try { const b = await (await fetch('/budget', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, purseCap: chatCap(), sessionId }) })).json(); if (b && b.defaultAllowance != null && $('set-allow')) $('set-allow').value = (b.defaultAllowance / 1e6).toFixed(2); } catch { /* */ }
  const sv = $('set-allow-save'); if (sv) sv.onclick = async () => { const msg = $('set-allow-msg'); const amt = Math.round((Number($('set-allow').value) || 0) * 1e6); msg.textContent = 'saving…'; try { const r = await (await fetch('/budget/default', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, amount: amt }) })).json(); msg.textContent = r.error ? r.error : `saved · ${fmtUsd(r.defaultAllowance)} / new chat`; } catch (e) { msg.textContent = e.message; } };
  // the leaderboard reads the server-cached spend LEDGER (allowance USED per chat, cumulative — one call, not N).
  try {
    const r = await (await fetch('/budget/ledger', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) })).json();
    const el = $('set-costs'); if (!el) return;
    const rows = _arr(r.ledger).filter(x => x.spent > 0);
    if (!rows.length) { el.textContent = 'no measurable spend yet.'; return; }
    el.innerHTML = rows.slice(0, 8).map((x, i) => { const c = chats.find(ch => ch.id === x.sessionId); return `<div class="set-cost-row" data-id="${esc(x.sessionId)}"><span class="set-rank">${i + 1}</span><span class="set-cost-t">${esc((c && c.title) || '(untitled / past chat)')}</span><span class="set-cost-v">${fmtUsd(x.spent)}</span></div>`; }).join('');
    el.querySelectorAll('.set-cost-row').forEach(row => { const id = row.getAttribute('data-id'); if (chats.some(c => c.id === id)) { row.style.cursor = 'pointer'; row.onclick = () => { closeModal(); switchChat(id); }; } });
  } catch { const el = $('set-costs'); if (el) el.textContent = '(could not load usage)'; }
};
// ── Settings → 📂 Files: the confined FileBrowser island, host-driven. The host owns
//    the cap + state + fetching (/files/*); the island only renders + calls back. Re-renders
//    via draw() through renderInto (the host-owned-state island pattern, cf. buildAskCard).
const renderSettingsFiles = async body => {
  body.innerHTML = '<div class="set-h">📂 Files</div><div class="pmeta" style="margin-bottom:9px">Browse + add files in your power folders. The browser is a <b>confined island</b> — it holds no capability; the server reads/writes on your behalf.</div><div id="fb-mount"></div>'
    + '<div id="fb-share" style="margin-top:12px;border-top:1px solid var(--edge);padding-top:10px">'
    + '<div class="pmeta" style="margin-bottom:6px">🔗 <b>Share the current folder as an app</b> — a scoped, revocable link (a confined cap, not your root) that lets someone browse + add files in <i>just this folder</i>, against a granted allowance.</div>'
    + '<div class="kit-rowx" style="gap:6px;align-items:center"><span class="pmeta">allowance $</span><input id="fb-share-allow" class="hdr-sel" style="max-width:80px" value="1.00"><button class="mini" id="fb-share-go">Share current folder</button> <button class="mini" id="fb-minimize">⊟ Minimize into a chat</button> <span id="fb-share-out" class="pmeta"></span></div></div>';
  const mount = $('fb-mount'); if (!mount) return;
  const roots = ((await pf('/files/roots')).roots) || [];
  const st = { root: (roots[0] && roots[0].key) || 'vault', path: '', entries: [], file: null, busy: false, error: '' };
  const rel = name => st.path ? `${st.path}/${name}` : name;
  const draw = () => { if (window.__fieldIslands && window.__fieldIslands.renderInto) window.__fieldIslands.renderInto('FileBrowser', mount, { roots, root: st.root, path: st.path, entries: st.entries, file: st.file, busy: st.busy, error: st.error, onRoot, onOpen, onCrumb, onAdd, onDownload, onRemove, onCloseFile }); else mount.textContent = '(islands bundle not loaded)'; };
  const list = async () => { st.busy = true; st.error = ''; st.file = null; draw(); const r = await pf('/files/list', { root: st.root, path: st.path }); st.busy = false; if (r.error) { st.error = r.error; st.entries = []; } else st.entries = r.entries || []; draw(); };
  const onRoot = k => { st.root = k; st.path = ''; st.file = null; list(); };
  const onCrumb = i => { const segs = st.path.split('/').filter(Boolean); st.path = i < 0 ? '' : segs.slice(0, i + 1).join('/'); st.file = null; list(); };
  const onOpen = async (name, isDir) => { if (isDir) { st.path = rel(name); list(); return; } st.busy = true; st.error = ''; draw(); const r = await pf('/files/get', { root: st.root, path: rel(name) }); st.busy = false; if (r.error) st.error = r.error; else st.file = { name: r.name, text: r.text, size: r.size, b64: r.b64 }; draw(); };
  const onCloseFile = () => { st.file = null; draw(); };
  const onDownload = () => { const f = st.file; if (f && f.b64) dlB64(f.name, f.b64); };
  const onRemove = async name => { if (!confirm(`Delete ${name}?`)) return; const r = await pf('/files/rm', { root: st.root, path: rel(name) }); if (r.error) { st.error = r.error; draw(); } else { st.file = null; list(); } };
  const onAdd = () => { const inp = document.createElement('input'); inp.type = 'file'; inp.onchange = async () => { const file = inp.files && inp.files[0]; if (!file) return; if (file.size > 25 * 1024 * 1024) { st.error = `${file.name} is over the 25MB limit`; draw(); return; } st.busy = true; draw(); const b64 = await fileToB64(file); const r = await pf('/files/put', { root: st.root, path: rel(file.name), b64 }); st.busy = false; if (r.error) { st.error = r.error; draw(); } else list(); }; inp.click(); };
  // 🔗 Share the CURRENT folder as a scoped, allowance-funded app link. The cap stays in JS (copied to the
  // clipboard on click) and is NEVER rendered to the DOM — the cap-hygienic copy hand-off.
  { const sg = $('fb-share-go'); if (sg) sg.onclick = async () => {
    const out = $('fb-share-out'); const allow = Math.max(0, Math.round((parseFloat(($('fb-share-allow') || {}).value) || 1) * 1e6));
    sg.disabled = true; if (out) out.textContent = 'minting…';
    const r = await pf('/apps/share', { app: 'file-browser', roots: [st.root], allowanceUusd: allow });
    sg.disabled = false;
    if (!r || r.error) { if (out) out.textContent = (r && r.error) || 'share failed'; return; }
    if (out) { out.innerHTML = `✓ scoped link for <b>${esc(st.root)}</b> ($${(allow / 1e6).toFixed(2)}) <button class="mini" id="fb-share-copy">Copy link</button> <span id="fb-share-msg" style="color:var(--acc)"></span>`;
      const cb = $('fb-share-copy'); if (cb) cb.onclick = async () => { try { await navigator.clipboard.writeText(r.url); $('fb-share-msg').textContent = 'copied'; } catch { $('fb-share-msg').textContent = 'copy failed — link in console'; console.log(r.url); } }; }
  }; }
  { const mb = $('fb-minimize'); if (mb) mb.onclick = () => { closeModal(); minimizeAppToChat('file-browser'); }; } // bring this app into a chat as a live inline widget
  list();
};

// ── Settings → 🧑‍🔬 Specialists: view/edit the role catalog the agent can employ(),
//    and create new roles. Built-ins edit into an operator override; custom roles are
//    fully editable + deletable. A saved role is immediately employable by the entry agent.
const ROLE_TIERS = ['strong', 'mid', 'cheap'];
const ROLE_VIAS = ['subagent', 'dev'];
const renderSettingsSpecialists = async body => {
  body.innerHTML = '<div class="set-h">🧑‍🔬 Specialists</div>'
    + '<div class="pmeta" style="margin-bottom:9px">The <b>roles</b> the agent can <code>employ</code> — each is a system prompt + a least-privilege tool ring + a model tier. Edit a built-in to override it, or create a new role the entry agent can call.</div>'
    + '<div id="set-roles" class="pmeta">loading…</div>';
  const d = await pf('/roles/list');
  const host = $('set-roles'); if (!host) return;
  if (d.error) { host.textContent = d.error; return; }
  const powers = d.powers || [];
  const roles = d.roles || [];
  const ta = 'background:var(--panel);border:1px solid var(--edge);color:var(--ink);border-radius:7px;padding:6px';
  const fields = (idk, r) => `
    <input class="hdr-sel" style="max-width:none" data-rl-label="${idk}" placeholder="label (display name)" value="${esc(r.label || '')}">
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
      <select class="hdr-sel" data-rl-tier="${idk}" title="model tier">${ROLE_TIERS.map(t => `<option${r.tier === t ? ' selected' : ''}>${t}</option>`).join('')}</select>
      <select class="hdr-sel" data-rl-via="${idk}" title="how it runs: a confined sub-agent, or routed to the Blacksmith dev session">${ROLE_VIAS.map(v => `<option${r.via === v ? ' selected' : ''}>${v}</option>`).join('')}</select>
      <label class="pill" style="cursor:pointer"><input type="checkbox" data-rl-writes="${idk}"${r.writes ? ' checked' : ''}> writes</label>
    </div>
    <input class="hdr-sel" style="max-width:none" data-rl-blurb="${idk}" placeholder="one-line blurb (shown in the role menu)" value="${esc(r.blurb || '')}">
    <div style="font-size:11px;color:var(--mut)">tool ring (its MAX powers — intersected with the employer's at run time):</div>
    <div data-rl-tools="${idk}"></div>
    <textarea data-rl-prompt="${idk}" placeholder="the system prompt / instructions defining this role" style="${ta};min-height:120px">${esc(r.prompt || '')}</textarea>
    <input class="hdr-sel" style="max-width:none" data-rl-output="${idk}" placeholder="output contract — what the role must return" value="${esc(r.output || '')}">`;
  host.innerHTML = roles.map(r => `
    <div style="border:1px solid var(--edge);border-radius:8px;padding:8px;margin:6px 0">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>🧑‍🔬 ${esc(r.label || r.role)}</b>
        <span>${r.custom ? '<span class="pill">custom</span>' : '<span class="pill" style="opacity:.55">built-in</span>'} <span class="pill">${esc(r.tier)}</span>${r.writes ? ' <span class="pill">writes</span>' : ''}</span></div>
      <div style="color:var(--mut);font-size:12px;margin-top:3px"><code>${esc(r.role)}</code> · ${esc((r.powers || []).join(', ') || 'no tools')}</div>
      <div style="font-size:12px;margin-top:3px">${esc(r.blurb || '')}</div>
      <details style="margin-top:6px"><summary class="mini" style="display:inline-block">✏️ edit${r.custom ? '' : ' (saves an override)'}</summary>
        <div style="margin-top:6px;display:flex;flex-direction:column;gap:6px">
          ${fields('e|' + r.role, r)}
          <div><button class="mini" data-rl-save="${esc(r.role)}">Save</button> ${r.custom
    ? `<button class="mini bad" data-rl-del="${esc(r.role)}">Delete</button>`
    : `<button class="mini" data-rl-revert="${esc(r.role)}" title="remove your override, revert to the built-in">↺ revert</button>`}
            <span data-rl-out="${esc(r.role)}" style="font-size:11px;color:var(--acc);margin-left:6px"></span></div>
        </div></details>
    </div>`).join('')
    + `<details style="margin-top:10px;border-top:1px solid var(--edge);padding-top:8px"><summary class="mini" style="display:inline-block">+ new specialist role</summary>
        <div style="margin-top:6px;display:flex;flex-direction:column;gap:6px">
          <input class="hdr-sel" style="max-width:none" data-rl-newname placeholder="role key — lowercase, no spaces (e.g. triager)">
          ${fields('n|', { tier: 'mid', via: 'subagent', powers: [] })}
          <div><button class="mini" data-rl-create>Create role</button> <span data-rl-out="__new" style="font-size:11px;color:var(--acc);margin-left:6px"></span></div>
        </div></details>`;
  // mount a power picker into each form (edit forms pre-granted with the role's ring; new form empty)
  host.querySelectorAll('[data-rl-tools]').forEach(el => { const idk = el.dataset.rlTools; const role = idk.startsWith('e|') ? idk.slice(2) : null; const r = roles.find(x => x.role === role); renderPowersPicker(el, { all: powers, granted: (r && r.powers) || [], itemShare: true }); });
  const val = sel => { const e = host.querySelector(sel); return e ? e.value : ''; };
  const collect = idk => ({
    label: val(`[data-rl-label="${idk}"]`), tier: val(`[data-rl-tier="${idk}"]`), via: val(`[data-rl-via="${idk}"]`),
    writes: !!(host.querySelector(`[data-rl-writes="${idk}"]`) || {}).checked,
    blurb: val(`[data-rl-blurb="${idk}"]`), prompt: val(`[data-rl-prompt="${idk}"]`), output: val(`[data-rl-output="${idk}"]`),
    powers: [...host.querySelectorAll(`[data-rl-tools="${idk}"] input:checked`)].map(x => x.value),
  });
  host.querySelectorAll('[data-rl-save]').forEach(b => b.onclick = async () => {
    const role = b.dataset.rlSave; const out = host.querySelector(`[data-rl-out="${role}"]`);
    if (out) out.textContent = 'saving…';
    const r = await pf('/roles/save', { name: role, spec: collect('e|' + role) });
    if (r.error) { if (out) out.textContent = r.error; return; }
    renderSettingsSpecialists(body);
  });
  host.querySelectorAll('[data-rl-del]').forEach(b => b.onclick = async () => { const role = b.dataset.rlDel; if (!confirm(`Delete custom role "${role}"?`)) return; await pf('/roles/delete', { name: role }); renderSettingsSpecialists(body); });
  host.querySelectorAll('[data-rl-revert]').forEach(b => b.onclick = async () => { const role = b.dataset.rlRevert; if (!confirm(`Revert "${role}" to the built-in (discard your override)?`)) return; await pf('/roles/delete', { name: role }); renderSettingsSpecialists(body); });
  { const cb = host.querySelector('[data-rl-create]'); if (cb) cb.onclick = async () => {
    const name = (host.querySelector('[data-rl-newname]').value || '').trim(); const out = host.querySelector('[data-rl-out="__new"]');
    if (!name) { if (out) out.textContent = 'a role key is required'; return; }
    if (out) out.textContent = 'creating…';
    const r = await pf('/roles/save', { name, spec: collect('n|') });
    if (r.error) { if (out) out.textContent = r.error; return; }
    renderSettingsSpecialists(body);
  }; }
};

const renderSettingsTimers = async body => {
  body.innerHTML = '<div class="set-h">⏰ Scheduled work</div>'
    + '<div class="pmeta" style="margin-bottom:6px">Recurring <b>agents</b> that do work on a cadence. Open one for its Detail — edit the prompt, powers, timing, browse its run history, or cancel it.</div>'
    + '<div id="set-sched" class="pmeta">loading…</div>'
    + '<div class="set-h" style="margin-top:14px">🔔 Reminders &amp; checks</div><div class="pmeta" style="margin-bottom:9px">Lighter one-off / interval jobs your agents scheduled (durable wake-ups). Cancel any that have outlived their use.</div><div id="set-timers" class="pmeta">loading…</div>';
  // ── scheduled AGENTS (projects.scheduledAgents): each links into its full Detail view ──
  try {
    const d = await pf('/projects/list');
    const el = $('set-sched'); if (el) {
      const rows = [];
      for (const p of (d.projects || [])) for (const a of (p.scheduledAgents || [])) rows.push({ p, a });
      if (!rows.length) el.textContent = 'no scheduled agents — create one under 🕐 Projects.';
      else {
        el.innerHTML = '';
        for (const { p, a } of rows) {
          const row = document.createElement('div'); row.className = 'tmr-row';
          const main = document.createElement('div'); main.className = 'tmr-main';
          const title = document.createElement('div'); title.className = 'tmr-title'; title.textContent = `⏰ ${a.name}`;
          const last = a.lastRun ? ` · last ${new Date(a.lastRun).toLocaleDateString()}` : '';
          const sub = document.createElement('div'); sub.className = 'tmr-sub'; sub.textContent = `${p.name} · ${cadenceLabel(a.schedule) || 'event-triggered'}${last}`;
          main.append(title, sub);
          const right = document.createElement('div'); right.style.cssText = 'display:flex;gap:5px;flex:0 0 auto;align-items:center';
          const run = document.createElement('button'); run.className = 'mini'; run.textContent = 'Run now';
          run.onclick = async () => { run.disabled = true; run.textContent = 'running…'; const r = await pf('/projects/agents/run', { id: p.id, agentId: a.id }); run.textContent = r.error ? 'error' : '✓ ran'; setTimeout(() => { run.disabled = false; run.textContent = 'Run now'; }, 2500); };
          const open = document.createElement('button'); open.className = 'mini'; open.textContent = 'Detail ›';
          open.onclick = () => { openProjectId = p.id; closeModal(); renderProjects(); }; // → the rich per-agent Detail (prompt/powers/timing/runs)
          right.append(run, open); row.append(main, right); el.appendChild(row);
        }
      }
    }
  } catch { const el = $('set-sched'); if (el) el.textContent = '(could not load scheduled agents)'; }
  try {
    const r = await (await fetch('/timers/list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) })).json();
    const el = $('set-timers'); if (!el) return;
    const ts = _arr(r.timers);
    if (!ts.length) { el.textContent = 'no scheduled jobs.'; return; }
    el.innerHTML = '';
    for (const t of ts) {
      const row = document.createElement('div'); row.className = 'tmr-row';
      const main = document.createElement('div'); main.className = 'tmr-main';
      const title = document.createElement('div'); title.className = 'tmr-title'; title.textContent = t.label || '(unnamed job)';
      const sub = document.createElement('div'); sub.className = 'tmr-sub'; sub.textContent = `${t.actionType === 'command' ? '⚙ runs' : '🔔 notifies'} · ${t.summary || ''}`;
      main.append(title, sub);
      const right = document.createElement('div'); right.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;gap:5px;flex:0 0 auto';
      const when = document.createElement('div'); when.className = 'tmr-when'; when.textContent = t.kind === 'interval' ? `every ${fmtEvery(t.everyMs)}` : 'once';
      const cancel = document.createElement('button'); cancel.className = 'mini bad'; cancel.textContent = 'Cancel';
      cancel.onclick = async () => { cancel.disabled = true; cancel.textContent = 'cancelling…'; try { const c = await (await fetch('/timers/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, id: t.id }) })).json(); if (c && c.ok) row.remove(); else { cancel.disabled = false; cancel.textContent = 'Cancel'; } } catch { cancel.disabled = false; cancel.textContent = 'Cancel'; } };
      right.append(when, cancel); row.append(main, right); el.appendChild(row);
    }
  } catch { const el = $('set-timers'); if (el) el.textContent = '(could not load timers)'; }
};
// 🕸️ Agent shape — the STATIC structural graph of what an agent HOLDS (its authority), the long-promised
// Granovetter diagram: powers (each fanning to the verbs it can call) + specialist sub-agents (crowned with
// their granted powers) + employable roles (latent authority). What the agent IS, vs the trace = what it DID.
// Map the /agent/shape payload → the SAME pendant node schema ({name,ok,detail,granted,children}) so the 3D
// renders it for free. Roles stay in the list (the pendant has no "latent/ghost" idiom). Names/labels only.
const shapeToSteps = shape => {
  const powers = _arr(shape && shape.powers).map(p => ({
    name: p.name, ok: true, detail: scrubCap(p.label || p.name),
    children: _arr(p.verbs).map(v => ({ name: v, ok: true })),
  }));
  const specialists = _arr(shape && shape.specialists).map(s => ({
    name: s.name || s.id, ok: true, detail: scrubCap('specialist · ' + (s.domain || '')),
    granted: _arr(s.powers), children: _arr(s.powers).map(pn => ({ name: pn, ok: true })),
  }));
  return [...powers, ...specialists];
};
// drive the chat pendant SINGLETON fullscreen with the held-authority graph (reusing the exact path
// traceGeometry's core-tap uses — pendantShapeMode guards pendantShowFor from reclaiming it for a chat trace).
const openShapePendant = async steps => {
  if (!steps.length) { setStatus('no structural nodes to show'); return; }
  try {
    const p = await ensurePendant();
    pendantShapeMode = true; pendantFs = true;
    pendantWrap.classList.remove('hide'); pendantWrap.classList.add('fs');
    const fsx = $('pendant-fsx'); if (fsx) fsx.classList.remove('hide');
    p.setVisible(true); p.showSteps(steps);
    setTimeout(() => { try { p.resize(); } catch {} }, 40);
  } catch { /* enhancement-only */ }
};
let lastShape = {};
const AGENT_LABEL = id => (id === 'field-agent' ? 'Agent C' : ((agentMeta[id] && agentMeta[id].name) || id));
const renderSettingsShape = async body => {
  body.innerHTML = `<div class="set-h">🕸️ Agent shape</div>
    <div class="pmeta" style="margin-bottom:9px">The structural graph of what an agent <b>holds</b> — its powers (each fanning to the tools it can call), its specialist sub-agents, and the roles it could employ. What the agent <i>is</i> (distinct from the per-message trace, which is what it <i>did</i>). Includes the built-in domain agents (Dietician, …) + your specialists.</div>
    <div class="set-row" style="margin-bottom:9px;gap:8px"><select id="shape-agent" class="mini">${agentGroupsHtml()}</select><button class="mini" id="shape-3d">🧊 Open 3D diagram</button></div>
    <div id="shape-body" class="pmeta">loading…</div>`;
  const chips = arr => _arr(arr).map(x => `<span class="pill" style="margin:1px 3px 1px 0">${esc(String(x))}</span>`).join('');
  const load = async () => {
    const who = ($('shape-agent') && $('shape-agent').value) || 'field-agent';
    const host = $('shape-body'); if (host) host.textContent = 'loading…';
    let shape = {};
    try { shape = await (await fetch('/agent/shape', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, agent: who }) })).json(); } catch (e) { shape = { error: e.message }; }
    lastShape = shape; if (!host) return;
    if (!shape || shape.error) { host.textContent = shape && shape.error ? `(${shape.error})` : '(could not load)'; return; }
    const powers = _arr(shape.powers), specs = _arr(shape.specialists), roles = _arr(shape.roles).filter(r => _arr(r.powers).length);
    host.innerHTML = `
      <div class="set-sec"><div class="set-h">🔑 Powers <span class="pmeta">· ${powers.length}</span></div>
        ${powers.map(p => `<div class="share" style="display:block;padding:6px 9px;margin:4px 0"><div style="font-size:13px">${esc(scrubCap(p.label || p.name))} <span class="pmeta">(${esc(p.name)})</span></div><div style="margin-top:3px">${chips(p.verbs)}</div></div>`).join('') || '<div class="pill">none</div>'}</div>
      <div class="set-sec"><div class="set-h">🧑‍🚀 Specialists <span class="pmeta">· ${specs.length}</span></div>
        ${specs.length ? specs.map(s => `<div class="share" style="display:block;padding:6px 9px;margin:4px 0"><div style="font-size:13px">${esc(s.name || s.id)}${s.domain ? ` <span class="pmeta">· ${esc(scrubCap(s.domain))}</span>` : ''}</div><div style="margin-top:3px">${chips(s.powers)}</div>${_arr(s.autonomy).length ? `<div class="pmeta" style="margin-top:2px">may autonomously: ${esc(_arr(s.autonomy).join(', '))}</div>` : ''}</div>`).join('') : '<div class="pill">no persistent specialists yet</div>'}</div>
      <div class="set-sec"><div class="set-h">🎭 Employable roles <span class="pmeta">· latent authority (a subset of held powers)</span></div>
        ${roles.length ? roles.map(r => `<div class="share" style="display:block;padding:6px 9px;margin:4px 0;opacity:.85"><div style="font-size:13px">${esc(r.label || r.role)} <span class="pmeta">(${esc(r.role)} · ${r.writes ? 'writes' : 'read-only'})</span></div>${r.blurb ? `<div class="pmeta" style="margin-top:1px">${esc(scrubCap(r.blurb))}</div>` : ''}<div style="margin-top:3px">${chips(r.powers)}</div></div>`).join('') : `<div class="pill">no roles employable with this agent's powers</div>`}</div>`;
  };
  const sel = $('shape-agent'); if (sel) sel.onchange = load;
  const btn = $('shape-3d'); if (btn) btn.onclick = () => openShapePendant(shapeToSteps(lastShape));
  load();
};
{ const f = $('drawer-foot'); if (f) f.onclick = openSettings; }

const boot = async () => {
  if (pendingShare) { try { await openSharedChat(pendingShare); } catch {} }
  if (!cap) {
    if (pendingShare && chats.some(c => c.shareToken)) { // share-only recipient — works with no account
      $('nocap').classList.add('hide'); $('talk').classList.remove('hide'); $('composer').classList.remove('hide');
      $('scope').textContent = '🔗 shared chat'; renderChatList(); renderTx(); renderChatBar(); setStatus(''); return; // renderChatBar → applyShareMode: show the rights badge + gate the composer for read-only holders
    }
    $('nocap').classList.remove('hide'); $('talk').classList.add('hide'); $('composer').classList.add('hide'); $('scope').textContent = 'no link'; return;
  }
  let d;
  try { d = await rpc('describe'); }
  catch (e) {
    // Only forget a definitively dead cap (revoked/unknown) — keep it across a
    // transient network error so a flaky reload doesn't log you out.
    if (/revoked|unknown/i.test(e.message)) { try { localStorage.removeItem(CAP_KEY); } catch {} }
    $('nocap').classList.remove('hide'); $('nocap').textContent = 'This link is dead (revoked or unknown).'; $('talk').classList.add('hide'); $('composer').classList.add('hide'); $('scope').textContent = 'revoked'; return;
  }
  isRoot = d.kind === 'root';
  heldPowers = new Set((d.powers || []).map(p => p.name)); // gates self-confirm of proposals
  const powers = (d.powers || []).map(p => p.name).join(', ');
  // Headline removed (dan): "reads all · proposes changes" only fit a pure Agent C selection.
  // Powers are now shown where they're accurate per-chat: the powers banner at the top of a chat
  // (the entry agent's / handed-off ring) + the Powers tab. Keep $('scope') empty for normal caps.
  $('scope').textContent = ''; $('scope').onclick = null; $('scope').style.cursor = '';
  // populate the power dropdown with exactly what this cap can mint
  $('sh-power').innerHTML = (d.canMint || []).map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  if (!(d.canMint || []).length) { $('tab-shares').classList.add('hide'); }
  if (isRoot) { $('tab-components').classList.remove('hide'); // component version/fork/revert is owner-managed
    try { const pc = await (await fetch('/tools/pending-count', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) })).json(); updateComponentsBadge(pc.count || 0); } catch {} } // badge proposed-but-unreviewed tools
  fillInviteBox(); // 👤 owner-only "Invite a new user" box (starter-power picker)
  fillConnectorsBox(); // 🔌 owner-only "Connect an API service" box
  greetingText = d.kind === 'root'
    ? `Hi — I'm Agent C. I can ${(d.powers || []).map(p => p.label.toLowerCase()).join('; ')}. Type a message, or tap 🎤 for voice.`
    : `You hold a shared link for: ${powers}. Type a message, or tap 🎤 for voice.`;
  initChats(); // restore chats + active transcript (shows greeting if empty)
  if (pendingMinimizeApp) { try { minimizeAppToChat(pendingMinimizeApp); } catch (e) { console.warn('minimize-app handoff', e); } } // /apps → "minimize to chat" landed here
  if (pendingForkToken) { try { openForkInChat({ shareToken: pendingForkToken, name: 'shared fork' }, '⑂ Shared fork'); } catch (e) { console.warn('fork handoff', e); } } // #fork=<token> shared link → open inline
  setStatus('');
  refreshBadge(); setInterval(refreshBadge, 60000); // 🔔 notification badge
  loadModels(); loadAgentList(); loadProjectList(); // populate the header agent + model-provider selectors and the project menu
};
boot();

// ── Projects + scheduled agents (🕐) — set up recurring self-improvement from here ──────
// A Project groups chats + recurring "scheduled agents" (a prompt + a tool ring + a cadence)
// sharing ONE home folder. Agents run on schedule (server tick) and on demand ("Run now").
const pf = async (path, body = {}) => { try { return await (await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, ...body }) })).json(); } catch (e) { return { error: e.message }; } };
const CADENCES = [
  { label: 'Weekly · Sun 03:00', schedule: { kind: 'weekly', day: 0, at: '03:00' } },
  { label: 'Daily · 03:00', schedule: { kind: 'daily', at: '03:00' } },
  { label: 'Every 6 hours', schedule: { kind: 'interval', everyMs: 21600000 } },
  { label: 'Every 30 min', schedule: { kind: 'interval', everyMs: 1800000 } },
];
const cadenceLabel = s => !s ? '' : s.kind === 'interval' ? `every ${Math.round(s.everyMs / 60000)}m` : s.kind === 'weekly' ? `weekly ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][s.day || 0]} ${s.at}` : `daily ${s.at}`;
let openProjectId = null; // 🕐 Projects view: null = the project list; else the drilled-in project id
// project home-folder helpers: binary-safe via base64, never put the cap in a URL/href.
const fmtBytes = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const fileToB64 = file => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1] || ''); r.onerror = reject; r.readAsDataURL(file); });
const dlB64 = (name, b64) => { const bin = atob(b64), arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i); const url = URL.createObjectURL(new Blob([arr])); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000); };
const renderProjectFiles = async pid => {
  const host = $('pj-files'); if (!host) return;
  const r = await pf('/projects/files/list', { id: pid });
  const files = (r && r.files) || [];
  host.innerHTML = files.length
    ? files.map(f => `<div class="share"><div>📄 ${esc(f.name)} <span style="color:var(--mut);font-size:11px">${esc(fmtBytes(f.size))}</span></div><div><button class="mini" data-dlfile="${esc(f.name)}">download</button> <button class="mini" data-rmfile="${esc(f.name)}">×</button></div></div>`).join('')
    : '<div style="color:var(--mut);font-size:12px;margin:4px 0">no files yet — drag some in below</div>';
  host.querySelectorAll('[data-dlfile]').forEach(b => b.onclick = async () => { const r = await pf('/projects/files/get', { id: pid, name: b.dataset.dlfile }); if (r && r.b64) dlB64(r.name || b.dataset.dlfile, r.b64); else alert(r.error || 'download failed'); });
  host.querySelectorAll('[data-rmfile]').forEach(b => b.onclick = async () => { if (!confirm(`Remove ${b.dataset.rmfile} from the project?`)) return; await pf('/projects/files/remove', { id: pid, name: b.dataset.rmfile }); renderProjectFiles(pid); });
};
const uploadProjectFiles = async (pid, fileList) => {
  const host = $('pj-files');
  for (const file of fileList) {
    if (file.size > 25 * 1024 * 1024) { alert(`${file.name} is over the 25MB limit`); continue; }
    if (host) host.innerHTML = `<div style="color:var(--mut);font-size:12px">uploading ${esc(file.name)}…</div>`;
    const b64 = await fileToB64(file);
    const r = await pf('/projects/files/put', { id: pid, name: file.name, b64 });
    if (r && r.error) alert(`${file.name}: ${r.error}`);
  }
  renderProjectFiles(pid);
};
const renderProjects = async () => {
  const d = await pf('/projects/list');
  if (d.error) { showModal(`<b>🕐 Projects</b><p>${esc(d.error)}</p>`); return; }
  const powers = d.powers || [];
  const projects = d.projects || [];
  // ── LIST mode: just the projects (open one to see its chats + agents) ──
  if (!openProjectId) {
    const rows = projects.map(p => `<div class="share" style="cursor:pointer" data-openproj="${esc(p.id)}">
      <div><b>📁 ${esc(p.name)}</b></div>
      <div><span class="pill">${(p.chatIds || []).length} chat · ${(p.scheduledAgents || []).length} agent</span> <button class="mini" data-openproj="${esc(p.id)}">open ›</button></div></div>`).join('');
    showModal(`<div class="dkm" style="text-align:left;width:520px;max-width:86vw;margin:-18px -18px 8px;padding:16px;border-radius:12px 12px 0 0;max-height:72vh;overflow-y:auto">
      <b>🕐 Projects</b>
      <div style="color:var(--mut);font-size:12px;margin:4px 0 10px">A project groups chats + recurring scheduled agents that share a home folder. Open one to see what's inside.</div>
      ${rows || '<div class="pill">no projects yet — create one below</div>'}
      <div style="border-top:1px solid var(--edge);margin-top:12px;padding-top:10px;display:flex;gap:6px"><input class="hdr-sel" style="flex:1;max-width:none" id="pj-newname" placeholder="new project name"><button class="mini" id="pj-create">+ New project</button></div>
    </div>`);
    const ml = $('qrmodal');
    $('pj-create').onclick = async () => { const n = $('pj-newname').value.trim(); if (!n) return; const r = await pf('/projects/create', { name: n }); loadProjectList(); if (r && r.project) openProjectId = r.project.id; renderProjects(); };
    ml.querySelectorAll('[data-openproj]').forEach(b => b.onclick = () => { openProjectId = b.dataset.openproj; renderProjects(); });
    return;
  }
  // ── DETAIL mode: one project's chats + scheduled agents ──
  const p = projects.find(x => x.id === openProjectId);
  if (!p) { openProjectId = null; return renderProjects(); }
  await loadSeedChats(); // refresh so each timer agent's runs folder reflects the latest scheduled runs
  // a timer agent's runs = the scheduled seed-chats filed under it (kept out of the sidebar; here is their home)
  const agentRuns = ag => seedChats.filter(s => s && s.source === 'scheduled' && s.scheduled && s.scheduled.agent === ag.name && s.scheduled.project === p.name).sort((x, y) => (y.ts || 0) - (x.ts || 0));
  const agents = (p.scheduledAgents || []).map(a => { return `
      <div style="border:1px solid var(--edge);border-radius:8px;padding:8px;margin:6px 0">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><b>⏰ ${esc(a.name)}</b>
          <span><button class="mini" data-run="${p.id}|${a.id}">Run now</button> <button class="mini" data-delagent="${p.id}|${a.id}">×</button></span></div>
        <div style="color:var(--mut);font-size:12px;margin-top:3px">${esc(cadenceLabel(a.schedule))} · tools: ${esc((a.tools || []).join(', ') || 'none')}${a.lastRun ? ` · ${a.lastRunChatId ? `<a href="#" data-openrun="${esc(a.lastRunChatId)}">last run ${esc(new Date(a.lastRun).toLocaleString())} ↗</a>` : `last ${esc(new Date(a.lastRun).toLocaleString())}`}` : ''}${a.nextAt ? ` · next ${esc(new Date(a.nextAt).toLocaleString())}` : ''}</div>
        <div style="font-size:12px;margin-top:4px;white-space:pre-wrap">${esc((a.prompt || '').slice(0, 200))}</div>
        <details style="margin-top:6px"><summary class="mini" style="display:inline-block">✏️ edit prompt &amp; powers</summary>
          <div style="margin-top:6px;display:flex;flex-direction:column;gap:6px">
            <input class="hdr-sel" style="max-width:none" data-ename="${p.id}|${a.id}" value="${esc(a.name)}">
            <textarea data-eprompt="${p.id}|${a.id}" style="background:var(--panel);border:1px solid var(--edge);color:var(--ink);border-radius:7px;padding:6px;min-height:90px">${esc(a.prompt || '')}</textarea>
            <div style="display:flex;align-items:center;gap:8px"><div style="font-size:11px;color:var(--mut)">tools (its ring):</div><button class="mini" data-epropose="${p.id}|${a.id}">✨ propose from prompt</button></div>
            <div data-etools="${p.id}|${a.id}"></div>
            <div style="display:flex;align-items:center;gap:8px"><div style="font-size:11px;color:var(--mut)">timing:</div><select class="hdr-sel" style="max-width:none;flex:1" data-ecad="${p.id}|${a.id}"><option value="-1">keep current · ${esc(cadenceLabel(a.schedule) || 'event-triggered')}</option>${CADENCES.map((c, i) => `<option value="${i}">${esc(c.label)}</option>`).join('')}</select></div>
            <div><button class="mini" data-saveagent="${p.id}|${a.id}">Save changes</button></div>
          </div></details>
        <details style="margin-top:6px"><summary class="mini" style="display:inline-block">📁 run log (${(a.runs || []).length})</summary>
          <div style="margin-top:6px;display:flex;flex-direction:column;gap:4px">${(a.runs || []).length ? (a.runs).map(r => `<div class="share" style="padding:5px 7px;align-items:flex-start"><div style="font-size:12px;min-width:0;flex:1"><div>${esc(new Date(r.at).toLocaleString())} ${r.ok === false ? '⚠️ failed' : (r.nProp ? `· ${r.nProp} proposal(s)` : '· ✓')}</div>${r.summary ? `<div style="color:var(--mut);font-size:11px;white-space:pre-wrap;word-break:break-word">${esc(String(r.summary).slice(0, 200))}</div>` : ''}</div>${r.chatId ? `<button class="mini" data-openrun="${esc(r.chatId)}">open</button>` : ''}</div>`).join('') : '<div style="color:var(--mut);font-size:12px">no runs yet — every run lands here (silent no-op runs too); the chat opens for runs that had something to report</div>'}</div>
        </details>
        <div data-out="${p.id}|${a.id}" style="font-size:12px;color:var(--acc);margin-top:4px"></div>
      </div>`; }).join('');
  const projChats = (p.chatIds || []).map(cid => { const c = chats.find(x => x.id === cid) || {}; return `<div class="share"><div>💬 ${esc(c.title || cid)}</div><div><button class="mini" data-openchat="${esc(cid)}">open</button></div></div>`; }).join('');
  showModal(`<div class="dkm" style="text-align:left;width:560px;max-width:86vw;margin:-18px -18px 8px;padding:16px;border-radius:12px 12px 0 0;max-height:72vh;overflow-y:auto">
    <div style="display:flex;align-items:center;gap:8px"><button class="mini" id="pj-back">‹ Projects</button><b>📁 ${esc(p.name)}</b><span style="flex:1"></span><span style="color:var(--mut);font-size:11px">shared home</span></div>
    <div style="font-weight:600;font-size:13px;margin-top:10px">Chats</div>
    ${projChats || '<div style="color:var(--mut);font-size:12px;margin:4px 0">no chats yet — start one via the agent menu → this project</div>'}
    <div style="font-weight:600;font-size:13px;margin-top:12px;border-top:1px solid var(--edge);padding-top:10px">📂 Files <span style="color:var(--mut);font-weight:400;font-size:11px">· the project's shared home folder — its chats &amp; scheduled agents read/write here</span></div>
    <div id="pj-files" style="margin:4px 0">loading…</div>
    <div id="pj-drop" style="border:1px dashed var(--edge);border-radius:8px;padding:10px;text-align:center;color:var(--mut);font-size:11px;margin-top:4px">drag files here, or <label style="color:var(--acc);cursor:pointer;text-decoration:underline">choose files<input type="file" id="pj-upload" multiple style="display:none"></label> to add them to the project</div>
    <div style="font-weight:600;font-size:13px;margin-top:12px;border-top:1px solid var(--edge);padding-top:10px">Scheduled agents</div>
    ${agents || '<div style="color:var(--mut);font-size:12px;margin:4px 0">no scheduled agents yet</div>'}
    <details style="margin-top:6px"><summary class="mini" style="display:inline-block">+ add scheduled agent</summary>
      <div style="margin-top:6px;display:flex;flex-direction:column;gap:6px">
        <input class="hdr-sel" style="max-width:none" data-naname="${p.id}" placeholder="name (e.g. garden-scan)">
        <textarea data-naprompt="${p.id}" placeholder="what this recurring agent should do" style="background:var(--panel);border:1px solid var(--edge);color:var(--ink);border-radius:7px;padding:6px;min-height:54px"></textarea>
        <div style="display:flex;align-items:center;gap:8px"><div style="font-size:11px;color:var(--mut)">tools (its ring):</div><button class="mini" data-napropose="${p.id}">✨ propose from prompt</button></div>
        <div data-natools="${p.id}"></div>
        <select class="hdr-sel" style="max-width:none" data-nacad="${p.id}">${CADENCES.map((c, i) => `<option value="${i}">${esc(c.label)}</option>`).join('')}</select>
        <div><button class="mini" data-addagent="${p.id}">Add</button> <button class="mini" data-template="${p.id}">↳ prefill: overnight garden-scan</button></div>
      </div></details>
  </div>`);
  const m = $('qrmodal');
  $('pj-back').onclick = () => { openProjectId = null; renderProjects(); };
  // mount the shared powers-picker into every scheduled-agent ring (edit = pre-granted with a.tools; add = empty)
  m.querySelectorAll('[data-etools]').forEach(el => { const [, aid] = el.dataset.etools.split('|'); const ag = (p.scheduledAgents || []).find(x => x.id === aid) || {}; renderPowersPicker(el, { all: powers, granted: ag.tools || [], itemShare: true }); });
  m.querySelectorAll('[data-natools]').forEach(el => renderPowersPicker(el, { all: powers, granted: [], itemShare: true }));
  renderProjectFiles(p.id); // populate the home-folder file list
  { const up = $('pj-upload'); if (up) up.onchange = () => { if (up.files.length) uploadProjectFiles(p.id, [...up.files]); up.value = ''; }; }
  { const dz = $('pj-drop'); if (dz) { ['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.style.borderColor = 'var(--acc)'; })); ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.style.borderColor = 'var(--edge)'; })); dz.addEventListener('drop', e => { const fl = e.dataTransfer && e.dataTransfer.files; if (fl && fl.length) uploadProjectFiles(p.id, [...fl]); }); } }
  m.querySelectorAll('[data-openchat]').forEach(b => b.onclick = () => { closeModal(); switchChat(b.dataset.openchat); });
  m.querySelectorAll('[data-template]').forEach(b => b.onclick = () => {
    const pid = b.dataset.template;
    m.querySelector(`[data-naname="${pid}"]`).value = 'garden-scan';
    m.querySelector(`[data-naprompt="${pid}"]`).value = "Review my notes and the tools I haven't connected yet. Suggest 1–3 concrete optimizations I could get by wiring the right tools/capabilities together. Be specific and brief; propose, don't act.";
    const tc = m.querySelector(`[data-natools="${pid}"]`); tc.querySelectorAll('input').forEach(x => { x.checked = ['notes', 'reference'].includes(x.value); }); if (tc._ppRefresh) tc._ppRefresh();
  });
  m.querySelectorAll('[data-addagent]').forEach(b => b.onclick = async () => {
    const pid = b.dataset.addagent;
    const name = m.querySelector(`[data-naname="${pid}"]`).value.trim() || 'agent';
    const prompt = m.querySelector(`[data-naprompt="${pid}"]`).value.trim();
    const tools = [...m.querySelectorAll(`[data-natools="${pid}"] input:checked`)].map(x => x.value);
    const schedule = CADENCES[+m.querySelector(`[data-nacad="${pid}"]`).value].schedule;
    if (!prompt) { alert('a prompt is required'); return; }
    const r = await pf('/projects/agents/add', { id: pid, name, prompt, tools, schedule, model: 'default' });
    if (r.error) alert(r.error);
    renderProjects();
  });
  // ✨ propose powers from the assignment — like a chat's consent scoper, but seeds the tool checkboxes.
  const proposeInto = async (promptText, container, btn) => {
    if (!promptText.trim()) { alert('write the prompt first, then propose'); return; }
    const old = btn.textContent; btn.textContent = 'thinking…'; btn.disabled = true;
    const r = await pf('/scope', { prompt: promptText });
    const proposed = (r && r.proposed) || [];
    container.querySelectorAll('input').forEach(x => { x.checked = proposed.includes(x.value); });
    if (container._ppRefresh) container._ppRefresh(); // re-sync the visible chips with the proposed ring
    btn.textContent = old; btn.disabled = false;
    setStatus(proposed.length ? `proposed: ${proposed.join(', ')} — adjust if needed` : 'no powers auto-detected — pick the ring manually');
  };
  m.querySelectorAll('[data-napropose]').forEach(b => b.onclick = () => { const pid = b.dataset.napropose; proposeInto(m.querySelector(`[data-naprompt="${pid}"]`).value, m.querySelector(`[data-natools="${pid}"]`), b); });
  m.querySelectorAll('[data-epropose]').forEach(b => b.onclick = () => { const k = b.dataset.epropose; proposeInto(m.querySelector(`[data-eprompt="${k}"]`).value, m.querySelector(`[data-etools="${k}"]`), b); });
  m.querySelectorAll('[data-saveagent]').forEach(b => b.onclick = async () => {
    const [pid, aid] = b.dataset.saveagent.split('|');
    const name = m.querySelector(`[data-ename="${pid}|${aid}"]`).value.trim() || 'agent';
    const prompt = m.querySelector(`[data-eprompt="${pid}|${aid}"]`).value.trim();
    const tools = [...m.querySelectorAll(`[data-etools="${pid}|${aid}"] input:checked`)].map(x => x.value);
    if (!prompt) { alert('a prompt is required'); return; }
    const patch = { name, prompt, tools };
    const cv = m.querySelector(`[data-ecad="${pid}|${aid}"]`); // adjust timing (–1 = keep current/event schedule)
    if (cv && cv.value !== '-1') patch.schedule = CADENCES[+cv.value].schedule;
    const r = await pf('/projects/agents/update', { id: pid, agentId: aid, patch });
    if (r.error) alert(r.error);
    renderProjects();
  });
  m.querySelectorAll('[data-openrun]').forEach(b => b.onclick = async e => { e.preventDefault(); const cid = b.dataset.openrun; if (!cid) return; closeModal(); pendingChat = cid; await loadSeedChats(); tryOpenPendingChat(); }); // open a past scheduled run from the Projects view
  m.querySelectorAll('[data-delrun]').forEach(b => b.onclick = async () => { const id = b.dataset.delrun; if (!id || !window.confirm('Throw away this run?')) return; seedChats = seedChats.filter(s => s.id !== id); try { localStorage.removeItem(txKey(id)); } catch {} await pf('/seed-chats/delete', { id }); renderProjects(); }); // throw away one scheduled run
  m.querySelectorAll('[data-delagent]').forEach(b => b.onclick = async () => { const [pid, aid] = b.dataset.delagent.split('|'); await pf('/projects/agents/remove', { id: pid, agentId: aid }); renderProjects(); });
  m.querySelectorAll('[data-run]').forEach(b => b.onclick = async () => {
    const [pid, aid] = b.dataset.run.split('|'); const out = m.querySelector(`[data-out="${pid}|${aid}"]`);
    b.disabled = true; out.textContent = 'running…';
    const r = await pf('/projects/agents/run', { id: pid, agentId: aid });
    out.textContent = r.error ? ('error: ' + r.error) : `✓ ${String(r.answer || '').slice(0, 300)}${r.proposals ? ` · ${r.proposals} proposal(s)` : ''}`;
    b.disabled = false;
  });
};
{ const _pjBtn = $('projects-btn'); if (_pjBtn) _pjBtn.onclick = renderProjects; }

// ── Meeting mode (👥) — record a room, get a multi-speaker (diarized) transcript ─────────
// Single-shot: record the whole meeting, then diarize the full clip once on the local tinix
// box (consistent speaker labels). Transcript posts into the chat; raw audio never leaves home.
let mtgRec = null, mtgChunks = [], mtgStream = null, mtgOn = false;
const mtgBtn = $('meeting-btn');
const finishMeeting = async () => {
  mtgStream?.getTracks().forEach(t => t.stop());
  const blob = new Blob(mtgChunks, { type: (mtgRec && mtgRec.mimeType) || 'audio/webm' });
  mtgChunks = [];
  if (blob.size < 2200) { setStatus('meeting too short — nothing recorded'); return; }
  setStatus('diarizing meeting (local, on tinix)…');
  try {
    const r = await fetch('/meeting/transcribe', { method: 'POST', headers: { 'content-type': blob.type || 'audio/webm', 'x-cap': cap }, body: blob });
    const j = await r.json();
    if (j.error) { setStatus('meeting: ' + j.error); return; }
    const segs = j.segments || [];
    const lines = segs.length ? segs.map(s => `[${s.speaker}] ${s.text}`).join('\n') : '(no speech detected)';
    pushTx('agent', `🎙️ Meeting transcript — ${(j.speakers || []).length} speaker(s)\n\n${lines}`, { tools: ['meetingScribe'] });
    renderTx(); setStatus('');
  } catch (e) { setStatus('meeting error: ' + e.message); }
};
const startMeeting = async () => {
  if (!cap) { setStatus('no capability — open your #cap= link'); return; }
  try {
    mtgStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } }); // keep distinct voices separable for diarization
    mtgChunks = [];
    mtgRec = new MediaRecorder(mtgStream, { mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '' });
    mtgRec.ondataavailable = e => e.data.size && mtgChunks.push(e.data);
    mtgRec.onstop = finishMeeting;
    mtgRec.start();
    mtgOn = true; if (mtgBtn) { mtgBtn.textContent = '⏹'; mtgBtn.title = 'Stop & transcribe the meeting'; }
    document.body.classList.add('meeting-live');
    setStatus('● Recording meeting (multi-speaker). Audio is transcribed locally on your tinix box, never the cloud. Tap ⏹ to stop.');
  } catch (e) { setStatus('mic error: ' + e.message); }
};
const stopMeeting = () => { mtgOn = false; document.body.classList.remove('meeting-live'); if (mtgBtn) { mtgBtn.textContent = '👥'; mtgBtn.title = 'Record a multi-speaker meeting (diarized)'; } try { mtgRec && mtgRec.state !== 'inactive' && mtgRec.stop(); } catch {} };
if (mtgBtn) mtgBtn.onclick = () => (mtgOn ? stopMeeting() : startMeeting());
