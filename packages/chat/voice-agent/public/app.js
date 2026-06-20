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
const CAP_KEY = 'field-agent-cap';
const _hashParams = new URLSearchParams(location.hash.slice(1));
let cap = _hashParams.get('cap');
// deep-link: #chat=<id> opens that chat once it resolves. The cap is read from
// localStorage (already there from the initial #cap link), so a notification's
// chat link carries NO swissnum — cap-hygiene preserved.
let pendingChat = _hashParams.get('chat') || null;
const pendingShare = _hashParams.get('chatshare') || null; // Feature B: opened via a chat-share link
if (cap) { try { localStorage.setItem(CAP_KEY, cap); } catch {} }
if (location.hash) { try { history.replaceState(null, '', location.pathname + location.search); } catch {} } // strip the fragment (cap and/or chat)
if (!cap) { try { cap = localStorage.getItem(CAP_KEY) || null; } catch {} }
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
const bubble = (who, text, agent) => {
  const d = document.createElement('div'); d.className = `msg ${who === 'you' ? 'user' : ''}`;
  const id = who === 'you' ? 'you' : (agent || 'field-agent');
  const col = frameColor(id);
  d.style.borderColor = col; // the 1px security-frame
  const named = who !== 'you' && !ENTRY_AGENTS.has(id);
  const label = who === 'you' ? 'you' : (named ? id : 'agent');
  d.innerHTML = `<div class="who"></div><div class="body"></div>`;
  const w = d.querySelector('.who'); w.textContent = label; if (named) w.style.color = col;
  linkify(d.querySelector('.body'), text || '…');
  log.appendChild(d); window.scrollTo(0, document.body.scrollHeight);
  return d.querySelector('.body');
};

