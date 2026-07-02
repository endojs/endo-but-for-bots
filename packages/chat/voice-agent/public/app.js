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
// P4 (shell→island): render the header bar from its EDITABLE island — BEFORE anything else touches the header
// (the theme toggle below + app.js's by-id wiring). The confined renderer keeps `id`, so app.js's getElementById
// wiring still finds every button. SNAPSHOT→VERIFY→RESTORE: if islands aren't up, or any expected id is missing
// after the render, restore the original static header so the live app can never break.
(() => {
  const hdr = document.querySelector('header');
  if (!hdr || !window.__fieldIslands || !window.__fieldIslands.renderHeaderBar) return;
  const NEED = ['hamburger', 'new-chat-top', 'trash-chat-top', 'scope', 'budget', 'agent-sel', 'model-sel', 'tab-talk', 'tab-shares', 'tab-components', 'stories-btn', 'bell-btn', 'bell-badge', 'info-btn', 'projects-btn', 'chatshare-btn', 'hooks-btn'];
  const snapshot = hdr.innerHTML;
  try {
    window.__fieldIslands.renderHeaderBar(hdr);
    if (!NEED.every(id => hdr.querySelector('#' + id))) throw new Error('header island missing an id — restoring');
  } catch (e) { try { hdr.innerHTML = snapshot; } catch { /* keep static */ } }
})();
(() => { // P4: composer input row as an island (mount BEFORE app.js grabs #text/#send below)
  const row = document.querySelector('.inputrow');
  if (!row || !window.__fieldIslands || !window.__fieldIslands.renderInputRow) return;
  const NEED = ['attach', 'file', 'text', 'send', 'mic', 'meeting-btn'];
  const snapshot = row.innerHTML;
  try {
    window.__fieldIslands.renderInputRow(row);
    if (!NEED.every(id => row.querySelector('#' + id))) throw new Error('input-row island missing an id — restoring');
  } catch (e) { try { row.innerHTML = snapshot; } catch { /* keep static */ } }
})();
(() => { // P4: sidebar/drawer frame as an island. Provides #chat-list (app.js fills it imperatively after).
  const dr = document.getElementById('drawer');
  if (!dr || !window.__fieldIslands || !window.__fieldIslands.renderDrawerFrame) return;
  const NEED = ['new-chat', 'drawer-close', 'chat-list', 'drawer-foot', 'df-sub'];
  const snapshot = dr.innerHTML;
  try {
    window.__fieldIslands.renderDrawerFrame(dr);
    if (!NEED.every(id => dr.querySelector('#' + id))) throw new Error('drawer island missing an id — restoring');
  } catch (e) { try { dr.innerHTML = snapshot; } catch { /* keep static */ } }
})();
(() => { // P4: notifications view as an island — a CONTAINER of nested islands (rec-list/chg-list); renders once.
  const iv = document.getElementById('inbox-view');
  if (!iv || !window.__fieldIslands || !window.__fieldIslands.renderInboxView) return;
  const NEED = ['att-head', 'att-count', 'att-list', 'rec-head', 'rec-list', 'chg-section', 'chg-head', 'chg-count', 'chg-list'];
  const snapshot = iv.innerHTML;
  try {
    window.__fieldIslands.renderInboxView(iv);
    if (!NEED.every(id => iv.querySelector('#' + id))) throw new Error('inbox island missing an id — restoring');
  } catch (e) { try { iv.innerHTML = snapshot; } catch { /* keep static */ } }
})();
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
let pendingInbox = location.hash === '#inbox' || _hashParams.has('inbox'); // #inbox deep-link (a notification with no chat thread → open the 🔔 inbox)
// #sched=<id> deep-link → that scheduled task's Detail card (config + run history). The id is a
// DESIGNATOR, not a cap: authority comes from the cap already in localStorage, and the server's
// owner-gated /projects/list means an id you don't own resolves to the same "not found" as one
// that doesn't exist (no enumeration).
let pendingSched = _hashParams.get('sched') || null;
// A pasted link becomes an inline widget card (embedSiteInline) AND is staged here per-session so the next
// send also tells the AGENT about it — otherwise the card is client-only and the agent never sees the link.
// cap-hygiene: only the cap-STRIPPED URL is staged (the swissnum never reaches the agent/server).
const pendingSharedLinks = {}; // sessionId -> [url, …]
const pendingCustomView = {}; // sessionId -> { name, kind, methods, sample, current } — a custom-view task folded into the next send
const pendingWidgetRef = {}; // sessionId -> a context note for a widget whose chat-tail (💬) the user tapped, folded into the next send
// tapping a widget's chat-tail opens the conversation with the ENTRYPOINT AGENT about THAT widget: focus the
// composer + carry the widget as context (its type/name, so the agent knows what "this" is) into the next send.
const WIDGET_LABEL = { 'theme-preview': '🎨 theme', 'site-preview': '🌐 page', component: '🧩 component', choices: 'choices', 'entity-status': 'status', countdowns: 'countdowns' };
const talkAboutWidget = (spec) => {
  const type = (spec && spec.type) || 'widget';
  const name = (spec && (spec.name || spec.title || spec.label)) || '';
  const lbl = WIDGET_LABEL[type] || type;
  const detail = type === 'theme-preview' && spec && spec.vars ? ` Its current vars: ${JSON.stringify(spec.vars).slice(0, 400)}.` : '';
  pendingWidgetRef[sessionId] = `[The user tapped the chat-tail on the "${type}" widget${name ? ` ("${name}")` : ''} shown above — they want to discuss or change it. It is a system-rendered widget (you propose its data, e.g. via showThemePreview / showComponent), not an editable confined component.${detail} Help them: adjust it via the right tool, or build a confined component that does what they want.]`;
  const t = $('text');
  if (t) { if (!t.value.trim()) t.value = `About the ${lbl} above — `; t.focus(); try { t.setSelectionRange(t.value.length, t.value.length); } catch { /* */ } try { t.scrollIntoView({ block: 'center' }); } catch { /* */ } }
  setStatus(`talking to the agent about the ${lbl}`);
};
if (cap) { try { localStorage.setItem(CAP_KEY, cap); } catch {} }
if (location.hash) { try { history.replaceState(null, '', location.pathname + location.search); } catch {} } // strip the fragment (cap and/or chat)
if (!cap) { try { cap = localStorage.getItem(CAP_KEY) || null; } catch {} }
// A confined component (or other surface) failed to render → route the error (1) to the self-improvement
// loop (server de-dupes + files a backlog item), (2) to THIS CHAT's pending-error queue so the AUTHORING
// agent sees it as system feedback on its next turn (the chat-1cbe89a9 loop), and (3) as a visible system
// note in the transcript so the human knows the agent will hear about it. Cap-gated; the source snippet is
// render-safe (a widget's (ui)=>element body, never a swissnum).
const __seenCompErrs = new Set(); // one note+report per identical error per page load (a re-rendered broken widget re-throws)
window.__fieldReportError = (error, source, meta) => {
  try {
    if (!cap || !error) return;
    const err = String(error).slice(0, 300);
    const name = String((meta && meta.name) || '').slice(0, 80);
    // the failing object's IDENTITY (a uicomp-/fork- id — never a cap): when present, the server ALSO
    // files the error onto that object's OWN backlog (the project carries its breakage with it).
    const componentId = String((meta && meta.componentId) || '').slice(0, 80) || undefined;
    const forkId = String((meta && meta.forkId) || '').slice(0, 80) || undefined;
    const dedup = `${sessionId}|${name}|${err}`;
    if (__seenCompErrs.has(dedup)) return;
    __seenCompErrs.add(dedup);
    fetch('/error/flag', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, kind: 'component-render', error: err, source: String(source || '').slice(0, 500), sessionId, name, componentId, forkId }) }).catch(() => {});
    componentErrorNote(name, err);
  } catch { /* */ }
};
// the visible system note under the broken widget's message — themed via existing CSS vars (both palettes
// define --bad/--panel/--mut/--ink), VISUAL-only (never enters the transcript/history; the AGENT hears the
// same error server-side, injected into its next turn).
const componentErrorNote = (name, err) => {
  try {
    const logEl = document.getElementById('log'); if (!logEl) return;
    const d = document.createElement('div');
    d.className = 'msg comp-err-note';
    d.style.cssText = 'border:1px solid var(--bad);background:var(--panel);border-radius:10px;padding:8px 12px;margin:6px 0;font-size:12.5px;color:var(--ink)';
    const head = document.createElement('div'); head.style.cssText = 'font-weight:600;color:var(--bad)'; head.textContent = `⚠️ ${name || 'component'} failed in your browser`;
    const body = document.createElement('div'); body.style.cssText = 'color:var(--mut);margin-top:2px'; body.textContent = `${err} — the agent will see this error on its next turn and can fix it.`;
    d.append(head, body); logEl.appendChild(d); window.scrollTo(0, document.body.scrollHeight);
  } catch { /* */ }
};
// A confined component rendered a raw JS value as text ("[object Object]", a leaked promise, …) → route
// the smell to /render-smell so the server files it to the owner feedback-loops view AND feeds the
// correction back into that renderer's authoring loop so it self-corrects. Cap-gated; source is render-safe.
window.__fieldReportSmell = (smells, meta) => { try { if (!cap || !Array.isArray(smells) || !smells.length) return; fetch('/render-smell', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, smells: smells.slice(0, 20), componentId: String((meta && meta.componentId) || '').slice(0, 80), name: String((meta && meta.name) || 'component').slice(0, 80), source: String((meta && meta.source) || '').slice(0, 2000) }) }).catch(() => {}); } catch { /* */ } };
// ── APP CHROME as registry-backed components (increment 1 of the chrome decomposition —
//    designs/preact-component-trie.md). Seeded chrome-* project-objects (chrome-components.mjs) render
//    pieces of the shell through the confined no-iframe path: sources fetched ONCE per load (and after an
//    edit), compiled once per version (islands renderChrome caches the Compartment), mounted per site. A
//    failed mount returns false → the caller paints the ORIGINAL hardcoded DOM (never a dead toolbar) and
//    the error auto-files onto the component's own backlog (renderChrome → __fieldReportError → /error/flag).
//    Chrome components hold NO cap: the host passes exactly the affordance callbacks they may fire
//    (onClip / onCopy / onSuggest) as props — the props ARE the ocap boundary. ──
let chromeComps = {}; // id → { source, name, version }
const loadChromeComps = async () => {
  try { const r = await (await fetch('/chrome/components')).json(); if (r && r.ok && Array.isArray(r.components)) chromeComps = Object.fromEntries(r.components.map(c => [c.id, c])); }
  catch { /* unreachable → every chrome site falls back to its hardcoded DOM */ }
};
let chromeReady = loadChromeComps();
const mountChrome = (id, el, props) => {
  const c = chromeComps[id]; const isl = window.__fieldIslands;
  if (!c || !c.source || !isl || typeof isl.renderChrome !== 'function') return false;
  try { return isl.renderChrome(el, c.source, props, { componentId: id, name: c.name || id }); } catch { return false; }
};
// After an edit/revert of a chrome component: re-fetch HEAD sources + repaint every chrome site live.
const reloadChromeComps = async () => {
  chromeReady = loadChromeComps(); await chromeReady;
  try { renderTx(); } catch { /* transcript repaint is best-effort */ }
  try { mountWelcome(); } catch { /* landing repaint is best-effort */ }
  // chrome-studio IS the Components-tab list — repaint it too (audit flagged this repaint set only covered
  // renderTx + welcome). refreshComponents re-aggregates the props + re-mounts chrome-studio (or falls back).
  try { if (typeof curTab !== 'undefined' && curTab === 'components' && typeof refreshComponents === 'function') refreshComponents(); } catch { /* Studio repaint is best-effort */ }
};
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

// ── 🪪 AGENT PROFILE — the petname handle for an agent opens its whole self: identity, the powers + agents
//    in its inventory (double-click to browse / open), its feedback loops, and (with the root cap) the
//    entry points to reshape them. The name you use to identify another IS your petname for it.
const POWER_NS = { notes: 'notes', home: 'home', homeassistant: 'ha', agents: 'agents', contacts: 'contacts', timers: 'timers' };
const openInventoryForPower = pn => { const ns = POWER_NS[pn]; if (!ns) return false; closeModal(); if (curTab !== 'shares') showTab('shares'); try { navGo([{ ns, label: pn }]); } catch {} return true; };
const agentProfile = async who => {
  const id = who || chatAgent() || 'field-agent';
  showModal('<div class="qrlabel">loading agent profile…</div>');
  let shape; try { shape = await (await fetch('/agent/shape', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, agent: id }) })).json(); } catch (e) { shape = { error: e.message }; }
  if (!shape || shape.error) { showModal(`<div class="qrlabel">🪪 ${esc(id)}</div><div class="pmeta">${esc((shape && shape.error) || 'could not load profile')}${shape && /owner-only/.test(shape.error || '') ? ' — a fuller profile needs the root capability.' : ''}</div>`); return; }
  let gaunt = null; try { gaunt = await (await fetch('/gauntlet', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) })).json(); } catch {}
  const chips = arr => _arr(arr).map(x => `<span class="pill" style="margin:1px 3px 1px 0">${esc(String(x))}</span>`).join('');
  const powers = _arr(shape.powers), specs = _arr(shape.specialists);
  const html = `<div class="qrlabel" style="font-size:16px">🪪 ${esc(shape.label || id)} <span class="pmeta">· ${esc(shape.kind || 'agent')}</span></div>
    <div class="pmeta" style="margin:2px 0 11px">This name is your <b>petname</b> for it — the handle you use to identify, inspect, and (with permission) reshape this agent.</div>
    <div class="set-sec"><div class="set-h">🔑 Powers <span class="pmeta">· ${powers.length} · double-click to browse</span></div>
      ${powers.map(p => `<div class="share prof-power" data-pn="${esc(p.name)}" style="display:block;padding:6px 9px;margin:4px 0;cursor:pointer" title="double-click to browse / expand"><div style="font-size:13px">${esc(scrubCap(p.label || p.name))} <span class="pmeta">(${esc(p.name)})${POWER_NS[p.name] ? ' · 📂' : ''}</span></div><div class="prof-verbs" style="margin-top:3px;display:none">${chips(p.verbs)}</div></div>`).join('') || '<div class="pill">none</div>'}</div>
    <div class="set-sec"><div class="set-h">🧑‍🚀 Agents it holds <span class="pmeta">· ${specs.length} · double-click to open</span></div>
      ${specs.length ? specs.map(s => `<div class="share prof-spec" data-sid="${esc(s.id || s.name)}" style="display:block;padding:6px 9px;margin:4px 0;cursor:pointer" title="double-click to open its profile"><div style="font-size:13px">${esc(s.name || s.id)}${s.domain ? ` <span class="pmeta">· ${esc(scrubCap(s.domain))}</span>` : ''}</div><div style="margin-top:3px">${chips(s.powers)}</div></div>`).join('') : '<div class="pill">no held agents</div>'}</div>
    ${gaunt && gaunt.ok ? `<div class="set-sec"><div class="set-h">🛡️ Feedback loops <span class="pmeta">· ${gaunt.lanes.reduce((n, l) => n + l.gates.length, 0)} gates</span></div><div class="pmeta" style="line-height:1.5">${gaunt.lanes.map(l => `${esc(l.action)}:<br>&nbsp;&nbsp;${l.gates.map(g => esc(g.name)).join(' → ')}`).join('<br>')}</div><button class="mini" id="prof-checks" style="margin-top:6px">open the gauntlet ↗</button></div>` : ''}
    ${isRoot ? `<div class="set-sec"><div class="set-h">✎ Reshape <span class="pmeta">· you hold the root cap</span></div><button class="mini" id="prof-ep">manage powers</button> <button class="mini" id="prof-es">manage agents</button> <button class="mini" id="prof-ec">manage checks</button></div>` : '<div class="pmeta">Editing this agent needs the root capability.</div>'}`;
  showModal(html);
  document.querySelectorAll('.prof-power').forEach(el => { el.ondblclick = () => { if (!openInventoryForPower(el.dataset.pn)) { const v = el.querySelector('.prof-verbs'); if (v) v.style.display = v.style.display === 'none' ? 'block' : 'none'; } }; });
  document.querySelectorAll('.prof-spec').forEach(el => { el.ondblclick = () => { agentProfile(el.dataset.sid); }; });
  const go = (sec) => { closeModal(); settingsSection = sec; openSettings(); };
  const pc = $('prof-checks'); if (pc) pc.onclick = () => go('feedback');
  const ep = $('prof-ep'); if (ep) ep.onclick = () => go('agents');
  const es = $('prof-es'); if (es) es.onclick = () => go('specialists');
  const ec = $('prof-ec'); if (ec) ec.onclick = () => go('feedback');
};
window.agentProfile = agentProfile; // reachable from any surface that names an agent

// ── 🔬 OBJECT INSPECTOR — see + poke the goods. A live inventory object self-describes (describe/help +
// its method set); the inspector lists its methods, lets you CALL one, and renders the result as an
// interactive value TREE (records/arrays collapse; remotables surface their interface; secrets redacted
// server-side). Rung 1 of the "blossom a renderer per object" loop — the generic fallback every object gets.
const valNode = (v, key) => {
  const row = document.createElement('div'); row.style.cssText = 'font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word';
  const kpart = key != null ? `<span style="color:var(--acc,#39d3ff)">${esc(String(key))}</span>: ` : '';
  if (v === null || v === undefined) { row.innerHTML = `${kpart}<span style="color:var(--mut)">${v === null ? 'null' : 'undefined'}</span>`; return row; }
  const t = typeof v;
  if (t === 'string') { row.innerHTML = `${kpart}<span style="color:var(--ok,#3fb950)">${esc(JSON.stringify(v))}</span>`; return row; }
  if (t === 'number' || t === 'boolean') { row.innerHTML = `${kpart}<span style="color:#d29922">${esc(String(v))}</span>`; return row; }
  if (v && v.__ref) { row.innerHTML = `${kpart}<span class="pill" title="a live remotable — call its .describe()/.help()">⛓ ${esc(v.__ref)}</span>`; return row; }
  if (v && v.__fn) { row.innerHTML = `${kpart}<span class="pill">ƒ ${esc(v.__fn)}</span>`; return row; }
  // array / object → collapsible
  const isArr = Array.isArray(v); const entries = isArr ? v.map((x, i) => [i, x]) : Object.entries(v);
  const head = document.createElement('div'); head.style.cssText = 'cursor:pointer'; head.innerHTML = `${kpart}<span style="color:var(--mut)">${isArr ? `▸ [${entries.length}]` : `▸ {${entries.length}}`}</span>`;
  const kids = document.createElement('div'); kids.style.cssText = 'margin-left:14px;border-left:1px solid var(--edge);padding-left:8px;display:none';
  let built = false;
  head.onclick = () => { const open = kids.style.display !== 'none'; if (!built && !open) { for (const [k, val] of entries) kids.appendChild(valNode(val, k)); built = true; } kids.style.display = open ? 'none' : 'block'; head.querySelector('span:last-child').textContent = (open ? '▸ ' : '▾ ') + (isArr ? `[${entries.length}]` : `{${entries.length}}`); };
  row.append(head, kids); return row;
};
const objectInspector = async (name, opts = {}) => {
  // opts.mount → render INLINE into that element (e.g. the navigator's detail pane) instead of a modal,
  // so the inspector + blossoming UI live right in the Powers/navigator. The #insp-* ids are wired via $()
  // so the handlers work in either host.
  const mount = opts.mount || null;
  const render = html => { if (mount) mount.innerHTML = `<div class="insp-wrap">${html}</div>`; else showModal(html); };
  render('<div class="pmeta">loading inventory…</div>');
  let objs; try { objs = await rpc('objectsList', []); } catch (e) { render(`<div class="qrlabel">🔬 Objects</div><div class="pmeta">${esc(e.message)}</div>`); return; }
  const o = (objs || []).find(x => x.name === name) || (objs || [])[0];
  if (!o) { render('<div class="qrlabel">🔬 Objects</div><div class="pmeta">No objects in your inventory yet — accept an Endo invite link.</div>'); return; }
  const methods = (o.methods || []).length ? o.methods : ['describe'];
  render(`<div class="qrlabel" style="font-size:16px">🔬 ${esc(o.name)} <span class="pmeta">· ${esc(o.transport)}</span></div>
    <div class="pmeta" style="margin:2px 0 9px">${esc(o.description || 'a live capability in your inventory')} — self-describing: call a method to see the goods.</div>
    <div class="set-sec"><div class="set-h">Methods</div>
      <div class="set-row" style="gap:6px;align-items:center;flex-wrap:wrap">${methods.map(m => `<button class="mini insp-m" data-m="${esc(m)}">${esc(m)}()</button>`).join('')}</div>
      <input id="insp-args" class="mini" placeholder="args (JSON array, or plain text for one string arg) — optional" style="width:100%;box-sizing:border-box;margin-top:7px;font-family:ui-monospace,monospace">
    </div>
    <div class="set-sec" id="insp-bloom-sec"><div class="set-h">🌱 Custom view <span class="pmeta" id="insp-bloom-status"></span></div><div id="insp-bloom" class="pmeta">checking…</div></div>
    <div class="set-sec"><div class="set-h">Result</div><div id="insp-result" class="pmeta">— call a method —</div></div>`);
  // BLOSSOM a bespoke renderer for this object's INTERFACE. Generating one costs an LLM call, METERED against
  // THIS CHAT's budget — so it's MANUAL by default (a "Generate" button), with an opt-in "always generate"
  // checkbox (persisted) for the eager behaviour. A renderer already authored for this interface is reused.
  let rendererSrc = null; let lastValue = undefined;
  const bfetch = (p, b) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json()).catch(() => null);
  const genControls = (prefix) => { const host = $('insp-bloom'); if (!host) return; host.innerHTML = `${prefix || ''}<div style="margin-top:6px"><button class="mini" id="insp-gen">✨ Generate a custom view</button> <label style="font-size:11px;color:var(--mut);margin-left:8px;cursor:pointer"><input type="checkbox" id="insp-auto"${localStorage.getItem('blossom-auto') === '1' ? ' checked' : ''}> always generate interfaces for unknown objects</label></div>`; const g = $('insp-gen'); if (g) g.onclick = () => requestCustomView({ name: o.name, kind: 'object', methods, callable: true }); const a = $('insp-auto'); if (a) a.onchange = () => { try { localStorage.setItem('blossom-auto', a.checked ? '1' : '0'); } catch {} }; };
  // populate props.value with REAL data (describe) so a ready view isn't empty before any method is clicked
  const loadReady = async sig => { const s = await bfetch('/blossom/source', { cap, sig }); if (s && s.ok) { rendererSrc = s.source; if (lastValue === undefined) { try { lastValue = await callObj(methods.includes('describe') ? 'describe' : methods[0], []); } catch {} } paintBespoke(); return true; } return false; };
  const triggerBlossom = async () => {
    const host = $('insp-bloom'), st = $('insp-bloom-status');
    if (host) host.innerHTML = '<div class="pmeta">🌱 generating a custom view… <span style="color:var(--mut)">(drawing from this chat’s budget)</span></div>';
    await bfetch('/blossom/ensure', { cap, sessionId, name: o.name, methods, kind: 'object', sample: { name: o.name, transport: o.transport, methods } });
    for (let i = 0; i < 24; i++) {
      const r = await bfetch('/blossom/for', { cap, methods, kind: 'object' }); const e = r && r.entry; if (!e) { if (st) st.textContent = ''; return; }
      if (st) st.textContent = `· ${e.status}`;
      if (e.status === 'ready') { if (st) st.textContent = ''; await loadReady(e.sig); return; }
      if (e.status === 'failed' || e.status === 'budget-exhausted' || e.status === 'no-interface' || e.status === 'queued') { if (st) st.textContent = ''; genControls(`<div class="pmeta">⚠︎ ${esc(e.reason || e.status)}</div>`); return; }
      await new Promise(r => setTimeout(r, 2500));
    }
  };
  const setupBloom = async () => {
    const host = $('insp-bloom'); if (!host) return;
    const r = await bfetch('/blossom/for', { cap, methods, kind: 'object' }); const e = r && r.entry;
    if (e && e.status === 'ready') { if (await loadReady(e.sig)) return; }
    if (e && e.status === 'blossoming') { host.innerHTML = '<div class="pmeta">🌱 generating a custom view…</div>'; triggerBlossom(); return; } // already in flight → just poll
    if (localStorage.getItem('blossom-auto') === '1') { triggerBlossom(); return; } // opted into eager
    genControls('<div class="pmeta">No custom view yet for this kind of object.</div>'); // MANUAL by default
  };
  // A MEDIATED capability handed to the confined renderer: it can invoke THIS object's methods (host-side,
  // scoped to o.name) but holds no cap of its own — least authority. Used by interactive widgets (e.g. a
  // send box). Returns a Promise of the (structured) result.
  const callObj = async (method, args) => { const r = await rpc('objectCall', [o.name, method, Array.isArray(args) ? args : (args == null ? [] : [args])]); return r && r.value; };
  const paintBespoke = () => {
    const host = $('insp-bloom'); if (!host || !rendererSrc) return;
    host.innerHTML = '';
    const props = { value: lastValue, name: o.name, methods, call: callObj, refresh: () => { call(methods.includes('describe') ? 'describe' : methods[0]); } };
    const ok = window.__fieldIslands && window.__fieldIslands.renderSource && window.__fieldIslands.renderSource(rendererSrc, host, props);
    if (!ok) host.innerHTML = '<div class="pmeta">A bespoke confined renderer was authored for this interface — it renders inline (interactive) once the confined runtime (lockdown) is on.</div>';
  };
  const call = async m => {
    const out = $('insp-result'); out.textContent = `calling ${m}()…`;
    let args = []; const raw = ($('insp-args') && $('insp-args').value || '').trim();
    if (raw) { try { const p = JSON.parse(raw); args = Array.isArray(p) ? p : [p]; } catch { args = [raw]; } }
    let r; try { r = await rpc('objectCall', [o.name, m, args]); } catch (e) { out.innerHTML = `<span style="color:var(--bad)">⚠︎ ${esc(e.message)}</span>`; return; }
    lastValue = r && r.value;
    out.innerHTML = ''; out.appendChild(valNode(lastValue, null));
    const hd = out.querySelector('div[style*="cursor"]'); if (hd) hd.click(); // auto-expand to see the goods
    if (rendererSrc) paintBespoke(); // re-render the bespoke view with this result
  };
  document.querySelectorAll('.insp-m').forEach(b => { b.onclick = () => call(b.dataset.m); });
  setupBloom();
};
window.objectInspector = objectInspector;
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
// LIVE PROGRESS (dan): a long turn used to sit SILENT — the model thinks + tools run for a minute+ with no
// visible sign, so the page looked stalled. This is an ephemeral agent-side bubble in the log that shows the
// CURRENT activity (a "Thinking…" heartbeat, the agent's own updateProgress() pings, and tool starts). It is
// replaced by the real answer bubble when the turn lands (clearLiveProgress, called from pendantEnd + render).
let liveProgressEl = null;
const showLiveProgress = text => {
  try {
    if (!liveProgressEl || !liveProgressEl.isConnected) {
      liveProgressEl = document.createElement('div');
      liveProgressEl.className = 'msg live-progress';
      liveProgressEl.style.opacity = '.85';
      liveProgressEl.innerHTML = '<div class="who"></div><div class="body" style="display:flex;align-items:flex-start;gap:7px"><span class="lp-dot" style="flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:var(--acc,#7c5cff);margin-top:5px;animation:lp-pulse 1.1s ease-in-out infinite"></span><span class="lp-text" style="flex:1;min-width:0;color:var(--mut,#8b949e);overflow-wrap:anywhere;word-break:break-word;white-space:normal"></span></div>';
      const w = liveProgressEl.querySelector('.who'); if (w) w.textContent = 'agent';
      log.appendChild(liveProgressEl);
      if (!document.getElementById('lp-kf')) { const st = document.createElement('style'); st.id = 'lp-kf'; st.textContent = '@keyframes lp-pulse{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1.15)}}'; document.head.appendChild(st); }
    }
    const tx = liveProgressEl.querySelector('.lp-text'); if (tx) tx.textContent = text || 'Thinking…';
    try { liveProgressEl.scrollIntoView({ block: 'end', behavior: 'smooth' }); } catch { /* */ }
  } catch { /* progress UI is enhancement-only — never block a turn */ }
};
const clearLiveProgress = () => { try { if (liveProgressEl) { liveProgressEl.remove(); liveProgressEl = null; } } catch { /* */ } };
// a friendly label for a tool start, so the heartbeat reads in plain language ("Researching…") not "research"
const PROGRESS_VERB = { research: 'Researching', search: 'Searching', browser: 'Browsing the web', web: 'Searching the web', fileWrite: 'Writing a file', fileRead: 'Reading a file', publishSite: 'Publishing a page', delegateTask: 'Delegating to a sub-agent', employ: 'Bringing in a specialist', proposeTool: 'Building a tool', forgeTool: 'Building a tool', requestAccess: 'Requesting access', scheduleWakeup: 'Setting up a schedule' };
const progressLabelFor = (name, detail) => { const v = PROGRESS_VERB[name] || (name ? name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase()) : 'Working'); return detail ? `${v}: ${String(detail).slice(0, 80)}` : `${v}…`; };
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
  // P4: render the bubble SHELL (.who + .body) via its editable island (alt-click a message → edit the bubble
  // template). Fall back to static markup if islands aren't up or the shell didn't render its two slots.
  let shellOk = false;
  try { if (window.__fieldIslands && window.__fieldIslands.renderMessageBubble) shellOk = window.__fieldIslands.renderMessageBubble(d); } catch { shellOk = false; }
  if (!shellOk || !d.querySelector('.who') || !d.querySelector('.body')) d.innerHTML = `<div class="who"></div><div class="body"></div>`;
  const w = d.querySelector('.who'); w.textContent = label; if (named) w.style.color = col;
  // the agent's NAME is your petname handle for it → click to open its profile (identity · inventory · feedback loops)
  if (who !== 'you') { w.style.cursor = 'pointer'; w.title = `open ${id}'s profile`; w.onclick = e => { if (e.target.classList && e.target.classList.contains('msg-time')) return; agentProfile(id); }; }
  if (at) { const ts = document.createElement('span'); ts.className = 'msg-time'; ts.style.cssText = 'margin-left:7px;font-size:10px;font-weight:400;color:var(--mut);opacity:.65'; ts.textContent = fmtMsgTime(at); ts.title = new Date(at).toLocaleString(); w.appendChild(ts); }
  // agent replies are Markdown (agents format even unprompted) → render it; user text stays literal (linkify only)
  const bodyEl = d.querySelector('.body');
  // CAP HYGIENE (defense-in-depth; the server already scrubs answers): never render a #cap=/swissnum an
  // agent reply might echo — into the bubble OR into a clip promoted from it (attachMsgToolbar). User text
  // is left literal (it's their own input, linkified not clipped-by-default).
  const shownText = who === 'you' ? (text == null ? '' : text) : scrubCap(text == null ? '' : text);
  if (who === 'you') { linkify(bodyEl, shownText || '…'); } else { bodyEl.classList.add('md'); renderMarkdown(bodyEl, shownText || '…'); }
  attachMsgToolbar(d, bodyEl, shownText); // the per-message action strip (chrome-msg-toolbar component; falls back to the plain 🔗)
  log.appendChild(d); window.scrollTo(0, document.body.scrollHeight);
  return d.querySelector('.body');
};
// ── CLIP ("promote on attention", dan): any message can become a shareable PAGE on demand — it doesn't start
//    as one (perf). A quiet 🔗 in the bottom-right of every message clips the WHOLE message; selecting a segment
//    first clips just that part. The rendered markdown is ALREADY safe HTML in bodyEl — we send it as-is (the
//    server re-strips scripts) → it becomes a /sites page (web-key link = the share credential; copy/QR). ──
const clipShareSheet = (clip) => {
  const link = { url: clip.url, label: clip.name || 'Clip' };
  showModal(`<div class="qrlabel">🔗 Clip created — “${esc(clip.name || 'Clip')}”</div>
    <div class="sub" style="margin:6px 0 10px;max-width:320px">A shareable page of this. The link IS the access — copy or QR it, don't screenshot.</div>
    <div style="display:flex;gap:7px;flex-wrap:wrap"><button class="mini" id="clip-copy">copy link</button><button class="mini" id="clip-qr">show QR</button><button class="mini" id="clip-open">open ↗</button></div>`);
  if ($('clip-copy')) $('clip-copy').onclick = e => copyLink(link, e.currentTarget);
  if ($('clip-qr')) $('clip-qr').onclick = () => showQr(link);
  if ($('clip-open')) $('clip-open').onclick = () => { try { window.open(localizeUrl(clip.url), '_blank', 'noopener'); } catch { /* */ } };
};
const clipAndShare = async ({ html, text, title }) => {
  if (!html || !html.trim()) { setStatus('nothing to clip'); return; }
  const ttl = (title || (String(text || '').match(/^#{1,6}\s*(.+)$/m) || [])[1] || String(text || '').split('\n').find(l => l.trim()) || 'Clip').slice(0, 80);
  setStatus('clipping…');
  let r; try { r = await (await fetch('/clip/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: chatCap(), title: ttl, html }) })).json(); } catch (e) { r = { error: e.message }; }
  setStatus('');
  if (!r || !r.ok) { setStatus('clip: ' + ((r && r.error) || 'failed')); return; }
  clipShareSheet(r);
};
// The per-message TOOLBAR is now app chrome (chrome-msg-toolbar, a registry-backed confined component):
// 📋 copy + 🔗 clip. The HOST keeps every authority-bearing move — reading the selection/DOM, the clipboard,
// the /clip/create call — and hands the component only two callbacks; the component is pure render. If the
// chrome component fails to mount (or the registry is unreachable), the ORIGINAL hardcoded 🔗 button paints
// instead, so the affordance never dies with a broken edit.
const attachMsgToolbar = (msgEl, bodyEl, text) => {
  try {
    msgEl.style.position = 'relative';
    // if the user highlighted a SEGMENT inside this message, clip just that; else the whole message.
    const doClip = () => {
      const sel = window.getSelection && window.getSelection();
      let html = bodyEl.innerHTML, segText = text;
      if (sel && !sel.isCollapsed && bodyEl.contains(sel.anchorNode) && bodyEl.contains(sel.focusNode)) {
        const frag = sel.getRangeAt(0).cloneContents(); const tmp = document.createElement('div'); tmp.appendChild(frag); html = tmp.innerHTML; segText = sel.toString();
      }
      clipAndShare({ html, text: segText });
    };
    const doCopy = async () => { const okc = await writeClipboard(String(text || bodyEl.textContent || '')); setStatus(okc ? '📋 copied' : 'copy failed (clipboard permission?)'); };
    // ⭐ SAVE AS STORY (MAGIC-STORIES-1): nominate THIS flow as a candidate for the 🪄 gallery. Host-gated (the
    // authority-bearing move is ours); the payload is the already-flowing trace context (sanitized server-side).
    const doSaveStory = () => saveStoryFromMessage(String(text || bodyEl.textContent || ''));
    // a host-owned ⭐ button, always present (independent of the confined chrome-msg-toolbar), so the affordance
    // never dies with a broken component edit — sits just left of the copy/clip toolbar.
    const star = document.createElement('button'); star.className = 'msg-star'; star.title = 'Save this flow as a Magic Story'; star.textContent = '⭐';
    star.style.cssText = 'all:unset;position:absolute;right:34px;bottom:4px;cursor:pointer;font-size:12px;opacity:.3;transition:opacity .15s;padding:2px 5px;border-radius:6px;line-height:1';
    star.addEventListener('mouseenter', () => { star.style.opacity = '1'; });
    star.addEventListener('mouseleave', () => { star.style.opacity = '.3'; });
    star.addEventListener('click', e => { e.stopPropagation(); doSaveStory(); });
    msgEl.appendChild(star);
    const legacy = () => { // the pre-decomposition DOM — the guaranteed floor
      const b = document.createElement('button'); b.className = 'msg-clip'; b.title = 'Clip & share this as a page'; b.textContent = '🔗';
      b.style.cssText = 'all:unset;position:absolute;right:6px;bottom:4px;cursor:pointer;font-size:12px;opacity:.3;transition:opacity .15s;padding:2px 5px;border-radius:6px;line-height:1';
      b.addEventListener('mouseenter', () => { b.style.opacity = '1'; });
      b.addEventListener('mouseleave', () => { b.style.opacity = '.3'; });
      b.addEventListener('click', e => { e.stopPropagation(); doClip(); });
      msgEl.appendChild(b);
    };
    const host = document.createElement('div'); host.className = 'msg-toolbar';
    host.style.cssText = 'position:absolute;right:6px;bottom:4px;opacity:.3;transition:opacity .15s';
    host.addEventListener('mouseenter', () => { host.style.opacity = '1'; });
    host.addEventListener('mouseleave', () => { host.style.opacity = '.3'; });
    host.addEventListener('click', e => e.stopPropagation()); // host-side: toolbar taps never bubble into the message
    msgEl.appendChild(host);
    chromeReady.then(() => {
      if (!host.isConnected) return; // the transcript re-rendered while sources loaded — this mount is gone
      if (!mountChrome('chrome-msg-toolbar', host, { onClip: doClip, onCopy: doCopy, onSaveStory: doSaveStory })) { host.remove(); legacy(); }
    }).catch(() => { try { host.remove(); } catch { /* */ } legacy(); });
  } catch { /* the toolbar is enhancement-only */ }
};

// ── 🌱 BLOSSOM OBJECTS IN MESSAGES (increment 1b) — a reply can hand answer()/ask()/blocked() a LIVE value
//    (a remotable, a record, an array) that would otherwise be destroyed to "[object Object]". The server carries
//    it as a cap-safe descriptor on donePayload.objects (see server.mjs OBJECT CHANNEL + codemode describeRef):
//      { kind, name, methods:[…], sample:<render-safe JSON/preview string>, preview, redacted?, blossomSig }
//    and drops a clean text placeholder ("🌱 {kind} — {name} (unrendered object)") where the value was. We render
//    each descriptor RICHLY, in place of that placeholder: the generic valNode drill-down tree by default (readable,
//    explorable), plus a "🌱 blossom this" affordance that authors/uses a bespoke confined renderer for the object's
//    INTERFACE (pet-naming: once blossomed, every object of that kind renders that way). Cap-hygiene: the sample is
//    treated as untrusted (client scrubCap pass even though the server scrubbed); a redacted cap is a chip, never a value.
const blossomObjFetch = (p, b) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json()).catch(() => null);
// Reconstruct the exact in-text placeholder codemode emitted for a descriptor, so we can find it in the rendered
// markdown and swap the rich render in at that spot (keep in lock-step with codemode.mjs refPlaceholder).
const objPlaceholderText = d => {
  if (d.redacted) return '🌱 capability (redacted — not shown)';
  const nm = (d.name && d.name !== d.kind) ? d.name
    : ((d.methods && d.methods.length) ? d.methods.slice(0, 4).join(', ') + (d.methods.length > 4 ? ', …' : '') : (d.name || 'value'));
  return `🌱 ${d.kind} — ${nm} (unrendered object)`;
};
// Turn the descriptor's sample (a server-scrubbed JSON/preview STRING) into something valNode can drill into.
// Defense-in-depth: run our own scrubCap over the raw text first (a swissnum must never reach the DOM), THEN parse.
const parseObjSample = sample => {
  const raw = scrubCap(sample == null ? '' : String(sample));
  try { const v = JSON.parse(raw); if (v && typeof v === 'object') return v; } catch { /* not JSON — a preview string */ }
  return raw;
};
// Render ONE object descriptor as an inline card: header (kind · name · methods) + a value view. Default view is
// the valNode tree; if a bespoke renderer already exists for this interface it's used instead; a 🌱 control lets the
// user author/revise one (which then applies to every object of the same kind — the pet-naming loop).
const renderObjectDescriptor = d => {
  const card = document.createElement('div');
  card.className = 'msg-object';
  card.style.cssText = 'margin:8px 0;border:1px solid var(--edge);border-radius:9px;padding:8px 10px;background:var(--panel,rgba(127,127,127,.06))';
  const kindIcon = { remotable: '⛓', array: '≣', object: '{}', promise: '⏳', cap: '🔒' }[d.kind] || '🌱';
  const methods = Array.isArray(d.methods) ? d.methods : [];
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:12px';
  head.innerHTML = `<span class="pill" title="${esc(d.kind)}">${kindIcon} ${esc(scrubCap(d.name || d.kind || 'object'))}</span>` +
    (methods.length ? `<span class="pmeta" style="font-size:11px">${methods.slice(0, 6).map(m => `<code>${esc(scrubCap(m))}</code>`).join(' ')}${methods.length > 6 ? ' …' : ''}</span>` : '');
  card.appendChild(head);
  // A redacted capability is NEVER expanded — chip only, no value fetched or shown (stack-wide cap hygiene).
  if (d.redacted) {
    const chip = document.createElement('div');
    chip.className = 'pill';
    chip.style.cssText = 'margin-top:6px;color:var(--mut)';
    chip.textContent = '🔒 capability — redacted, not shown';
    chip.title = 'a live capability was handed back; its value is a secret and is never rendered';
    card.appendChild(chip);
    return card;
  }
  const mount = document.createElement('div');
  mount.style.cssText = 'margin-top:6px';
  const data = parseObjSample(d.sample);
  const paintTree = () => { mount.innerHTML = ''; const tree = valNode(data, null); mount.appendChild(tree); const hd = tree.querySelector('div[style*="cursor"]'); if (hd) hd.click(); }; // auto-expand one level
  paintTree();
  card.appendChild(mount);
  // Blossom is keyed on the object's INTERFACE (kind + method-set). Method-less plain data (blossomSig 'sig-empty',
  // or no methods → a too-generic "any object" key) keeps the valNode tree — the right default; no bespoke path.
  const sig = d.blossomSig || '';
  const blossomable = !!methods.length && sig && sig !== 'sig-empty';
  if (blossomable) {
    // If a bespoke renderer for this interface is already authored, render THROUGH it (the confined path); else the
    // valNode tree stands. Either way, offer a 🌱 control to author (or revise) how this KIND of object looks.
    (async () => {
      try {
        const r = await blossomObjFetch('/blossom/for', { cap, methods, kind: d.kind }); const e = r && r.entry;
        if (e && e.status === 'ready' && e.sig) {
          const s = await blossomObjFetch('/blossom/source', { cap, sig: e.sig });
          if (s && s.ok && window.__fieldIslands && window.__fieldIslands.renderSource) {
            const view = document.createElement('div');
            // props.value = the scrubbed snapshot; these are DEAD descriptors (no live handle) so no props.call.
            const ok = window.__fieldIslands.renderSource(s.source, view, { value: data, name: d.name, kind: d.kind, methods });
            if (ok) { mount.innerHTML = ''; mount.appendChild(view); }
          }
        }
      } catch { /* a broken renderer never strands the tree */ }
    })();
    const bar = document.createElement('div');
    bar.style.cssText = 'margin-top:6px';
    const btn = document.createElement('button'); btn.className = 'mini';
    btn.textContent = '🌱 change how this looks';
    btn.title = 'author (or revise) a custom view for this kind of object — it then applies to every object of this interface';
    btn.onclick = () => { try { requestCustomView({ name: d.name || d.kind, kind: d.kind, methods, data, callable: false }); } catch (e) { setStatus('blossom: ' + e.message); } };
    bar.appendChild(btn);
    card.appendChild(bar);
  }
  return card;
};
// Walk the rendered bubble's TEXT nodes for `placeholder` and splice `node` in at that spot (so the rich render sits
// exactly where the object was in the sentence). Returns true if anchored; false → the caller appends at the end.
const anchorObjectAt = (bodyEl, placeholder, node) => {
  if (!placeholder) return false;
  try {
    const walker = document.createTreeWalker(bodyEl, NodeFilter.SHOW_TEXT);
    let tn;
    while ((tn = walker.nextNode())) {
      const idx = tn.nodeValue.indexOf(placeholder);
      if (idx < 0) continue;
      const rest = tn.splitText(idx);
      rest.nodeValue = rest.nodeValue.slice(placeholder.length); // strip the placeholder text; leave any trailing prose
      rest.parentNode.insertBefore(node, rest);
      return true;
    }
  } catch { /* fall back to append */ }
  return false;
};
// Render every carried object into the bubble body: replace its text placeholder in place when we can find it,
// otherwise append it below the prose. Isolated per-object so one bad descriptor can't swallow the rest.
const renderMessageObjects = (bodyEl, objects) => {
  const list = Array.isArray(objects) ? objects : [];
  if (!list.length || !bodyEl) return;
  let tail = null; // lazily-created container for descriptors whose placeholder wasn't found in the text
  for (const d of list) {
    try {
      const node = renderObjectDescriptor(d);
      if (!anchorObjectAt(bodyEl, objPlaceholderText(d), node)) {
        if (!tail) { tail = document.createElement('div'); tail.className = 'msg-objects'; tail.style.cssText = 'margin-top:6px'; bodyEl.appendChild(tail); }
        tail.appendChild(node);
      }
    } catch (e) { console.error('renderObjectDescriptor failed', e); }
  }
};
window.renderMessageObjects = renderMessageObjects; window.renderObjectDescriptor = renderObjectDescriptor; // staging hooks (mirror window.appendLeafBlossom)

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
  const card = document.createElement('div'); card.setAttribute('data-trusted-path', ''); log.appendChild(card); // Confirm/Reject renders an authority decision → trusted path, never editable chrome
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
  card.setAttribute('data-trusted-path', ''); // Grant button = an authority decision → trusted path, never editable chrome
  // notesFolder → a LEAST-AUTHORITY notes grant: scope the chat's notes to JUST that vault subtree (not all notes)
  const scopeNote = a.notesFolder ? ` <span class="pill" title="least authority — only this folder">📁 ${esc(a.notesFolder)}</span>` : '';
  const title = a.notesFolder ? `Grant notes — scoped to just “${esc(a.notesFolder)}”?` : `Grant the “${esc(a.power)}” capability to this chat?`;
  card.innerHTML = `<div class="ptitle">🔓 <span>${title}</span></div><div class="pmeta">${esc(a.label || a.power)}${scopeNote}${a.why ? ' — ' + esc(a.why) : ''}</div><div class="pbtns"></div>`;
  const btns = card.querySelector('.pbtns');
  if (!isRoot || !cc.scopedCap) { btns.innerHTML = '<span class="pmeta">only the owner can grant powers (open this chat with your root link)</span>'; }
  else {
    const g = document.createElement('button'); g.className = 'confirm'; g.textContent = a.notesFolder ? `Grant this folder` : 'Grant';
    const d = document.createElement('button'); d.className = 'reject'; d.textContent = 'Not now';
    g.onclick = async () => {
      g.disabled = d.disabled = true;
      const cur = cc.scopedPowers || [];
      await rescopeChat(cc, [...new Set([...cur, a.power])], a.notesFolder || undefined);
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
  const pre = (txt, col) => `<pre style="white-space:pre-wrap;word-break:break-word;max-height:38vh;overflow:auto;background:var(--bg);border:1px solid var(--edge);border-left:3px solid ${col};border-radius:7px;padding:8px 10px;margin:4px 0 10px;font:12px ui-monospace,Menlo,Consolas,monospace;color:var(--ink)">${esc(txt)}</pre>`;
  return `<div class="trace-detail" style="text-align:left;width:520px;max-width:88vw">
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
  // introspect how many sub-agents got promoted to their own tower (the sub-agent-lifeline regression guard).
  window.__pendantStats = async () => { try { const p = await ensurePendant(); return p.stats ? p.stats() : null; } catch (e) { return String((e && e.message) || e); } };
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
// open a fresh chat AS a spawned specialist (the inline specialist island's 💬 Chat) — by the name it was given.
const onOpenSpecialist = (id, name) => {
  newChat(); // mints a new ephemeral sessionId
  pendingAgent[sessionId] = String(id || ''); // run this chat AS the specialist (committed on first message)
  const sel = $('agent-sel'); if (sel) { const has = [...sel.options].some(o => o.value === id); if (has) sel.value = id; } // reflect it in the header selector if listed
  try { renderChatBar(); } catch { /* */ }
  setStatus(`chatting as ${name || 'specialist'}`);
  const t = $('text'); if (t) t.focus();
};
// open one of a specialist's standing-nudge runs (a seed-chat) from the inline island's RECENT RUNS.
const onOpenRun = async runId => { pendingChat = runId; try { await loadSeedChats(); } catch { /* */ } tryOpenPendingChat(); };

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
  clearLiveProgress(); // the real answer supersedes the ephemeral "working…" bubble
  // The ANSWER bubble must render even if an auxiliary part (trace SVG, a widget, a Grant/proposal/ask card)
  // throws on malformed data — otherwise one bad card swallows the whole turn (the "answer + the permission
  // request both vanished" bug). Each piece is isolated; the answer comes first and unconditionally.
  try { if (_arr(r.steps).length) log.appendChild(traceGeometry(r.steps)); } catch (e) { console.error('traceGeometry failed', e); } // the SVG trace sits ABOVE the message (tap it for the 3D)
  const body = bubble('agent', r.answer || '…', r.agentId, Date.now());
  if (r.toolsUsed?.length) { const e = document.createElement('div'); e.className = 'tools'; e.textContent = '⚙ ' + r.toolsUsed.join(', '); body.parentNode.appendChild(e); }
  ((r.images && r.images.length ? r.images : (r.imageUrls || [])) || []).forEach(src => { const im = document.createElement('img'); im.src = src; body.appendChild(im); }); // data-URLs in the moment; durable /uploads urls as fallback (e.g. the share-post path)
  try { if (Array.isArray(r.ui) && r.ui.length) renderWidgets(body, r.ui, { cap: chatCap(), onChoice: t => sendChat(t), onBreakOut: breakOutComponent, onShareOut: shareOutComponent, onExpand: toggleApplet, onTalk: talkAboutWidget, onOpenSpecialist, onOpenRun }); } catch (e) { console.error('renderWidgets failed', e); } // live/interactive widgets
  try { if (Array.isArray(r.objects) && r.objects.length) renderMessageObjects(body, r.objects); } catch (e) { console.error('renderMessageObjects failed', e); } // 🌱 carried live values → rich, blossom-able render
  (r.autoFired || []).forEach(a => { const e = document.createElement('div'); e.className = 'autofired'; e.textContent = `✓ auto-confirmed: ${a.title}${a.ok === false ? ' (failed)' : ''}`; body.parentNode.appendChild(e); }); // fired via a "don't ask again" rule
  // Each card renders INDEPENDENTLY — one malformed proposal/access-request/ask must never abort the rest
  // (the answer is already shown above; a throwing Grant card used to swallow the whole turn's render).
  (r.proposals || []).forEach(p => { try { renderProposal(p); } catch (e) { console.error('renderProposal failed', e); } }); // destructive actions show as confirmable cards
  (r.accessRequests || []).forEach(a => { try { renderAccessRequest(a); } catch (e) { console.error('renderAccessRequest failed', e); } }); // requestAccess → an actionable Grant card
  (r.asks || []).forEach(a => { try { openAsks.unshift(a); renderAskCard(a); } catch (e) { console.error('renderAskCard failed', e); } }); // typed questions → answerable cards
  if (r.asks?.length) refreshBadge();
  refreshTraceApp(); // push the new turn to the iframe trace app if it's open
  window.scrollTo(0, document.body.scrollHeight);
  schedulePendantPosition(); // the answer bubble shifted layout — re-anchor the pendant
};
window.renderAgentResponse = renderAgentResponse; // staging hook: drive a full answer render (incl. 🌱 object channel)

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
    if (r.exhausted) { updateBudgetChip(r.remaining, r.allowance); renderExhausted({ ...payload, invited: !!r.invited }, spoken); return; }
    renderAgentResponse(r);
    pushTx('agent', r.answer || '', { tools: r.toolsUsed || [], images: r.images || [], imageUrls: r.imageUrls || [], steps: r.steps || [], agent: r.agentId, ui: r.ui || [], objects: r.objects || [] });
    pendantEnd(r.steps || []);
    updateBudgetChip(r.remaining, r.allowance);
    if (spoken) await speak(r.answer || '');
  } catch (e) { setStatus('error: ' + e.message); }
  finally { traceIslandEnd(); try { pendantES && pendantES.close(); } catch {} pendantLive = false; if (pendant) pendant.finish(); setStatus(on ? 'listening…' : ''); }
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
  if (r.exhausted) { const p = stalledTurnFromTx(); if (p) renderExhausted({ ...p.payload, invited: !!r.invited }, false); return; }
  renderAgentResponse(r);
  pushTx('agent', r.answer || '', { tools: r.toolsUsed || [], images: r.images || [], imageUrls: r.imageUrls || [], steps: r.steps || [], agent: r.agentId, ui: r.ui || [], objects: r.objects || [] });
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
        if (sid !== sessionId) { traceIslandEnd(); try { pendantES && pendantES.close(); } catch {} pendantLive = false; return false; } // navigated away — stop the live trace; pick it up next time
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
  // `payload.invited` = this user's credit came CARRIED ON AN INVITE (a conserved allowance the inviter
  // funded) — say so, and make "buy your own" the legible next step (User Agency: the top-up storefront).
  const blurb = isRoot ? 'This conversation has used up its budget. Top it up to keep going, or abandon the thread.'
    : payload.invited ? 'The usage credit that came with your invite is used up. From here you buy your own — top up below and your stalled message resumes automatically.'
    : 'You\'ve used up the credit you were given. Add more to keep going — or abandon the thread.';
  const title = isRoot ? 'Out of inference allowance' : 'Allowance exhausted — top up to continue';
  card.innerHTML = `<div class="ptitle">🪙 <span>${title}</span></div><div class="pmeta">${blurb}</div><div class="pbtns"></div>`;
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
    let s; try { s = await (await fetch('/pay/delegation/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: chatCap(), sessionId }) })).json(); if (!s.available) return; } catch { return; }
    const mm = document.createElement('button'); mm.className = 'confirm'; mm.textContent = s.subscribed ? '⛓️ Top up from your subscription' : '⛓️ Subscribe with MetaMask';
    mm.onclick = async () => {
      mm.disabled = true;
      try {
        // Grant the recurring allowance once (skip if already subscribed), then draw a top-up + resume.
        if (!s.subscribed) { const g = await grantMetaMaskSubscription({ periodUsd: 10, periodDays: 30, grantParams: s.grant }); if (!g.ok) throw new Error(g.error); }
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
const showImage = src => { showModal('<div id="imgview"></div>'); const v = $('imgview'); if (v) { const img = document.createElement('img'); img.src = src; img.style.cssText = 'max-width:86vw;max-height:80vh;border-radius:8px;display:block'; v.appendChild(img); const ip = document.createElement('button'); ip.className = 'mini'; ip.textContent = '🖌 Inpaint'; ip.style.cssText = 'margin-top:10px;background:var(--acc,#7c5cff);color:#fff;border:0;font-weight:600'; ip.onclick = () => { closeModal(); window.__openInpaint(src); }; v.appendChild(ip); } };
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
// ERC-7715 SUBSCRIPTION: ask the wallet for a RECURRING (periodic) spending allowance — granted ONCE, then the
// server auto-draws from it to keep this user's purse funded (inference + hosting) without a manual payment each
// time. Returns {ok} | {ok:false,error}. The signed grant (permissions context) is opaque + forwarded — never
// parsed, rendered, or persisted here; no key touches the page.
// `grantParams` = {to, signer, chainId, weiPerUsd} from /pay/delegation/status. The 7715 `to` (delegate)
// must be the settlement delegate that redeems — the old raw wallet_grantPermissions call here named no
// delegate at all, so the wallet's grant (when it granted anything) was unredeemable by our charge-server.
const grantMetaMaskSubscription = async ({ periodUsd = 10, periodDays = 30, grantParams = null } = {}) => {
  const eth = window.ethereum;
  if (!eth || !eth.request) return { ok: false, error: 'No Ethereum wallet found — install MetaMask (advanced permissions).' };
  let gp = grantParams;
  if (!gp) { try { gp = (await (await fetch('/pay/delegation/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: chatCap(), sessionId }) })).json()).grant; } catch {} }
  const delegate = gp && (gp.to || gp.signer); // `to` (current shape); `signer` = older servers' name for it
  if (!gp || !delegate || !gp.chainId || !gp.weiPerUsd) return { ok: false, error: 'On-chain payments aren\'t fully set up (settlement service unreachable).' };
  const periodDuration = Math.max(1, periodDays) * 86400;
  const startTime = Math.floor(Date.now() / 1000);
  const periodAmount = '0x' + (BigInt(gp.weiPerUsd) * BigInt(Math.max(1, Math.round(periodUsd)))).toString(16); // the $ period cap, in wei
  let grants;
  try {
    // ERC-7715 as CURRENT MetaMask Flask (13.x) validates it — empirically verified against real Flask
    // 13.25/13.31/13.37 (wallet-e2e probe-schema, 2026-07-01): `to` = the delegate address (the old
    // signer:{type:'account',…} object is now rejected -32602), permission carries isAdjustmentAllowed,
    // rule entries are exactly {type, data} (rule-level isAdjustmentAllowed also rejected). The wallet
    // returns an opaque signed permissions context that only `to` (the settlement delegate) can redeem
    // via ERC-7710. NOTE the chain must be on MetaMask's remote 7715 allowlist — Sepolia is, Linea
    // Sepolia is NOT (-32004); the server-vended gp.chainId decides.
    grants = await eth.request({ method: 'wallet_requestExecutionPermissions', params: [{
      chainId: gp.chainId,
      to: delegate,
      permission: { type: 'native-token-periodic', isAdjustmentAllowed: true,
        data: { periodAmount, periodDuration, startTime, justification: `Agent C subscription — up to $${periodUsd} per ${periodDays} days, drawn automatically to keep your credit topped up` } },
      rules: [{ type: 'expiry', data: { timestamp: startTime + periodDuration + 86400 } }], // outlive one period
    }] });
  } catch (e) { return { ok: false, error: 'Your wallet declined or lacks ERC-7715 recurring permissions (MetaMask Flask). ' + (e.message || '') }; }
  const grant = Array.isArray(grants) ? grants[0] : grants;
  if (!grant || !(grant.context || grant.permissionsContext)) return { ok: false, error: 'The wallet returned no permissions context — grant not usable.' };
  try {
    const r = await (await fetch('/pay/delegation/grant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: chatCap(), sessionId, delegation: grant, subscription: { periodUsd, periodDays } }) })).json();
    return r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || 'grant failed' };
  } catch (e) { return { ok: false, error: e.message }; }
};
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
    m.innerHTML = `<div class="consent" data-trusted-path role="dialog" aria-label="Approve this chat’s powers">
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
  const t = (text || '').trim();
  // Fold any pasted-link cards for this chat into the AGENT-FACING text (the visible bubble stays `t`; the
  // link also shows as its widget card). Consumed once. Lets a link-only message (empty `t`) still send.
  const sharedLinks = (pendingSharedLinks[sessionId] || []).slice();
  const cvNote = customViewTaskNote(pendingCustomView[sessionId]); // a pending custom-view task (kind/methods/sample/source)
  const widgetNote = pendingWidgetRef[sessionId] || ''; // a widget the user tapped the chat-tail on (folded as context)
  const agentText = (t
    + (sharedLinks.length ? `${t ? '\n\n' : ''}${sharedLinks.map(u => `[link the user shared in chat: ${u}]`).join('\n')}` : '')
    + (cvNote ? `${t || sharedLinks.length ? '\n\n' : ''}${cvNote}` : '')
    + (widgetNote ? `${t || sharedLinks.length || cvNote ? '\n\n' : ''}${widgetNote}` : '')).trim();
  if ((!agentText && !attachments.length) || busy) return false;
  delete pendingSharedLinks[sessionId]; // consumed
  delete pendingCustomView[sessionId]; // consumed
  delete pendingWidgetRef[sessionId]; // consumed
  busy = true; if (sendBtn) sendBtn.disabled = true;
  const myTurn = ++turn; const stale = () => myTurn !== turn;
  let ok = false;
  // Once the user bubble is rendered + pushed, the message IS SENT — a later turn error / gateway timeout /
  // resume must NOT cause the composer to re-insert the (already-sent) text. `committed` gates that: the
  // caller (doSend) only restores text when sendChat returns false, and we return false ONLY pre-commit.
  let committed = false;
  // EVERYTHING runs inside try/finally so `busy` + the send button can NEVER get wedged:
  // a throw, a stale turn, or a mic toggle mid-send always releases the composer.
  try {
    // Feature B: posting INTO a shared chat → /share/post (the agent runs under the chat's confined
    // cap; metered against the share's allowance). No scoping gate / no /chat here.
    const activeChat = chats.find(c => c.id === sessionId);
    if (activeChat && activeChat.shareToken) {
      if (activeChat.shareMode !== 'write') { setStatus('this is a read-only shared chat'); return false; }
      renderUserBubble(t, attachments); document.body.classList.remove('landing'); activeTx.push({ who: 'you', text: t, at: Date.now() }); saveTx(); committed = true; setStatus('thinking…');
      let r; try { r = await (await fetch('/share/post', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: activeChat.shareToken, text: agentText }) })).json(); } catch (e) { r = { error: e.message }; }
      if (stale()) return true;
      if (r.error) { setStatus('share: ' + r.error); return true; } // committed → don't re-insert the sent text
      if (r.exhausted) { renderAgentResponse({ answer: 'The shared spend allowance for this chat is used up.' }); pushTx('agent', '(allowance spent)'); setStatus(''); ok = true; return true; }
      renderAgentResponse(r); pushTx('agent', r.answer || '', { tools: r.toolsUsed || [], images: r.images || [], imageUrls: r.imageUrls || [], ui: r.ui || [], objects: r.objects || [] }); setStatus(''); ok = true;
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
        sc = await scopeChat(agentText || (attachments[0] && attachments[0].name) || 'this task');
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
    activeTx.push(tx); saveTx(); committed = true; // message is now SENT — never re-insert its text into the composer
    { const cc = chats.find(c => c.id === sessionId); if (cc) { cc.lastMsgAt = Date.now(); saveChats(); } } // baseline for the in-chat run indicator ("since your last message")
    try { userBubbleControls(activeTx.length - 1, tx, ub); } catch { /* control row: ↻ retry / ✎ edit / 🔊 audio — appears live INSIDE the bubble */ }
    titleFrom(t || (attachments[0] && attachments[0].name) || 'photo'); setStatus('thinking…'); if (spoken) setMic('thinking');
    await pendantBegin(t); // descend the live 3D pendant + open the step stream BEFORE the turn starts
    const payload = { sessionId, text: agentText, cap: chatCap(), model: model || chatModel(), agent: chatAgent() }; // agentText = typed text + any pasted-link references; chatCap() = this chat's CONFINED cap (Feature A); agent = run AS this entrypoint specialist (server confines)
    // Send the DURABLE transcript as history so the agent's memory of this chat survives a server
    // restart (the server's in-memory history is volatile + wiped on restart). Exclude the current
    // user turn (just pushed above) — the server appends it from `text`. Plain text per turn.
    payload.history = buildHistory(activeTx.slice(0, -1), payload.model); // folds prior tool OUTPUTS in (kept long for large models) → the agent reuses what it fetched
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
    if (r.error) { if (r.retryable || r.llmError) { renderRetryableError(r.error, payload, spoken); ok = true; return true; } setStatus('chat: ' + r.error); return true; } // committed → don't re-insert the sent text (retry via the bubble's ↻)
    // prepaid allowance spent — server refused WITHOUT a model call. Static Top-up/Abandon card.
    if (r.exhausted) { updateBudgetChip(r.remaining, r.allowance); renderExhausted(payload, spoken); ok = true; return true; }
    // durable server URLs for the attached images → persist these (survive reload + cross-device sync)
    const urls = (r.attachments || []).filter(a => a.kind === 'image' && a.url).map(a => a.url);
    if (urls.length) { tx.attachUrls = urls; saveTx(); }
    renderAgentResponse(r); pushTx('agent', r.answer || '', { tools: r.toolsUsed || [], images: r.images || [], imageUrls: r.imageUrls || [], steps: r.steps || [], agent: r.agentId, ui: r.ui || [], objects: r.objects || [], vmodel: payload.model, vagent: payload.agent }); // ui = widget specs; vmodel/vagent = the params of this attempt (fork 0) for W2 fork/retry
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
        // Two cases land here, and BOTH want a RE-ATTACH, not a blind re-run:
        //  (a) gateway-timeout — a long turn (e.g. Opus) outlived the PUBLIC PROXY's request window, but it is
        //      STILL RUNNING (or already finished) server-side. Re-running it would just hit the same proxy
        //      timeout again AND abort the in-flight run — so the completed answer never renders (the "long
        //      Opus voice-note never comes back" stall).
        //  (b) the connection genuinely dropped (server restart) — the server may have no record.
        // reattachRun handles both: it renders a finished result, POLLS a still-running one to completion, and
        // falls back to a reconstruct+re-run ONLY when the server truly has no record (rr.state === 'none').
        // Don't persist a dead agent turn — leave the user turn unanswered so re-attach/auto-resume can heal it.
        setStatus('⏳ still working on the server — reattaching (safe to leave; the answer will land here)…'); try { pendantEnd([]); } catch {}
        const sidAtDrop = sessionId;
        setTimeout(() => { if (!busy && sessionId === sidAtDrop) reattachRun(sidAtDrop).catch(() => {}); }, 1800);
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
    traceIslandEnd(); try { pendantES && pendantES.close(); } catch {} pendantLive = false; if (pendant) pendant.finish(); // never leave the step stream / trace-cell stream open
    if (queuedSend) setTimeout(flushQueued, 0); // a message typed mid-turn was queued → send it now the turn is done
  }
  // committed → the message was sent (a post-commit error/timeout is shown in-band; the user turn stays + is
  // retryable via the bubble's ↻). Returning truthy here stops doSend from re-inserting the sent text.
  return committed || ok;
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
// ⏹ STOP — interrupt a running agentic turn and drop straight into refining the prompt. Aborts the turn
// server-side (/cancel → the reasoning loop sees signal.aborted at its next step), supersedes it locally so
// the half-finished answer is discarded, then opens the inline editor on the last prompt (Save & retry
// forks a fresh branch with the edited prompt). This is the "the agent went the wrong way — stop + redirect"
// control. (Typing while busy still INTERJECTS to re-steer without aborting — a softer nudge.)
const stopTurn = () => {
  if (!busy) return;
  fetch('/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }) }).catch(() => {});
  turn += 1; // supersede the in-flight turn → stale() discards its (aborted) response
  busy = false; if (sendBtn) sendBtn.disabled = false;
  try { pendant && pendant.finish(); } catch {}
  setStatus('⏹ stopped — refine your prompt and resend');
  let uIx = -1; for (let i = activeTx.length - 1; i >= 0; i--) { if (activeTx[i] && activeTx[i].who === 'you') { uIx = i; break; } }
  // defer to the next tick so any synchronous re-render from the abort settles before we open the editor
  if (uIx >= 0) setTimeout(() => { const bubs = log.querySelectorAll('.msg.user'); const bub = bubs[bubs.length - 1]; if (bub && !bub.querySelector('.msg-edit')) editPrompt(uIx, bub); }, 0);
};
if (sendBtn && !$('stop')) {
  const stopBtn = document.createElement('button'); stopBtn.id = 'stop'; stopBtn.type = 'button'; stopBtn.textContent = '⏹';
  stopBtn.title = 'Stop the agent + edit your prompt'; stopBtn.setAttribute('aria-label', 'Stop the agent and edit your prompt');
  stopBtn.style.cssText = 'display:none;background:var(--bad,#cf5a3a);color:#fff;border:none;border-radius:9px;cursor:pointer;font-size:14px;line-height:1;padding:0 11px;align-self:stretch';
  stopBtn.onclick = stopTurn;
  sendBtn.parentNode.insertBefore(stopBtn, sendBtn); // sits just left of Send
  let stopShown = false; // cheap sync to `busy` (the flag is toggled from many turn paths; avoid threading a setter through all)
  setInterval(() => { const want = !!busy; if (want !== stopShown) { stopShown = want; stopBtn.style.display = want ? '' : 'none'; } }, 200);
}
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
  $('specialists-list').innerHTML = specs.map((s, i) => `<div class="share"><div><b>${esc(s.name)}</b> <span class="pill">${esc(s.domain || '')}${s.powers && s.powers.length ? ' · ' + esc(s.powers.join(', ')) : ''}${s.autonomy && s.autonomy.length ? ' · auto: ' + esc(s.autonomy.join(', ')) : ''}</span></div><div><button class="mini" data-edit="${i}">✏️ edit</button> <button class="mini bad" data-retire="${i}">retire</button></div></div>`).join('');
  document.querySelectorAll('#specialists-list [data-edit]').forEach(b => { b.onclick = () => openAgentEditor(specs[+b.dataset.edit].id); });
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
  if (heldPowers.has('objects')) r.push({ ns: 'objects', label: 'Objects', sub: 'inventory' });
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
  // file-system feel: the WHOLE row is clickable — a folder drills in, a leaf opens (renderNav shows a note's
  // text / a contact's or entity's detail). The share buttons live on the row but stopPropagation so they
  // don't also trigger the open. A › affordance signals "click to open".
  $('obj-list').innerHTML = shown.length ? shown.map((k, i) => `<div class="share obj-row" data-row="${i}" style="cursor:pointer"><div>${k.leaf ? '📄 ' : '📂 '}<b>${esc(k.label)}</b> <span class="pill">${esc(k.sub || '')}</span></div><div class="kit-rowx" style="gap:5px;align-items:center">${shareBtns(k, i)}<span style="color:var(--mut);font-size:16px;line-height:1">›</span></div></div>`).join('') : '<div class="pill">(nothing here)</div>';
  document.querySelectorAll('#obj-list .obj-row').forEach(r => { r.onclick = () => { const k = shown[+r.dataset.row]; navGo([...navStack, { ns: k.root ? k.ns : loc.ns, handle: k.root ? null : k.handle, label: k.label, leaf: !!k.leaf, kind: k.kind }]); }; });
  document.querySelectorAll('#obj-list [data-shro]').forEach(b => { b.onclick = e => { e.stopPropagation(); const k = shown[+b.dataset.shro]; mintNode(loc.ns, k.handle, k.label, true); }; });
  document.querySelectorAll('#obj-list [data-shfull]').forEach(b => { b.onclick = e => { e.stopPropagation(); const k = shown[+b.dataset.shfull]; mintNode(loc.ns, k.handle, k.label, false); }; });
};
// the blossom KIND for a navigator leaf — all contacts share one renderer, all agents another, HA entities
// keyed by domain (lights vs locks differ). This is what makes the inspector/blossom work on ANY leaf.
const blossomKindFor = (ns, n) => { if (ns === 'contacts') return 'contact'; if (ns === 'agents') return 'agent'; if (ns === 'ha') { const eid = n && n.entity_id; return eid ? `ha:${String(eid).split('.')[0]}` : 'ha-entity'; } return `${ns}${n && n.kind ? `:${n.kind}` : ''}`; };
// append a custom-view affordance to a leaf's detail: render a ready renderer inline (props.value = the
// leaf's data), and a 🎨 Generate/Revise button that grants this KIND's custom view to a chat (the agent authors/revises it).
const appendLeafBlossom = async (kind, name, data) => {
  const node = $('obj-node'); if (!node) return;
  const bf = (p, b) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json()).catch(() => null);
  const wrap = document.createElement('div'); wrap.style.cssText = 'margin-top:10px;border-top:1px solid var(--edge);padding-top:8px';
  const r = await bf('/blossom/for', { cap, methods: [], kind }); const e = r && r.entry;
  if (e && e.status === 'ready' && e.forkId) { const s = await bf('/blossom/source', { cap, sig: e.sig }); if (s && s.ok && window.__fieldIslands && window.__fieldIslands.renderSource) { const view = document.createElement('div'); view.style.cssText = 'margin-bottom:8px'; wrap.appendChild(view); window.__fieldIslands.renderSource(s.source, view, { value: data, name, kind }); } }
  const btn = document.createElement('button'); btn.className = 'mini'; btn.textContent = (e && e.status === 'ready') ? '🎨 Revise the custom view' : '🎨 Generate a custom view';
  btn.onclick = () => requestCustomView({ name, kind, methods: [], data, callable: false });
  wrap.appendChild(btn); node.appendChild(wrap);
};
window.appendLeafBlossom = appendLeafBlossom; window.blossomKindFor = blossomKindFor; // staging hooks
const renderNav = async () => {
  const loc = navStack[navStack.length - 1];
  $('obj-crumbs').innerHTML = ['<a href="#" data-crumb="-1">Home</a>'].concat(navStack.map((l, i) => `<a href="#" data-crumb="${i}">${esc(l.label)}</a>`)).join(' › ');
  document.querySelectorAll('#obj-crumbs [data-crumb]').forEach(a => { a.onclick = e => { e.preventDefault(); navGo(navStack.slice(0, +a.dataset.crumb + 1)); }; });
  $('obj-filter').value = '';
  if (!loc) { navNode = null; $('obj-node').innerHTML = '<div class="pmeta">Choose a tree to browse:</div>'; renderNavList(); return; }
  // CLICK INTO A TEXT DOCUMENT: a note leaf → show its content (treeRpc would try to readdir a file and fail).
  if (loc.leaf && loc.ns === 'notes') {
    navNode = null; $('obj-list').innerHTML = '';
    let nc; try { nc = await rpc('noteContent', [loc.handle]); } catch (e) { $('obj-node').innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
    $('obj-node').innerHTML = `<div class="kv" style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span><b>📄 ${esc(nc.name)}</b></span><button class="mini" id="sh-note">🔗 share</button></div><pre style="white-space:pre-wrap;word-break:break-word;max-height:62vh;overflow:auto;background:var(--panel);border:1px solid var(--edge);border-radius:7px;padding:10px;font-size:13px;margin-top:8px">${esc(nc.text || '')}</pre>`;
    const sb = $('sh-note'); if (sb) sb.onclick = () => mintNode('notes', loc.handle, nc.name, true);
    return;
  }
  if (loc.ns === 'objects') { // the inventory of accepted live capabilities — click one → the inspector (+ blossom) INLINE
    navNode = null;
    let objs = []; try { objs = await rpc('objectsList', []); } catch (e) { $('obj-node').innerHTML = `<div class="err">${esc(e.message)}</div>`; $('obj-list').innerHTML = ''; return; }
    $('obj-node').innerHTML = `<div class="kv"><b>📦 Inventory objects</b> <span class="pill">${objs.length}</span></div><div class="pmeta" style="margin:4px 0 2px">live capabilities you've accepted — click one to inspect, call its methods, and generate a custom view.</div>`;
    $('obj-list').innerHTML = objs.length ? objs.map((o, i) => `<div class="share obj-obj" data-i="${i}" style="cursor:pointer"><div>🔬 <b>${esc(o.name)}</b> <span class="pill">${esc(o.transport)}</span></div>${o.description ? `<div style="font-size:11px;color:var(--mut)">${esc(o.description)}</div>` : ''}</div>`).join('') : '<div class="pill">none yet — accept an Endo invite link</div>';
    // the LIST stays in obj-list (so you can switch objects); the inspector + blossom UI renders in obj-node (the detail pane)
    document.querySelectorAll('#obj-list .obj-obj').forEach(el => { el.onclick = () => { document.querySelectorAll('#obj-list .obj-obj').forEach(x => x.classList.remove('on')); el.classList.add('on'); objectInspector(objs[+el.dataset.i].name, { mount: $('obj-node') }); }; });
    return;
  }
  if (loc.leaf && loc.ns === 'home') { // a home-folder FILE leaf — viewing/editing lives in the Files app
    navNode = null; $('obj-list').innerHTML = '';
    $('obj-node').innerHTML = `<div class="kv"><b>📄 ${esc(loc.label)}</b></div><div class="pmeta" style="margin-top:6px">Open the <b>Files</b> app (Settings → 📂 Files) to view or edit this file.</div>`;
    return;
  }
  let n; try { n = await treeRpc(loc.ns, loc.handle); } catch (e) { $('obj-node').innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  navNode = n;
  const curName = n.name || n.entity_id || n.label || (loc.ns === 'ha' ? 'Home Assistant' : 'Agents');
  if (loc.ns === 'contacts') { // contact view — a single contact can be SHARED as a read-only granule
    if (n.kind === 'contacts') { $('obj-node').innerHTML = `<div class="kv"><b>👥 Contacts</b> <span class="pill">${(n.children || []).length}</span></div>`; }
    else {
      const det = [n.org && `🏢 ${n.org}`, ...(n.emails || []).map(e => `✉️ ${e}`), ...(n.tels || []).map(t => `📞 ${t}`), n.note && `📝 ${n.note}`].filter(Boolean);
      $('obj-node').innerHTML = `<div class="kv" style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span><b>👤 ${esc(curName)}</b></span><button class="mini" id="sh-contact">🔗 share this contact</button></div>${det.length ? `<div style="font-size:13px;margin-top:6px;white-space:pre-wrap">${det.map(esc).join('<br>')}</div>` : '<div class="pmeta">contact</div>'}`;
      const sb = $('sh-contact'); if (sb) sb.onclick = () => mintNode('contacts', n.handle, curName, true);
      appendLeafBlossom('contact', curName, n); // a contact is blossomable too
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
  if (loc.leaf) appendLeafBlossom(blossomKindFor(loc.ns, n), curName, n); // any LEAF (an HA entity, an agent, …) is inspectable + blossomable
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
// ── LIVE inbound-capture rows: FOLLOW the seeds:<owner> propagator cell over the one /cells/subscribe
//    broker (owner-gated server-side — a non-owner just never sees any). The /ingest pipeline PUSHES a
//    stage on every transition (received → understanding → proposed), so a voice note appears in the chats
//    list the instant it arrives and advances while it's analyzed — no polling. `self` resolves server-side
//    to THIS cap's own owner key (no key in the request → cap-hygiene). When a capture reaches proposed/done
//    its seed-chat has landed, so we pull it via loadSeedChats and the in-flight row dedupes away.
let inflightSeeds = []; // [{ id, title?, stage, at, chatId? }] — the current seeds:self cell value
let seedCellAbort = null;
const STAGE_LABEL = { received: '🎙️ received…', transcribing: '🎙️ transcribing…', understanding: '🧠 understanding…', proposed: '✍️ proposing…', done: '✓ ready' };
const subscribeSeedCells = async () => {
  if (!cap || seedCellAbort) return; // one stream for the life of the tab
  seedCellAbort = new AbortController();
  try {
    const res = await fetch('/cells/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, cells: ['seeds:self'] }), signal: seedCellAbort.signal });
    if (!res.ok || !res.body) { seedCellAbort = null; return; }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = block.split('\n').find(l => l.startsWith('data:')); if (!line) continue;
        try {
          const m = JSON.parse(line.slice(5).trim());
          if (m && !m.error && Array.isArray(m.value)) {
            inflightSeeds = m.value;
            // a capture that reached proposed/done has a real seed-chat now — adopt it promptly so the
            // in-flight row resolves into the normal row (loadSeedChats dedupes; then it drops out here).
            if (inflightSeeds.some(c => (c.stage === 'proposed' || c.stage === 'done') && c.chatId && !chats.some(x => x.id === c.chatId))) loadSeedChats();
            renderChatItems();
          }
        } catch { /* ignore malformed frame */ }
      }
    }
  } catch { /* aborted / no cap → no live rows (the finished seed-chat still lands via loadSeedChats) */ }
  seedCellAbort = null;
};
// in-flight rows to SHOW: still processing (no seed-chat adopted yet). Dedupe against adopted chats +
// loaded seed-chats so a capture never renders twice once its real row has landed.
const visibleInflightSeeds = () => inflightSeeds.filter(c => !c.chatId || (!chats.some(x => x.id === c.chatId) && !seedChats.some(s => s.id === c.chatId)));
const inflightRowHtml = c => `<div class="chat-item inflight" data-inflight="${esc(c.id)}"><span class="ci-spin"></span><span class="ci-title">${esc(c.title || '')}<span class="ci-stage">${esc(STAGE_LABEL[c.stage] || c.stage)}</span></span></div>`;
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
  { id: 'anthropic:claude-fable-5',    name: 'Claude Fable',  cost: '$$$$', size: 'XL', speed: '⚡' },
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
  showModal(`<div class="qrlabel">↻ Re-run "${esc(r.title)}" under changed instructions</div><span class="qrwarn">Edit the agent's instructions, then re-run the same transcript to see how the trace changes.</span><textarea id="rr-persona" rows="5" style="width:340px;max-width:84vw" placeholder="(agent instructions — blank = default)">${esc(cur.persona || '')}</textarea><div id="rr-status" class="pill"></div><button class="mini" id="rr-go">Re-run</button>${r.scheduled && r.scheduled.agent ? ` <button class="mini" id="rr-config">⚙️ Edit this agent's full config →</button>` : ''}`);
  // a scheduled run's "change environment" → the rich per-agent Detail (editable prompt/powers/model/mode
  // + the assembled-toolbox context view). Resolve the sched agent by its project+name (the seed-chat
  // carries names, never a cap), then open its Detail card.
  { const rc = $('rr-config'); if (rc) rc.onclick = async () => {
    const d = await pf('/projects/list'); const pr = (d.projects || []).find(x => x.name === r.scheduled.project);
    const ag = pr && (pr.scheduledAgents || []).find(x => x.name === r.scheduled.agent);
    if (ag) { closeModal(); openProjectId = pr.id; renderProjects(ag.id); }
    else setStatus('couldn\'t find that scheduled agent — open it from 🕐 Projects');
  }; }
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
  chats = [...byId.values()].filter(c => !deletedIds.has(c.id)).sort((a, c) => ((c.lastMsgAt || c.ts) || 0) - ((a.lastMsgAt || a.ts) || 0)); // most recent activity first
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
const pushTx = (who, text, extra = {}) => { activeTx.push({ who, text, at: Date.now(), ...extra }); saveTx(); const cc = chats.find(c => c.id === sessionId); if (cc) { cc.lastMsgAt = Date.now(); saveChats(); renderChatList(); } }; // any message (you/agent/widget) bumps the chat's recency → sidebar re-sorts

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
  const st = { root: (roots[0] && roots[0].key) || 'vault', path: '', entries: [], file: null, busy: false, error: '', editing: false, draft: '', dirty: false };
  const rel = n => (st.path ? `${st.path}/${n}` : n);
  const draw = () => { if (window.__fieldIslands && window.__fieldIslands.renderInto) window.__fieldIslands.renderInto('FileBrowser', el, { roots, root: st.root, path: st.path, entries: st.entries, file: st.file, busy: st.busy, error: st.error, editing: st.editing, draft: st.draft, dirty: st.dirty, onRoot, onOpen, onCrumb, onAdd, onDownload, onRemove, onCloseFile, onToggleEdit, onEdit, onSave }); };
  const list = async () => { st.busy = true; st.error = ''; st.file = null; st.editing = false; draw(); const r = await apf('/files/list', { root: st.root, path: st.path }); st.busy = false; if (r.error) { st.error = r.error; st.entries = []; } else st.entries = r.entries || []; draw(); };
  const onRoot = k => { st.root = k; st.path = ''; st.file = null; list(); };
  const onCrumb = i => { const s = st.path.split('/').filter(Boolean); st.path = i < 0 ? '' : s.slice(0, i + 1).join('/'); st.file = null; list(); };
  const onOpen = async (n, isDir) => { if (isDir) { st.path = rel(n); list(); return; } st.busy = true; st.editing = false; draw(); const r = await apf('/files/get', { root: st.root, path: rel(n) }); st.busy = false; if (r.error) st.error = r.error; else st.file = { name: r.name, text: r.text, size: r.size, b64: r.b64 }; draw(); };
  const onCloseFile = () => { st.file = null; st.editing = false; draw(); };
  const onToggleEdit = () => { if (!st.file || st.file.text == null) return; st.editing = !st.editing; if (st.editing) { st.draft = st.file.text; st.dirty = false; } draw(); };
  const onEdit = text => { st.draft = text; st.dirty = text !== (st.file && st.file.text); draw(); };
  const onSave = async () => { if (!st.file || !st.dirty) return; st.busy = true; draw(); const b64 = await fileToB64(new Blob([st.draft], { type: 'text/plain' })); const r = await apf('/files/put', { root: st.root, path: rel(st.file.name), b64 }); st.busy = false; if (r.error) st.error = r.error; else { st.file = { ...st.file, text: st.draft }; st.dirty = false; } draw(); };
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
// 🎨 CUSTOM VIEW — the chat IS the studio. Instead of a bespoke generate/revise widget, we GRANT the custom
// view (the renderer component) to a chat and let the NORMAL chat agent author/revise it — visible in the
// normal trace, because it's a normal agent. requestCustomView seeds that turn: it mounts the live component
// into the chat (so you can see it) and hands the agent a structured task (kind / methods / sample / current
// source) via pendingCustomView, which sendChat folds into the agent-facing text. The agent writes the
// (endowments,props)=>vnode and registers it with the `customView` tool.
const requestCustomView = async (spec) => {
  const s = typeof spec === 'string' ? { name: spec, kind: 'object', methods: [], callable: true } : spec;
  const name = s.name; const kind = s.kind || 'object'; const methods = s.methods || []; const callable = s.callable !== false;
  const bf = (p, b) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json()).catch(() => null);
  // resolve a sample of the object's data (props.value) so the agent renders the REAL shape
  let sample = s.data;
  if (sample === undefined && callable) { try { const r = await rpc('objectCall', [name, methods.includes('describe') ? 'describe' : methods[0], []]); sample = r && r.value; } catch { /* */ } }
  if (sample === undefined) sample = { name, kind };
  // is there already a renderer for this kind? → this is a REVISE; fetch its source so the agent iterates it
  const forR = await bf('/blossom/for', { cap: chatCap(), methods, kind }); const e = forR && forR.entry;
  let current = null; if (e && e.status === 'ready' && e.sig) { const sr = await bf('/blossom/source', { cap: chatCap(), sig: e.sig }); if (sr && sr.ok) current = sr.source; }
  const revising = !!current;
  // open a focused chat, grant it the live component, stash the task
  newChat();
  if (!chats.some(c => c.id === sessionId)) { chats.unshift({ id: sessionId, title: `🎨 ${name} view`, ts: Date.now(), lastMsgAt: Date.now() }); saveChats(); }
  pushTx('widget', '', { customview: { name, kind, methods, sample, callable } });
  pendingCustomView[sessionId] = { name, kind, methods, sample, current };
  document.body.classList.remove('landing'); showTab('talk'); renderTx(); renderChatList();
  if (revising) { const input = $('text'); if (input) { input.value = `Revise the custom view for the ${kind} "${name}": `; input.focus(); try { input.setSelectionRange(input.value.length, input.value.length); } catch {} } }
  else { await sendChat(`Create a custom view for "${name}" (a ${kind}).`); }
};
window.requestCustomView = requestCustomView;
// Fold a pending custom-view task into the agent-facing text (visible bubble unchanged): the structured spec
// the agent needs to author/revise the renderer + call the customView tool. Consumed once.
const customViewTaskNote = ctx => {
  if (!ctx) return '';
  let sample = ''; try { sample = JSON.stringify(ctx.sample); } catch { sample = String(ctx.sample); }
  if (sample && sample.length > 1500) sample = sample.slice(0, 1500) + '…';
  return [
    `[custom-view task — author${ctx.current ? ' (revise)' : ''} a CONFINED renderer for this object, then register it with the customView tool.`,
    `  kind: ${JSON.stringify(ctx.kind || 'object')}`,
    `  objectName: ${JSON.stringify(ctx.name || 'object')}`,
    `  methods: ${JSON.stringify(ctx.methods || [])}   (props.methods you may props.call; [] = a data-only leaf keyed by kind)`,
    `  sample (props.value): ${sample}`,
    ctx.current ? `  current renderer source to REVISE (iterate this, don't rewrite from scratch):\n\`\`\`js\n${ctx.current}\n\`\`\`` : '',
    `  → write the (endowments,props)=>vnode, then call customView({ kind, methods, objectName, source }).]`,
  ].filter(Boolean).join('\n');
};
// mountCustomView(el, cv) — render the live custom view (the component granted to this chat) fed its sample
// data. Read-only display; the AGENT revises it (the chat is the studio). Re-renders on each renderTx, so it
// picks up the agent's newly-registered/revised renderer automatically.
const mountCustomView = async (el, cv) => {
  const bf = (p, b) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json()).catch(() => null);
  el.innerHTML = '<div class="pmeta">🌱 the agent is authoring this view…</div>';
  const r = await bf('/blossom/for', { cap: chatCap(), methods: cv.methods || [], kind: cv.kind || 'object' }); const e = r && r.entry;
  if (!e || e.status !== 'ready' || !e.sig) return; // not authored yet — stays as the placeholder until the next render
  const sr = await bf('/blossom/source', { cap: chatCap(), sig: e.sig }); if (!sr || !sr.ok) return;
  el.innerHTML = '';
  const props = { value: cv.sample, name: cv.name, kind: cv.kind, methods: cv.methods || [] };
  // The mediated handle is ATTENUATED to exactly the methods this view was granted: the confined component
  // can only invoke those (read-only by construction — a view handed only read methods cannot act). The
  // confined renderer holds nothing but this props.call, so scoping it here IS the component's authority boundary.
  if (cv.callable) props.call = async (m, args) => {
    const allowed = Array.isArray(cv.methods) ? cv.methods : [];
    if (allowed.length && !allowed.includes(m)) throw new Error(`this view holds a ${cv.kind || 'object'} handle scoped to: ${allowed.join(', ')} — not "${m}"`);
    const cr = await rpc('objectCall', [cv.name, m, Array.isArray(args) ? args : (args == null ? [] : [args])]); return cr && cr.value;
  };
  const ok = window.__fieldIslands && window.__fieldIslands.renderSource && window.__fieldIslands.renderSource(sr.source, el, props);
  if (!ok) el.innerHTML = '<div class="pmeta">This view renders once the confined runtime (lockdown) is on.</div>';
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

// Landing screen: an empty chat shows the WELCOME panel in normal content flow (above the docked
// composer) with a tagline; the first message hides it. Driven off the active tab + cap +
// whether the transcript is still empty, so it stays correct across chat switches/reloads.
const syncLanding = () => document.body.classList.toggle('landing', curTab === 'talk' && !!cap && !activeTx.length);
// The landing WELCOME panel is app chrome (chrome-welcome, a registry-backed confined component): the
// tagline + tappable starter suggestions. Live-editable via its edit chat (no rebuild, no reload).
// Fallback ladder: chrome-welcome → the tagline-hero island (the previous incarnation) → the static text.
const mountWelcome = () => {
  const el = $('composer-tagline'); if (!el) return;
  const prev = el.textContent;
  const fallbackIsland = () => {
    try { if (window.__fieldIslands && window.__fieldIslands.renderTaglineHero) { el.textContent = ''; window.__fieldIslands.renderTaglineHero(el); return; } } catch { /* fall through to static */ }
    try { el.textContent = prev || 'What can Agent C do for you?'; } catch { /* keep whatever is there */ }
  };
  chromeReady.then(() => {
    el.textContent = ''; // clear the static text node so the confined render isn't doubled
    const okw = mountChrome('chrome-welcome', el, {
      // the ONE affordance the welcome panel holds: put a starter prompt into the composer (never send).
      onSuggest: s => { const t = $('text'); if (!t) return; t.value = String(s || ''); t.focus(); try { t.setSelectionRange(t.value.length, t.value.length); } catch { /* */ } },
    });
    if (!okw) { el.textContent = prev; fallbackIsland(); }
  }).catch(fallbackIsland);
};
mountWelcome();

// Re-grant/revoke this chat's powers in place (banner + Add / ×). Root-only; recovers an orphaned cap.
const rescopeChat = async (cc, newPowers, notesFolder) => {
  const body = { swiss: cc.scopedCap || '', powers: newPowers, label: cc.title };
  if (notesFolder !== undefined) body.notesFolder = notesFolder; // least-authority notes scope (a vault subtree)
  const r = await pf('/chat/rescope', body);
  if (!r || r.error) { alert((r && r.error) || 'could not change powers'); return; }
  cc.scopedCap = r.scopedCap; cc.scopedPowers = r.powers; cc.notesFolder = r.notesFolder || undefined; saveChats();
  setStatus(r.recovered ? 'powers re-granted — chat recovered' : (r.notesFolder ? `notes scoped to ${r.notesFolder}` : 'powers updated'));
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
// An agent turn's TOP-LEVEL tool results only. CRITICAL: do NOT descend into `children` — those are a
// sub-agent's (delegate/specialist/research) INTERNAL tool calls, which are deliberately context-ISOLATED
// (the whole point of a sub-agent). The top-level step's `result` already IS the sub-agent's OUTPUT; that
// stays, its internals do not.
const stepResults = m => {
  const v = activeVariant(m); const steps = (Array.isArray(v.steps) && v.steps.length) ? v.steps : _arr(m.steps);
  return steps.map(s => { if (!s) return null; const res = String(s.result !== undefined ? s.result : (s.info || '')).trim(); return res ? { name: s.name || 'tool', call: String(s.call || s.detail || ''), result: res } : null; }).filter(Boolean);
};
// Build cross-turn history. FOLD each agent turn's TOP-LEVEL tool OUTPUTS into its message — so the agent
// remembers what it ALREADY retrieved (a note, a fetch, a search, a sub-agent's RETURNED result) and reuses
// it instead of re-running the same search/read every turn. Outputs stay until context is genuinely tight:
// for large-context models (Opus/Sonnet/…) the budget is huge, so they persist for a long time; only the
// small default model trims aggressively. Budget is spent NEWEST-first (recent retrievals stay full).
const buildHistory = (msgs, model = '') => {
  const big = !!model && !/^default$/i.test(model) && !/gemma|haiku|mini|tiny|small/i.test(model); // large-context → keep outputs long
  // Opus-class windows are ~1M tokens now; budgets are in CHARS (~4/token). Keep retrieved outputs
  // until the window is genuinely exhausted: ~750k chars (~190k tokens) leaves ample room for the
  // system prompt, toolbox, current turn, and the response. Small models stay tight.
  const totalBudget = big ? 750000 : 8000, perCap = big ? 120000 : 2000;
  const list = msgs.filter(m => m && (m.who === 'you' || m.who === 'agent')).slice(-24);
  const blocks = new Array(list.length).fill('');
  let budget = totalBudget;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i]; if (m.who !== 'agent' || budget <= 0) continue;
    const rs = stepResults(m); if (!rs.length) continue;
    const lines = [];
    for (const s of rs) { if (budget <= 0) break; let res = s.result; const cap = Math.min(perCap, budget); if (res.length > cap) res = res.slice(0, cap) + '…'; const call = s.call.replace(/\s+/g, ' ').trim().slice(0, 160); const head = call ? (call.startsWith(s.name) ? call : `${s.name}(${call})`) : s.name; const line = `• ${head} → ${res}`; budget -= line.length; lines.push(line); }
    if (lines.length) blocks[i] = `\n\n[results I already retrieved this turn — REUSE these; do NOT re-search/re-read the same source:\n${lines.join('\n')}\n]`;
  }
  return list.map((m, i) => ({ role: m.who === 'you' ? 'user' : 'assistant', content: String(m.who === 'you' ? (m.text || '') : (activeVariant(m).answer || m.text || '')) + blocks[i] })).filter(x => x.content.trim());
};
const histUpTo = uIx => buildHistory(activeTx.slice(0, uIx), chatModel());
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
// A propose-only sub-agent (voice-note ingest) → let dan READ the prompt the agent would run AND APPROVE it
// (approval = authorization). Shows the granted powers + a collapsible prompt; for older proposals that
// predate prompt-at-ingest, a one-tap generate (cached server-side after). "✅ Approve & run" grants exactly
// the proposed powers to THIS chat (mints a confined scoped cap) and runs the attenuated agent on the prompt.
const appendProposalPrompt = (parent, m) => {
  if (!m || (!m.proposedPrompt && !(Array.isArray(m.proposedPowers) && m.proposedPowers.length))) return;
  const powers = Array.isArray(m.proposedPowers) ? m.proposedPowers : [];
  const cc = chats.find(c => c.id === sessionId);
  const approved = !!(cc && Array.isArray(cc.scopedPowers) && cc.scopedPowers.length); // already granted → consumed
  const wrap = document.createElement('div'); wrap.style.cssText = 'margin-top:6px';
  wrap.setAttribute('data-trusted-path', ''); // "✅ Approve & run · grants …" grants powers + runs the agent = an authority decision → trusted path (explicit marker, never editable chrome)
  // resolve (generating + caching if needed) the proposed prompt; returns '' on failure
  const resolvePrompt = async () => {
    if (m.proposedPrompt) return m.proposedPrompt;
    const r = await pf('/seed-chats/gen-prompt', { id: sessionId });
    if (r && r.ok && r.prompt) { m.proposedPrompt = r.prompt; saveTx(); return r.prompt; }
    return '';
  };
  // ── prompt viewer (collapsible) ──
  const det = document.createElement('details'); det.style.cssText = 'border:1px solid var(--edge);border-radius:8px;padding:6px 10px;background:var(--panel)';
  const sum = document.createElement('summary'); sum.style.cssText = 'cursor:pointer;color:var(--acc);font-size:13px;list-style:none;user-select:none';
  sum.innerHTML = `🔍 View proposed agent prompt${powers.length ? ' &nbsp;' + powers.map(p => `<span class="pill" title="${esc(powerTip(p))}">${powerIcon(p)} ${esc(p)}</span>`).join('') : ''}`;
  const body = document.createElement('div'); body.style.cssText = 'margin-top:8px';
  det.append(sum, body);
  const fill = txt => { body.innerHTML = ''; const pre = document.createElement('pre'); pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--edge);border-radius:7px;padding:10px;font-size:12.5px;line-height:1.5;max-height:48vh;overflow:auto;margin:0;color:var(--ink)'; pre.textContent = txt; body.appendChild(pre); };
  if (m.proposedPrompt) { fill(m.proposedPrompt); }
  else {
    const gen = document.createElement('button'); gen.className = 'mini'; gen.textContent = '✨ Generate the proposed prompt';
    gen.onclick = async () => { gen.disabled = true; gen.textContent = '✨ generating…'; const p = await resolvePrompt(); if (p) fill(p); else { gen.disabled = false; gen.textContent = '⚠︎ retry'; } };
    const hint = document.createElement('div'); hint.className = 'pmeta'; hint.style.cssText = 'margin-bottom:6px'; hint.textContent = 'This proposal predates prompt-at-ingest — generate the exact instructions the sub-agent would run:';
    body.append(hint, gen);
  }
  // ── action row: approve (only while pending + root) + the viewer ──
  if (isRoot && !approved) {
    const actions = document.createElement('div'); actions.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px';
    const approve = document.createElement('button'); approve.className = 'mini';
    approve.style.cssText = 'background:var(--acc);color:#fff;border:none;font-weight:600';
    approve.textContent = powers.length ? `✅ Approve & run · grants ${powers.join(', ')}` : '✅ Approve & run';
    approve.title = 'Grant exactly these powers to this chat (a confined scoped cap) and run the agent on the proposed prompt';
    approve.onclick = async () => {
      approve.disabled = true; approve.textContent = '✅ approving…';
      const task = await resolvePrompt() || (runFor(sessionId) || {}).transcript || (activeTx[0] && activeTx[0].text) || '';
      if (powers.length) await rescopeChat(cc, powers); // grant exactly the proposed powers (mints a confined cap, re-renders)
      if (task) await sendChat(task); // run the now-attenuated agent on the reviewed instructions
    };
    actions.appendChild(approve);
    wrap.appendChild(actions);
  } else if (approved) {
    const note = document.createElement('div'); note.className = 'pmeta'; note.style.cssText = 'margin-bottom:6px'; note.textContent = '✅ approved — running with the granted powers above'; wrap.appendChild(note);
  }
  wrap.appendChild(det); parent.appendChild(wrap);
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
    const b = document.createElement('div'); b.className = 'powers-banner'; b.setAttribute('data-trusted-path', ''); let show = true; // power grant/revoke UI = trusted path (never editable chrome)
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
      if (m.who === 'widget' && m.customview) { // the COMPONENT granted to this chat: the live custom view the agent will author/revise (the chat IS the studio)
        const cv = m.customview; const wrap = document.createElement('div'); wrap.className = 'msg';
        wrap.innerHTML = `<div class="who">🎨 <span>${esc(cv.name)}</span> <span style="font-size:10px;color:var(--mut);opacity:.7;margin-left:6px">custom view · ${esc(cv.kind || 'object')}</span></div><div class="cv-mount" style="margin-top:4px;border:1px solid var(--edge);border-radius:8px;padding:10px;min-height:40px;background:var(--bg)"></div>`;
        log.appendChild(wrap); mountCustomView(wrap.querySelector('.cv-mount'), cv);
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
        if (_arr(v.ui).length) renderWidgets(b, _arr(v.ui), { cap: chatCap(), onChoice: t => sendChat(t), onBreakOut: breakOutComponent, onShareOut: shareOutComponent, onExpand: toggleApplet, onTalk: talkAboutWidget, onOpenSpecialist, onOpenRun }); // re-hydrate live widgets
        try { if (_arr(m.objects).length) renderMessageObjects(b, _arr(m.objects)); } catch (e) { console.error('renderMessageObjects (replay) failed', e); } // 🌱 re-render carried objects on reload
        if (_arr(v.tools).length) { const e = document.createElement('div'); e.className = 'tools'; e.textContent = '⚙ ' + _arr(v.tools).join(', '); b.parentNode.appendChild(e); }
        appendProposalPrompt(b.parentNode, m); // a propose-only sub-agent → "🔍 View proposed agent prompt"
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
// Which parent rows are EXPANDED to reveal their sub-agent chats. Persisted; default collapsed (tidy sidebar).
const EXPAND_KEY = 'field-agent-expanded';
let expandedParents = (() => { try { return new Set(JSON.parse(localStorage.getItem(EXPAND_KEY) || '[]')); } catch { return new Set(); } })();
const saveExpanded = () => { try { localStorage.setItem(EXPAND_KEY, JSON.stringify([...expandedParents].slice(-200))); } catch { /* */ } };
// One row's HTML. `lead` is the disclosure triangle (parent), the ↳ marker (child), or an alignment spacer.
const chatRowHtml = (it, lead = '', child = false, kidCount = 0) => {
  const needs = openAsks.some(a => a.origin && a.origin.kind === 'chat' && a.origin.chatId === it.id);
  const perm = it.shared ? (it.shareMode === 'write' ? '<span class="ci-perm" title="shared link · you can post">✍️ </span>' : '<span class="ci-perm" title="shared link · read-only">🔒 </span>') : '';
  const badge = kidCount ? `<span class="ci-kidcount" title="${kidCount} sub-agent chat${kidCount > 1 ? 's' : ''}">${kidCount}</span>` : '';
  return `<div class="chat-item ${child ? 'child' : ''} ${it.id === sessionId ? 'on' : ''}" data-id="${esc(it.id)}">${lead}<span class="ci-title"${it.voice ? '' : ' title="double-click to rename"'}>${needs ? '<span class="ci-dot" title="awaiting your reply"></span>' : ''}${perm}${child ? '<span class="ci-sub">↳ </span>' : ''}${it.voice ? '🎙 ' : ''}${esc(it.title)}</span>${badge}<button class="ci-del mini" data-del="${esc(it.id)}" title="delete">×</button></div>`;
};
const renderChatItems = () => {
  const box = $('chat-items'); if (!box) return;
  // Scheduled-agent runs (⏰ timer chats) are kept OUT of the sidebar — too noisy. They live in seedChats,
  // are openable via the project/feed deep-link, and GC server-side after a week. Filter both newly-arrived
  // and any already-adopted ones (older clients folded them into `chats`).
  const sched = scheduledSeedIds();
  const chatItems = chats.filter(c => !sched.has(c.id)).map(c => ({ id: c.id, title: c.title || 'New chat', ts: c.lastMsgAt || c.ts || 0, voice: false, shared: !!(c.shared && c.shareToken), shareMode: c.shareMode, parentId: c.parentId || '' }));
  const memoItems = memoRuns.map(r => ({ id: r.id, title: r.title || 'voice note', ts: Date.parse(r.date) || 0, voice: true, parentId: '' }));
  const all = [...chatItems, ...memoItems];
  const byId = new Map(all.map(it => [it.id, it]));
  // A sub-agent chat (specialist / scoped sub-chat) whose parent is present → nest it under that parent.
  const kids = new Map(); // parentId → [child items]
  for (const it of chatItems) { if (it.parentId && byId.has(it.parentId) && it.parentId !== it.id) { const a = kids.get(it.parentId) || []; a.push(it); kids.set(it.parentId, a); } }
  const isChild = it => it.parentId && byId.has(it.parentId) && it.parentId !== it.id;
  const byTsDesc = (a, b) => b.ts - a.ts;
  const f = chatFilter.trim().toLowerCase();
  const matches = it => (it.title || '').toLowerCase().includes(f);

  let html = '';
  let total = 0; // top-level count (for pagination); children don't count against the page
  if (f) {
    // While SEARCHING, show a flat list of every matching chat (parent or child) so nothing hides behind a
    // collapsed parent — a child keeps its ↳ marker so its sub-agent origin stays legible.
    const hits = all.filter(matches).sort(byTsDesc);
    total = hits.length;
    html = hits.slice(0, chatShowN).map(it => chatRowHtml(it, isChild(it) ? '' : '<span class="ci-twist-sp"></span>', isChild(it))).join('');
  } else {
    // roots = everything that isn't a nested child; sort by most recent activity, bubbling a root up when one
    // of its sub-agent chats is more recent (an active specialist surfaces the chat that spawned it).
    const roots = all.filter(it => !isChild(it));
    const rootActivity = it => Math.max(it.ts, ...((kids.get(it.id) || []).map(k => k.ts)), it.ts);
    roots.sort((a, b) => rootActivity(b) - rootActivity(a));
    total = roots.length;
    for (const it of roots.slice(0, chatShowN)) {
      const myKids = (kids.get(it.id) || []).sort(byTsDesc);
      const open = expandedParents.has(it.id);
      const lead = myKids.length
        ? `<span class="ci-twist" data-twist="${esc(it.id)}" title="${open ? 'hide' : 'show'} ${myKids.length} sub-agent chat${myKids.length > 1 ? 's' : ''}">${open ? '▾' : '▸'}</span>`
        : '<span class="ci-twist-sp"></span>';
      html += chatRowHtml(it, lead, false, myKids.length);
      if (open) for (const k of myKids) html += chatRowHtml(k, '<span class="ci-twist-sp"></span>', true);
    }
  }
  // LIVE inbound captures pinned at the TOP (not while searching — they have no stable title to match yet).
  const inflightHtml = (f ? [] : visibleInflightSeeds()).map(inflightRowHtml).join('');
  box.innerHTML = (total || inflightHtml)
    ? inflightHtml + html + (total > chatShowN ? `<button class="ci-more mini" style="width:100%;margin-top:4px;opacity:.85">show ${total - chatShowN} more</button>` : '')
    : `<div class="pill">${f ? 'no matches' : 'no chats'}</div>`;
  box.querySelectorAll('.chat-item .ci-title').forEach(s => {
    s.onclick = () => switchChat(s.parentElement.dataset.id);
    s.ondblclick = e => { e.stopPropagation(); startRename(s); };
  });
  box.querySelectorAll('.ci-twist[data-twist]').forEach(t => { t.onclick = e => { e.stopPropagation(); const id = t.dataset.twist; if (expandedParents.has(id)) expandedParents.delete(id); else expandedParents.add(id); saveExpanded(); renderChatItems(); }; });
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
    activeTx = [{ who: 'you', text: run.transcript }, { who: 'agent', text: ver.answer || '', tools: ver.toolsUsed || [], steps: ver.steps || [], proposedPowers: ver.proposedPowers || run.proposedPowers, proposedPrompt: ver.proposedPrompt || run.proposedPrompt }];
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
  subscribeSeedCells(); // FOLLOW the seeds:self cell → show inbound captures being processed live at the top of the list
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
// ── FLUX.2 inpaint (🖌): a PROPER CONFINED ISLAND. The mask-painter (public/inpaint-island.js) runs inside a
//    /confined.html iframe using the canvas primitive — it holds NO cap. The ONE host-mediated seam is
//    ui.call('inpaint',…), routed here to the cap-gated /gpu/inpaint → tinix ComfyUI. Opened over any image
//    via __openInpaint(dataUrl). mountConfined is generic — reuse it for any confined-canvas island. ──
let inpaintOverlay = null, inpaintPanel = null;
const currentThemeVars = () => { try { const s = getComputedStyle(document.documentElement); const out = {}; for (const k of ['--bg', '--ink', '--mut', '--edge', '--acc', '--panel']) { const v = s.getPropertyValue(k); if (v) out[k] = v.trim(); } return out; } catch { return null; } };
// Mount a confined component SOURCE into a fresh sandboxed iframe: transfer a private MessagePort, seed props +
// theme, auto-size to the reported height, and route ui.call(method,args) → `onCall` (the HOST is the gate).
const mountConfined = (container, source, { props = {}, onCall = null } = {}) => {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts'); iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.style.cssText = 'width:520px;max-width:92vw;border:0;display:block;height:220px;border-radius:12px;background:#11141f';
  container.appendChild(iframe);
  let port = null;
  const onReady = e => {
    if (e.source !== iframe.contentWindow) return; const m = e.data; if (!m || m.__cu !== 1 || m.type !== 'ready') return;
    window.removeEventListener('message', onReady);
    const ch = new MessageChannel(); port = ch.port1;
    port.onmessage = async pe => {
      const pm = pe.data; if (!pm || pm.__cu !== 1) return;
      if (pm.type === 'height') { iframe.style.height = Math.min(3000, Math.max(80, Number(pm.px) || 220)) + 'px'; }
      else if (pm.type === 'call') { let ok = false, value = null, error = ''; try { value = onCall ? await onCall(String(pm.method || ''), pm.args || {}) : null; ok = true; } catch (err) { error = (err && err.message) || String(err); } try { port.postMessage({ __cu: 1, type: 'call-result', id: pm.id, ok, value, error }); } catch { /* */ } }
      else if (pm.type === 'error') { try { (window.__fieldReportError || (() => {}))(String(pm.error || ''), 'confined-mount'); } catch { /* */ } }
      else if (pm.type === 'render-smell') { try { (window.__fieldReportSmell || (() => {}))(Array.isArray(pm.smells) ? pm.smells : [], { name: 'inpaint-island' }); } catch { /* */ } }
    };
    try { port.start(); } catch { /* */ }
    iframe.contentWindow.postMessage({ __cu: 1, type: 'mount', source, props, theme: currentThemeVars() }, '*', [ch.port2]);
  };
  window.addEventListener('message', onReady);
  iframe.src = '/confined.html';
  return iframe;
};
const ensureInpaintOverlay = () => {
  if (inpaintOverlay) return;
  inpaintOverlay = document.createElement('div');
  inpaintOverlay.style.cssText = 'position:fixed;inset:0;z-index:9000;display:none;align-items:flex-start;justify-content:center;padding:24px;overflow:auto;background:rgba(0,0,0,.55)';
  inpaintPanel = document.createElement('div'); inpaintPanel.style.cssText = 'position:relative;margin:auto';
  const close = document.createElement('button'); close.textContent = '✕'; close.title = 'close';
  close.style.cssText = 'position:absolute;top:-10px;right:-10px;z-index:1;all:unset;cursor:pointer;background:var(--panel,#11141f);border:1px solid var(--edge,#262c3d);color:var(--ink,#e6edf3);width:26px;height:26px;border-radius:50%;text-align:center;line-height:26px';
  const hide = () => { inpaintOverlay.style.display = 'none'; inpaintPanel.querySelectorAll('iframe').forEach(f => f.remove()); };
  close.onclick = hide;
  inpaintOverlay.onclick = e => { if (e.target === inpaintOverlay) hide(); };
  inpaintPanel.appendChild(close); inpaintOverlay.appendChild(inpaintPanel); document.body.appendChild(inpaintOverlay);
};
const measureImage = url => new Promise(res => { const i = new Image(); i.onload = () => res({ w: i.naturalWidth || 512, h: i.naturalHeight || 512 }); i.onerror = () => res({ w: 512, h: 512 }); i.src = url; });
window.__openInpaint = async dataUrl => {
  try {
    ensureInpaintOverlay();
    inpaintPanel.querySelectorAll('iframe').forEach(f => f.remove()); // fresh mount per open
    inpaintOverlay.style.display = 'flex';
    if (!dataUrl) return true;
    const [{ inpaintIsland }, dim] = await Promise.all([import('./inpaint-island.js'), measureImage(dataUrl)]);
    window.__inpaintIframe = mountConfined(inpaintPanel, inpaintIsland.toString(), {
      props: { image: dataUrl, width: dim.w, height: dim.h },
      onCall: async (method, args) => {
        if (method !== 'inpaint') throw new Error('unknown method: ' + method);
        if (!cap) throw new Error('open this from your agent (no capability)');
        const r = await (await fetch('/gpu/inpaint', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, image: args.image, mask: args.mask, prompt: args.prompt }) })).json();
        if (!r || !r.ok) throw new Error((r && r.error) || 'inpaint failed');
        return { dataUrl: r.dataUrl, info: r.info };
      },
    });
    return true;
  } catch (e) { return String((e && e.message) || e); }
};

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
  // Stage the (cap-stripped) URL so the next send tells the agent about it (the widget alone is client-only).
  if (stored.url) (pendingSharedLinks[sessionId] || (pendingSharedLinks[sessionId] = [])).push(stored.url);
  const inlined = site.html != null || isSameOriginSite(stored.url ?? '/') || isFramableFleetSite(stored.url || '');
  setStatus(inlined ? '🧩 site embedded inline — the agent will see it on send' : '🧩 cross-origin app linked — tap “open ↗” (the agent sees the link on send)');
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
// ── TRACE ISLAND (chrome-trace-view): the in-turn LIVE trace as a registry-backed, fork-riffable
//    chrome component. THE CELL IS THE INTERFACE: the host opens ONE /cells/subscribe stream for this
//    chat's `trace:<sid>` cell (fed server-side from the same emitStep events as /chat/steps, monotonic)
//    and re-renders the island on every push — the confined component holds no cap and never fetches.
//    Fallback ladder: island mounts → it owns the turn's trace surface; the island fails (broken edit,
//    registry unreachable, no lockdown) → the LEGACY 3D pendant paints instead (never a silent turn), and
//    the failure auto-files onto chrome-trace-view's own backlog via renderChrome's error report. ──
let traceIsland = null; // { host, ctrl, sid } — the active island instance for the running turn
const traceIslandEnd = () => { if (!traceIsland) return; try { traceIsland.ctrl.abort(); } catch { /* */ } try { traceIsland.host.remove(); } catch { /* */ } traceIsland = null; };
// the running-glow keyframes the seeded island source uses (documented in its header) — host-provided,
// like lp-kf for the live-progress bubble (a confined component cannot inject a <style> tag).
const traceKeyframes = () => { if (document.getElementById('ti-kf')) return; const st = document.createElement('style'); st.id = 'ti-kf'; st.textContent = '@keyframes ti-pulse{0%,100%{opacity:.45;transform:scale(.88)}50%{opacity:1;transform:scale(1.1)}}'; document.head.appendChild(st); };
// ⊿3D from the island: open the classic 3D pendant FULLSCREEN on the same live stream (the server
// replays the fan-out so far over /chat/steps, then streams new steps — the "jump into the trace" path).
const openLive3D = async (promptText, sid) => {
  try {
    const p = await ensurePendant();
    pendantWrap.classList.remove('hide'); p.setVisible(true); p.reset(promptText || '');
    try { pendantES && pendantES.close(); } catch { /* */ }
    pendantES = new EventSource('/chat/steps?sid=' + encodeURIComponent(sid));
    pendantES.onmessage = e => { try { const m = JSON.parse(e.data); if (m.t === 'start') p.toolStart(m.name, m.detail, m.call); else if (m.t === 'done') p.toolDone(m.name, m.ok, m.detail, m.children, m.call, m.result, m.granted); else if (m.t === 'rnode') p.rnode(m); else if (m.t === 'child-done') p.childDone(m.parent, m.name, m.ok); else if (m.t === 'end') { try { pendantES.close(); } catch { /* */ } } } catch { /* */ } };
    if (!pendantFs) togglePendantFs();
  } catch { /* the 3D view is enhancement-only */ }
};
// ── TRACE-VIZ ISLAND (Tier-2) ── dan (2026-07-02): the SVG/WebGL trace must be an alt-clickable, forkable
//    island; the SES no-iframe fork path's sanitizer has NO <canvas>/<svg>, so a WebGL trace view needs the
//    sandboxed opaque-origin IFRAME runtime (public/confined.html). This mounts the reference 3D force-graph
//    viz (public/trace-viz-3d.js) via grain-ui.mountTraceViz: the iframe subscribes to trace:<sid> and the
//    PARENT brokers that cell in over a private MessagePort (the cap never crosses; the frame has no network).
//    It is the DEFAULT trace surface with a clean fallback ladder — Tier-2 WebGL → chrome-trace-view (divs)
//    → legacy 3D pendant — so a failure NEVER blanks the turn. (This block lives in the trace region, far
//    from componentSelect; the view-switching worker owns that.)
const TRACE_VIZ_LS = 'field-trace-viz-id';
let __traceVizSeed = null; // memoized seed promise: ONE /components/break-out per session gives the viz its git id
const ensureTraceVizSeeded = async () => {
  try { const c = localStorage.getItem(TRACE_VIZ_LS); if (c) return c; } catch { /* */ }
  if (__traceVizSeed) return __traceVizSeed;
  __traceVizSeed = (async () => {
    try {
      const { TRACE_VIZ_3D_SOURCE } = await import('./trace-viz-3d.js');
      const r = await (await fetch('/components/break-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: chatCap(), source: TRACE_VIZ_3D_SOURCE, name: 'Trace 3D (force graph)', cells: ['trace:<chatId>'] }) })).json();
      if (r && r.ok && r.id) { try { localStorage.setItem(TRACE_VIZ_LS, r.id); } catch { /* */ } return r.id; }
    } catch { /* best-effort: the island still renders live without a git id (just not forkable this session) */ }
    return null;
  })();
  return __traceVizSeed;
};
// ── THE 5 TRACE VIEWS ── the switchable set for the trace island + the gallery cards. dan (2026-07-02):
//    "a gallery of a few different well-researched ways one might view how a complicated task is completed."
//    The 5 confined Tier-2 viz are alternative SOURCES for the ONE trace island — the live trace:<sid> cell
//    is the interface, so rotating the view just re-mounts the island with a different source over the SAME
//    cell. The active choice persists per-user in localStorage (a durable per-user server store is a
//    follow-up). Default '3d' keeps the reference surface (+ its seeded git id → alt-click/fork/backlog).
const TRACE_VIZ_CHOICE_LS = 'field-trace-viz-choice';
const traceVizChoice = () => { try { return localStorage.getItem(TRACE_VIZ_CHOICE_LS) || '3d'; } catch { return '3d'; } };
const setTraceVizChoice = k => { try { localStorage.setItem(TRACE_VIZ_CHOICE_LS, String(k)); } catch { /* */ } };
let __traceVizKinds = null; // memoized load of the 5 viz (source+name+splash+caption) from grain-ui's registry
const loadTraceVizKinds = async () => {
  if (__traceVizKinds) return __traceVizKinds;
  try { const gu = await import('./grain-ui.js'); __traceVizKinds = (typeof gu.loadTraceVizKinds === 'function') ? await gu.loadTraceVizKinds() : []; } catch { __traceVizKinds = []; }
  return __traceVizKinds;
};
const traceVizIslandBegin = async (promptText, sid) => {
  try {
    const gu = await import('./grain-ui.js');
    if (!gu || typeof gu.mountTraceViz !== 'function') return false;
    traceIslandEnd();
    const host = document.createElement('div');
    host.className = 'msg trace-island-host';
    host.style.cssText = 'padding:0;border:0;background:none;max-width:none';
    log.appendChild(host); window.scrollTo(0, document.body.scrollHeight);
    // pick the user's chosen view from the 5 (default: the 3D reference). Only the 3D reference carries a
    // seeded uicomp git id this session (ensureTraceVizSeeded broke it out); the others mount name-only
    // (still live + switchable via "views ▾", just not fork/backlog-tagged this session — noted follow-up).
    const kinds = await loadTraceVizKinds().catch(() => []);
    const choiceKey = traceVizChoice();
    const kind = kinds.find(k => k.key === choiceKey) || kinds.find(k => k.key === '3d') || null;
    const componentId = (kind && kind.key === '3d') || !kind ? await ensureTraceVizSeeded().catch(() => null) : null;
    // honor the TEST-ONLY source override (window.__traceVizSourceOverride, used to exercise variant/broken
    // paths): when it's set, let mountTraceViz apply it — don't pass our curated source over the top of it.
    const overriding = typeof window !== 'undefined' && !!window.__traceVizSourceOverride;
    const inst = { host, sid, tier2: true, frames: 0, ctrl: { abort() {} }, promptText, vizKey: kind ? kind.key : '3d' };
    let fellBack = false;
    const onError = () => { // the confined viz failed to mount/threw → the LEGACY 3D pendant takes over (never a blank turn)
      if (fellBack) return; fellBack = true;
      try { traceIslandEnd(); } catch { /* */ }
      try { pendantBeginLegacy(promptText, sid); } catch { /* */ }
    };
    // a slim control bar: which view is live + a "views ▾" gallery opener + a 🔀 quick-rotate through the 5.
    host.appendChild(traceViewsBar(inst));
    const wrap = await gu.mountTraceViz(host, { cap: chatCap(), sid, componentId, name: (kind && kind.name) || 'Trace 3D (force graph)', source: overriding ? undefined : ((kind && kind.source) || undefined), height: 300, onError, onVizFrame: n => { inst.frames = n; } });
    if (!wrap) { try { host.remove(); } catch { /* */ } return false; }
    inst.ctrl = { abort: () => { try { wrap.__dispose && wrap.__dispose(); } catch { /* */ } } };
    traceIsland = inst; window.__traceIsland = inst; // test seam: { frames, sid, tier2, vizKey }
    return true;
  } catch { return false; }
};
// re-render the LIVE island through a different view (set the active source + re-mount over the SAME cell).
// Composed-vs-direct note: the shipped 🔀 view-switch overlay (commit 39aedd2fd) keys strictly on a
// component's git history + /forks/* — it can't take a CURATED in-memory source set without seeding all 5 as
// git objects (a server round-trip). So the island switch is implemented DIRECTLY here (re-mount with the
// chosen source); deeper composition (the 5 as the overlay's upstream/peer node set) is the noted follow-up.
const switchTraceViz = async key => {
  setTraceVizChoice(key);
  const inst = traceIsland;
  if (inst && inst.tier2 && inst.sid) { try { await traceVizIslandBegin(inst.promptText || '', inst.sid); } catch { /* */ } }
};
// the on-island control bar: the current view's name + a gallery opener + a quick rotate (dan's 🔀 gesture).
const traceViewsBar = inst => {
  const bar = document.createElement('div');
  bar.className = 'trace-views-bar'; bar.setAttribute('data-trace-views-bar', '');
  bar.style.cssText = 'display:flex;align-items:center;gap:8px;padding:3px 8px 5px;font:11px -apple-system,sans-serif;color:var(--mut)';
  const lbl = document.createElement('span'); lbl.textContent = 'trace view'; lbl.style.cssText = 'opacity:.7';
  const views = document.createElement('button'); views.className = 'mini'; views.textContent = 'views ▾'; views.title = 'See 5 ways to view how this task got done';
  views.onclick = () => openTraceViewsGallery();
  const rot = document.createElement('button'); rot.className = 'mini'; rot.textContent = '🔀'; rot.title = 'Rotate this trace through the next view (same data, different lens)'; rot.setAttribute('data-trace-rotate', '');
  rot.onclick = async () => { const kinds = await loadTraceVizKinds(); if (!kinds.length) return; const i = Math.max(0, kinds.findIndex(k => k.key === traceVizChoice())); await switchTraceViz(kinds[(i + 1) % kinds.length].key); };
  bar.append(lbl, views, rot);
  return bar;
};
// TIER-2 GATING (opt-in mode, dan-gated default): the WebGL views need field-trace-tier2. The gallery + its
// splash cards render REGARDLESS (a splash card is a plain confined component, no flag needed). Only making a
// view your LIVE trace lens needs Tier-2 — so if it's off we show a legible banner offering to enable it.
// Clicking "Enable" is the USER opting IN per-instance; the code default stays OFF (dan's policy call — see
// the report). We never flip the default here.
const renderTraceGate = el => {
  if (!el) return;
  if (traceTier2On()) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.cssText = 'display:block;margin:0 0 12px;padding:9px 12px;border:1px solid var(--warn,#d29922);border-radius:10px;font-size:12px;background:rgba(210,153,34,.09);color:var(--ink)';
  el.textContent = 'These are WebGL views. Your live trace uses the lightweight surface until you turn on the Tier-2 WebGL trace — then your chosen view renders under each answer. ';
  const btn = document.createElement('button'); btn.className = 'mini primary'; btn.textContent = 'Enable Tier-2 WebGL trace'; btn.style.marginLeft = '4px'; btn.setAttribute('data-enable-tier2', '');
  btn.onclick = () => { try { localStorage.setItem('field-trace-tier2', '1'); } catch { /* */ } renderTraceGate(el); setStatus('Tier-2 WebGL trace enabled — your next answer uses your chosen view.'); };
  el.appendChild(btn);
};
// make `k` the active trace view (persist + re-render any live island), then refresh the surface it was
// picked from (moves the "active" highlight + updates the gate).
const pickTraceView = async (k, refresh) => {
  await switchTraceViz(k.key);
  setStatus(`Trace view set: ${k.name}`);
  if (typeof refresh === 'function') { try { refresh(); } catch { /* */ } }
};
// build the 5 SPLASH CARDS into `host`: each mounts a small confined instance of its viz rendering its OWN
// canned splash-example trace (cap-free, fed through the cell) — so at a glance you see the distinct ways to
// read a trace. Clicking a card makes it the active view. Reused by the modal + the Component-Studio section.
const buildTraceViewsGrid = async (host, opts) => {
  const o = opts || {}; host.innerHTML = '';
  let gu, kinds;
  try { gu = await import('./grain-ui.js'); kinds = await loadTraceVizKinds(); } catch { kinds = []; }
  if (!kinds || !kinds.length) { host.innerHTML = '<div class="sub" style="padding:8px 2px;font-size:11px">trace views unavailable (viz sources failed to load)</div>'; return; }
  const active = o.activeKey || traceVizChoice();
  const grid = document.createElement('div'); grid.style.cssText = GALLERY_GRID;
  for (const k of kinds) {
    const isActive = k.key === active;
    const card = document.createElement('div'); card.setAttribute('data-trace-view', k.key);
    card.style.cssText = `border:1px solid ${isActive ? 'var(--acc,#7c5cff)' : 'var(--edge)'};border-radius:12px;padding:10px;background:var(--bg);overflow:hidden;cursor:pointer;position:relative` + (isActive ? ';box-shadow:0 0 0 1px var(--acc,#7c5cff)' : '');
    const h = document.createElement('div'); h.style.cssText = 'font-size:12px;font-weight:600;display:flex;align-items:center;gap:6px'; h.textContent = k.name;
    if (isActive) { const b = document.createElement('span'); b.textContent = 'active'; b.style.cssText = 'font-size:9px;font-weight:600;background:var(--acc-fill,#6b3fd6);color:#fff;border-radius:8px;padding:1px 6px'; h.appendChild(b); }
    const sub = document.createElement('div'); sub.className = 'sub'; sub.style.cssText = 'font-size:11px;margin:2px 0 8px;line-height:1.35'; sub.textContent = k.caption;
    const slot = document.createElement('div'); slot.style.cssText = 'pointer-events:none'; // the CARD owns the click; the confined iframe never sees it
    card.append(h, sub, slot);
    try { gu.mountVizSplash(slot, { source: k.source, splash: k.splash, height: 190, cellId: 'trace:splash-' + k.key }); } catch { slot.textContent = 'preview unavailable'; }
    card.onclick = () => { if (typeof o.onPick === 'function') o.onPick(k); };
    grid.appendChild(card);
  }
  host.appendChild(grid);
};
// a self-refreshing Trace-views section (gate banner + the 5 cards). Picking re-renders both in place.
const mountTraceViewsSection = host => {
  const gate = document.createElement('div'); const grid = document.createElement('div');
  host.append(gate, grid);
  const refresh = () => { renderTraceGate(gate); buildTraceViewsGrid(grid, { onPick: k => pickTraceView(k, refresh) }); };
  refresh();
};
// the "🔭 Trace views" GALLERY modal — reached from "views ▾" on the live trace island (and mirrored in the
// Component Studio tab). Shows all 5 splash cards at once so, at a glance, you see the ways to read a trace.
let __traceGalleryOverlay = null;
const openTraceViewsGallery = () => {
  if (!__traceGalleryOverlay) {
    const ov = document.createElement('div'); ov.id = 'tv-gallery-overlay'; ov.setAttribute('data-trace-gallery', '');
    ov.style.cssText = 'position:fixed;inset:0;z-index:9400;display:none;align-items:center;justify-content:center;background:rgba(4,8,14,.72);backdrop-filter:blur(4px);padding:20px';
    ov.innerHTML = `<div style="width:min(980px,94vw);max-height:88vh;display:flex;flex-direction:column;background:var(--bg,#0d1117);border:1px solid var(--acc,#7c5cff);border-radius:16px;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,.7)">
      <div style="display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid var(--edge)"><b style="flex:1">🔭 Trace views — ways to see how a task got done</b><button class="mini" id="tv-x">✕</button></div>
      <div id="tv-body" style="flex:1;overflow:auto;padding:14px"></div></div>`;
    document.body.appendChild(ov);
    ov.addEventListener('click', e => { if (e.target === ov) hideTraceViewsGallery(); });
    ov.querySelector('#tv-x').onclick = hideTraceViewsGallery;
    __traceGalleryOverlay = ov;
  }
  __traceGalleryOverlay.style.display = 'flex';
  const body = __traceGalleryOverlay.querySelector('#tv-body'); body.innerHTML = '';
  mountTraceViewsSection(body);
};
const hideTraceViewsGallery = () => { if (__traceGalleryOverlay) __traceGalleryOverlay.style.display = 'none'; };
try { window.openTraceViewsGallery = openTraceViewsGallery; } catch { /* */ } // reachable from tests + other surfaces

// ══ 🪄 MAGIC STORIES ══ a gallery of flows this harness made possible + the ⭐ collector that feeds it.
// dan (2026-07-02): "a fun-filled gallery of interesting stories sanitized from identity implications
// representing different flows made possible by this system — especially ones that leverage the object-
// capability, multi-hop delegation, and composition qualities." The showcase that makes the ocap thesis
// obvious. Sanitization is server-side + mandatory (stories.mjs); nothing here ever renders a raw cap.
const STORY_QUALITIES = [
  ['multi-hop-delegation', '🔗 Multi-hop delegation'], ['composition', '🧩 Composition'],
  ['revocation', '⛔ Revocation'], ['confinement', '🔒 Confinement'],
  ['attenuation', '🎚️ Attenuation'], ['paid-capability', '💰 Paid capability'], ['other', '✨ Other'],
];
const storyQualityLabel = q => (STORY_QUALITIES.find(([k]) => k === q) || ['other', '✨ Other'])[1];

// ⭐ COLLECTOR — nominate the CURRENT chat's just-completed flow as a story candidate. A small form captures a
// title + "what made this possible" + which ocap quality it shows; the server pulls the trace SHAPE (delegation
// edges) from the live trace cell and sanitizes before persisting. `seedText` prefills the title from the message.
const saveStoryFromMessage = seedText => {
  const seed = String(seedText || '').replace(/\s+/g, ' ').trim().slice(0, 90);
  const opts = STORY_QUALITIES.map(([k, label], i) => `<option value="${k}"${i === 0 ? ' selected' : ''}>${esc(label)}</option>`).join('');
  showModal(`<div class="qrlabel">⭐ Save this flow as a Magic Story</div>
    <div style="text-align:left;font-size:12px;color:var(--mut);margin:2px 0 8px">Sanitized before it's saved — no names, emails, or capabilities are ever stored. It becomes a candidate for the 🪄 gallery once you review it.</div>
    <label style="display:block;font-size:11px;color:var(--mut);margin-bottom:2px">Title</label>
    <input id="story-title" type="text" maxlength="140" value="${esc(seed)}" placeholder="e.g. Shared a device that composed with a stranger's agent" style="width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid var(--edge);border-radius:8px;background:var(--bg);color:var(--ink);font-size:13px;margin-bottom:8px">
    <label style="display:block;font-size:11px;color:var(--mut);margin-bottom:2px">What made this possible? (the ocap quality it shows)</label>
    <textarea id="story-why" maxlength="400" rows="3" placeholder="A capability passed hand to hand, attenuating at each edge…" style="width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid var(--edge);border-radius:8px;background:var(--bg);color:var(--ink);font-size:13px;margin-bottom:8px;resize:vertical"></textarea>
    <label style="display:block;font-size:11px;color:var(--mut);margin-bottom:2px">Quality</label>
    <select id="story-quality" style="width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid var(--edge);border-radius:8px;background:var(--bg);color:var(--ink);font-size:13px;margin-bottom:10px">${opts}</select>
    <button class="mini primary" id="story-save" style="width:100%">⭐ Save as story candidate</button>`);
  const btn = $('story-save');
  if (btn) btn.onclick = async () => {
    const title = ($('story-title') || {}).value || seed;
    if (!String(title || '').trim()) { setStatus('a story needs a title'); return; }
    btn.disabled = true; btn.textContent = 'saving…';
    let r; try { r = await (await fetch('/stories/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: chatCap(), sid: sessionId, title, why: ($('story-why') || {}).value || '', quality: ($('story-quality') || {}).value || 'other' }) })).json(); } catch (e) { r = { error: e.message }; }
    if (r && r.ok) { closeModal(); setStatus(`⭐ Saved as a story candidate${r.scrubbed ? ` (${r.scrubbed} identity detail${r.scrubbed === 1 ? '' : 's'} sanitized)` : ''} — review it in 🪄`); }
    else { btn.disabled = false; btn.textContent = '⭐ Save as story candidate'; setStatus('story: ' + ((r && r.error) || 'failed')); }
  };
};
try { window.saveStoryFromMessage = saveStoryFromMessage; } catch { /* */ }

// render ONE story card: its title, the ocap quality it demonstrates, "what made this possible", and — where a
// flow shape was captured — a small cap-free authority/data-flow viz of the flow (the ocap lens, reusing the
// trace-viz splash-card mechanism). Candidate cards also carry the review actions (Publish / Discard).
let __storyVizSource = null; // memoized: the Sankey (authority & data flow) viz source, the ocap lens for a story
const storyVizSource = async () => {
  if (__storyVizSource !== null) return __storyVizSource;
  try { const kinds = await loadTraceVizKinds(); const k = kinds.find(x => x.key === 'sankey') || kinds.find(x => x.key === 'provenance') || kinds[0]; __storyVizSource = k ? k.source : ''; }
  catch { __storyVizSource = ''; }
  return __storyVizSource;
};
const renderStoryCard = async (s, { review, onChanged } = {}) => {
  const card = document.createElement('div'); card.setAttribute('data-story', s.id);
  card.style.cssText = 'border:1px solid var(--edge);border-radius:12px;padding:12px;background:var(--bg);overflow:hidden;position:relative';
  const q = document.createElement('div'); q.style.cssText = 'font-size:10px;font-weight:600;color:var(--acc);letter-spacing:.02em;margin-bottom:3px'; q.textContent = storyQualityLabel(s.quality);
  const h = document.createElement('div'); h.style.cssText = 'font-size:13px;font-weight:600;line-height:1.3'; h.textContent = s.title; // textContent — a story title is never HTML
  card.append(q, h);
  if (s.why) { const w = document.createElement('div'); w.className = 'sub'; w.style.cssText = 'font-size:11.5px;margin:4px 0 8px;line-height:1.4;color:var(--mut)'; w.textContent = s.why; card.appendChild(w); }
  // the flow viz — a confined splash card fed the story's canned (sanitized) flow shape, cap-free.
  if (s.flow && Array.isArray(s.flow.steps) && s.flow.steps.length) {
    const slot = document.createElement('div'); slot.style.cssText = 'pointer-events:none;border-radius:9px;overflow:hidden;border:1px solid var(--edge);margin-top:6px'; card.appendChild(slot);
    try { const gu = await import('./grain-ui.js'); const src = await storyVizSource(); if (src) gu.mountVizSplash(slot, { source: src, splash: s.flow, height: 170, cellId: 'story:' + s.id }); else slot.remove(); }
    catch { slot.remove(); }
  }
  if (review) {
    const bar = document.createElement('div'); bar.style.cssText = 'display:flex;gap:6px;margin-top:10px';
    const pub = document.createElement('button'); pub.className = 'mini primary'; pub.setAttribute('data-story-publish', s.id); pub.textContent = '✅ Publish';
    const dis = document.createElement('button'); dis.className = 'mini'; dis.setAttribute('data-story-discard', s.id); dis.textContent = '🗑️ Discard';
    pub.onclick = async () => { pub.disabled = true; let r; try { r = await (await fetch('/stories/publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: chatCap(), id: s.id }) })).json(); } catch (e) { r = { error: e.message }; } if (r && r.ok) { setStatus('🪄 Story published to the gallery'); if (onChanged) onChanged(); } else { pub.disabled = false; setStatus('publish: ' + ((r && (r.error || (r.leaks && 'still contains identity'))) || 'failed')); } };
    dis.onclick = async () => { dis.disabled = true; try { await fetch('/stories/discard', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: chatCap(), id: s.id }) }); } catch { /* */ } setStatus('story discarded'); if (onChanged) onChanged(); };
    bar.append(pub, dis); card.appendChild(bar);
  }
  return card;
};

// the 🪄 gallery modal: published stories up top (the showcase), a review queue below for the operator.
let __magicOverlay = null;
const openMagicStories = () => {
  if (!__magicOverlay) {
    const ov = document.createElement('div'); ov.id = 'magic-stories-overlay'; ov.setAttribute('data-magic-stories', '');
    ov.style.cssText = 'position:fixed;inset:0;z-index:9400;display:none;align-items:center;justify-content:center;background:rgba(4,8,14,.72);backdrop-filter:blur(4px);padding:20px';
    ov.innerHTML = `<div style="width:min(1000px,94vw);max-height:88vh;display:flex;flex-direction:column;background:var(--bg,#0d1117);border:1px solid var(--acc,#7c5cff);border-radius:16px;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,.7)">
      <div style="display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid var(--edge)"><b style="flex:1">🪄 Magic Stories — flows this harness made possible</b><button class="mini" id="ms-x">✕</button></div>
      <div id="ms-body" style="flex:1;overflow:auto;padding:14px"></div></div>`;
    document.body.appendChild(ov);
    ov.addEventListener('click', e => { if (e.target === ov) hideMagicStories(); });
    ov.querySelector('#ms-x').onclick = hideMagicStories;
    __magicOverlay = ov;
  }
  __magicOverlay.style.display = 'flex';
  refreshMagicStories();
};
const hideMagicStories = () => { if (__magicOverlay) __magicOverlay.style.display = 'none'; };
const refreshMagicStories = async () => {
  if (!__magicOverlay) return;
  const body = __magicOverlay.querySelector('#ms-body'); body.innerHTML = '<div class="sub" style="padding:8px 2px;font-size:12px">loading…</div>';
  let r; try { r = await (await fetch('/stories/list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: chatCap() }) })).json(); } catch (e) { r = { error: e.message }; }
  body.innerHTML = '';
  if (!r || !r.ok) { body.innerHTML = `<div class="sub" style="padding:8px 2px;font-size:12px">could not load stories (${esc((r && r.error) || 'error')})</div>`; return; }
  const published = r.published || []; const candidates = r.candidates || [];
  // PUBLISHED (the showcase)
  if (published.length) {
    const grid = document.createElement('div'); grid.style.cssText = GALLERY_GRID; grid.setAttribute('data-story-grid', '');
    for (const s of published) grid.appendChild(await renderStoryCard(s, {}));
    body.appendChild(grid);
  } else {
    const empty = document.createElement('div'); empty.setAttribute('data-story-empty', '');
    empty.style.cssText = 'text-align:center;padding:34px 16px;color:var(--mut)';
    empty.innerHTML = '<div style="font-size:34px;margin-bottom:8px">🪄</div><div style="font-size:14px;font-weight:600;color:var(--ink)">No published stories yet</div><div style="font-size:12px;margin-top:5px;max-width:440px;margin-inline:auto;line-height:1.5">Hit the ⭐ on any message to nominate the flow that produced it. The best ones show off multi-hop delegation and composition — a capability passed hand to hand, or a device composed with someone else\'s agent.</div>';
    body.appendChild(empty);
  }
  // REVIEW QUEUE (operator only)
  if (r.canReview) {
    const hr = document.createElement('div'); hr.style.cssText = 'margin:16px 0 8px;font-size:12px;font-weight:600;color:var(--ink);display:flex;align-items:center;gap:6px';
    hr.textContent = `🔔 Needs review${candidates.length ? ` (${candidates.length})` : ''}`; body.appendChild(hr);
    if (candidates.length) {
      const grid = document.createElement('div'); grid.style.cssText = GALLERY_GRID; grid.setAttribute('data-story-review-grid', '');
      for (const s of candidates) grid.appendChild(await renderStoryCard(s, { review: true, onChanged: refreshMagicStories }));
      body.appendChild(grid);
    } else { const n = document.createElement('div'); n.className = 'sub'; n.style.cssText = 'font-size:12px;color:var(--mut)'; n.textContent = 'No story candidates waiting.'; body.appendChild(n); }
  }
};
try { window.openMagicStories = openMagicStories; } catch { /* */ }
// Tier-2 is OPT-IN for now (dan-gated policy call — it changes the central trace surface + the prior
// chrome-trace-view test asserts the divs island). Enable per-instance with localStorage
// field-trace-tier2='1' (or window.__traceVizTier2 = true). When on: Tier-2 WebGL island → (on failure)
// legacy 3D pendant; when off / unavailable: the chrome-trace-view island → (call site) legacy pendant.
const traceTier2On = () => { try { return window.__traceVizTier2 === true || localStorage.getItem('field-trace-tier2') === '1'; } catch { return false; } };
const traceIslandBegin = async (promptText, sid) => {
  if (traceTier2On()) { try { if (await traceVizIslandBegin(promptText, sid)) return true; } catch { /* fall through to chrome */ } }
  return traceChromeIslandBegin(promptText, sid);
};
const traceChromeIslandBegin = async (promptText, sid) => {
  try {
    await chromeReady;
    const c = chromeComps['chrome-trace-view'];
    const isl = window.__fieldIslands;
    if (!c || !c.source || !isl || typeof isl.renderChrome !== 'function') return false;
    traceIslandEnd(); traceKeyframes();
    const host = document.createElement('div');
    host.className = 'msg trace-island-host';
    host.style.cssText = 'padding:0;border:0;background:none;max-width:none';
    log.appendChild(host); window.scrollTo(0, document.body.scrollHeight);
    const handlers = { onOpen3D: () => openLive3D(promptText, sid) };
    if (!mountChrome('chrome-trace-view', host, { trace: { sid, turn: 0, status: 'running', progress: 'Thinking…', steps: [], nodes: [] }, ...handlers })) { host.remove(); return false; }
    const ctrl = new AbortController();
    const inst = { host, ctrl, sid, baseTurn: null, sawFresh: false, frames: 0 };
    traceIsland = inst;
    window.__traceIsland = inst; // test seam: frame count + sid (render-safe step names only, no cap)
    (async () => { // one open stream; the server pushes the current value + every change (never polls)
      try {
        const res = await fetch('/cells/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: chatCap(), cells: ['trace:' + sid] }), signal: ctrl.signal });
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let i; while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const line = block.split('\n').find(l => l.startsWith('data:')); if (!line) continue;
            let m; try { m = JSON.parse(line.slice(5).trim()); } catch { continue; }
            if (!m || m.error || !m.value || traceIsland !== inst) continue;
            const v = m.value;
            // the cell replays its CURRENT value on subscribe — a finished PREVIOUS turn replays first
            // when we attach just before POST /chat lands. Skip stale completed turns; render this one.
            if (!inst.sawFresh) { if (v.status === 'done' && (v.steps || []).length) { inst.baseTurn = v.turn; continue; } inst.sawFresh = true; }
            if (inst.baseTurn != null && v.turn === inst.baseTurn) continue;
            if (!inst.host.isConnected) { try { log.appendChild(inst.host); } catch { /* */ } } // a mid-turn renderTx rebuilt the log
            if (!mountChrome('chrome-trace-view', inst.host, { trace: v, ...handlers })) {
              // a live edit broke the island MID-TURN (the error auto-filed onto its backlog via
              // renderChrome) → the legacy pendant takes over the still-running trace.
              traceIslandEnd(); pendantBeginLegacy(promptText, sid); return;
            }
            inst.frames += 1;
          }
        }
      } catch { /* aborted / network drop — the SVG trace record still lands with the answer */ }
    })();
    return true;
  } catch { return false; }
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
      // ABOVE it, so on the landing view (composer docked at the bottom) it can never overflow the
      // top of the screen — it hugs just over the input box, shrinking if room is tight.
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
// A turn's trace surface: the TRACE ISLAND first (chrome-trace-view — fork/riff/edit like any chrome
// component), the legacy 3D pendant as the guaranteed fallback (island refused / broken / no lockdown).
const pendantBegin = async (promptText, sid = sessionId) => {
  pendantLive = true; liveChatId = sid; pendantShapeMode = false; // a real turn reclaims the trace surface from any Settings shape view
  if (await traceIslandBegin(promptText, sid)) return; // the island owns this turn; no host-side /chat/steps SSE, no 3D canvas
  await pendantBeginLegacy(promptText, sid);
};
const pendantBeginLegacy = async (promptText, sid = sessionId) => {
  try {
    const p = await ensurePendant();
    pendantWrap.classList.remove('hide'); p.setVisible(true);
    positionPendant(); p.reset(promptText);
    showLiveProgress('Thinking…'); // immediate sign of life, before the model has even written its first program
    try { pendantES && pendantES.close(); } catch {}
    pendantES = new EventSource('/chat/steps?sid=' + encodeURIComponent(sid)); // tool NAMES + queries/urls only — never the cap (cap-hygiene). The server replays the trace so far → joining mid-run shows it live.
    pendantES.onmessage = e => { try { const m = JSON.parse(e.data); if (m.t === 'start') { p.toolStart(m.name, m.detail, m.call); showLiveProgress(progressLabelFor(m.name, m.detail)); } else if (m.t === 'thinking') { if (!liveProgressEl) showLiveProgress('Thinking…'); } else if (m.t === 'progress') { showLiveProgress(m.text || 'Working…'); } else if (m.t === 'done') p.toolDone(m.name, m.ok, m.detail, m.children, m.call, m.result, m.granted); else if (m.t === 'rnode') p.rnode(m); else if (m.t === 'child-done') p.childDone(m.parent, m.name, m.ok); else if (m.t === 'end') { clearLiveProgress(); try { pendantES.close(); } catch {} } } catch {} };
    pendantES.onerror = () => {}; // degrade silently — applyFinal reconciles from the final steps[]
  } catch { /* pendant is enhancement-only; never block the turn */ }
};
const pendantEnd = steps => { clearLiveProgress(); traceIslandEnd(); try { pendantES && pendantES.close(); } catch {} pendantLive = false; if (pendant) { pendant.finish(); pendant.applyFinal(steps || []); } hidePendant(); }; // done WORKING → remove the live trace island / hide the 3D animation; the per-message SVG trace (above the message) becomes the record. Tap an SVG to reopen the 3D on demand.
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
// a notification link to a scheduled task (#sched=<id>). Routed IN-APP regardless of which origin minted the
// link (public chu vs tailnet) — the id is an origin-independent designator and this app is its only producer;
// opening it in-app uses THIS browser's stored cap instead of bouncing through a possibly-capless other origin.
const schedIdFromLink = u => {
  if (typeof u !== 'string') return '';
  try { const url = new URL(u, location.href); if (!/^https?:$/.test(url.protocol)) return ''; return (new URLSearchParams(url.hash.slice(1)).get('sched') || '').replace(/[^\w-]/g, ''); }
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
    // a deep-link to a scheduled task's Detail → route IN-APP (openSchedDetail).
    const schedId = schedIdFromLink(l && l.href);
    if (schedId) return `<a class="nlink" href="#" data-opensched="${esc(schedId)}">⏰ scheduled task</a>`;
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
  const schedId = schedIdFromLink(l && l.href);
  if (schedId) return { label: '⏰ scheduled task', open: () => openSchedDetail(schedId) };
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
  // scheduled-task deep-links route IN-APP to that task's Detail card.
  document.querySelectorAll('#att-list .nlink[data-opensched], #rec-list .nlink[data-opensched]').forEach(a => { a.onclick = e => { e.preventDefault(); openSchedDetail(a.dataset.opensched); }; });
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
if ($('stories-btn')) $('stories-btn').onclick = () => openMagicStories();
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
// ── Increment 1 of designs/live-editable-everything.md: Alt-click ✎ edit opens a CONVERSATIONAL edit chat
//    with the component's agent (not a one-shot window.prompt). Each message edits the component live via its
//    edit endpoint; the exchange renders as a chat; the live component re-renders. Session-only thread per id.
const compEditThreads = {}; // `${kind}:${id}` → [{who, text}]
const openComponentEditChat = (id, name, { kind = 'component' } = {}) => {
  const endpoint = kind === 'fork' ? '/forks/edit-chat' : '/components/edit-chat';
  const capFor = kind === 'fork' ? chatCap() : cap;
  const key = `${kind}:${id}`; const hist = compEditThreads[key] || (compEditThreads[key] = []);
  const ov = document.createElement('div'); ov.className = 'qrmodal';
  ov.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:60;background:rgba(0,0,0,.45)';
  ov.innerHTML = `<div class="qrcard" style="width:min(560px,93vw);max-height:84vh;display:flex;flex-direction:column;text-align:left;padding:0;overflow:hidden">
    <div style="padding:11px 14px;border-bottom:1px solid var(--edge);display:flex;align-items:center;gap:8px">
      <b style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">🧩 ${esc(name)} <span class="pill">live edit</span> <span class="pill" data-ce-bl style="display:none;color:var(--bad)">⚑ 0</span></b>
      <button class="mini" data-ce-close>✕</button></div>
    <div id="ce-log" style="flex:1;overflow:auto;padding:12px 14px;display:flex;flex-direction:column;gap:8px;min-height:120px">
      <div data-ce-backlog style="display:none;border:1px solid var(--edge);border-radius:9px;padding:8px 10px;font-size:12px"></div>
      <div class="pmeta">Talk to <b>${esc(name)}</b>'s agent — describe a change and it edits this component live (a new, revertable version, applied on the spot). e.g. "make the header teal", "add a copy button", "show the newest first". Revert any version in the Components tab.</div></div>
    <div style="padding:10px 12px;border-top:1px solid var(--edge);display:flex;gap:6px">
      <input id="ce-input" class="hdr-sel" style="flex:1;min-width:0" placeholder="Describe a change to ${esc(name)}…" autocomplete="off">
      <button class="mini primary" id="ce-send">Send</button></div></div>`;
  document.body.appendChild(ov);
  const logEl = ov.querySelector('#ce-log'), input = ov.querySelector('#ce-input');
  const close = () => { try { blAbort.abort(); } catch { /* */ } ov.remove(); }; ov.querySelector('[data-ce-close]').onclick = close; ov.onclick = e => { if (e.target === ov) close(); };
  // ── the object's BACKLOG, live: FOLLOW the backlog:<id> propagator cell over the one /cells/subscribe
  //    broker (owner-only server-side — a non-owner just never sees the panel). The store PUSHES on every
  //    add/ack (an auto-filed runtime error, a recipient's ⚑ report), so the badge + list update with no
  //    refresh. ✓ marks an item done via the owner facet's ack verb; the cell push repaints this panel.
  const blAbort = new AbortController();
  const blPill = ov.querySelector('[data-ce-bl]'), blBox = ov.querySelector('[data-ce-backlog]');
  const ackPath = kind === 'fork' ? '/forks/backlog/ack' : '/components/backlog/ack';
  const paintBacklog = v => {
    const items = (v && v.open) || [];
    blPill.style.display = items.length ? '' : 'none'; blPill.textContent = `⚑ ${items.length}`;
    blBox.style.display = items.length ? '' : 'none'; blBox.innerHTML = '';
    if (!items.length) return;
    const head = document.createElement('div'); head.style.cssText = 'font-weight:600;color:var(--bad);margin-bottom:4px'; head.textContent = `⚑ ${items.length} open backlog item${items.length === 1 ? '' : 's'} — the agent sees these too`; blBox.appendChild(head);
    for (const it of items.slice(0, 8)) {
      const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:6px;align-items:flex-start;padding:2px 0';
      const txt = document.createElement('div'); txt.style.cssText = 'flex:1;min-width:0;color:var(--ink)';
      txt.textContent = `[${it.kind}] ${it.title}${it.count > 1 ? ` (×${it.count})` : ''}`;
      const sub = document.createElement('div'); sub.style.cssText = 'font-size:10px;color:var(--mut)'; sub.textContent = `from ${it.from || 'unknown'}`; txt.appendChild(sub);
      const done = document.createElement('button'); done.className = 'mini'; done.textContent = '✓'; done.title = 'mark resolved';
      done.onclick = async () => { done.disabled = true; try { await fetch(ackPath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: capFor, id, itemId: it.id, status: 'done' }) }); } catch { /* the cell push repaints either way */ } };
      row.append(txt, done); blBox.appendChild(row);
    }
  };
  (async () => { // one open stream; the server pushes the current value + every change (never polls)
    try {
      const res = await fetch('/cells/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: capFor, cells: [`backlog:${id}`] }), signal: blAbort.signal });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = block.split('\n').find(l => l.startsWith('data:')); if (!line) continue;
          try { const m = JSON.parse(line.slice(5).trim()); if (m && !m.error && m.value) paintBacklog(m.value); } catch { /* ignore malformed frame */ }
        }
      }
    } catch { /* aborted / not the owner — panel stays hidden */ }
  })();
  const bubble = (who, text) => { const d = document.createElement('div'); d.style.cssText = `align-self:${who === 'you' ? 'flex-end' : 'flex-start'};max-width:86%;padding:7px 10px;border-radius:9px;font-size:13px;white-space:pre-wrap;background:${who === 'you' ? 'var(--acc-fill)' : 'rgba(127,127,127,.14)'};color:${who === 'you' ? '#fff' : 'var(--ink)'}`; d.textContent = text; logEl.appendChild(d); logEl.scrollTop = logEl.scrollHeight; return d; };
  hist.forEach(m => bubble(m.who, m.text));
  let busyCe = false;
  // BOTH kinds run the REAL agent loop (P2): a conversational editor that reads the source, asks clarifying
  // questions, and edits — /components/edit-chat for components, /forks/edit-chat for forks (P2-for-forks).
  const send = async () => {
    const change = (input.value || '').trim(); if (!change || busyCe) return;
    busyCe = true; input.value = ''; bubble('you', change); hist.push({ who: 'you', text: change });
    const pend = bubble('agent', '…');
    try {
      let msg;
      const priorHistory = hist.slice(0, -1).map(m => ({ role: m.who === 'you' ? 'user' : 'assistant', content: m.text }));
      const r = await (await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: capFor, id, message: change, history: priorHistory }) })).json();
      if (!r.ok) msg = `⚠️ ${r.error || 'failed'}`;
      else { msg = r.answer || (r.edited ? '✓ updated.' : '(no reply)'); if (r.edited) msg += `  ·  v${r.edited.version}${r.edited.review && r.edited.review.worst && r.edited.review.worst !== 'none' ? ` · review: ${r.edited.review.worst}` : ''} — applied live`; }
      if (r.edited) {
        // an APP-CHROME edit applies LIVE: re-fetch the new HEAD source + repaint every chrome site
        // (reloadChromeComps itself re-runs renderTx + the welcome mount); everything else re-renders in place.
        if (/^chrome-/.test(String(id))) { try { await reloadChromeComps(); } catch { /* repaint is best-effort */ } }
        else { try { renderTx(); } catch { /* re-render mounted components + forks */ } }
        if (curTab === 'components') { try { refreshComponents(); } catch { /* */ } }
      }
      pend.textContent = msg; hist.push({ who: 'agent', text: msg });
    } catch (e) { pend.textContent = `⚠️ ${e.message}`; }
    busyCe = false; logEl.scrollTop = logEl.scrollHeight; input.focus();
  };
  ov.querySelector('#ce-send').onclick = send;
  input.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
  setTimeout(() => input.focus(), 30);
};
window.openComponentEditChat = openComponentEditChat; // reachable from the 🔀 switch "try before adopt" + tests
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
// component-projects as the trie grows). Owner-only. On MOBILE (no Alt, no hover) the header ⌥ button
// is a sticky ONE-SHOT modifier: arm → next tap selects (see the sticky block inside).
const componentSelect = () => {
  let altHeld = false, hoverEl = null;
  // While Alt is held, drop pointer-events on confined-component iframes so the PARENT receives the hover
  // and click (a sandboxed iframe otherwise swallows them — the reason in-chat components were unselectable).
  // pointer-events:none grants the frame nothing: the sandbox/CSP boundary is untouched; it only routes the
  // OWNER's pointer to the wrapper while Alt is down, and restores normal interaction the instant Alt lifts.
  const sstyle = document.createElement('style'); sstyle.textContent = '.comp-select .gw-component iframe{pointer-events:none!important}.comp-select .gw-component{cursor:pointer}#comp-select-btn.armed{color:#fff;background:var(--acc-fill,#7a4ce6);border-radius:8px;box-shadow:0 0 0 2px var(--acc,#7c5cff)}'; document.head.appendChild(sstyle);
  const outline = document.createElement('div');
  outline.style.cssText = 'position:fixed;z-index:9000;pointer-events:none;border:1px solid var(--bad,#f85149);box-shadow:0 0 7px var(--bad,#f85149);display:none;transition:all .05s ease;'; // 1px impact-colour line (themes via --bad)
  const label = document.createElement('div');
  label.style.cssText = 'position:absolute;top:0;left:0;color:var(--bad,#f85149);background:rgba(0,0,0,.6);font:600 11px ui-monospace,Menlo,Consolas,monospace;padding:1px 5px;white-space:nowrap;';
  outline.appendChild(label);
  const HINT_ALT = '⌥ Alt-click a component to edit it with its agent';
  const HINT_STICKY = 'Tap a component to edit it — tap the ⌥ button again to cancel';
  const hint = document.createElement('div');
  hint.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:9001;background:#0d1117f2;border:1px solid var(--acc,#39d3ff);color:#e6edf3;font:12px -apple-system,sans-serif;padding:6px 13px;border-radius:20px;display:none;pointer-events:none;';
  hint.textContent = HINT_ALT;
  const chip = document.createElement('div');
  chip.style.cssText = 'position:fixed;z-index:9002;display:none;gap:6px;background:#0d1117f7;border:1px solid var(--acc,#39d3ff);border-radius:10px;padding:6px 7px;box-shadow:0 10px 34px rgba(0,0,0,.6);font:12px -apple-system,sans-serif;align-items:center;';
  document.body.append(outline, hint, chip);
  // a "component" = any element carrying its project id (the Studio) OR a live in-chat confined component
  // OR a live mounted FORK ([data-fork-id]). Forks select for any cap-holder; components stay root-only.
  // TRUSTED PATH (dan's hard boundary, explicit DENYLIST not omission): anything inside [data-trusted-path]
  // — the scope-consent sheet, the Shares panel (power grant/revoke + auto-confirm rules), proposal
  // confirms — is NOT selectable chrome. Selection REFUSES it with a distinct 🔒 indicator so the boundary
  // is legible, and tagComponent (islands.js) refuses to give those surfaces a component identity at all.
  const trustedOf = el => { try { return el && el.closest ? el.closest('[data-trusted-path]') : null; } catch { return null; } };
  const tagOf = el => (el && el.closest && !trustedOf(el) ? el.closest('[data-fork-id], [data-component-id], .gw-component') : null);
  const isForkEl = el => !!(el && el.closest && el.closest('[data-fork-id]'));
  const hasForks = () => !!document.querySelector('[data-fork-id]');
  const canEngage = () => isRoot || hasForks(); // forks are alt-selectable even without the root cap
  const setAlt = on => { altHeld = on; hint.style.display = on ? 'block' : 'none'; document.documentElement.classList.toggle('comp-select', on); if (!on && (!chip.style.display || chip.style.display === 'none')) { outline.style.display = 'none'; hoverEl = null; } };
  // ── ⌥ STICKY one-shot modifier (mobile: no Alt key, no hover). A header button ARMS select mode for the
  // NEXT tap, sticky-keys/caps style: armed → the same outline/hint UI as holding Alt; the next tap on a
  // taggable element runs the normal chip flow then AUTO-DISARMS (one-shot). A tap on a trusted-path surface
  // 🔒-refuses and STAYS armed (so the user can pick a valid target); a tap on empty space, Escape, or the
  // button itself cancels. Desktop alt-hover/click is untouched — the button also works there (discoverability).
  let stickyArmed = false;
  const isSelectActive = e => !!(e && e.altKey) || stickyArmed || switchArmed; // switchArmed set below (same closure scope)
  const stickyBtn = document.createElement('button');
  stickyBtn.id = 'comp-select-btn'; stickyBtn.className = 'iconbtn hide'; stickyBtn.textContent = '⌥';
  stickyBtn.title = 'Select a component to edit (one tap)'; stickyBtn.setAttribute('aria-label', 'Select a component to edit (one tap)');
  const hdrEl = document.querySelector('header'); if (hdrEl) hdrEl.appendChild(stickyBtn);
  const armSticky = () => { stickyArmed = true; stickyBtn.classList.add('armed'); hint.textContent = HINT_STICKY; setAlt(true); };
  const disarmSticky = () => { if (!stickyArmed) return; stickyArmed = false; stickyBtn.classList.remove('armed'); setAlt(false); hint.textContent = HINT_ALT; };
  stickyBtn.onclick = () => { if (stickyArmed) disarmSticky(); else if (canEngage()) armSticky(); };
  const syncStickyBtn = () => { const on = canEngage(); stickyBtn.classList.toggle('hide', !on); if (!on) disarmSticky(); };
  syncStickyBtn(); setInterval(syncStickyBtn, 3000); // isRoot lands async at boot; forks mount later
  const place = el => { if (!el) { outline.style.display = 'none'; return; } const r = el.getBoundingClientRect(); outline.style.display = 'block'; outline.style.borderStyle = 'solid'; outline.style.borderColor = 'var(--bad,#f85149)'; outline.style.boxShadow = '0 0 7px var(--bad,#f85149)'; label.style.color = 'var(--bad,#f85149)'; outline.style.left = `${r.left - 1}px`; outline.style.top = `${r.top - 1}px`; outline.style.width = `${r.width}px`; outline.style.height = `${r.height}px`; label.textContent = (el.closest && el.closest('[data-fork-id]') ? `⑂ ${el.closest('[data-fork-id]').getAttribute('data-fork-name') || 'fork'}` : '') || el.getAttribute('data-component-name') || el.getAttribute('data-component-id') || 'component'; }; // formal name, impact-colour monospace, top-left
  // the 🔒 REFUSAL indicator: a muted, dashed outline + "🔒 trusted path" label — visibly NOT the edit
  // affordance. Selection never proceeds from here (no chip, no edit chat, no break-out).
  const placeTrusted = el => { if (!el) { outline.style.display = 'none'; return; } const r = el.getBoundingClientRect(); outline.style.display = 'block'; outline.style.borderStyle = 'dashed'; outline.style.borderColor = 'var(--mut,#8b949e)'; outline.style.boxShadow = 'none'; label.style.color = 'var(--mut,#8b949e)'; outline.style.left = `${r.left - 1}px`; outline.style.top = `${r.top - 1}px`; outline.style.width = `${r.width}px`; outline.style.height = `${r.height}px`; label.textContent = '🔒 trusted path'; };
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

  // ══ 🔀 VIEW SWITCH — rotate a component through ALTERNATIVE VIEWS of the SAME data (dan's marquee gesture)
  // While a component is focused (⌥-hover, or after the sticky ⌥ arm) holding SHIFT — or the 🔀 toolbar toggle
  // next to ⌥, or the 🔀 chip button — enters SWITCH mode: the SAME props re-render through a DIFFERENT confined
  // (endowments,props)=>vnode source, previewed LIVE in an app-switcher overlay, committed only on Adopt/Enter.
  //   • ↑ / ↓  + scroll  — this component's HISTORY versions, a commit log (/components/history → /components/read)
  //   • ←                — UPSTREAM: toward the canonical / one-size-fits-all (the component itself / its seed)
  //   • →                — DOWNSTREAM: peers' forks & shared variants (/forks/list) — the social / custom axis
  //   • Enter / ✓ Adopt  — pop the focused view into position: a version SETTLES via /components/revert; a fork
  //                        via the existing fork-adopt path (openForkInChat). NO new server route.
  //   • 💬 chat          — "try before adopt": route the focused candidate into its edit chat first.
  // A candidate that fails to render is kept OUT of rotation with a legible note — the live view is never touched
  // until adopt, and a broken source can't strand the user on a blank. Trusted-path surfaces are un-switchable
  // (same 🔒 refusal as select). PEER-VARIANT GAP: a first-class "other people's variants of THIS component"
  // feed isn't reachable from the existing client routes (dist-trust surfaces are review-scoped), and /forks/*
  // vends only the CURRENT source of a fork (no per-version fork source) — so the downstream axis falls back to
  // the owner's OWN forks (current source each) and full ↑/↓ history is the CANONICAL node's. Noted, not worked
  // around with a server route (a reliability worker is in server.mjs).
  const swFetch = (p, b) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json()).catch(() => null);
  const srcOfFiles = f => { if (!f) return ''; if (f['component.js'] || f['tool.js'] || f['index.js']) return f['component.js'] || f['tool.js'] || f['index.js']; const js = Object.keys(f).find(k => /\.js$/.test(k)); return js ? f[js] : ''; };
  let switchState = null; // { id, kind, name, props, nodes:[{kind,id,label,versions?,curSrc?}], xi, vi, homeXi, ui:{...} }
  const buildNodes = async (id, kind, name) => {
    const nodes = [];
    nodes.push(kind === 'fork' ? { kind: 'fork', id, label: `⑂ ${name}` } : { kind: 'component', id, label: `${name} · canonical` }); // the focused node, upstream-most
    try { const fl = await swFetch('/forks/list', { cap: chatCap() }); if (fl && fl.ok) for (const f of (fl.forks || [])) { if (f.id === id) continue; nodes.push({ kind: 'fork', id: f.id, label: `⑂ ${f.name || 'fork'}` }); } } catch { /* forks are the optional downstream axis */ }
    return nodes;
  };
  const loadVersions = async node => {
    if (node.versions) return node.versions;
    if (node.kind === 'fork') {
      const r = await swFetch('/forks/read', { cap: chatCap(), id: node.id }); // /forks/* vends only the CURRENT source (the per-version gap)
      node.versions = [{ source: (r && r.ok) ? r.source : '', label: 'current', at: (r && r.updatedAt) || '' }];
    } else {
      const h = await swFetch('/components/history', { cap, id: node.id }); // newest-first: vi 0 = HEAD (live)
      const vs = (h && h.ok && Array.isArray(h.versions)) ? h.versions : [];
      node.versions = vs.map(v => ({ version: v.version, label: v.summary || String(v.version).slice(0, 8), at: v.at, source: null }));
      if (!node.versions.length) { const r = await swFetch('/components/read', { cap, id: node.id, version: 'HEAD' }); if (r && r.ok) node.versions = [{ version: 'HEAD', source: srcOfFiles(r.files) || r.source || '', label: 'HEAD' }]; }
    }
    return node.versions;
  };
  const versionSource = async (node, vi) => {
    const v = node.versions[vi]; if (!v) return '';
    if (v.source != null) return v.source;
    const r = await swFetch('/components/read', { cap, id: node.id, version: v.version });
    v.source = (r && r.ok) ? (srcOfFiles(r.files) || r.source || '') : '';
    return v.source;
  };
  const swStyle = document.createElement('style');
  swStyle.textContent = '#sw-overlay{position:fixed;inset:0;z-index:9500;display:none;background:rgba(4,8,14,.72);backdrop-filter:blur(4px);align-items:center;justify-content:center}#sw-card{width:min(720px,92vw);max-height:84vh;display:flex;flex-direction:column;background:var(--bg,#0d1117);border:1px solid var(--acc,#39d3ff);border-radius:16px;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,.7)}#sw-bar{display:flex;align-items:center;gap:8px;padding:9px 13px;border-bottom:1px solid var(--edge);font:12px -apple-system,sans-serif;color:var(--ink)}#sw-stage{position:relative;flex:1;min-height:140px;overflow:auto;padding:14px;background:var(--panel,#0d1117)}#sw-preview{transition:transform .22s cubic-bezier(.2,.8,.2,1),opacity .22s}#sw-foot{display:flex;align-items:center;gap:8px;padding:9px 13px;border-top:1px solid var(--edge)}#sw-foot .grow{flex:1;color:var(--mut);font:11px -apple-system,sans-serif}.sw-arrow{color:var(--mut);border:1px solid var(--edge);border-radius:8px;padding:2px 8px;font:12px -apple-system,sans-serif}.sw-arrow.on{color:var(--acc);border-color:var(--acc)}#comp-switch-btn.armed{color:#fff;background:var(--acc-fill,#7a4ce6);border-radius:8px;box-shadow:0 0 0 2px var(--acc,#7c5cff)}';
  document.head.appendChild(swStyle);
  const swOverlay = document.createElement('div'); swOverlay.id = 'sw-overlay'; swOverlay.setAttribute('data-switch-overlay', '');
  swOverlay.innerHTML = `<div id="sw-card">
    <div id="sw-bar"><b id="sw-title" style="flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">🔀 switch views</b>
      <span id="sw-pos" class="pill"></span><span style="flex:1"></span>
      <span class="sw-arrow" id="sw-up">↑↓ history</span><span class="sw-arrow" id="sw-lr">← canonical · social →</span></div>
    <div id="sw-stage"><div id="sw-preview"></div></div>
    <div id="sw-foot"><span class="grow" id="sw-status">↑/↓ or scroll = versions · ←/→ = canonical ↔ forks · Enter = adopt · Esc = cancel</span>
      <button class="mini" id="sw-chat">💬 chat</button><button class="mini primary" id="sw-adopt">✓ Adopt</button><button class="mini" id="sw-x">✕</button></div></div>`;
  document.body.appendChild(swOverlay);
  const swEls = { title: swOverlay.querySelector('#sw-title'), pos: swOverlay.querySelector('#sw-pos'), stage: swOverlay.querySelector('#sw-stage'), preview: swOverlay.querySelector('#sw-preview'), status: swOverlay.querySelector('#sw-status'), up: swOverlay.querySelector('#sw-up'), lr: swOverlay.querySelector('#sw-lr') };
  swOverlay.addEventListener('click', e => { if (e.target === swOverlay) closeSwitch('switch cancelled'); });
  const setSwStatus = m => { if (swEls.status) swEls.status.textContent = m; };
  const animateSwap = (axis, dir) => {
    const c = swEls.preview; if (!c) return;
    const from = axis === 'x' ? `translateX(${dir > 0 ? '44px' : '-44px'})` : `translateY(${dir > 0 ? '34px' : '-34px'})`;
    c.style.transition = 'none'; c.style.transform = from; c.style.opacity = '0';
    requestAnimationFrame(() => { c.style.transition = 'transform .22s cubic-bezier(.2,.8,.2,1),opacity .22s'; c.style.transform = 'none'; c.style.opacity = '1'; });
  };
  const paintPreview = (src, node) => {
    const host = swEls.preview; host.innerHTML = ''; const isl = window.__fieldIslands; let ok = false, threw = false;
    try {
      if (isl && node.kind === 'component' && typeof isl.renderChrome === 'function') ok = isl.renderChrome(host, src, switchState.props, { componentId: node.id, name: switchState.name }); // reuse the chrome compile-cache
      // renderSource SWALLOWS a render-time throw (Confined returns null + fires onError) — catch that signal
      // so a broken candidate lands on the unified fallback, never a blank/partial (the live view is untouched).
      else if (isl && typeof isl.renderSource === 'function') ok = isl.renderSource(src, host, switchState.props, { name: node.label, forkId: node.kind === 'fork' ? node.id : undefined, onError: () => { threw = true; } });
    } catch { ok = false; }
    if (!ok || threw) host.innerHTML = '<div style="padding:16px;color:var(--mut);font:12px -apple-system,sans-serif">⚠︎ this view couldn’t render — kept out of rotation. Your live view is untouched.</div>';
    return ok && !threw;
  };
  const paintBar = node => {
    swEls.title.textContent = `🔀 ${node.label}`;
    const nver = (node.versions || []).length; const at = node.versions && node.versions[switchState.vi] && node.versions[switchState.vi].at;
    swEls.pos.textContent = node.kind === 'component' ? `v ${switchState.vi + 1}/${nver}${switchState.vi === 0 ? ' · live' : ''}` : 'fork';
    swEls.up.classList.toggle('on', node.kind === 'component' && nver > 1);
    swEls.lr.classList.toggle('on', switchState.nodes.length > 1);
    if (at) setSwStatus(`${node.versions[switchState.vi].label} · ${new Date(at).toLocaleString()}`);
  };
  const showCandidate = async (axis, dir) => {
    const node = switchState.nodes[switchState.xi];
    await loadVersions(node);
    if (switchState.vi >= node.versions.length) switchState.vi = node.versions.length - 1;
    if (switchState.vi < 0) switchState.vi = 0;
    const src = node.kind === 'component' ? await versionSource(node, switchState.vi) : node.versions[0].source;
    if (!switchState) return; // closed mid-flight
    paintPreview(src, node); paintBar(node); animateSwap(axis, dir);
  };
  const moveX = async dir => { const n = Math.max(0, Math.min(switchState.nodes.length - 1, switchState.xi + dir)); if (n === switchState.xi) return; switchState.xi = n; switchState.vi = 0; await showCandidate('x', dir); };
  const moveV = async dir => { const node = switchState.nodes[switchState.xi]; if (node.kind !== 'component') return; const n = Math.max(0, Math.min((node.versions || []).length - 1, switchState.vi + dir)); if (n === switchState.vi) return; switchState.vi = n; await showCandidate('y', dir); };
  const repaintLive = async id => { try { if (/^chrome-/.test(String(id))) { await reloadChromeComps(); } else { renderTx(); if (curTab === 'components') refreshComponents(); } } catch { /* live repaint is best-effort */ } };
  const adopt = async () => {
    if (!switchState) return; const node = switchState.nodes[switchState.xi];
    if (node.kind === 'component') {
      const v = node.versions[switchState.vi]; if (!v || !v.version) { closeSwitch(); return; }
      if (switchState.xi === switchState.homeXi && switchState.vi === 0) { closeSwitch('already the live view'); return; } // HEAD of the canonical = nothing to settle
      setSwStatus('adopting…');
      const r = await swFetch('/components/revert', { cap, id: node.id, version: v.version });
      if (r && r.ok) { const nid = node.id; closeSwitch(`Adopted “${v.label}” as the live view (v${String(r.version || '').slice(0, 8)}).`); repaintLive(nid); }
      else setSwStatus(`adopt: ${(r && r.error) || 'failed'}`);
    } else { // a FORK variant → the existing fork-adopt path (opens it inline; the fork widget's onAdopt settles it)
      const name = node.label.replace(/^⑂\s*/, ''); closeSwitch(`Opening ⑂ ${name} to adopt…`);
      try { openForkInChat({ id: node.id, name }, `⑂ ${name}`); } catch { /* */ }
    }
  };
  const chatCandidate = () => { if (!switchState) return; const node = switchState.nodes[switchState.xi]; const kind = node.kind === 'fork' ? 'fork' : 'component'; const id = node.id; const nm = switchState.name || node.label; closeSwitch(); try { openComponentEditChat(id, nm, { kind }); } catch { /* */ } };
  swOverlay.querySelector('#sw-adopt').onclick = adopt;
  swOverlay.querySelector('#sw-chat').onclick = chatCandidate;
  swOverlay.querySelector('#sw-x').onclick = () => closeSwitch('switch cancelled');
  const onSwitchKey = e => {
    if (!switchState) return;
    if (e.key === 'Escape') { e.preventDefault(); closeSwitch('switch cancelled'); return; }
    if (e.key === 'Enter') { e.preventDefault(); adopt(); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); moveX(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); moveX(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveV(1); }   // up the commit log = older
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveV(-1); } // down = newer, toward HEAD
  };
  const onSwitchWheel = e => { if (!switchState) return; e.preventDefault(); if (e.deltaY > 0) moveV(1); else if (e.deltaY < 0) moveV(-1); };
  function closeSwitch(msg) {
    switchState = null; swOverlay.style.display = 'none'; try { swEls.preview.innerHTML = ''; } catch { /* */ }
    removeEventListener('keydown', onSwitchKey, true); swOverlay.removeEventListener('wheel', onSwitchWheel);
    if (msg) setStatus(msg);
  }
  const enterSwitch = async el => {
    if (!el || switchState) return;
    if (trustedOf(el)) { placeTrusted(el); setStatus('🔒 trusted path — consent & permission surfaces are not switchable views'); return; }
    clearChip(); disarmSticky();
    const forkEl = el.closest ? el.closest('[data-fork-id]') : null;
    let id, kind, name, props;
    if (forkEl) { id = forkEl.getAttribute('data-fork-id'); kind = 'fork'; name = forkEl.getAttribute('data-fork-name') || 'fork'; props = el.__lastProps || forkEl.__lastProps || {}; }
    else {
      const compEl = (el.closest && el.closest('[data-component-id]')) || el;
      id = compEl && compEl.getAttribute && compEl.getAttribute('data-component-id');
      if (!id) { setStatus('break this component out into a project first — then its views are switchable'); return; }
      kind = 'component'; name = (compEl.getAttribute('data-component-name')) || 'component'; props = compEl.__lastProps || {};
    }
    if (kind === 'component' && !isRoot) { setStatus('switching component views needs the root capability'); return; }
    setStatus('🔀 gathering alternative views…');
    const nodes = await buildNodes(id, kind, name);
    switchState = { id, kind, name, props, nodes, xi: 0, vi: 0, homeXi: 0 };
    swOverlay.style.display = 'flex';
    addEventListener('keydown', onSwitchKey, true); swOverlay.addEventListener('wheel', onSwitchWheel, { passive: false });
    await showCandidate('x', 0);
  };

  // ── 🔀 toolbar toggle (mobile + discoverability), sibling of the ⌥ button: arms switch-on-next-tap. ──
  let switchArmed = false;
  const switchBtn = document.createElement('button');
  switchBtn.id = 'comp-switch-btn'; switchBtn.className = 'iconbtn hide'; switchBtn.textContent = '🔀';
  switchBtn.title = 'Switch a component through its alternative views (one tap, then ←/→/↑/↓)'; switchBtn.setAttribute('aria-label', 'Switch a component through its alternative views');
  if (hdrEl) hdrEl.appendChild(switchBtn);
  const armSwitch = () => { switchArmed = true; switchBtn.classList.add('armed'); hint.textContent = 'Tap a component to switch its views — tap 🔀 again to cancel'; setAlt(true); };
  const disarmSwitch = () => { if (!switchArmed) return; switchArmed = false; switchBtn.classList.remove('armed'); setAlt(false); hint.textContent = HINT_ALT; };
  switchBtn.onclick = () => { if (switchArmed) disarmSwitch(); else if (canEngage()) { disarmSticky(); armSwitch(); } };
  const syncSwitchBtn = () => { const on = canEngage(); switchBtn.classList.toggle('hide', !on); if (!on) disarmSwitch(); };
  syncSwitchBtn(); setInterval(syncSwitchBtn, 3000);

  addEventListener('keydown', e => { if ((e.key === 'Alt' || e.altKey) && canEngage()) setAlt(true); });
  addEventListener('keyup', e => { if ((e.key === 'Alt' || !e.altKey) && !stickyArmed) setAlt(false); });
  addEventListener('blur', () => { if (!stickyArmed) setAlt(false); }); // alt-tab / focus loss → never leave iframes disabled (sticky survives — it's an explicit mode)
  // Drive selection off EACH event's own altKey, not just a captured Alt keydown. The keydown frequently never
  // reaches the window — focus sits inside a sandboxed component iframe, or the OS/browser swallows Alt — which
  // is why holding Alt did nothing. mousemove/click both carry altKey regardless of focus, so any Alt-move
  // engages select mode (which disables the iframes' pointer-events, letting the rest of the gesture land).
  addEventListener('mousemove', e => {
    if (!canEngage()) return;
    if (isSelectActive(e)) {
      if (!altHeld) setAlt(true);
      const tp = trustedOf(e.target);
      if (tp) { hoverEl = tp; placeTrusted(tp); return; } // 🔒 legible refusal — never the edit outline
      const el = tagOf(e.target); if (el !== hoverEl) { hoverEl = el; place(el); } else if (el) place(el);
    } else if (altHeld) setAlt(false);
  }, true);
  // Touch preview while ARMED: touching paints the same outline/🔒 the mouse hover would (tap-to-select is
  // the essential path; this is live feedback). elementFromPoint sees the component WRAPPER because sticky
  // mode already dropped the confined iframes' pointer-events (the same routing trick as Alt).
  const touchPreview = e => {
    if (!(stickyArmed || switchArmed) || !canEngage()) return;
    const t = (e.touches && e.touches[0]) || null; if (!t) return;
    const under = document.elementFromPoint(t.clientX, t.clientY);
    const tp = trustedOf(under);
    if (tp) { hoverEl = tp; placeTrusted(tp); return; }
    const el = tagOf(under); hoverEl = el; place(el);
  };
  addEventListener('touchstart', touchPreview, { capture: true, passive: true });
  addEventListener('touchmove', touchPreview, { capture: true, passive: true });
  addEventListener('click', e => {
    if ((stickyArmed || switchArmed) && e.target && e.target.closest && (e.target.closest('#comp-select-btn') || e.target.closest('#comp-switch-btn'))) return; // a toolbar button's own tap — its onclick toggles
    if (switchState) return; // the switch overlay owns input while it's up
    if (!isSelectActive(e) || !canEngage()) return;
    const tp = trustedOf(e.target);
    if (tp) { e.preventDefault(); e.stopPropagation(); placeTrusted(tp); setStatus(switchArmed ? '🔒 trusted path — consent & permission surfaces are not switchable views' : '🔒 trusted path — consent & permission surfaces are not editable chrome'); return; } // armed modifier STAYS armed — pick a valid target
    const el = tagOf(e.target);
    if (!el) { // armed tap on empty space = cancel (sticky/switch only; the alt path just passes through, as before)
      if ((stickyArmed || switchArmed) && !e.altKey && !(chip.contains(e.target) || outline.contains(e.target))) { e.preventDefault(); e.stopPropagation(); disarmSticky(); disarmSwitch(); }
      return;
    }
    // 🔀 SWITCH-armed (toolbar/next-tap): a valid target enters view-switch (one-shot), before the edit chip.
    if (switchArmed) { e.preventDefault(); e.stopPropagation(); const t = el; disarmSwitch(); enterSwitch(t); return; }
    // LIVE FORK ([data-fork-id]): editable by any cap-holder via the /forks/* path. Takes priority over the
    // component branch (a fork mount is never also a Studio component).
    const forkEl = el.closest ? el.closest('[data-fork-id]') : null;
    if (forkEl) {
      e.preventDefault(); e.stopPropagation();
      const fid = forkEl.getAttribute('data-fork-id'); const fname = forkEl.getAttribute('data-fork-name') || 'fork';
      const r = el.getBoundingClientRect();
      chip.innerHTML = `<span style="color:var(--mut)">⑂ ${esc(fname)}</span> <button class="mini" data-act="fedit">✎ edit</button> <button class="mini" data-act="fswitch">🔀 switch</button> <button class="mini" data-act="ffork">⑂ fork</button> <button class="mini" data-act="x">✕</button>`;
      chip.style.display = 'flex'; chip.style.left = `${Math.min(r.left, innerWidth - 300)}px`; chip.style.top = `${Math.min(r.bottom + 6, innerHeight - 44)}px`; place(el);
      chip.querySelector('[data-act=fedit]').onclick = () => { clearChip(); openComponentEditChat(fid, fname, { kind: 'fork' }); };
      chip.querySelector('[data-act=fswitch]').onclick = () => { const t = el; clearChip(); enterSwitch(t); };
      chip.querySelector('[data-act=ffork]').onclick = () => { clearChip(); forkForkAct(fid, fname); };
      chip.querySelector('[data-act=x]').onclick = clearChip;
      disarmSticky(); // ONE-SHOT: selection landed — the sticky modifier releases (chip + outline stay)
      return;
    }
    if (!isRoot) return; // component selection (Studio + in-chat components) stays owner-only
    e.preventDefault(); e.stopPropagation();
    const id = el.getAttribute('data-component-id'); const name = el.getAttribute('data-component-name') || 'component'; const spec = el.__componentSpec;
    const r = el.getBoundingClientRect();
    const editLabel = id ? '✎ edit' : '⤴ edit (break out)';
    chip.innerHTML = `<span style="color:var(--mut)">🧩 ${esc(name)}</span> <button class="mini" data-act="edit">${editLabel}</button> ${id ? '<button class="mini" data-act="switch">🔀 switch</button> <button class="mini" data-act="fork">🍴 fork</button>' : ''} <button class="mini" data-act="x">✕</button>`;
    chip.style.display = 'flex'; chip.style.left = `${Math.min(r.left, innerWidth - (id ? 320 : 240))}px`; chip.style.top = `${Math.min(r.bottom + 6, innerHeight - 44)}px`; place(el);
    chip.querySelector('[data-act=edit]').onclick = () => { clearChip(); if (id) openComponentEditChat(id, name, { kind: 'component' }); else breakOutThenEdit(spec, name); };
    const sw = chip.querySelector('[data-act=switch]'); if (sw) sw.onclick = () => { const t = el; clearChip(); enterSwitch(t); };
    const fk = chip.querySelector('[data-act=fork]'); if (fk) fk.onclick = () => { clearChip(); forkComponentAct(id, name); };
    chip.querySelector('[data-act=x]').onclick = clearChip;
    disarmSticky(); // ONE-SHOT: selection landed — the sticky modifier releases (chip + outline stay)
  }, true);
  // SHIFT while a component is ⌥-focused (or sticky-armed) → enter 🔀 view-switch on that focused component.
  addEventListener('keydown', e => { if (e.key === 'Shift' && !switchState && (altHeld || stickyArmed) && hoverEl && !trustedOf(hoverEl)) { disarmSticky(); enterSwitch(hoverEl); } });
  addEventListener('keydown', e => { if (e.key === 'Escape' && !switchState) { clearChip(); disarmSticky(); disarmSwitch(); } });
  addEventListener('scroll', () => { if (chip.style.display === 'flex') clearChip(); }, true);
};
componentSelect();
// ── { } raw-context viewer: a top-right button revealing EXACTLY what the agent was shown this chat
//    (system persona + tool/capability manifest + message history + this turn), monospace + theme colours. ──
const fmtRawContext = c => {
  const L = [];
  L.push(`agent:    ${c.agent}`);
  L.push(`model:    ${c.model}`);
  L.push(`powers:   ${(c.powers || []).join(', ') || '(none)'}`);
  L.push(`captured: ${new Date(c.at).toLocaleString()}`);
  const msgs = c.messages || [];
  const provenance = c.preview
    ? 'PREVIEW — the system prompt this agent will receive given its current permissions (persona + tool/capability manifest). No turn has run yet.'
    : c.reconstructed ? 'reconstructed from this chat’s transcript + current persona/tools (no live capture since the last restart)'
      : 'the most recent provider messages API call';
  L.push(`messages: ${msgs.length} — ${provenance}`);
  L.push('');
  // the actual provider payload: a system message, then alternating user/assistant (+ tool results)
  for (const m of msgs) { L.push(`━━━ ${String(m.role || '?').toUpperCase()} ━━━`, m.content || '', ''); }
  if (!msgs.length) L.push('(no LLM call captured yet)');
  return L.join('\n');
};
const rawContextUI = () => {
  const btn = document.createElement('button');
  btn.id = 'ctx-btn'; btn.title = 'Reveal the raw context + messages shown to the agent';
  btn.textContent = '{ }';
  // BELOW the sticky header (don't obscure its buttons): top is set dynamically to the header's bottom edge.
  btn.style.cssText = 'position:fixed;right:max(12px,env(safe-area-inset-right));z-index:29;font:600 13px ui-monospace,Menlo,Consolas,monospace;background:var(--panel);color:var(--mut);border:1px solid var(--edge);border-radius:8px;padding:4px 9px;cursor:pointer;line-height:1';
  const positionBtn = () => { const hdr = document.querySelector('header'); btn.style.top = `${(hdr ? hdr.getBoundingClientRect().bottom : 56) + 6}px`; };
  const back = document.createElement('div');
  back.style.cssText = 'position:fixed;inset:0;z-index:90;background:rgba(0,0,0,.55);display:none;align-items:stretch;justify-content:center;padding:max(16px,env(safe-area-inset-top)) 12px max(16px,env(safe-area-inset-bottom))';
  const panel = document.createElement('div');
  panel.style.cssText = 'background:var(--bg);color:var(--ink);border:1px solid var(--edge);border-radius:12px;width:min(920px,100%);max-height:100%;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 18px 60px rgba(0,0,0,.6)';
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 13px;border-bottom:1px solid var(--edge);font:600 13px ui-monospace,Menlo,Consolas,monospace;color:var(--ink)';
  head.innerHTML = '<span style="color:var(--acc)">{ }</span><span>raw context shown to the agent</span><span style="flex:1"></span>';
  const close = document.createElement('button'); close.textContent = '✕'; close.style.cssText = 'background:var(--panel);color:var(--ink);border:1px solid var(--edge);border-radius:7px;padding:3px 9px;cursor:pointer;font:inherit';
  head.appendChild(close);
  const pre = document.createElement('pre');
  pre.style.cssText = 'margin:0;padding:13px;overflow:auto;font:12px/1.55 ui-monospace,Menlo,Consolas,monospace;color:var(--ink);white-space:pre-wrap;word-break:break-word';
  panel.append(head, pre); back.appendChild(panel); document.body.append(btn, back);
  positionBtn(); addEventListener('resize', positionBtn); setTimeout(positionBtn, 600); // header height settles after layout
  const hide = () => { back.style.display = 'none'; };
  close.onclick = hide; back.onclick = e => { if (e.target === back) hide(); };
  addEventListener('keydown', e => { if (e.key === 'Escape' && back.style.display !== 'none') hide(); });
  btn.onclick = async () => {
    pre.textContent = 'loading…'; back.style.display = 'flex';
    // Send the transcript so the server can RECONSTRUCT the context when there's no live capture (e.g. after
    // a restart) — same shape the agent's history uses.
    const history = activeTx.filter(m => m && (m.who === 'you' || m.who === 'agent') && (m.text || '').trim())
      .map(m => ({ role: m.who === 'you' ? 'user' : 'assistant', content: String(m.text) })).slice(-40);
    let r; try { r = await (await fetch('/chat/context', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: chatCap(), sessionId, history, agent: chatAgent() }) })).json(); } catch (e) { r = { error: e.message }; }
    pre.textContent = (r && r.ok) ? fmtRawContext(r.context) : '⚠︎ ' + ((r && r.error) || 'could not load context');
  };
};
rawContextUI();
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
  // 1b) TRACE VIEWS — the 5 confined ways to see how a complicated task got done (they're forkable components
  //     too). Each card is a live splash render; clicking one makes it your live trace view.
  const tvHd = document.createElement('div'); tvHd.className = 'shares-sec'; tvHd.style.cssText = 'margin:18px 0 8px'; tvHd.textContent = 'Trace views · how a task got done';
  host.appendChild(tvHd);
  const tvSec = document.createElement('div'); host.appendChild(tvSec); mountTraceViewsSection(tvSec);
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

// ── Shared, host-gated component-lifecycle actions — the authority-bearing moves. Used by chrome-studio's
//    prop callbacks (below) AND by the imperative fallback (wireComponentActions). The confined chrome-studio
//    component only RENDERS + calls these back; it never holds the cap. Admits/reverts stay exactly as gated
//    as before (window.confirm on critical/destructive; the fetch carries the operator's cap). ──
const studioAdmit = async (id, name) => {
  let r = await (await fetch('/tools/admit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, id }) })).json();
  if (r.blocked === 'critical' && !window.confirm(`The review panel flagged a CRITICAL issue in "${name}". Admit anyway?`)) return;
  if (r.blocked === 'critical') { r = await (await fetch('/tools/admit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, id, override: true }) })).json(); }
  setStatus(r.ok ? `Admitted "${name}" — it's now a live component.` : `admit: ${r.error || 'failed'}`);
  refreshComponents();
};
const studioReject = async (id, name) => {
  if (!window.confirm(`Reject "${name}"? It's discarded.`)) return;
  await fetch('/tools/reject', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, id }) });
  refreshComponents();
};
const studioRevise = async (id, name) => {
  setStatus(`Revising "${name}" against the review panel…`);
  try { const r = await (await fetch('/tools/revise', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, id }) })).json(); setStatus(r.ok ? `Revised "${name}" — ${r.converged ? '✓ converged (clean)' : `${r.rounds} round(s), worst now ${r.worst}`}.` : `revise: ${r.error || 'failed'}`); }
  catch (e) { setStatus('revise failed: ' + e.message); }
  refreshComponents();
};
const studioRevert = async (id, version) => {
  if (!window.confirm('Revert the LIVE component to this version? Non-destructive — it makes a new version; the live tool then runs it.')) return;
  await fetch('/components/revert', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, id, version }) });
  if (/^chrome-/.test(String(id))) { try { await reloadChromeComps(); } catch { /* repaint is best-effort */ } }
  refreshComponents();
};