// ── action-proposal cards: a destructive action the agent PROPOSED. Rendered by
//    type; only the operator (root cap) sees Confirm/Reject. Confirm fires the
//    real (operator-held) action; the agent never could. ────────────────────────
let isRoot = false;
let heldPowers = new Set(); // the powers this cap holds — gates who may confirm a proposal
const ICON = { 'note-edit': '📝', 'home-assistant': '🏠', email: '✉️', subagent: '🤖', 'system-prompt': '🧠', 'contact-add': '👤', 'contact-edit': '👤', 'spawn-specialist': '🧑‍🔬', 'give-kazputer': '📱', 'kazputer-setting': '📱', 'kazputer-coins': '🪙' };
// per-power glyphs for the consent (scope-approval) card; 🔑 is the generic fallback.
const POWER_ICON = { notes: '📓', reference: '📚', web: '🌐', research: '🔎', youtube: '📺', images: '🎨', feed: '📣', phone: '📱', timers: '⏰', browser: '🧭', home: '🏠', vm: '🖥️', host: '🖥️', agents: '🛰️', delegate: '🤝', roles: '🧑‍🔬', homeassistant: '🏠', email: '✉️', subagent: '🤖', contacts: '👥', contact: '📨', specialists: '🧑‍🔬', kazputer: '📱', dietician: '🥗', app: '🧩' };
const powerIcon = p => POWER_ICON[p] || '🔑';
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
const proposalBody = p => {
  const d = p.detail || {};
  if (p.type === 'note-edit') return `<div class="pmeta">${esc(d.path)} · ${esc(d.mode)}</div>${renderDiff(d.oldContent || '', d.newContent || '')}`;
  if (p.type === 'system-prompt') return `<div class="pmeta">the agent's own system-prompt block</div>${renderDiff(d.oldContent || '', d.newContent || '')}`;
  if (p.type === 'home-assistant') return `<div class="kv"><div><b>entity</b>${esc(d.entity_id)}</div><div><b>service</b>${esc(d.service)}</div>${d.data && Object.keys(d.data).length ? `<div><b>data</b>${esc(JSON.stringify(d.data))}</div>` : ''}</div>`;
  if (p.type === 'email') return `<div class="kv"><div><b>to</b>${esc(d.to)}</div><div><b>subject</b>${esc(d.subject)}</div></div><div class="diff">${esc(d.body || '')}</div><div class="warn">Confirming sends this via your SMTP relay (or saves a reviewed draft if no relay creds are set).</div>`;
  if (p.type === 'subagent') return `<div class="kv"><div><b>name</b>${esc(d.name)}</div><div><b>task</b>${esc(d.task)}</div><div><b>powers</b>${esc((d.powers || []).join(', ') || '(none)')}</div></div><div class="warn">Confirming queues it to the dashboard for a second approval before anything with system access runs.</div>`;
  if (p.type === 'contact-add' || p.type === 'contact-edit') return `<div class="pmeta">${p.type === 'contact-edit' ? 'edit ' + esc(d.handle) : 'new contact'}</div><div class="kv">${d.name ? `<div><b>name</b>${esc(d.name)}</div>` : ''}${d.email ? `<div><b>email</b>${esc(d.email)}</div>` : ''}${d.phone ? `<div><b>phone</b>${esc(d.phone)}</div>` : ''}${d.org ? `<div><b>org</b>${esc(d.org)}</div>` : ''}${d.note ? `<div><b>note</b>${esc(d.note)}</div>` : ''}</div>${p.type === 'contact-edit' ? '<div class="warn">Only the fields shown will change; others are preserved.</div>' : ''}`;
  if (p.type === 'spawn-specialist') return `<div class="pmeta">${esc(d.domain || 'specialist')}</div><div class="kv"><div><b>name</b>${esc(d.name)}</div><div><b>powers</b>${esc((d.powers || []).join(', ') || '(none)')}</div></div>${d.instructions ? `<div class="diff">${esc(d.instructions)}</div>` : ''}<div class="warn">Confirming creates a persistent specialist with these powers. You'll still confirm each of its destructive actions until you grant it autonomy via "don't ask again".</div>`;
  if (p.type === 'give-kazputer') return `<div class="kv"><div><b>for</b>${esc(d.name)}</div><div><b>email</b>${esc(d.email)}</div></div><div class="warn">Confirming creates a new Kazputer (kid-phone) and emails the invite link. The link works off-tailnet only once the kazputer-phone is bound public (your call).</div>`;
  if (p.type === 'kazputer-setting') return `<div class="kv"><div><b>setting</b>${esc(d.setting)}</div><div><b>value</b>${esc(String(d.value))}</div></div>`;
  if (p.type === 'kazputer-coins') return `<div class="kv"><div><b>coins</b>${Number(d.coins) >= 0 ? '+' : ''}${esc(String(d.coins))}</div></div>`;
  return `<div class="kv">${esc(p.summary || '')}</div>`;
};
const renderProposal = p => {
  const card = document.createElement('div'); card.className = 'prop msg';
  card.innerHTML = `<div class="ptitle">${ICON[p.type] || '⚠️'} <span>${esc(p.title || 'Proposed action')}</span></div>${proposalBody(p)}<div class="pbtns"></div>`;
  card.style.borderLeft = `3px solid ${frameColor(p.agent)}`; // security-frame: which agent proposed it
  const btns = card.querySelector('.pbtns');
  // You may confirm only if you hold the authority this action needs (root holds
  // all). Confirmation is required even on a shared cap — it's the typo guard.
  const mayConfirm = isRoot || heldPowers.has(p.power);
  if (!mayConfirm) { btns.innerHTML = '<span class="pmeta">awaiting the operator’s confirmation</span>'; }
  else {
    const cb = document.createElement('button'); cb.className = 'confirm'; cb.textContent = 'Confirm';
    const rb = document.createElement('button'); rb.className = 'reject'; rb.textContent = 'Reject';
    // "don't ask again for this kind" — records a revocable auto-confirm rule. Never for
    // HomeAssistant (physical-world) or spawning a specialist (authority-granting).
    let dontAsk = null;
    if (!['home-assistant', 'spawn-specialist'].includes(p.type)) {
      const lbl = document.createElement('label'); lbl.className = 'dontask';
      lbl.innerHTML = `<input type="checkbox"> don't ask again for ${esc(p.type)}`;
      dontAsk = lbl.querySelector('input'); dontAsk._label = lbl;
    }
    const resolve = async path => {
      cb.disabled = rb.disabled = true;
      const body = { cap, id: p.id };
      if (path === '/confirm' && dontAsk?.checked) body.dontAskAgain = true;
      const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json()).catch(e => ({ ok: false, error: e.message }));
      if (r.ok) { const extra = r.result?.savedTo ? ' · ' + esc(String(r.result.savedTo).split('/').pop()) : (r.result?.drafted ? ' · drafted' : ''); const rem = r.remembered ? ' · won’t ask again for this' : ''; btns.innerHTML = `<span style="color:var(--acc2);font-size:13px">✓ ${path === '/confirm' ? 'confirmed' : 'rejected'}${extra}${rem}</span>`; if (path === '/confirm') speak('Done.'); }
      else { cb.disabled = rb.disabled = false; btns.insertAdjacentHTML('beforeend', `<span style="color:var(--bad);font-size:12px">${esc(r.error || 'failed')}</span>`); }
    };
    cb.onclick = () => resolve('/confirm'); rb.onclick = () => resolve('/reject');
    btns.append(cb, rb); if (dontAsk) btns.append(dontAsk._label);
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
const askControl = (ask, q) => {
  const nm = `${esc(ask.id)}-${esc(q.id)}`;
  if (q.type === 'choice') return (q.options || []).map(o => `<label class="ask-opt"><input type="radio" name="${nm}" value="${esc(o)}"> ${esc(o)}</label>`).join('');
  if (q.type === 'multiselect') return (q.options || []).map(o => `<label class="ask-opt"><input type="checkbox" data-ms="${esc(q.id)}" value="${esc(o)}"> ${esc(o)}</label>`).join('');
  if (q.type === 'bool') return `<label class="ask-opt"><input type="radio" name="${nm}" value="yes"> Yes</label><label class="ask-opt"><input type="radio" name="${nm}" value="no"> No</label>`;
  if (q.type === 'number') return `<input type="number" class="ask-in" data-num="${esc(q.id)}" placeholder="number">`;
  if (q.type === 'approve-reject') return `<label class="ask-opt"><input type="radio" name="${nm}" value="approve"> ✅ Approve</label><label class="ask-opt"><input type="radio" name="${nm}" value="reject"> ❌ Reject</label>`;
  if (q.type === 'secret') return `<input type="password" class="ask-in ask-secret" data-secret="${esc(q.id)}" autocomplete="off" placeholder="🔒 stored securely — never shown or logged">`;
  return `<textarea class="ask-in" data-text="${esc(q.id)}" rows="2" placeholder="your answer"></textarea>`;
};
const buildAskCard = ask => {
  const card = document.createElement('div'); card.className = 'ask msg'; card.dataset.ask = ask.id;
  const qHtml = (ask.questions || []).map(q => `<div class="ask-q"><div class="ask-qtext">${esc(q.q)}</div><div class="ask-ctrl">${askControl(ask, q)}</div></div>`).join('');
  const o = ask.origin || {}; let link = '';
  if (o.kind === 'chat' && o.chatId && o.chatId !== sessionId) link = `<button class="mini ask-origin" data-openchat="${esc(o.chatId)}">→ open conversation</button>`;
  else if (o.doc) link = `<a class="mini ask-origin" href="obsidian://open?path=${encodeURIComponent(o.doc)}">→ open note</a>`;
  card.innerHTML = `<div class="ask-title">❓ <span>${esc(ask.title)}</span>${ask.requestedBy ? ` <span class="pill">${esc(ask.requestedBy)}</span>` : ''}</div>${ask.body ? `<div class="ask-body">${esc(ask.body)}</div>` : ''}${qHtml}<div class="ask-btns"><button class="ask-submit">Submit</button>${link}<span class="ask-status pill"></span></div>`;
  card.style.borderLeft = `3px solid ${frameColor(ask.requestedBy)}`; // security-frame: who raised it
  card.querySelector('.ask-submit').onclick = () => submitAsk(ask, card);
  const oc = card.querySelector('[data-openchat]'); if (oc) oc.onclick = () => switchChat(oc.dataset.openchat);
  return card;
};
const collectAnswers = (ask, card) => {
  const a = {};
  for (const q of (ask.questions || [])) {
    const k = CSS.escape(q.id);
    if (q.type === 'multiselect') a[q.id] = [...card.querySelectorAll(`[data-ms="${k}"]:checked`)].map(c => c.value);
    else if (q.type === 'number') { const el = card.querySelector(`[data-num="${k}"]`); a[q.id] = el && el.value !== '' ? Number(el.value) : null; }
    else if (q.type === 'secret') { const el = card.querySelector(`[data-secret="${k}"]`); a[q.id] = el ? el.value : ''; } // sent over the tailnet POST; server diverts to the 0600 store
    else if (q.type === 'text') { const el = card.querySelector(`[data-text="${k}"]`); a[q.id] = el ? el.value.trim() : ''; }
    else { const sel = card.querySelector(`input[name="${CSS.escape(ask.id + '-' + q.id)}"]:checked`); a[q.id] = sel ? sel.value : ''; }
  }
  return a;
};
const submitAsk = async (ask, card) => {
  const btn = card.querySelector('.ask-submit'); btn.disabled = true;
  const st = card.querySelector('.ask-status');
  const answers = collectAnswers(ask, card);
  const r = await fetch('/asks/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, id: ask.id, answers }) }).then(x => x.json()).catch(e => ({ ok: false, error: e.message }));
  if (!r.ok) { st.textContent = 'error: ' + (r.error || ''); btn.disabled = false; return; }
  // SECRET HYGIENE: wipe each secret field's value from the DOM immediately and replace the
  // input with a static marker, so the secret is never shown or re-rendered after entry.
  card.querySelectorAll('.ask-secret, input[type="password"]').forEach(el => { try { el.value = ''; } catch {} const tag = document.createElement('span'); tag.className = 'pill'; tag.textContent = '🔒 stored securely — never shown again'; el.replaceWith(tag); });
  st.textContent = '✓ answered'; card.querySelectorAll('input,textarea,.ask-submit').forEach(el => { el.disabled = true; });
  openAsks = openAsks.filter(x => x.id !== ask.id);
  for (const k of Object.keys(answers)) { const q = (ask.questions || []).find(x => x.id === k); if (q && q.type === 'secret') answers[k] = ''; } // drop the secret from the in-memory answers object too
  const o = ask.origin || {};
  // chat-origin ask answered while in that chat → continue the conversation with the answer
  if (o.kind === 'chat' && o.chatId === sessionId) {
    const summary = (ask.questions || []).map(q => `${q.q} → ${q.type === 'secret' ? '(secret provided)' : (Array.isArray(answers[q.id]) ? answers[q.id].join(', ') : (answers[q.id] ?? ''))}`).join('; ');
    sendChat(`Answering your question — ${summary}`);
  } else { await loadAsks(); } // off-app ask staged for the "Done" flush
  refreshBadge();
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
const traceStrip = steps => {
  const wrap = document.createElement('div'); wrap.className = 'trace-strip'; wrap.title = 'Open the 3D trace';
  const lbl = document.createElement('span'); lbl.className = 'ts-label'; lbl.textContent = `⊿ trace · ${steps.length}`; wrap.appendChild(lbl);
  for (const s of steps) {
    const n = document.createElement('span'); n.className = 'tn' + (s.ok === false ? ' bad' : '');
    const kids = Array.isArray(s.children) && s.children.length ? ` ·${s.children.length}` : '';
    n.textContent = `${STEP_ICON[s.name] || '⚙'} ${s.name}${kids}`;
    if (s.detail) n.title = String(s.detail).slice(0, 200);
    wrap.appendChild(n);
  }
  wrap.onclick = () => togglePendantFs();
  return wrap;
};

// render an agent reply (answer + tools + images + proposal cards)
const renderAgentResponse = r => {
  if (Array.isArray(r.steps) && r.steps.length) log.appendChild(traceStrip(r.steps)); // E6: trace strip above the response
  const body = bubble('agent', r.answer || '…', r.agentId);
  if (r.toolsUsed?.length) { const e = document.createElement('div'); e.className = 'tools'; e.textContent = '⚙ ' + r.toolsUsed.join(', '); body.parentNode.appendChild(e); }
  ((r.images && r.images.length ? r.images : (r.imageUrls || [])) || []).forEach(src => { const im = document.createElement('img'); im.src = src; body.appendChild(im); }); // data-URLs in the moment; durable /uploads urls as fallback (e.g. the share-post path)
  (r.autoFired || []).forEach(a => { const e = document.createElement('div'); e.className = 'autofired'; e.textContent = `✓ auto-confirmed: ${a.title}${a.ok === false ? ' (failed)' : ''}`; body.parentNode.appendChild(e); }); // fired via a "don't ask again" rule
  (r.proposals || []).forEach(renderProposal); // destructive actions show as confirmable cards
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
  try { const b = await (await fetch('/budget/topup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, purseCap: chatCap(), sessionId, amount }) })).json(); if (b && !b.error) updateBudgetChip(b.remaining, b.allowance); } catch {}
};
// retry the SAME turn after a top-up (no new user bubble — the user's message is already shown)
const retryTurn = async (payload, spoken) => {
  setStatus('thinking…');
  try {
    await pendantBegin(payload.text || '');
    const r = await (await fetch('/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })).json();
    if (r.error) { setStatus('chat: ' + r.error); return; }
    if (r.exhausted) { updateBudgetChip(r.remaining, r.allowance); renderExhausted(payload, spoken); return; }
    renderAgentResponse(r);
    pushTx('agent', r.answer || '', { tools: r.toolsUsed || [], images: r.images || [], imageUrls: r.imageUrls || [], steps: r.steps || [], agent: r.agentId });
    pendantEnd(r.steps || []);
    updateBudgetChip(r.remaining, r.allowance);
    if (spoken) await speak(r.answer || '');
  } catch (e) { setStatus('error: ' + e.message); }
  finally { try { pendantES && pendantES.close(); } catch {} pendantLive = false; if (pendant) pendant.finish(); setStatus(on ? 'listening…' : ''); }
};
// deterministic exhaustion card — NO model produced this; the user tops up or abandons.
const renderExhausted = (payload, spoken) => {
  const card = document.createElement('div'); card.className = 'prop msg';
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
        updateBudgetChip(b.remaining, b.allowance); card.remove(); await retryTurn(payload, spoken);
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
        if (r.ok) { updateBudgetChip(r.remaining, r.allowance); card.remove(); await retryTurn(payload, spoken); }
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
  const body = bubble('you', text); if (!text) body.textContent = '';
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
    scopeES.onmessage = e => { try { const m = JSON.parse(e.data); if (m.t === 'start') pendant.toolStart(m.name, m.detail); else if (m.t === 'done') pendant.toolDone(m.name, m.ok); else if (m.t === 'end') { try { scopeES.close(); } catch {} } } catch {} };
    scopeES.onerror = () => {};
  } catch { /* pendant is enhancement-only */ }
  const endScopeTrace = () => { scoping = false; try { scopeES && scopeES.close(); } catch {} try { pendant && pendant.finish(); } catch {} };
  let sc;
  try { sc = await (await fetch('/scope', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, prompt, sessionId }) })).json(); }
  catch { setStatus(''); endScopeTrace(); hidePendant(); return cap; } // scoper unreachable → don't block; fall back to root
  setStatus(''); endScopeTrace();
  if (!sc || sc.error || !Array.isArray(sc.catalog)) { hidePendant(); return cap; }
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
      pendingScopePowers = powers; // remember the approved grant so the chat can show it at the top
      $('sc-go').disabled = true;
      let mm; try { mm = await (await fetch('/scope/mint', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, powers, label: String(prompt).slice(0, 32) }) })).json(); } catch { /* fall through to root */ }
      fin((mm && mm.scopedCap) || cap);
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
      renderUserBubble(t, attachments); document.body.classList.remove('landing'); activeTx.push({ who: 'you', text: t }); saveTx(); setStatus('thinking…');
      let r; try { r = await (await fetch('/share/post', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: activeChat.shareToken, text: t }) })).json(); } catch (e) { r = { error: e.message }; }
      if (stale()) return true;
      if (r.error) { setStatus('share: ' + r.error); return false; }
      if (r.exhausted) { renderAgentResponse({ answer: 'The shared spend allowance for this chat is used up.' }); pushTx('agent', '(allowance spent)'); setStatus(''); ok = true; return true; }
      renderAgentResponse(r); pushTx('agent', r.answer || '', { tools: r.toolsUsed || [], images: r.images || [], imageUrls: r.imageUrls || [] }); setStatus(''); ok = true;
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
      if (pid) chat.projectId = pid;
      chats.unshift(chat); saveChats();
      setChatUrl(); // the chat is now committed (known) → reflect it in the bookmarkable URL
      // file the now-committed chat under its project (shared home folder + grouping) — fire-and-forget
      if (pid) { fetch('/projects/attach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, id: pid, chatId: sessionId }) }).catch(() => {}); delete pendingProjectId[sessionId]; }
    }
    if (!ub) ub = renderUserBubble(t, attachments);
    if (isFirst) { document.body.classList.remove('landing'); ub.parentNode.classList.add('pop'); } // composer drops to the bottom; the message pops in as a bubble
    // build the persisted tx entry (kept by reference so we can swap data-URLs → durable /uploads URLs)
    const tx = { who: 'you', text: t };
    if (audio) tx.audio = audio;
    const imgAtts = attachments.filter(a => a.kind === 'image');
    const fileAtts = attachments.filter(a => a.kind === 'text' || a.kind === 'file');
    if (imgAtts.length) tx.attachImgs = imgAtts.map(a => a.dataUrl);           // session-only (stripped before persist)
    if (fileAtts.length) tx.attachFiles = fileAtts.map(a => a.name);
    activeTx.push(tx); saveTx();
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
    const r = await cr.json();
    if (stale() || r.cancelled) return true;
    if (r.error) { setStatus('chat: ' + r.error); return false; }
    // prepaid allowance spent — server refused WITHOUT a model call. Static Top-up/Abandon card.
    if (r.exhausted) { updateBudgetChip(r.remaining, r.allowance); renderExhausted(payload, spoken); ok = true; return true; }
    // durable server URLs for the attached images → persist these (survive reload + cross-device sync)
    const urls = (r.attachments || []).filter(a => a.kind === 'image' && a.url).map(a => a.url);
    if (urls.length) { tx.attachUrls = urls; saveTx(); }
    renderAgentResponse(r); pushTx('agent', r.answer || '', { tools: r.toolsUsed || [], images: r.images || [], imageUrls: r.imageUrls || [], steps: r.steps || [], agent: r.agentId }); // imageUrls = durable /uploads copies (data-URL `images` are stripped on persist) so generated images survive a chat reload
    pendantEnd(r.steps || []); // settle the pendant + reconcile any steps the live stream missed
    updateBudgetChip(r.remaining, r.allowance); // toll-bridge: reflect this turn's spend in the budget chip
    refreshBadge(); // the turn may have posted a notification
    if ((r.toolsUsed || []).includes('routeToDev')) loadDevUpdates(); // surface the dev hand-off immediately
    if ((r.toolsUsed || []).includes('retitleChat')) { loadMemos(); loadSeedChats(); syncLoad(); } // the agent renamed conversations → pull the new titles now (before the debounced save reverts them)
    if (spoken && !stale()) await speak(r.answer || '');
    ok = true;
  } catch (e) { if (!stale()) setStatus('error: ' + e.message); ok = false; }
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
    // show the trace octahedron AS the listening indicator (one continuous identity); feedOrb pulses it
    ensurePendant().then(() => { if (pendantWrap) { pendantWrap.classList.remove('hide'); pendant.setVisible(true); } schedulePendantPosition(); }).catch(() => {});
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
  if (busy) { // a turn is running — queue instead of dropping, so the message isn't lost
    if (!t.trim() && !atts.length) return;
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
  { slug: 'anthropic/claude-3.7-sonnet',       name: 'Claude Sonnet',  cost: '$$',  size: 'L',  speed: '⚡⚡' },
  { slug: 'openai/gpt-4o',                     name: 'GPT-4o',         cost: '$$',  size: 'L',  speed: '⚡⚡' },
  { slug: 'moonshotai/kimi-k2.7-code',         name: 'Kimi K2.7 Code', cost: '$$',  size: 'XL', speed: '⚡⚡' },
  { slug: 'anthropic/claude-opus-4',           name: 'Claude Opus',    cost: '$$$', size: 'XL', speed: '⚡' },
].map(m => ({ id: `openrouter:${m.slug}`, name: m.name, size: m.size, label: `${m.name} · ${m.cost} · ${m.size} · ${m.speed}` }));
const LOCAL_DEFAULT = { id: 'default', name: 'Gemma (local)', size: 'M', label: 'Gemma · local · free · ⚡⚡⚡' };
// size→big ladder for "hold the send button to escalate to the next biggest model"
const MODEL_LADDER = [LOCAL_DEFAULT, ...OPENROUTER_MODELS];
let modelList = [LOCAL_DEFAULT, ...OPENROUTER_MODELS];
let agentList = ['field-agent'];
let projectList = []; // defined projects, surfaced in the agent menu so a project-scoped chat is one tap away
const pendingProjectId = {}; // sessionId → projectId for an ephemeral chat not yet committed to a project
let pendingScopePowers = null; // the powers approved in the consent gate, stashed until the chat commits
const rememberedModels = () => { try { return JSON.parse(localStorage.getItem(MODELS_KEY) || '{}'); } catch { return {}; } };
const rememberModel = (agent, model) => { try { const m = rememberedModels(); m[agent] = model; localStorage.setItem(MODELS_KEY, JSON.stringify(m)); } catch {} };
const curChatObj = () => chats.find(c => c.id === sessionId) || null;
// id → powers[] for each entrypoint specialist (so a chat can show its agent's ring up front).
let specialistPowers = {};
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
const populateAgentSel = () => {
  const s = $('agent-sel'); if (!s) return;
  const agents = agentList.map(a => `<option value="${esc(a)}">${esc(a === 'field-agent' ? '🗣️ Agent C' : a)}</option>`).join('');
  // every defined project gets an entry — picking one starts a fresh chat filed under that project
  const projs = projectList.length
    ? `<optgroup label="New chat in project…">${projectList.map(p => `<option value="project:${esc(p.id)}">📁 ${esc(p.name)}</option>`).join('')}</optgroup>`
    : '';
  s.innerHTML = agents + projs;
};
const populateModelSel = () => { const s = $('model-sel'); if (s) s.innerHTML = modelList.map(m => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join(''); };
const syncSelectors = () => {
  const as = $('agent-sel'), ms = $('model-sel'); if (!as || !ms) return;
  const show = curTab === 'talk' && !!cap;
  as.classList.toggle('hide', !show); ms.classList.toggle('hide', !show);
  as.value = chatAgent(); ms.value = chatModel();
};
const loadModels = async () => { if (!cap) return; try { const r = await (await fetch('/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) })).json(); const local = (r.models && r.models.length) ? r.models : [LOCAL_DEFAULT]; modelList = [...local, ...OPENROUTER_MODELS]; populateModelSel(); syncSelectors(); } catch {} };
const loadAgentList = async () => {
  agentList = ['field-agent']; specialistPowers = {};
  if (heldPowers.has('specialists')) { try { const specs = await rpc('listSpecialists'); for (const s of (specs || [])) if (s && s.id) { agentList.push(s.id); specialistPowers[s.id] = Array.isArray(s.powers) ? s.powers : []; } } catch {} }
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
const stripImg = tx => tx.map(m => (m.images || m.audio || m.attachImgs) ? { ...m, images: undefined, audio: undefined, attachImgs: undefined } : m);
// persist transcript WITHOUT image data URLs (they'd blow the localStorage quota);
// images stay in the in-memory activeTx so the 3D trace can render them this session.
const saveTx = () => { try { localStorage.setItem(txKey(sessionId), JSON.stringify(stripImg(activeTx).slice(-120))); } catch {} scheduleSync(); };

// ── cross-device sync: the chat list + transcripts live server-side keyed by the
//    cap, so the same root link shows the same chats on phone + laptop. localStorage
//    is the fast/offline cache; the server is the shared source of truth. ──────────
const UPD_KEY = 'field-agent-updated';
let syncTimer = null;
function bundleAll(updated) { return { chats, active: sessionId, updated, tx: Object.fromEntries(chats.map(c => [c.id, stripImg(loadTx(c.id)).slice(-200)])) }; }
function scheduleSync() {
  if (!cap) return;
  const now = Date.now(); try { localStorage.setItem(UPD_KEY, String(now)); } catch {} // mark local as freshest
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { fetch('/chats/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, data: bundleAll(now) }) }).catch(() => {}); }, 1500);
}
function adoptBundle(b, { keepActive = false } = {}) {
  if (!b || !Array.isArray(b.chats) || !b.chats.length) return false;
  chats = b.chats; try { localStorage.setItem(CHATS_KEY, JSON.stringify(chats)); } catch {}
  for (const [id, tx] of Object.entries(b.tx || {})) { try { localStorage.setItem(txKey(id), JSON.stringify(tx)); } catch {} }
  try { localStorage.setItem(UPD_KEY, String(b.updated || 0)); } catch {}
  // keepActive: adopt the shared chat LIST but stay on the current (blank boot) chat, so
  // the cross-device load never yanks focus to the most-recent chat on page load.
  if (!keepActive) {
    const active = (b.active && chats.find(c => c.id === b.active)) ? b.active : chats[0].id;
    sessionId = active; try { localStorage.setItem(ACTIVE_KEY, active); } catch {}
    activeTx = loadTx(active);
  }
  return true;
}
async function syncLoad({ keepActive = false } = {}) {
  if (!cap) return;
  try {
    const r = await fetch('/chats/load', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) });
    const { data } = await r.json();
    const localUpdated = +(localStorage.getItem(UPD_KEY) || 0);
    // adopt the server's chats only if they're at least as fresh as our last local edit
    if (data && Array.isArray(data.chats) && data.chats.length && (data.updated || 0) >= localUpdated) {
      if (adoptBundle(data, { keepActive })) { renderChatList(); if (!keepActive) renderTx(); tryOpenPendingChat(); }
    } else { scheduleSync(); } // server empty/older → push our local state up
  } catch {}
}
const pushTx = (who, text, extra = {}) => { activeTx.push({ who, text, ...extra }); saveTx(); };
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
      <div id="ap-list" style="display:flex;flex-direction:column;gap:5px;max-height:42vh;overflow:auto">${avail.map(p => `<label style="font-size:13px;cursor:pointer"><input type="checkbox" value="${esc(p)}"> ${powerIcon(p)} ${esc(p)}</label>`).join('')}</div>
      <button class="mini" id="ap-go" style="margin-top:10px">Grant</button></div>`);
    $('ap-go').onclick = async () => { const add2 = [...document.querySelectorAll('#ap-list input:checked')].map(x => x.value); if (!add2.length) return; closeModal(); await rescopeChat(cc, [...ps, ...add2]); };
  };
}
const renderTx = () => {
  syncLanding();
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
      b.innerHTML = `<span class="pb-label">🔑 this chat can</span>${ps.map(p => `<span class="chip">${powerIcon(p)} ${esc(p)}${xbtn(p)}</span>`).join('')}${manageable ? '<button class="chip chip-add" data-addpower title="grant another power">+ Add</button>' : ''}`;
    } else if (isRoot && chatAgent() === 'field-agent' && !cc.shareToken) {
      b.innerHTML = '<span class="pb-label">🔑 Agent C can</span><span class="chip">📖 read everything</span><span class="chip">🧑‍🔬 only propose new agents</span>';
    } else { show = false; }
    if (show) { log.appendChild(b); if (manageable) wirePowerBanner(b, cc, ps); } }
  if (!activeTx.length) return; // a new chat starts empty — no agent greeting (the banner above still shows)
  const asArr = v => (Array.isArray(v) ? v : (v ? [v] : [])); // coerce: a malformed (non-array) field must never throw + abort the whole render
  for (const m of activeTx) {
    try { // one bad message must not stop the rest of the transcript from rendering
      if (m.who === 'widget' && m.site) { log.appendChild(makeInlineWidget(m.site, m.id)); continue; } // a pasted site, rendered inline as a live widget
      if (m.who === 'agent' && Array.isArray(m.steps) && m.steps.length) log.appendChild(traceStrip(m.steps)); // E6: persistent trace above each response
      const b = bubble(m.who === 'you' ? 'you' : 'agent', m.text, m.agent);
      if (m.who === 'you' && !m.text) b.textContent = '';
      if (m.who === 'you') appendAtt(b, asArr(m.attachUrls).length ? asArr(m.attachUrls) : asArr(m.attachImgs), asArr(m.attachFiles));
      else { const imgs = asArr(m.imageUrls).length ? asArr(m.imageUrls) : asArr(m.images).filter(s => typeof s === 'string' && s.startsWith('data:')); imgs.forEach(src => { const im = document.createElement('img'); im.src = src; b.appendChild(im); }); } // durable /uploads urls survive reload (data-URLs as fallback)
      if (asArr(m.tools).length) { const e = document.createElement('div'); e.className = 'tools'; e.textContent = '⚙ ' + asArr(m.tools).join(', '); b.parentNode.appendChild(e); }
    } catch (e) { console.error('renderTx message', e); }
  }
  // re-show any still-open typed asks the agent raised in THIS chat (persist across reloads)
  openAsks.filter(a => a.origin && a.origin.kind === 'chat' && a.origin.chatId === sessionId).forEach(a => log.appendChild(buildAskCard(a)));
  // dev (Blacksmith) tasks routed from THIS chat — visible, dev-framed, pending→done
  devTasks.filter(t => t.chatId === sessionId).forEach(devCard);
  schedulePendantPosition(); // re-anchor the live pendant after the log was rebuilt
};

const SIDEBAR_KEY = 'field-agent-sidebar';
const setSidebar = open => { document.body.classList.toggle('sidebar-open', open); if (open) document.body.classList.remove('sidebar-peek'); /* pinning open supersedes a transient hover-peek */ try { localStorage.setItem(SIDEBAR_KEY, open ? '1' : '0'); } catch {} if (!$('trace-overlay').classList.contains('hide')) traceInst?.resize(); };
const openDrawer = () => setSidebar(true);
const closeDrawer = () => setSidebar(false);
const toggleDrawer = () => setSidebar(!document.body.classList.contains('sidebar-open'));
const renderChatList = () => {
  // ONE recency-sorted list. Voice memos (and any future intake channel) are not a
  // category — just conversations to keep surfaced + moving forward. A subtle 🎙 marks
  // voice origin (provenance, not a section). Every item is openable + deletable.
  const items = [
    ...chats.map(c => ({ id: c.id, title: c.title || 'New chat', ts: c.ts || 0, voice: false, shared: !!(c.shared && c.shareToken), shareMode: c.shareMode })),
    ...memoRuns.map(r => ({ id: r.id, title: r.title || 'voice note', ts: Date.parse(r.date) || 0, voice: true })),
  ].sort((a, b) => b.ts - a.ts);
  $('chat-list').innerHTML = items.length
    ? items.map(it => {
        // a chat is "requesting user interaction" when it has an unanswered ask of its own
        const needs = openAsks.some(a => a.origin && a.origin.kind === 'chat' && a.origin.chatId === it.id);
        // a shared-link entry shows its permission level so it's distinct from your own (root) chat
        // and from another link to the same chat at a different level (each link = its own entry).
        const perm = it.shared ? (it.shareMode === 'write' ? '<span class="ci-perm" title="shared link · you can post">✍️ </span>' : '<span class="ci-perm" title="shared link · read-only">🔒 </span>') : '';
        return `<div class="chat-item ${it.id === sessionId ? 'on' : ''}" data-id="${esc(it.id)}"><span class="ci-title">${needs ? '<span class="ci-dot" title="awaiting your reply"></span>' : ''}${perm}${it.voice ? '🎙 ' : ''}${esc(it.title)}</span><button class="ci-del mini" data-del="${esc(it.id)}" title="delete">×</button></div>`;
      }).join('')
    : '<div class="pill">no chats</div>';
  document.querySelectorAll('.chat-item .ci-title').forEach(s => { s.onclick = () => switchChat(s.parentElement.dataset.id); });
  document.querySelectorAll('[data-del]').forEach(b => { b.onclick = e => { e.stopPropagation(); deleteChat(b.dataset.del); }; });
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
  const exists = chats.some(c => c.id === id) || (String(id).startsWith('memo-') && memoRuns.some(r => r.id === id));
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
  chats = chats.filter(c => c.id !== id); saveChats(); try { localStorage.removeItem(txKey(id)); } catch {}
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
// D4: the pendant is the ONE trace. 🧊 / tapping the trace expands it fullscreen instead of opening the
// separate ice-cube viewer (trace.js / #trace-overlay), which is now retired.
async function togglePendantFs() { // hoisted — wired eagerly by trace-btn before this line executes
  try { await ensurePendant(); } catch { return; }
  pendantFs = !pendantFs;
  pendantWrap.classList.toggle('fs', pendantFs);
  const fsx = $('pendant-fsx'); if (fsx) fsx.classList.toggle('hide', !pendantFs);
  if (pendantFs) { pendantWrap.classList.remove('hide'); pendant.setVisible(true); if (!pendantLive && !scoping) pendantShowFor(sessionId); }
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
const pendantBegin = async promptText => {
  pendantLive = true; liveChatId = sessionId;
  try {
    const p = await ensurePendant();
    pendantWrap.classList.remove('hide'); p.setVisible(true);
    positionPendant(); p.reset(promptText);
    try { pendantES && pendantES.close(); } catch {}
    pendantES = new EventSource('/chat/steps?sid=' + encodeURIComponent(sessionId)); // tool NAMES + queries/urls only — never the cap (cap-hygiene)
    pendantES.onmessage = e => { try { const m = JSON.parse(e.data); if (m.t === 'start') p.toolStart(m.name, m.detail, m.call); else if (m.t === 'done') p.toolDone(m.name, m.ok, m.detail, m.children, m.call, m.result, m.granted); else if (m.t === 'rnode') p.rnode(m); else if (m.t === 'child-done') p.childDone(m.parent, m.name, m.ok); else if (m.t === 'end') { try { pendantES.close(); } catch {} } } catch {} };
    pendantES.onerror = () => {}; // degrade silently — applyFinal reconciles from the final steps[]
  } catch { /* pendant is enhancement-only; never block the turn */ }
};
const pendantEnd = steps => { try { pendantES && pendantES.close(); } catch {} pendantLive = false; if (pendant) { pendant.finish(); pendant.applyFinal(steps || []); } schedulePendantPosition(); };
// re-render the latest turn's SAVED trace when opening/returning to a chat (persistence across navigation)
const pendantShowFor = async id => {
  if (pendantLive && id === liveChatId) { schedulePendantPosition(); return; } // a turn is mid-stream here — leave it
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
  return `<div class="notif ${it.attention ? 'att' : ''}"><div class="ntitle"><span>${esc(it.title)}</span><span class="ntime">${esc(fmtAgo(it.date))}</span></div>${it.body ? `<div class="nbody">${esc(it.body)}</div>` : ''}<div class="nmeta"><span>${meta}</span>${withDone ? `<button class="ndone" data-done="${esc(it.id)}">Done</button>` : ''}</div></div>`;
};
const loadFeed = async () => { try { return await (await fetch('/feed/load', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) })).json(); } catch { return null; } };
const refreshBadge = async () => { if (!cap) return; await loadAsks(); const d = await loadFeed(); const attN = d ? (d.items || []).filter(i => i.attention && !i.dismissed).length : 0; setBellBadge(openAsks.length + attN); };
const renderInbox = async () => {
  await loadAsks();
  const d = await loadFeed(); if (!d) return;
  capLinkReg.clear();
  const items = d.items || [];
  const att = items.filter(i => i.attention && !i.dismissed);
  const rec = items.filter(i => !(i.attention && !i.dismissed)).slice(0, 40);
  const attList = $('att-list'); attList.innerHTML = '';
  // 0) how to receive these on your phone (ntfy) — collapsible setup instructions
  try {
    const ni = await (await fetch('/notify/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap }) })).json();
    if (ni && (ni.server || ni.topic)) {
      const d = document.createElement('details'); d.style.cssText = 'margin-bottom:10px;border:1px solid var(--edge);border-radius:8px;padding:8px;background:var(--panel)';
      d.innerHTML = `<summary style="cursor:pointer;font-size:13px">📱 Get these notifications on your phone</summary>
        <ol style="font-size:12px;color:var(--mut);margin:8px 0 0;padding-left:18px;line-height:1.7">
          <li>Install the <b>ntfy</b> app (iOS App Store · Android Play/F-Droid).</li>
          <li>App <b>Settings → Default server</b> → <code style="user-select:all">${esc(ni.server)}</code> (be on the tailnet/LAN to reach it).</li>
          <li>Tap <b>＋ → Subscribe to topic</b>, enter <code style="user-select:all">${esc(ni.topic)}</code></li>
          <li>Done — your agent's pushes now arrive on your phone.</li>
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
  $('rec-list').innerHTML = rec.length ? rec.map(i => notifCard(i, false)).join('') : '<div class="pill">no recent activity</div>';
  $('att-count').textContent = (openAsks.length + att.length) ? String(openAsks.length + att.length) : '';
  setBellBadge(openAsks.length + att.length);
  document.querySelectorAll('#att-list [data-done]').forEach(b => { b.onclick = async () => { b.disabled = true; await fetch('/feed/dismiss', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cap, id: b.dataset.done }) }); renderInbox(); }; });
  // cap-link anchors carry only an opaque id; open the real (out-of-DOM) URL programmatically so the swissnum never lands in the DOM.
  document.querySelectorAll('#att-list [data-capopen], #rec-list [data-capopen]').forEach(a => { a.onclick = e => { e.preventDefault(); const u = capLinkReg.get(a.dataset.capopen); if (u) window.open(u, '_blank', 'noopener,noreferrer'); }; });
  // chat deep-links route IN-APP to the specific chat id (not a fresh tab that re-resolves to the most recent chat).
  document.querySelectorAll('#att-list .nlink[data-openchat], #rec-list .nlink[data-openchat]').forEach(a => { a.onclick = e => { e.preventDefault(); switchChat(a.dataset.openchat); }; });
};
const toggleSection = (headId, listId) => { const list = $(listId), head = $(headId); list.classList.toggle('hide'); head.querySelector('.caret').textContent = list.classList.contains('hide') ? '▸' : '▾'; };
if ($('bell-btn')) $('bell-btn').onclick = () => showTab('inbox');
if ($('att-head')) $('att-head').onclick = () => toggleSection('att-head', 'att-list');
if ($('rec-head')) $('rec-head').onclick = () => toggleSection('rec-head', 'rec-list');

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

// ── ⌥ Alt/Option-click to SELECT a component + edit it with its agent ───────────────────────────────
// Hold Alt/Option → hovering outlines the lowest-level element tagged with its component id; click →
// a chip offers ✎ edit (a focused agent for THAT component) / 🍴 fork. Works on any [data-component-id]
// element, so it lights up wherever a component is rendered (the Components tab today; mounted UI
// component-projects as the trie grows). Owner-only.
const componentSelect = () => {
  let altHeld = false, hoverEl = null;
  const outline = document.createElement('div');
  outline.style.cssText = 'position:fixed;z-index:9000;pointer-events:none;border:2px solid #39d3ff;border-radius:8px;box-shadow:0 0 16px #39d3ff66;display:none;transition:all .05s ease;';
  const label = document.createElement('div');
  label.style.cssText = 'position:absolute;top:-21px;left:-2px;background:#39d3ff;color:#021018;font:600 11px -apple-system,Segoe UI,sans-serif;padding:1px 7px;border-radius:6px;white-space:nowrap;';
  outline.appendChild(label);
  const hint = document.createElement('div');
  hint.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:9001;background:#0d1117f2;border:1px solid #39d3ff;color:#e6edf3;font:12px -apple-system,sans-serif;padding:6px 13px;border-radius:20px;display:none;pointer-events:none;';
  hint.textContent = '⌥ Alt-click a component to edit it with its agent';
  const chip = document.createElement('div');
  chip.style.cssText = 'position:fixed;z-index:9002;display:none;gap:6px;background:#0d1117f7;border:1px solid #39d3ff;border-radius:10px;padding:6px 7px;box-shadow:0 10px 34px rgba(0,0,0,.6);font:12px -apple-system,sans-serif;align-items:center;';
  document.body.append(outline, hint, chip);
  const tagOf = el => (el && el.closest ? el.closest('[data-component-id]') : null);
  const place = el => { if (!el) { outline.style.display = 'none'; return; } const r = el.getBoundingClientRect(); outline.style.display = 'block'; outline.style.left = `${r.left - 3}px`; outline.style.top = `${r.top - 3}px`; outline.style.width = `${r.width + 2}px`; outline.style.height = `${r.height + 2}px`; label.textContent = `🧩 ${el.getAttribute('data-component-name') || 'component'}`; };
  const clearChip = () => { chip.style.display = 'none'; outline.style.display = 'none'; };
  addEventListener('keydown', e => { if ((e.key === 'Alt' || e.altKey) && isRoot) { altHeld = true; hint.style.display = 'block'; } });
  addEventListener('keyup', e => { if (e.key === 'Alt' || !e.altKey) { altHeld = false; hint.style.display = 'none'; if (!chip.style.display || chip.style.display === 'none') outline.style.display = 'none'; } });
  addEventListener('mousemove', e => { if (!altHeld) return; const el = tagOf(e.target); if (el !== hoverEl) { hoverEl = el; place(el); } else if (el) place(el); });
  addEventListener('click', e => { if (!altHeld) return; const el = tagOf(e.target); if (!el) return; e.preventDefault(); e.stopPropagation(); const id = el.getAttribute('data-component-id'), name = el.getAttribute('data-component-name') || 'component'; const r = el.getBoundingClientRect(); chip.innerHTML = `<span style="color:var(--mut)">🧩 ${name}</span> <button class="mini" data-act="edit">✎ edit</button> <button class="mini" data-act="fork">🍴 fork</button> <button class="mini" data-act="x">✕</button>`; chip.style.display = 'flex'; chip.style.left = `${Math.min(r.left, innerWidth - 220)}px`; chip.style.top = `${Math.min(r.bottom + 6, innerHeight - 44)}px`; place(el); chip.querySelector('[data-act=edit]').onclick = () => { clearChip(); editComponent(id, name); }; chip.querySelector('[data-act=fork]').onclick = () => { clearChip(); forkComponentAct(id, name); }; chip.querySelector('[data-act=x]').onclick = clearChip; }, true);
  addEventListener('keydown', e => { if (e.key === 'Escape') clearChip(); });
  addEventListener('scroll', () => { if (chip.style.display === 'flex') clearChip(); }, true);
};
componentSelect();
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
      return `<div class="comp"><div class="comp-head"><b>${esc(t.name)}</b> <span class="pill${sevClass}">by ${esc(t.proposedBy || '?')} · panel: ${esc(sev)}</span> <button class="mini" data-admit="${esc(t.id)}" data-name="${esc(t.name)}" data-worst="${esc(rv ? rv.worst : '')}">admit</button> <button class="mini bad" data-reject="${esc(t.id)}" data-name="${esc(t.name)}">reject</button></div><div class="sub" style="margin:4px 0 0 6px">${findings}</div><details style="margin:5px 0 0 6px"><summary class="mini" style="display:inline-block">view code</summary><pre class="codeview">${esc(code)}</pre></details></div>`;
    }).join('');
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
  if (which === 'components') refreshComponents();
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
  $('inv-powers').innerHTML = grantable.map(p => `<label style="font-size:12px;border:1px solid var(--edge);border-radius:6px;padding:2px 7px;cursor:pointer"><input type="checkbox" value="${esc(p)}"${INVITE_STARTER.has(p) ? ' checked' : ''}> ${powerIcon(p)} ${esc(p)}</label>`).join('');
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
    <div id="sub-powers" style="display:flex;flex-direction:column;gap:5px;max-height:38vh;overflow:auto">${avail.map(p => `<label style="font-size:13px;cursor:pointer"><input type="checkbox" value="${esc(p)}"> ${esc(p)}</label>`).join('')}</div>
    <button class="mini" id="sub-make" style="margin-top:10px">Create sub-chat</button></div>`);
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
  const agents = (p.scheduledAgents || []).map(a => `
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
            <div style="display:flex;flex-wrap:wrap;gap:4px" data-etools="${p.id}|${a.id}">${powers.map(pw => `<label style="font-size:11px;border:1px solid var(--edge);border-radius:6px;padding:2px 6px;cursor:pointer"><input type="checkbox" value="${esc(pw)}"${(a.tools || []).includes(pw) ? ' checked' : ''}> ${esc(pw)}</label>`).join('')}</div>
            <div><button class="mini" data-saveagent="${p.id}|${a.id}">Save changes</button></div>
          </div></details>
        <div data-out="${p.id}|${a.id}" style="font-size:12px;color:var(--acc);margin-top:4px"></div>
      </div>`).join('');
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
        <div style="display:flex;flex-wrap:wrap;gap:4px" data-natools="${p.id}">${powers.map(pw => `<label style="font-size:11px;border:1px solid var(--edge);border-radius:6px;padding:2px 6px;cursor:pointer"><input type="checkbox" value="${esc(pw)}"> ${esc(pw)}</label>`).join('')}</div>
        <select class="hdr-sel" style="max-width:none" data-nacad="${p.id}">${CADENCES.map((c, i) => `<option value="${i}">${esc(c.label)}</option>`).join('')}</select>
        <div><button class="mini" data-addagent="${p.id}">Add</button> <button class="mini" data-template="${p.id}">↳ prefill: overnight garden-scan</button></div>
      </div></details>
  </div>`);
  const m = $('qrmodal');
  $('pj-back').onclick = () => { openProjectId = null; renderProjects(); };
  renderProjectFiles(p.id); // populate the home-folder file list
  { const up = $('pj-upload'); if (up) up.onchange = () => { if (up.files.length) uploadProjectFiles(p.id, [...up.files]); up.value = ''; }; }
  { const dz = $('pj-drop'); if (dz) { ['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.style.borderColor = 'var(--acc)'; })); ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.style.borderColor = 'var(--edge)'; })); dz.addEventListener('drop', e => { const fl = e.dataTransfer && e.dataTransfer.files; if (fl && fl.length) uploadProjectFiles(p.id, [...fl]); }); } }
  m.querySelectorAll('[data-openchat]').forEach(b => b.onclick = () => { closeModal(); switchChat(b.dataset.openchat); });
  m.querySelectorAll('[data-template]').forEach(b => b.onclick = () => {
    const pid = b.dataset.template;
    m.querySelector(`[data-naname="${pid}"]`).value = 'garden-scan';
    m.querySelector(`[data-naprompt="${pid}"]`).value = "Review my notes and the tools I haven't connected yet. Suggest 1–3 concrete optimizations I could get by wiring the right tools/capabilities together. Be specific and brief; propose, don't act.";
    m.querySelectorAll(`[data-natools="${pid}"] input`).forEach(x => { x.checked = ['notes', 'reference'].includes(x.value); });
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
    const r = await pf('/projects/agents/update', { id: pid, agentId: aid, patch: { name, prompt, tools } });
    if (r.error) alert(r.error);
    renderProjects();
  });
  m.querySelectorAll('[data-openrun]').forEach(b => b.onclick = async e => { e.preventDefault(); const cid = b.dataset.openrun; if (!cid) return; closeModal(); pendingChat = cid; await loadSeedChats(); tryOpenPendingChat(); }); // open a past scheduled run from the Projects view
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