const refreshComponents = async () => {
  const list = $('components-list'); if (!list) return;
  // ── aggregate the FOUR data sources into ONE render-safe props object (the audit's plan). Every action
  //    becomes a HOST callback (props ARE the boundary — no new authority in the confined component). ──
  let all = [];
  try { const r = await (await fetch('/tools/review', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) })).json(); all = r.tools || []; }
  catch { list.innerHTML = '<div class="pill">could not load components</div>'; return; }
  const pending = all.filter(t => t.status === 'pending');
  const tools = all.filter(t => t.status === 'admitted');
  updateComponentsBadge(pending.length);
  // App chrome (registry-backed shell pieces) + per-id history.
  let chromes = []; const chh = {};
  try { const cr = await (await fetch('/chrome/components')).json(); chromes = (cr && cr.components) || [];
    await Promise.all(chromes.map(async c => { try { const h2 = await (await fetch('/components/history', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, id: c.id }) })).json(); chh[c.id] = h2.versions || []; } catch { chh[c.id] = []; } })); }
  catch { /* section just omitted */ }
  // Islands (confined-Preact UI whose source is a client file) + per-id history.
  let islandList = []; const ih = {};
  try { const ir = await (await fetch('/components/islands', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) })).json(); islandList = ir.islands || [];
    await Promise.all(islandList.map(async i => { try { const h = await (await fetch('/components/history', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, id: i.id }) })).json(); ih[i.id] = h.versions || []; } catch { ih[i.id] = []; } })); }
  catch { /* section just omitted */ }
  // Admitted library tools: history + live grain data.
  const hists = {}; const grains = {};
  await Promise.all(tools.map(async t => { try { const h = await (await fetch('/components/history', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, id: t.id }) })).json(); hists[t.id] = h.versions || []; grains[t.id] = h.grains || {}; } catch { hists[t.id] = []; grains[t.id] = {}; } }));

  const nameOf = id => { for (const a of [tools, chromes, islandList]) { const x = a.find(e => e.id === id); if (x) return x.name; } return id; };
  const vmap = vs => (vs || []).map((v, i) => ({ version: v.version, summary: v.summary || '', current: i === 0 }));
  const props = {
    pending: pending.map(t => {
      const rv = t.review; const rl = t.reviseLog;
      return {
        id: t.id, name: t.name, by: t.proposedBy || '?', worst: rv ? rv.worst : 'reviewing…',
        findings: rv ? rv.findings.map(f => `${f.discipline}: ${f.severity}`).join(' · ') : 'running the discipline panel…',
        code: t.code || (t.files ? Object.entries(t.files).map(([k, v]) => `// ${k}\n${v}`).join('\n\n') : ''),
        revise: rl ? { converged: !!rl.converged, rounds: rl.rounds || 0, worst: rl.worst || '?' } : null,
      };
    }),
    admitted: tools.map(t => ({ id: t.id, name: t.name, kind: t.kind || 'instance', versions: vmap(hists[t.id]), grains: Object.entries(grains[t.id] || {}).map(([k, v]) => ({ k, v })) })),
    chrome: chromes.map(c => ({ id: c.id, name: c.name, versions: vmap(chh[c.id]) })),
    islands: islandList.map(i => ({ id: i.id, name: i.name, versions: vmap(ih[i.id]) })),
    // the affordance callbacks — the ocap boundary. Names are resolved host-side from the fetched data.
    onAdmit: id => { const t = pending.find(x => x.id === id); studioAdmit(id, t ? t.name : id); },
    onReject: id => { const t = pending.find(x => x.id === id); studioReject(id, t ? t.name : id); },
    onRevise: id => { const t = pending.find(x => x.id === id); studioRevise(id, t ? t.name : id); },
    onEdit: id => editComponent(id, nameOf(id)),
    onFork: id => forkComponentAct(id, nameOf(id)),
    onRevert: (id, version) => studioRevert(id, version),
  };
  // (a) mount chrome-studio through the confined path (registry-backed → its section ORDER is alt-click
  //     editable). (b) renderChrome returns false on ANY failure — compile/mount throw, or lockdown off —
  //     so we fall through to the imperative LEGACY builder below (the anti-brick floor: never a dead list).
  await chromeReady;
  if (mountChrome('chrome-studio', list, props)) return;

  // ── LEGACY FALLBACK (NEVER deleted — anti-brick floor per the recipe). The original imperative builder,
  //    reusing the data already fetched above; wired by wireComponentActions. Reachable whenever chrome-studio
  //    can't render, so admit/edit/revert stay usable even if a broken chrome-studio edit slips the gate. ──
  let html = '';
  if (pending.length) {
    html += `<div class="shares-sec">🆕 Pending review (${pending.length})</div>`;
    html += pending.map(t => {
      const rv = t.review; const sev = rv ? rv.worst : 'reviewing…';
      const findings = rv ? rv.findings.map(f => `${esc(f.discipline)}: ${esc(f.severity)}`).join(' · ') : 'running the discipline panel…';
      const code = t.code || (t.files ? Object.entries(t.files).map(([k, v]) => `// ${k}\n${v}`).join('\n\n') : '');
      const sevClass = sev === 'critical' ? ' bad' : '';
      const rl = t.reviseLog;
      const dialogue = rl ? `<details style="margin:6px 0 0 6px" open><summary class="mini" style="display:inline-block">🔧 revise dialogue · ${rl.converged ? '✓ converged' : `${esc(String(rl.rounds || 0))} round(s) · worst ${esc(rl.worst || '?')}`}</summary>${(rl.log || []).map(r => r.error
        ? `<div class="sub" style="margin:3px 0 0 8px;color:var(--bad)">round ${esc(String(r.round))}: ${esc(r.error)}</div>`
        : `<div class="sub" style="margin:5px 0 0 8px"><b>round ${esc(String(r.round))}</b> · ${esc(r.worstBefore || '?')} → ${esc(r.worstAfter || '?')}</div>${(r.resolutions || []).map(x => `<div class="sub" style="margin:1px 0 0 16px">• ${esc(x.finding || '')} ${x.action ? `<span class="pill">${esc(x.action)}</span>` : ''} ${esc(x.how || '')}</div>`).join('')}`).join('')}</details>` : '';
      return `<div class="comp"><div class="comp-head"><b>${esc(t.name)}</b> <span class="pill${sevClass}">by ${esc(t.proposedBy || '?')} · panel: ${esc(sev)}</span> <button class="mini" data-admit="${esc(t.id)}" data-name="${esc(t.name)}" data-worst="${esc(rv ? rv.worst : '')}">admit</button> <button class="mini" data-revise="${esc(t.id)}" data-name="${esc(t.name)}" title="Hand the panel's findings back to the developer to integrate / note / unify into an elegant solution, then re-review">✨ revise</button> <button class="mini bad" data-reject="${esc(t.id)}" data-name="${esc(t.name)}">reject</button></div><div class="sub" style="margin:4px 0 0 6px">${findings}</div>${dialogue}<details style="margin:5px 0 0 6px"><summary class="mini" style="display:inline-block">view code</summary><pre class="codeview">${esc(code)}</pre></details></div>`;
    }).join('');
  }
  let chromeHtml = '';
  if (chromes.length) {
    chromeHtml = `<div class="shares-sec">App chrome (live UI · applies on edit, no rebuild)</div>` + chromes.map(c => {
      const vs = chh[c.id] || []; const cur = vs[0];
      const rows = vs.map((v, k) => `<div class="cver"><span class="vmono">${esc(String(v.version).slice(0, 8))}</span> <span class="sub">${esc(v.summary || '')}</span>${k === 0 ? ' <span class="pill">current</span>' : ` <button class="mini" data-revert="${esc(c.id)}" data-ver="${esc(v.version)}">revert</button>`}</div>`).join('');
      return `<div class="comp" data-component-id="${esc(c.id)}" data-component-name="${esc(c.name)}"><div class="comp-head"><b>${esc(c.name)}</b> <span class="pill">chrome${cur ? ` · v ${esc(String(cur.version).slice(0, 8))}` : ''}</span> <button class="mini" data-edit="${esc(c.id)}" data-name="${esc(c.name)}">✎ edit</button></div><div class="cvers">${rows || '<span class="sub">no versions yet</span>'}</div></div>`;
    }).join('');
  }
  let islandsHtml = '';
  if (islandList.length) {
    islandsHtml = `<div class="shares-sec">Islands (live UI · rebuilt on edit)</div>` + islandList.map(i => {
      const vs = ih[i.id] || []; const cur = vs[0];
      const rows = vs.map((v, k) => `<div class="cver"><span class="vmono">${esc(String(v.version).slice(0, 8))}</span> <span class="sub">${esc(v.summary || '')}</span>${k === 0 ? ' <span class="pill">current</span>' : ` <button class="mini" data-revert="${esc(i.id)}" data-ver="${esc(v.version)}">revert</button>`}</div>`).join('');
      return `<div class="comp" data-component-id="${esc(i.id)}" data-component-name="${esc(i.name)}"><div class="comp-head"><b>${esc(i.name)}</b> <span class="pill">island${cur ? ` · v ${esc(String(cur.version).slice(0, 8))}` : ''}</span> <button class="mini" data-edit="${esc(i.id)}" data-name="${esc(i.name)}">✎ edit</button></div><div class="cvers">${rows || '<span class="sub">no versions yet</span>'}</div></div>`;
    }).join('');
  }
  if (!tools.length) { list.innerHTML = (html + chromeHtml + islandsHtml) || '<div class="pill">no components yet — ask the agent in chat to build a tool (proposeTool); it shows up here to review + admit</div>'; wireComponentActions(); return; }
  if (pending.length) html += `<div class="shares-sec">Admitted</div>`;
  html += tools.map(t => {
    const vs = hists[t.id] || []; const cur = vs[0];
    const rows = vs.map((v, i) => `<div class="cver"><span class="vmono">${esc(String(v.version).slice(0, 8))}</span> <span class="sub">${esc(v.summary || '')}</span>${i === 0 ? ' <span class="pill">current</span>' : ` <button class="mini" data-revert="${esc(t.id)}" data-ver="${esc(v.version)}">revert</button>`}</div>`).join('');
    const gks = Object.keys(grains[t.id] || {});
    const gview = gks.length ? `<div class="cgrains sub">🌱 data: ${gks.map(k => `${esc(k)}=${esc(JSON.stringify(grains[t.id][k]))}`).join(' · ')} <span style="opacity:.6">(survives edits/reverts)</span></div>` : '';
    return `<div class="comp" data-component-id="${esc(t.id)}" data-component-name="${esc(t.name)}"><div class="comp-head"><b>${esc(t.name)}</b> <span class="pill">${esc(t.kind || 'instance')}${cur ? ` · v ${esc(String(cur.version).slice(0, 8))}` : ''}</span> <button class="mini" data-edit="${esc(t.id)}" data-name="${esc(t.name)}">✎ edit</button> <button class="mini" data-fork="${esc(t.id)}" data-name="${esc(t.name)}">fork</button></div>${gview}<div class="cvers">${rows || '<span class="sub">no versions recorded yet</span>'}</div></div>`;
  }).join('');
  list.innerHTML = html + chromeHtml + islandsHtml;
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
  list.querySelectorAll('[data-revert]').forEach(b => { b.onclick = async () => { if (!window.confirm('Revert the LIVE component to this version? Non-destructive — it makes a new version; the live tool then runs it.')) return; b.disabled = true; await fetch('/components/revert', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, id: b.dataset.revert, version: b.dataset.ver }) }); if (/^chrome-/.test(String(b.dataset.revert))) { try { await reloadChromeComps(); } catch { /* repaint is best-effort */ } } refreshComponents(); }; });
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
  // show what the OWNER's invite wallet can still cover — invite credit is CONSERVED (debited from this
  // wallet, never minted from thin air); when a member uses theirs up they buy their own (Stripe/MetaMask).
  (async () => { try { const w = await (await fetch('/wallet/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) })).json(); if (w && w.ok && $('inv-wallet')) $('inv-wallet').innerHTML = `Optional starter credit — drawn from <b>your</b> invite wallet ($${(w.remaining / 1e6).toFixed(2)} available); when they use it up they buy their own.`; } catch { /* label keeps its static text */ } })();
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
  // the invite CARRIES this usage-credit allowance (µUSD) — conserved: the server debits YOUR invite
  // wallet the same amount it credits the member's; a wallet that can't cover it refuses the invite.
  const allowanceUusd = Math.max(0, Math.round((Number($('inv-credit') && $('inv-credit').value) || 0) * 1e6));
  im.disabled = true;
  let r; try { r = await (await fetch('/invite', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, powers, label, allowanceUusd }) })).json(); } catch (e) { r = { error: e.message }; }
  im.disabled = false;
  if (!r || r.error || !r.scopedCap) { alert((r && r.error) || 'invite failed'); return; }
  const link = { url: `${location.origin}/#cap=${r.scopedCap}`, label: `invite · ${label}` };
  const credit = r.allowanceUusd > 0 ? ` · funded with <b>$${(r.allowanceUusd / 1e6).toFixed(2)}</b> usage credit (your wallet: $${((r.walletRemaining || 0) / 1e6).toFixed(2)} left)` : '';
  $('inv-out').innerHTML = `<div class="sub" style="margin-bottom:6px">✓ Invite for <b>${esc(label)}</b> — tools: ${(r.powers || []).map(p => esc(p)).join(', ')}${credit}. Hand them this link (copy or QR — don't screenshot it):</div><div style="display:flex;gap:6px"><button class="mini" id="inv-copy">copy link</button><button class="mini" id="inv-qr">show QR</button></div>`;
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
const SETTINGS_SECTIONS = [{ key: 'usage', label: '📊 Usage' }, { key: 'providers', label: '🧠 Providers' }, { key: 'agents', label: '🕸️ Agents' }, { key: 'specialists', label: '🧑‍🔬 Specialists' }, { key: 'feedback', label: '🛡️ Checks' }, { key: 'files', label: '📂 Files' }, { key: 'timers', label: '⏰ Timers' }, { key: 'internal', label: '📨 Internal' }];
let settingsSection = 'usage';
const openSettings = async () => {
  // Owners see every section; an INVITED user sees only their OWN (provider + usage), so anyone can reach the
  // BYO-provider panel — but not the owner-management sections.
  const SECTIONS = isRoot ? SETTINGS_SECTIONS : [{ key: 'providers', label: '🧠 Provider' }, { key: 'usage', label: '📊 Usage' }];
  if (!SECTIONS.some(s => s.key === settingsSection)) settingsSection = SECTIONS[0].key;
  // P4: the settings modal SHELL is an editable island (.setnav + .setbody); app.js fills #setnav (sections) +
  // #setbody. Fall back to static markup if islands aren't up or the shell didn't render its two panes.
  showModal('<div id="settings-shell"></div>');
  const mount = $('settings-shell'); let shellOk = false;
  try { if (mount && window.__fieldIslands && window.__fieldIslands.renderSettingsShell) shellOk = window.__fieldIslands.renderSettingsShell(mount); } catch { shellOk = false; }
  if (!shellOk || !$('setnav') || !$('setbody')) { if (mount) mount.innerHTML = '<div class="setwrap"><div class="setnav" id="setnav"></div><div class="setbody" id="setbody"></div></div>'; }
  $('setnav').innerHTML = SECTIONS.map(s => `<button class="setnav-item${s.key === settingsSection ? ' on' : ''}" data-sec="${s.key}">${s.label}</button>`).join('');
  document.querySelectorAll('.setnav-item').forEach(btn => { btn.onclick = () => { settingsSection = btn.getAttribute('data-sec'); document.querySelectorAll('.setnav-item').forEach(b => b.classList.toggle('on', b === btn)); renderSettingsSection(); }; });
  renderSettingsSection();
};
const renderSettingsSection = () => {
  const body = $('setbody'); if (!body) return;
  if (settingsSection === 'providers') return renderSettingsProviders(body);
  if (settingsSection === 'agents') return renderSettingsShape(body);
  if (settingsSection === 'specialists') return renderSettingsSpecialists(body);
  if (settingsSection === 'feedback') return renderSettingsGauntlet(body);
  if (settingsSection === 'files') return renderSettingsFiles(body);
  if (settingsSection === 'timers') return renderSettingsTimers(body);
  if (settingsSection === 'internal') return renderSettingsInternal(body);
  return renderSettingsUsage(body);
};
// 🧠 Your inference provider (BYO): connect your OWN anthropic/openrouter account so your turns run unlimited
// on your key (bypassing the owner's allowance). Cap-hygiene: the key is a write-only password field, sent once,
// stored server-side in the vault, and never rendered back (status only ever reports whether one is set).
const renderSettingsProviders = async (body) => {
  body.innerHTML = '<div class="set-h">🧠 Your inference provider</div><div class="pmeta">loading…</div>';
  let st = {}; try { st = await (await fetch('/byo/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) })).json(); } catch {}
  let ds = {}; try { ds = await (await fetch('/pay/delegation/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap: chatCap(), sessionId }) })).json(); } catch {}
  const $usd = u => '$' + (Math.round((u || 0) / 10000) / 100).toFixed(2);
  // BILLING card: pay for ongoing inference + hosting via a recurring MetaMask (ERC-7715) allowance. Only shown
  // when the owner has set up on-chain settlement (ds.available). Granted once → the server auto-tops-up.
  const billingCard = !ds.available ? '' : `
    <div class="set-sec" style="margin-top:14px"><div class="set-h">💳 Pay for usage — MetaMask subscription</div>
      <div class="pmeta" style="line-height:1.5;margin-bottom:8px">Grant a <b>recurring</b> spending allowance once; it auto-tops-up your inference + hosting so they keep working — no manual payment each time. Revocable from your wallet anytime.</div>
      ${ds.subscribed ? `<div class="pill" style="margin-bottom:8px">✓ Subscribed — up to ${$usd(ds.periodUusd)} / ${Math.round((ds.periodMs || 0) / 86400000)}d · ${$usd(ds.periodRemaining)} left this period</div>` : ''}
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <label class="pmeta">Up to $<input id="sub-usd" class="kit-in" style="width:64px" type="number" min="1" value="10"> per <input id="sub-days" class="kit-in" style="width:54px" type="number" min="1" value="30"> days</label>
        <button class="go" id="sub-go">${ds.subscribed ? 'Update subscription' : 'Set up subscription'}</button><span class="pmeta" id="sub-msg"></span>
      </div>
    </div>`;
  body.innerHTML = `<div class="set-h">🧠 Your inference provider</div>
    <div class="pmeta" style="line-height:1.5;margin-bottom:9px">By default your turns run on ${isRoot ? 'your' : "the owner's"} providers + prepaid allowance. Connect your OWN provider key to run <b>unlimited on your own account</b>, or set up a subscription below to pay for usage. Your key is stored securely server-side and never shown again.</div>
    ${st.connected ? `<div class="pill" style="margin-bottom:9px">✓ Connected — <b>${esc(st.provider || '')}</b> · ${esc(st.model || '')}</div>` : ''}
    <div style="display:flex;flex-direction:column;gap:7px;max-width:400px">
      <select id="byo-prov" class="kit-in"><option value="anthropic">Anthropic (Claude)</option><option value="openrouter">OpenRouter</option></select>
      <input id="byo-model" class="kit-in" placeholder="model id — e.g. claude-sonnet-4-6 or openai/gpt-4o">
      <input id="byo-key" class="kit-in" type="password" autocomplete="off" placeholder="🔒 your API key — stored securely, never shown">
      <div style="display:flex;gap:6px;align-items:center"><button class="go" id="byo-save">${st.connected ? 'Update' : 'Connect'}</button>${st.connected ? '<button class="mini" id="byo-clear">Disconnect</button>' : ''}<span class="pmeta" id="byo-msg"></span></div>
    </div>${billingCard}`;
  if ($('sub-go')) $('sub-go').onclick = async () => {
    const periodUsd = Math.max(1, Number($('sub-usd').value) || 10), periodDays = Math.max(1, Number($('sub-days').value) || 30);
    $('sub-go').disabled = true; $('sub-msg').textContent = 'opening your wallet…';
    const g = await grantMetaMaskSubscription({ periodUsd, periodDays });
    $('sub-go').disabled = false; $('sub-msg').textContent = g.ok ? '✓ subscribed — usage now auto-tops-up' : ('⚠ ' + g.error);
    if (g.ok) setTimeout(() => renderSettingsProviders(body), 800);
  };
  if (st.provider && $('byo-prov')) $('byo-prov').value = st.provider;
  if (st.model && $('byo-model')) $('byo-model').value = st.model;
  $('byo-save').onclick = async () => {
    const provider = $('byo-prov').value, model = ($('byo-model').value || '').trim(), key = $('byo-key').value;
    $('byo-save').disabled = true; $('byo-msg').textContent = 'connecting…';
    let r; try { r = await (await fetch('/byo/set', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, provider, model, key }) })).json(); } catch (e) { r = { error: e.message }; }
    $('byo-key').value = ''; $('byo-save').disabled = false; // never keep the key in the DOM
    $('byo-msg').textContent = r && r.ok ? '✓ connected — your turns now run on your own account' : ('⚠ ' + ((r && r.error) || 'failed'));
    if (r && r.ok) setTimeout(() => renderSettingsProviders(body), 700);
  };
  if ($('byo-clear')) $('byo-clear').onclick = async () => { try { await fetch('/byo/clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) }); } catch {} renderSettingsProviders(body); };
};
// 🛡️ Feedback loops — the dev agent's checks & balances surfaced as GATE-LANES (the propagator-gate model:
// each gate reads the action's cells → a verdict; the action proceeds only while the verdict holds). Read-only
// "surface what exists": the real 4-discipline review panel + the FAPO verify/auto-merge/re-verify/revert.
const renderSettingsGauntlet = async body => {
  body.innerHTML = '<div class="set-h">🛡️ Feedback loops <span style="font-size:12px;color:var(--mut);font-weight:400">— the checks an action must clear</span></div><div class="pmeta" id="gl-meta" style="margin-bottom:12px">loading…</div><div id="gl-lanes"></div>';
  let r; try { r = await (await fetch('/gauntlet', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) })).json(); } catch (e) { r = { error: e.message }; }
  if (!r || !r.ok) { $('gl-meta').textContent = '⚠︎ ' + ((r && r.error) || 'could not load'); return; }
  $('gl-meta').innerHTML = `<b>${esc(r.agent)}</b><div style="font-size:12px;margin-top:4px;line-height:1.45">${esc(r.model)}</div>`;
  const sevColor = s => ({ critical: 'var(--bad)', high: 'var(--bad)', medium: '#d29922', low: 'var(--mut)' }[String(s || '').toLowerCase()] || 'var(--mut)');
  const gateCard = g => `<div style="flex:0 0 235px;border:1px solid var(--edge);border-radius:10px;padding:10px;background:var(--bg)">
      <div style="font-weight:600;font-size:13px">▣ ${esc(g.name)}</div>
      <div style="font-size:10px;color:var(--mut);margin:2px 0 6px">${esc(g.stage)} · policy <b style="color:${/BLOCK|REVERT/.test(g.policy) ? 'var(--bad)' : 'var(--mut)'}">${esc(g.policy)}</b></div>
      <div style="font-size:11px;color:var(--ink);line-height:1.4">${esc(g.checks)}</div>
      <div style="font-size:10px;color:var(--mut);margin-top:7px;font-family:ui-monospace,Menlo,monospace">reads ⟨${esc(g.reads)}⟩ → ${esc(g.verdictCell)}</div>
      ${(g.findings && g.findings.length) ? `<div style="margin-top:7px;border-top:1px solid var(--edge);padding-top:6px">${g.findings.map(f => `<div style="font-size:11px;margin-bottom:3px"><span style="color:${sevColor(f.severity)}">●</span> <b>${esc(f.tool || '')}</b>: ${esc(f.report)}</div>`).join('')}</div>` : (g.flagged === 0 ? '<div style="font-size:10px;color:var(--ok,#3fb950);margin-top:7px">✓ nothing flagged</div>' : '')}
    </div>`;
  $('gl-lanes').innerHTML = r.lanes.map(lane => `<div style="margin-bottom:18px">
      <div style="font-weight:600;margin-bottom:2px">⟶ ${esc(lane.action)}</div>
      <div style="font-size:11px;color:var(--mut);margin-bottom:8px">cell <span style="font-family:ui-monospace,Menlo,monospace">⟨${esc(lane.cell)}⟩</span> · ${esc(lane.note || '')}</div>
      <div style="display:flex;align-items:stretch;gap:7px;overflow-x:auto;padding-bottom:6px">${lane.gates.map(gateCard).join('<div style="align-self:center;color:var(--mut);font-size:18px">→</div>')}</div>
      ${(lane.recent && lane.recent.length) ? `<div style="margin-top:7px;font-size:11px;color:var(--mut)">recent: ${lane.recent.map(m => `${m.rolledBack ? '↩ reverted' : '✓ merged'} ${esc(String(m.goal || '').slice(0, 48))} <span style="font-family:ui-monospace,monospace">${esc(m.mergeCommit || '')}</span>`).join(' · ')}</div>` : ''}
    </div>`).join('');
  $('gl-lanes').insertAdjacentHTML('beforeend', '<div class="pmeta" style="margin-top:4px;font-size:11px">Next: each gate becomes a confined <b>checker</b> you can add live (“describe a check” → an agent writes it, governed by distribution-trust).</div>');
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
  // 👛 Invite wallet (root only): the CONSERVED source every invite-carried allowance (and Bluesky
  // namespace seed) is debited from. /wallet/fund is the owner's only balance-increaser — this row
  // is its UI. Non-root users never see it (the routes are root-gated regardless).
  const walletSec = isRoot ? `<div class="set-sec"><div class="set-h">👛 Invite wallet <span class="pmeta">· funds the credit your invites carry</span></div>
    <div class="set-row"><span id="wallet-bal" class="pmeta">loading…</span></div>
    <div class="set-row">$ <input id="wallet-fund-amt" type="number" step="1" min="0" value="10" style="width:88px"> <button class="mini" id="wallet-fund-go">Add to wallet</button> <span id="wallet-fund-msg" class="pmeta"></span></div>
    <div class="pmeta">Every invite minted with a usage-credit allowance — and each Bluesky namespace's starting credit — is debited from this wallet (conserved: members can't mint credit, they top up by paying).</div></div>` : '';
  body.innerHTML = `${walletSec}<div class="set-sec"><div class="set-h">Default allowance for new conversations</div>
    <div class="set-row">$ <input id="set-allow" type="number" step="0.10" min="0" style="width:88px"> <button class="mini" id="set-allow-save">Save</button> <span id="set-allow-msg" class="pmeta"></span></div>
    <div class="pmeta">Every new chat starts prepaid with this much inference budget.</div></div>
    <div class="set-sec"><div class="set-h">💸 Most expensive conversations <span class="pmeta">· by allowance used</span></div><div id="set-costs" class="pmeta">loading…</div></div>`;
  if (isRoot) {
    const drawWallet = async () => {
      try {
        const w = await (await fetch('/wallet/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) })).json();
        const el = $('wallet-bal'); if (!el) return;
        if (w.error) { el.textContent = '⚠ ' + w.error; return; }
        const n = (w.invites || []).length;
        el.innerHTML = `<b style="color:var(--ink);font-size:15px">${fmtUsd(w.remaining)}</b> available · ${fmtUsd(w.granted)} ever funded${n ? ` · backing ${n} funded invite${n === 1 ? '' : 's'}` : ''}`;
      } catch { const el = $('wallet-bal'); if (el) el.textContent = '(could not load the wallet)'; }
    };
    drawWallet();
    const go = $('wallet-fund-go'); if (go) go.onclick = async () => {
      const msg = $('wallet-fund-msg'); const amt = Math.round((Number($('wallet-fund-amt').value) || 0) * 1e6);
      if (!amt) { msg.textContent = 'enter an amount'; return; }
      go.disabled = true; msg.textContent = 'funding…';
      try { const r = await (await fetch('/wallet/fund', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, amount: amt }) })).json(); msg.textContent = r.error ? '⚠ ' + r.error : `✓ added · ${fmtUsd(r.remaining)} available`; if (!r.error) drawWallet(); }
      catch (e) { msg.textContent = '⚠ ' + e.message; }
      go.disabled = false;
    };
  }
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
      const cb = $('fb-share-copy'); if (cb) cb.onclick = async () => { try { await navigator.clipboard.writeText(r.url); $('fb-share-msg').textContent = 'copied'; } catch { $('fb-share-msg').textContent = 'copy failed — tap Copy link again'; } }; } // cap-hygiene: never log a #cap= link to the console (it IS the credential)
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
    <input class="hdr-sel" style="max-width:none" data-rl-output="${idk}" placeholder="output contract — what the role must return" value="${esc(r.output || '')}">
    <div style="font-size:11px;color:var(--mut)">📎 always-on reference documents — vault notes folded into this role's context every time (one path per line):</div>
    <input class="hdr-sel" style="max-width:none" data-rl-foldscope="${idk}" placeholder="scope folder these docs live under (blank = whole vault)" value="${esc(r.foldScope || '')}">
    <textarea data-rl-folddocs="${idk}" placeholder="Folder/Note.md&#10;Folder/Another.md" style="${ta};min-height:54px">${esc((r.foldDocs || []).join('\n'))}</textarea>`;
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
    foldScope: val(`[data-rl-foldscope="${idk}"]`).trim(),
    foldDocs: val(`[data-rl-folddocs="${idk}"]`).split('\n').map(s => s.trim()).filter(Boolean),
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
          const lk = document.createElement('button'); lk.className = 'mini'; lk.textContent = '🔗'; lk.title = 'Copy a link to this scheduled task';
          lk.onclick = async () => flashBtn(lk, (await writeClipboard(`${location.origin}/#sched=${a.id}`)) ? '✓' : 'copy failed'); // deep-link carries ONLY the sched id (a designator, never a cap)
          const open = document.createElement('button'); open.className = 'mini'; open.textContent = 'Detail ›';
          open.onclick = () => { closeModal(); openSchedDetail(a.id); }; // → the rich per-agent Detail (prompt/powers/timing/runs), card spotlighted
          right.append(run, lk, open); row.append(main, right); el.appendChild(row);
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
// The friendly Agent EDITOR — view + edit one agent's configuration: its system prompt (persona) and its
// STANDING REFERENCE DOCUMENTS (notes always folded into its context, so it never re-reads them). Works for the
// entry agent (Agent C), the built-in domain agents (Dietician, …), and your own specialists. Root-gated server-side.
const openAgentEditor = async agentId => {
  const d = await pf('/agents/config', { agent: agentId });
  if (!d || d.error || !d.config) { showModal(`<div class="qrlabel">Agent editor</div><div class="pmeta">${esc((d && d.error) || 'could not load this agent')}</div>`); return; }
  const c = d.config;
  const ta = 'width:100%;box-sizing:border-box;background:var(--panel);color:var(--ink);border:1px solid var(--edge);border-radius:8px;padding:8px;font:inherit';
  const docRow = (val = '') => `<div class="ae-doc set-row" style="gap:6px;margin:4px 0"><input class="hdr-sel ae-docpath" style="flex:1;min-width:0" placeholder="Folder/Note.md — a vault path" value="${esc(val)}"><button class="mini bad ae-docdel" title="remove this document">×</button></div>`;
  showModal(`<div style="text-align:left;width:min(640px,90vw)">
    <div class="set-h">✏️ Edit ${esc(c.name)}${c.builtin ? (c.entry ? ' <span class="pill">entry agent</span>' : ' <span class="pill">built-in</span>') : ' <span class="pill">your specialist</span>'}</div>
    <div class="pmeta" style="margin-bottom:10px">${esc(c.domain || '')}${c.powers && c.powers.length ? ` · <span class="pmeta">holds: ${esc(c.powers.join(', '))}</span>` : ''}</div>
    <div class="set-h" style="margin-top:6px">🧠 System prompt</div>
    <div class="pmeta">This agent's standing instructions — who it is and how it works.</div>
    <textarea id="ae-instr" style="${ta};min-height:170px;margin-top:5px">${esc(c.instructions || '')}</textarea>
    <div class="set-h" style="margin-top:14px">📎 Always-on reference documents</div>
    <div class="pmeta">Vault notes this agent <b>always has on hand</b> — folded into its context every turn, so it never has to search for or re-read them (e.g. the family diet specs for the Dietician). Least authority: docs must live under the scope folder.</div>
    <div class="set-row" style="gap:6px;margin:7px 0"><span class="pill">scope</span><input id="ae-scope" class="hdr-sel" style="flex:1;min-width:0" placeholder="folder these docs live under (blank = whole vault)" value="${esc(c.foldScope || '')}"></div>
    <div id="ae-docs">${(c.foldDocs || []).map(docRow).join('')}</div>
    <button class="mini" id="ae-add" style="margin-top:4px">+ add document</button>
    <div style="margin-top:14px"><button class="mini primary" id="ae-save">Save</button> <span id="ae-out" class="pill" style="margin-left:6px"></span></div>
  </div>`);
  const docsHost = $('ae-docs');
  const wireDel = () => docsHost.querySelectorAll('.ae-docdel').forEach(b => { b.onclick = () => b.closest('.ae-doc').remove(); });
  wireDel();
  $('ae-add').onclick = () => { docsHost.insertAdjacentHTML('beforeend', docRow('')); wireDel(); const last = docsHost.querySelector('.ae-doc:last-child .ae-docpath'); if (last) last.focus(); };
  $('ae-save').onclick = async () => {
    const foldDocs = [...docsHost.querySelectorAll('.ae-docpath')].map(i => i.value.trim()).filter(Boolean);
    const out = $('ae-out'); out.textContent = 'saving…';
    const r = await pf('/agents/save', { agent: c.id, instructions: $('ae-instr').value, foldDocs, foldScope: $('ae-scope').value.trim() });
    out.textContent = r && r.ok ? 'saved ✓ — applies on the next turn' : `error: ${(r && r.error) || '?'}`;
  };
};

const renderSettingsShape = async body => {
  body.innerHTML = `<div class="set-h">🕸️ Agent shape</div>
    <div class="pmeta" style="margin-bottom:9px">The structural graph of what an agent <b>holds</b> — its powers (each fanning to the tools it can call), its specialist sub-agents, and the roles it could employ. What the agent <i>is</i> (distinct from the per-message trace, which is what it <i>did</i>). Includes the built-in domain agents (Dietician, …) + your specialists.</div>
    <div class="set-row" style="margin-bottom:9px;gap:8px"><select id="shape-agent" class="mini">${agentGroupsHtml()}</select><button class="mini primary" id="shape-edit">✏️ Edit agent</button><button class="mini" id="shape-3d">🧊 Open 3D diagram</button></div>
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
  const ed = $('shape-edit'); if (ed) ed.onclick = () => openAgentEditor(($('shape-agent') && $('shape-agent').value) || 'field-agent');
  const btn = $('shape-3d'); if (btn) btn.onclick = () => openShapePendant(shapeToSteps(lastShape));
  load();
};
{ const f = $('drawer-foot'); if (f) f.onclick = openSettings; }
{ const ib = $('info-btn'); if (ib) ib.onclick = () => { try { window.open('/successes', '_blank', 'noopener'); } catch { location.href = '/successes'; } }; } // explain the system to visitors

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
  ensureUserCap(); // MULTI-USER: mint/restore this browser's persistent per-user cap (invite-only); no UI change yet
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
  if (pendingInbox) { pendingInbox = false; try { showTab('inbox'); } catch { /* */ } } // a notification's #inbox deep-link → open the 🔔 inbox (proposals/feed live here, not a chat thread)
  if (pendingSched) { const sid = pendingSched; pendingSched = null; try { openSchedDetail(sid); } catch { /* */ } } // #sched=<id> deep-link → that scheduled task's Detail card
  loadModels(); loadAgentList(); loadProjectList(); // populate the header agent + model-provider selectors and the project menu
};
boot();

// ── Projects + scheduled agents (🕐) — set up recurring self-improvement from here ──────
// A Project groups chats + recurring "scheduled agents" (a prompt + a tool ring + a cadence)
// sharing ONE home folder. Agents run on schedule (server tick) and on demand ("Run now").
const pf = async (path, body = {}) => { try { return await (await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, ...body }) })).json(); } catch (e) { return { error: e.message }; } };
// MULTI-USER (invite-only): ensure this browser holds a persistent per-user cap, minted on first open from the
// invite cap it already holds, storing the user's prefs + Root pointer (their app variant). Idempotent; the
// user-cap is stored locally + never rendered (cap-hygiene). No UI change yet — the per-user-variant rendering
// lands with the shell→island migration (P4); this establishes the identity + prefs substrate.
const USERCAP_KEY = 'field-agent-usercap';
let userCap = '', userPrefs = {}, userRoot = 'canonical';
const ensureUserCap = async () => {
  if (!cap) return;
  try { userCap = localStorage.getItem(USERCAP_KEY) || ''; } catch { userCap = ''; }
  if (userCap) { const v = await pf('/user/get', { userCap }); if (v && v.ok) { userPrefs = v.prefs || {}; userRoot = v.root || 'canonical'; return; } userCap = ''; } // stale → re-init
  const r = await pf('/user/init', {});
  if (r && r.ok && r.userCap) { userCap = r.userCap; userPrefs = r.prefs || {}; userRoot = r.root || 'canonical'; try { localStorage.setItem(USERCAP_KEY, userCap); } catch { /* */ } }
};
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
// power → verbs catalog (the toolbox each power contributes to the agent at run time). /powers carries
// labels but not verbs; /agent/shape (owner-gated) returns the root field-agent's held powers WITH their
// verbs — a scheduled agent's ring is a subset of grantable powers, so this map resolves any tool to the
// verbs it grants. Cached once per session; falls back to bare power names when not root / offline.
let powerVerbs = {};
const loadPowerVerbs = async () => {
  if (Object.keys(powerVerbs).length) return powerVerbs;
  try {
    const s = await (await fetch('/agent/shape', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, agent: 'field-agent' }) })).json();
    for (const pw of (s && s.powers) || []) powerVerbs[pw.name] = { label: pw.label, verbs: pw.verbs || [] };
  } catch { /* not root / offline → the context view shows power names without their verbs */ }
  return powerVerbs;
};
const renderProjects = async (focusArg = null) => {
  const focusSched = typeof focusArg === 'string' ? focusArg : null; // renderProjects doubles as a click handler — ignore a MouseEvent arg
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
  await loadPowerVerbs(); // resolve each agent's tools → the verbs they grant (for the "full context" view)
  // a timer agent's runs = the scheduled seed-chats filed under it (kept out of the sidebar; here is their home)
  const agentRuns = ag => seedChats.filter(s => s && s.source === 'scheduled' && s.scheduled && s.scheduled.agent === ag.name && s.scheduled.project === p.name).sort((x, y) => (y.ts || 0) - (x.ts || 0));
  const agents = (p.scheduledAgents || []).map(a => { return `
      <div style="border:1px solid var(--edge);border-radius:8px;padding:8px;margin:6px 0" data-schedcard="${esc(a.id)}">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><b>⏰ ${esc(a.name)}</b>
          <span><button class="mini" data-run="${p.id}|${a.id}">Run now</button> <button class="mini" data-schedlink="${esc(a.id)}" title="Copy a link to this scheduled task">🔗</button> <button class="mini" data-delagent="${p.id}|${a.id}">×</button></span></div>
        <div style="color:var(--mut);font-size:12px;margin-top:3px">${esc(cadenceLabel(a.schedule))} · tools: ${esc((a.tools || []).join(', ') || 'none')}${a.enabled === false ? ' · ⏸ disabled' : ''}${a.mode === 'implement' ? ' · mode: implement' : ''}${a.model && a.model !== 'default' ? ` · model: ${esc(a.model)}` : ''}${a.alwaysReport ? ' · always-reports' : ''}${a.lastRun ? ` · ${a.lastRunChatId ? `<a href="#" data-openrun="${esc(a.lastRunChatId)}">last run ${esc(new Date(a.lastRun).toLocaleString())} ↗</a>` : `last ${esc(new Date(a.lastRun).toLocaleString())}`}` : ''}${a.nextAt ? ` · next ${esc(new Date(a.nextAt).toLocaleString())}` : ''}</div>
        ${a.note ? `<div style="color:var(--mut);font-size:11px;margin-top:2px;font-style:italic">📝 ${esc(String(a.note).slice(0, 300))}</div>` : ''}
        <div style="font-size:12px;margin-top:4px;white-space:pre-wrap">${esc((a.prompt || '').slice(0, 200))}</div>
        <details style="margin-top:6px"><summary class="mini" style="display:inline-block">✏️ edit prompt, powers &amp; environment</summary>
          <div style="margin-top:6px;display:flex;flex-direction:column;gap:6px">
            <input class="hdr-sel" style="max-width:none" data-ename="${p.id}|${a.id}" value="${esc(a.name)}">
            <textarea data-eprompt="${p.id}|${a.id}" style="background:var(--panel);border:1px solid var(--edge);color:var(--ink);border-radius:7px;padding:6px;min-height:90px">${esc(a.prompt || '')}</textarea>
            <div style="display:flex;align-items:center;gap:8px"><div style="font-size:11px;color:var(--mut)">tools (its ring):</div><button class="mini" data-epropose="${p.id}|${a.id}">✨ propose from prompt</button></div>
            <div data-etools="${p.id}|${a.id}"></div>
            <div style="display:flex;align-items:center;gap:8px"><div style="font-size:11px;color:var(--mut);min-width:48px">timing:</div><select class="hdr-sel" style="max-width:none;flex:1" data-ecad="${p.id}|${a.id}"><option value="-1">keep current · ${esc(cadenceLabel(a.schedule) || 'event-triggered')}</option>${CADENCES.map((c, i) => `<option value="${i}">${esc(c.label)}</option>`).join('')}</select></div>
            <div style="display:flex;align-items:center;gap:8px"><div style="font-size:11px;color:var(--mut);min-width:48px">model:</div><select class="hdr-sel" style="max-width:none;flex:1" data-emodel="${p.id}|${a.id}"><option value="default"${(!a.model || a.model === 'default') ? ' selected' : ''}>instance default</option>${(a.model && a.model !== 'default' && !modelList.some(md => md.id === a.model)) ? `<option value="${esc(a.model)}" selected>${esc(a.model)}</option>` : ''}${modelList.map(md => `<option value="${esc(md.id)}"${a.model === md.id ? ' selected' : ''}>${esc(md.label)}</option>`).join('')}</select></div>
            <div style="display:flex;align-items:center;gap:8px"><div style="font-size:11px;color:var(--mut);min-width:48px">mode:</div><select class="hdr-sel" style="max-width:none;flex:1" data-emode="${p.id}|${a.id}"><option value="recommend"${a.mode !== 'implement' ? ' selected' : ''}>recommend · propose only (default)</option><option value="implement"${a.mode === 'implement' ? ' selected' : ''}>implement · autonomous (needs selfImprove)</option></select></div>
            <div style="display:flex;align-items:center;gap:16px;font-size:12px;color:var(--mut)"><label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" data-eenabled="${p.id}|${a.id}"${a.enabled !== false ? ' checked' : ''}> enabled</label><label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" data-ealways="${p.id}|${a.id}"${a.alwaysReport ? ' checked' : ''}> always report (even a no-op run)</label></div>
            <div><button class="mini" data-saveagent="${p.id}|${a.id}">Save changes</button></div>
          </div></details>
        <details style="margin-top:6px"><summary class="mini" style="display:inline-block">🧬 what it runs with (full context)</summary>
          <div style="margin-top:6px;font-size:12px;color:var(--ink);display:flex;flex-direction:column;gap:6px">
            <div><span style="color:var(--mut)">model:</span> ${esc(a.model && a.model !== 'default' ? a.model : 'instance default')} · <span style="color:var(--mut)">mode:</span> ${esc(a.mode === 'implement' ? 'implement (autonomous)' : 'recommend (propose only)')} · <span style="color:var(--mut)">schedule:</span> ${esc(cadenceLabel(a.schedule) || (a.trigger ? 'event: ' + (a.trigger.source || a.trigger.kind) : 'event-triggered'))} · ${a.enabled === false ? '⏸ disabled' : '▶ enabled'}${a.alwaysReport ? ' · always-reports' : ''}</div>
            <div><span style="color:var(--mut)">persona:</span> runs under the shared field-agent persona — scheduled agents carry no separate soul/cursor.</div>
            <div><span style="color:var(--mut)">assembled toolbox</span> — the verbs its ring (${(a.tools || []).length} power${(a.tools || []).length === 1 ? '' : 's'}) grants at run time:</div>
            <div style="display:flex;flex-direction:column;gap:3px">${(a.tools || []).length ? (a.tools).map(t => { const v = (powerVerbs[t] && powerVerbs[t].verbs) || null; return `<div style="border:1px solid var(--edge);border-radius:7px;padding:4px 8px"><span title="${esc(powerTip(t))}">${powerIcon(t)} <b>${esc(t)}</b></span>${v && v.length ? ` <span style="color:var(--mut)">→ ${esc(v.join(', '))}</span>` : ' <span style="color:var(--mut)">→ (verbs resolve with the root cap)</span>'}</div>`; }).join('') : '<div style="color:var(--mut)">no powers — this agent runs with an empty ring (text-only reasoning)</div>'}</div>
            <div style="color:var(--mut);font-size:11px">The fully-materialized toolbox/persona the server assembles per run (incl. this project's home-folder handles) isn't rendered here — a live <code>/projects/agents/context-preview</code> endpoint is the follow-up.</div>
          </div></details>
        <details style="margin-top:6px" data-runlog="${esc(a.id)}"><summary class="mini" style="display:inline-block">📁 run log (${(a.runs || []).length})</summary>
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
    // "change environment" — model + mode; plus pause/report toggles. All merge server-side via the
    // existing /projects/agents/update blanket-Object.assign, so no route change is needed.
    const mv = m.querySelector(`[data-emodel="${pid}|${aid}"]`); if (mv) patch.model = mv.value;
    const mo = m.querySelector(`[data-emode="${pid}|${aid}"]`); if (mo) patch.mode = mo.value;
    const en = m.querySelector(`[data-eenabled="${pid}|${aid}"]`); if (en) patch.enabled = en.checked;
    const ar = m.querySelector(`[data-ealways="${pid}|${aid}"]`); if (ar) patch.alwaysReport = ar.checked;
    const r = await pf('/projects/agents/update', { id: pid, agentId: aid, patch });
    if (r.error) alert(r.error);
    renderProjects();
  });
  m.querySelectorAll('[data-openrun]').forEach(b => b.onclick = async e => { e.preventDefault(); const cid = b.dataset.openrun; if (!cid) return; closeModal(); pendingChat = cid; await loadSeedChats(); tryOpenPendingChat(); }); // open a past scheduled run from the Projects view
  m.querySelectorAll('[data-delrun]').forEach(b => b.onclick = async () => { const id = b.dataset.delrun; if (!id || !window.confirm('Throw away this run?')) return; seedChats = seedChats.filter(s => s.id !== id); try { localStorage.removeItem(txKey(id)); } catch {} await pf('/seed-chats/delete', { id }); renderProjects(); }); // throw away one scheduled run
  m.querySelectorAll('[data-delagent]').forEach(b => b.onclick = async () => { const [pid, aid] = b.dataset.delagent.split('|'); await pf('/projects/agents/remove', { id: pid, agentId: aid }); renderProjects(); });
  // 🔗 copy a deep-link to this scheduled task (the clips pattern): carries ONLY the sched id — a
  // designator, never a cap; the opener's own stored cap governs what it resolves to.
  m.querySelectorAll('[data-schedlink]').forEach(b => b.onclick = async () => { flashBtn(b, (await writeClipboard(`${location.origin}/#sched=${b.dataset.schedlink}`)) ? '✓' : 'copy failed'); });
  // a #sched deep-link landed here → expand + spotlight that task's card (its run history included)
  if (focusSched) { const card = m.querySelector(`[data-schedcard="${focusSched}"]`); if (card) { const dl = card.querySelector(`details[data-runlog="${focusSched}"]`); if (dl) dl.open = true; card.style.outline = '2px solid var(--acc)'; setTimeout(() => { card.style.outline = ''; }, 2500); try { card.scrollIntoView({ block: 'center' }); } catch { /* */ } } }
  m.querySelectorAll('[data-run]').forEach(b => b.onclick = async () => {
    const [pid, aid] = b.dataset.run.split('|'); const out = m.querySelector(`[data-out="${pid}|${aid}"]`);
    b.disabled = true; out.textContent = 'running…';
    const r = await pf('/projects/agents/run', { id: pid, agentId: aid });
    out.textContent = r.error ? ('error: ' + r.error) : `✓ ${String(r.answer || '').slice(0, 300)}${r.proposals ? ` · ${r.proposals} proposal(s)` : ''}`;
    b.disabled = false;
  });
};
// #sched=<id> deep-link target: find the (owner-visible) project holding that scheduled task and open its
// Detail with the task's card spotlighted + run history expanded. Owner/root-gated by the SAME authority as
// the rest of the Projects surface — /projects/list only returns the caller's own projects, so an id you
// don't own is indistinguishable from one that doesn't exist.
const openSchedDetail = async schedId => {
  const sid = String(schedId || '').replace(/[^\w-]/g, ''); // designator hygiene: sched ids are `sched-<hex>`
  if (!sid) return;
  const d = await pf('/projects/list');
  if (d.error) { showModal(`<b>⏰ Scheduled task</b><p>${esc(d.error)}</p>`); return; }
  const p = (d.projects || []).find(x => (x.scheduledAgents || []).some(a => a.id === sid));
  if (!p) { showModal('<b>⏰ Scheduled task</b><p style="color:var(--mut)">Not found — it may have been removed, or your capability doesn\'t own it.</p>'); return; }
  openProjectId = p.id;
  await renderProjects(sid);
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
