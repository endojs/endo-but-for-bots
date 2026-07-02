// chrome-components.mjs — the app's own CHROME as registry-backed, live-editable components.
//
// Increment 1 of the chrome decomposition (designs/preact-component-trie.md "app chrome not
// registry-backed"): pieces of the monolithic shell are extracted into `(endowments, props) => vnode`
// sources — the SAME confined render path live forks use (client/confined-source.js, no iframe, SES
// compartment under FIELD_LOCKDOWN) — seeded at boot into component-git under stable `chrome-…` ids.
// That gives each piece the full project-object treatment for free:
//   • a git lineage (every edit = a revertable version; seeded once, edits survive restarts),
//   • a backlog (componentBacklog.ensure at seed; runtime render errors auto-file via /error/flag),
//   • alt-click selection + the conversational edit chat (/components/edit-chat recognizes chrome- ids),
//   • the render-check gate (an edit that fails a real render smoke is REFUSED; the old version stays).
// The client falls back to the original hardcoded DOM whenever a chrome component fails to mount, so a
// broken edit can degrade only to the pre-decomposition UI — never to a dead toolbar.
//
// AUTHORITY: a chrome component is pure render. It holds NO cap and NO DOM; the host passes exactly the
// affordance callbacks it may fire (onClip/onCopy/onSuggest) as props — the ocap boundary is the props.
// NOTE the deliberate counterpart: the TRUSTED-PATH surfaces (consent sheet, Shares panel, auto-confirm
// rules) are marked data-trusted-path and are NOT chrome — they must never render through this path.

// ── seed sources ────────────────────────────────────────────────────────────────────────────────────
// The per-message action strip (the quiet corner affordances): 📋 copy + 🔗 clip. The classes msg-copy /
// msg-clip are load-bearing (existing tests + muscle memory target .msg-clip). Host props: onCopy, onClip.
const MSG_TOOLBAR_SOURCE = `(endowments, props) => {
  const h = endowments.h;
  const btn = (icon, cls, title, act) => h('button', {
    class: cls,
    title,
    style: 'all:unset;cursor:pointer;font-size:12px;padding:2px 5px;border-radius:6px;line-height:1',
    onClick: () => { if (typeof act === 'function') act(); },
  }, icon);
  return h('div', { style: 'display:flex;gap:2px;align-items:center' }, [
    btn('📋', 'msg-copy', 'Copy this message', props.onCopy),
    btn('🔗', 'msg-clip', 'Clip & share this as a page', props.onClip),
  ]);
}`;

// The empty-chat WELCOME panel (the Google-style landing): the tagline + tappable starter suggestions.
// Host props: onSuggest(text) — fills the composer. The greeting + suggestion texts live IN the source on
// purpose: "reword my welcome" / "change my starter prompts" is the archetypal chrome edit.
const WELCOME_SOURCE = `(endowments, props) => {
  const h = endowments.h;
  const suggestions = props.suggestions || [
    'What can you see around the house right now?',
    'Summarize my recent notes',
    'Build me a small tool',
  ];
  const chip = s => h('button', {
    class: 'welcome-suggest',
    title: 'start with this',
    onClick: () => { if (typeof props.onSuggest === 'function') props.onSuggest(s); },
    style: 'cursor:pointer;background:var(--panel);border:1px solid var(--edge);color:var(--ink);border-radius:16px;padding:6px 14px;font-size:13px',
  }, s);
  return h('div', { style: 'text-align:center' }, [
    h('div', { style: 'font-size:21px;font-weight:500;letter-spacing:.2px;color:var(--mut)' }, props.greeting || 'What can Agent C do for you?'),
    h('div', { style: 'display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:14px' }, suggestions.map(chip)),
  ]);
}`;

// The LIVE TRACE view — the in-turn reasoning fan-out as an ISLAND (dan: "make the trace view an island
// … properly fork & riffable; people will have a lot of interesting ways they want to visualize a trace").
// DATA-FED CHROME: unlike the toolbar/welcome (pure affordances), this component follows a SERVER CELL.
// The header comment travels WITH the source, so anyone alt-clicking into the edit chat sees the contract.
const TRACE_VIEW_SOURCE = `// TRACE ISLAND (chrome-trace-view) — the LIVE reasoning-trace view of a running turn.
// THE CELL IS THE INTERFACE: props.trace is the current value of this chat's \`trace:<chatId>\` server
// cell. The HOST holds the cap + the /cells/subscribe stream and re-renders this component on every
// push — the component NEVER fetches (it holds no cap, no network; pure (endowments, props) => vnode).
// Value schema (MONOTONIC — steps append then settle in place, never rewind; rev only grows):
//   props.trace = { turn, status: 'running'|'done', progress: <live one-liner>, rev, truncated,
//     steps: [{ name, detail?, call?, result?, ok?, status: 'running'|'done',
//               children?: [{name, detail}], granted?: [power…] }],
//     nodes: [{ key, parent?, kind?, label?, state?, info? }] }   // live research sub-tree
// props.onOpen3D() → the host opens the classic 3D pendant on this same live stream.
// The host page provides @keyframes ti-pulse for the running glow.
// FORK / RIFF FREELY: any component honoring THIS props contract can replace this view entirely —
// a plain list, a timeline, a 2D graph — the trace cell feeds every fork the same frames.
(endowments, props) => {
  const h = endowments.h;
  const tr = props.trace || {};
  const steps = Array.isArray(tr.steps) ? tr.steps : [];
  const running = tr.status !== 'done';
  const chip = (s, i) => {
    const live = s.status === 'running';
    const col = live ? 'var(--acc,#7c5cff)' : (s.ok === false ? 'var(--trace-bad,#ff9e9e)' : 'var(--trace-ok,#8fd0a8)');
    const kids = Array.isArray(s.children) ? s.children.length : 0;
    return h('div', { key: i, class: 'trace-step', style: 'display:flex;align-items:center;gap:5px' }, [
      h('div', { style: 'width:13px;height:2px;background:linear-gradient(90deg,transparent,' + col + ')' }),
      h('div', {
        title: (s.detail || s.name || '') + (s.result ? '\\n◂ ' + String(s.result).slice(0, 280) : ''),
        style: 'display:flex;align-items:center;gap:5px;max-width:210px;padding:2px 9px;border:1px solid ' + col + ';border-radius:12px;box-shadow:0 0 8px ' + col + ';font:600 11px ui-monospace,Menlo,Consolas,monospace;color:' + col + (live ? ';animation:ti-pulse 1.2s ease-in-out infinite' : ''),
      }, [
        h('span', null, live ? '◌' : (s.ok === false ? '✕' : '◆')),
        h('span', { style: 'color:var(--ink,#e6edf3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, String(s.name || 'step')),
        kids ? h('span', { style: 'font-size:9px;color:var(--mut,#8b949e)' }, '×' + kids) : null,
      ]),
    ]);
  };
  const liveNodes = (tr.nodes || []).filter(n => n && n.state === 'pending').length;
  return h('div', { class: 'trace-live', style: 'margin:8px 0;padding:9px 12px;border:1px solid var(--edge,#30363d);border-radius:12px;background:var(--panel,#161b22)' }, [
    h('div', { style: 'display:flex;align-items:center;gap:8px' }, [
      running
        ? h('span', { style: 'flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:var(--acc,#7c5cff);box-shadow:0 0 8px var(--acc,#7c5cff);animation:ti-pulse 1.1s ease-in-out infinite' })
        : h('span', { style: 'flex:0 0 auto;color:var(--trace-ok,#8fd0a8)' }, '◆'),
      h('span', { class: 'trace-progress', style: 'flex:1;min-width:0;font-size:12px;color:var(--mut,#8b949e);overflow:hidden;text-overflow:ellipsis;white-space:nowrap' },
        running ? String(tr.progress || 'Thinking…') + (liveNodes ? ' · ' + liveNodes + ' in flight' : '') : 'done · ' + steps.length + ' step' + (steps.length === 1 ? '' : 's')),
      h('span', { style: 'font:600 11px ui-monospace,Menlo,Consolas,monospace;color:var(--mut,#8b949e)' }, '⊿ ' + steps.length + (tr.truncated ? '+' : '')),
      h('button', { class: 'trace-open-3d', title: 'Open the 3D trace', style: 'all:unset;cursor:pointer;font:600 11px ui-monospace,Menlo,Consolas,monospace;color:var(--acc,#7c5cff);padding:2px 7px;border:1px solid var(--edge,#30363d);border-radius:8px', onClick: () => { if (typeof props.onOpen3D === 'function') props.onOpen3D(); } }, '⊿3D'),
    ]),
    h('div', { style: 'display:flex;flex-wrap:wrap;gap:6px 2px;align-items:center;margin-top:8px' }, [
      h('div', { title: 'the agent', style: 'font-size:14px;color:var(--acc,#7c5cff);text-shadow:0 0 9px var(--acc,#7c5cff)' }, '◇'),
      ...steps.map(chip),
    ]),
  ]);
}`;

// The COMPONENT STUDIO list itself — the Components-tab section list, as editable chrome (wave 1 of the
// chrome decomposition beyond the first three pieces). dan's ask: the section ORDER used to be a hardcoded
// concat in app.js (pending+admitted, then chrome, then islands) — he wanted to reorder it and couldn't.
// Now the order lives in SECTION_ORDER IN THIS SOURCE, so "show islands before app chrome" / "put admitted
// at the top" is a one-sentence edit chat, persisted as a git commit that survives reload. It also SORTS
// each section most-recent-first (a versions-length recency PROXY — see the source header for the timestamp/
// usageCount gap) and FOLDS the long tail behind a "show N more" toggle so nobody wades through every little
// thing anyone ever made; needs-review stays pinned on top, unfolded. Like every chrome
// piece: PURE RENDER PROPAGATOR (no cap, no DOM, no network). The HOST keeps every authority-bearing move —
// admit / reject / revise / edit / revert / fork are real component-lifecycle actions and stay host-gated
// EXACTLY as before — and passes only render-safe data + the affordance callbacks it may fire; the props ARE
// the ocap boundary. The header schema travels WITH the source so a riffer sees the contract in the edit chat.
const STUDIO_SOURCE = `// CHROME-STUDIO (chrome-studio) — the Components/Studio LIST (its sections, their ORDER, SORT + FOLD).
// THE SECTION ORDER IS DATA IN THIS SOURCE (see SECTION_ORDER below). Reorder it in one sentence in the
// edit chat ("put islands above app chrome") — the change persists as a git commit and survives reload.
//
// SORT + FOLD (dan's ask 2026-07-02: "most-recent, needs-review at the top, then most-used after that, and
// then a fold at some point … nobody should see every little thing anyone ever made"):
//   • NEEDS-REVIEW (props.pending) stays pinned at the very TOP and is NEVER folded — you must see every
//     item awaiting your admit/reject.
//   • Admitted / chrome / islands render most-RECENT-first via byRecent(). RECENCY SIGNAL GAP: props carry
//     NO per-item timestamp today, so byRecent uses versions.length (how many commits a piece has) as an
//     ACTIVITY proxy — a more-edited piece floats up — with a stable insertion-order tiebreak. This is a
//     PROXY, not true recency; see the increment-2 note below.
//   • FOLD THE LONG TAIL: each sorted section shows the first FOLD_AT (6); the rest hide behind a
//     "▸ show N more" toggle (endowments.useState — local, ephemeral UI state). No hooks → show all (never
//     hide content you can't reveal: the anti-brick floor). Needs-review is exempt (never folded).
// INCREMENT-2 FOLLOW-UP (needs a store/props addition held by OTHER workers — do NOT fake it here): real
//   "most-used" ordering needs a per-component usageCount (bumped when a component mounts/renders) and real
//   "most-recent" needs an updatedAt timestamp — NEITHER exists in props today. Add both to the studio
//   props feed (app.js refreshComponents, sourced from the component store), then extend byRecent to prefer
//   updatedAt, then usageCount, then the versions-length proxy. Tracked in designs/preact-component-trie.md.
//
// PURE RENDER: this component holds NO cap, NO DOM, NO network. The HOST does every authority-bearing move
// (admit/reject/revise/edit/revert/fork are real, host-gated component-lifecycle actions — unchanged) and
// feeds only render-safe data + affordance callbacks. The props ARE the ocap boundary.
//
// props (all render-safe — no swissnum / cap / share token ever crosses this boundary):
//   props.pending  = [{ id, name, by, worst, findings, code, revise:{converged,rounds,worst}|null }]
//   props.admitted = [{ id, name, kind, versions:[{version,summary,current}], grains:[{k,v}] }]
//   props.chrome   = [{ id, name, versions:[{version,summary,current}] }]
//   props.islands  = [{ id, name, versions:[{version,summary,current}] }]
//   props.onAdmit(id)  props.onReject(id)  props.onRevise(id)                     — pending-review actions
//   props.onEdit(id)   props.onFork(id)    props.onRevert(id, version)            — lifecycle actions
// REORDER / RIFF FREELY: any (endowments, props) => vnode honoring THIS contract can replace this list
// (drop a section, regroup, re-lay-out, re-sort, re-fold). PER-USER runtime order is the deferred
// 'chrome-prefs grain' (designs/preact-component-trie.md); today's source-committed order is shared + durable.
(endowments, props) => {
  const h = endowments.h;
  // local UI state for the per-section long-tail FOLD. hooks come from confineComponent's endowments; if a
  // renderer lacks them we degrade to "show everything" (never hide what you can't expand — anti-brick).
  const hasHooks = typeof endowments.useState === 'function';
  const useState = endowments.useState || (v => [v, () => {}]);
  const [expanded, setExpanded] = useState({}); // { [sectionName]: true } — which long tails are open
  const p = props || {};
  const arr = x => (Array.isArray(x) ? x : []);
  const pending = arr(p.pending), admitted = arr(p.admitted), chrome = arr(p.chrome), islands = arr(p.islands);
  const call = (fn, a, b) => { if (typeof fn === 'function') fn(a, b); };
  const short = v => String(v || '').slice(0, 8);
  const sec = label => h('div', { class: 'shares-sec' }, label);
  const pill = (text, bad) => h('span', { class: bad ? 'pill bad' : 'pill' }, text);
  // RECENCY SORT (proxy): most-edited (most versions) first, stable insertion-order tiebreak. NOTE THE GAP —
  // there is no timestamp/usageCount in props today (increment-2 follow-up in the header); versions.length
  // is the only per-item activity signal available. Total-order-stable so ties never reshuffle on re-render.
  const byRecent = items => arr(items)
    .map((c, i) => ({ c, i, n: arr(c.versions).length }))
    .sort((a, b) => (b.n - a.n) || (a.i - b.i))
    .map(x => x.c);
  const FOLD_AT = 6; // show the first N of a section; the long tail hides behind a "show N more" toggle
  // fold(name, cards): the anti-long-tail primitive. Short sections (or a hookless renderer) render whole;
  // long ones render the head + a toggle that reveals/hides the rest (local, ephemeral useState per section).
  const fold = (name, cards) => {
    if (!hasHooks || cards.length <= FOLD_AT) return cards;
    const open = !!expanded[name];
    const rest = cards.length - FOLD_AT;
    const toggle = h('button', {
      class: 'mini studio-fold', 'data-fold': name, key: '__fold_' + name,
      onClick: () => setExpanded({ ...expanded, [name]: !open }),
      style: 'margin:6px 0 2px 4px',
    }, open ? '▾ show less' : ('▸ show ' + rest + ' more'));
    return open ? [...cards, toggle] : [...cards.slice(0, FOLD_AT), toggle];
  };
  // version-history rows (shared by admitted / chrome / islands): newest first; current is a pill, older
  // versions offer a non-destructive revert (a new commit that re-runs an earlier tree — history preserved).
  const verRows = (id, versions) => {
    const vs = arr(versions);
    if (!vs.length) return [h('span', { class: 'sub' }, 'no versions yet')];
    return vs.map((v, k) => h('div', { class: 'cver', key: v.version || k }, [
      h('span', { class: 'vmono' }, short(v.version)), ' ',
      h('span', { class: 'sub' }, String(v.summary || '')), ' ',
      (k === 0 || v.current)
        ? pill('current')
        : h('button', { class: 'mini', onClick: () => call(p.onRevert, id, v.version) }, 'revert'),
    ]));
  };
  // a library/chrome/island card: header (name + kind pill + ✎ edit [+ fork]) then its version history.
  const compCard = (c, kindLabel, canFork) => {
    const cur = arr(c.versions)[0];
    const head = [
      h('b', null, String(c.name || c.id)), ' ',
      pill(kindLabel + (cur ? ' · v ' + short(cur.version) : '')), ' ',
      h('button', { class: 'mini', onClick: () => call(p.onEdit, c.id) }, '✎ edit'),
    ];
    if (canFork) head.push(' ', h('button', { class: 'mini', onClick: () => call(p.onFork, c.id) }, 'fork'));
    const kids = [h('div', { class: 'comp-head' }, head)];
    if (arr(c.grains).length) kids.push(h('div', { class: 'cgrains sub' },
      '🌱 data: ' + c.grains.map(g => g.k + '=' + JSON.stringify(g.v)).join(' · ') + ' (survives edits/reverts)'));
    kids.push(h('div', { class: 'cvers' }, verRows(c.id, c.versions)));
    // data-component-id lets alt-click target THIS piece (edit its own source); alt-clicking the list chrome
    // (outside any card) selects chrome-studio itself — the host tags the outer mount.
    return h('div', { class: 'comp', 'data-component-id': c.id, 'data-component-name': c.name || c.id }, kids);
  };
  // pending-review card: findings + admit / ✨ revise / reject and a collapsed view-code disclosure.
  const pendCard = t => {
    const rv = t.revise;
    return h('div', { class: 'comp' }, [
      h('div', { class: 'comp-head' }, [
        h('b', null, String(t.name || t.id)), ' ',
        pill('by ' + String(t.by || '?') + ' · panel: ' + String(t.worst || 'reviewing…'), t.worst === 'critical'), ' ',
        h('button', { class: 'mini', onClick: () => call(p.onAdmit, t.id) }, 'admit'), ' ',
        h('button', { class: 'mini', title: 'Hand the panel findings back to the developer, then re-review', onClick: () => call(p.onRevise, t.id) }, '✨ revise'), ' ',
        h('button', { class: 'mini bad', onClick: () => call(p.onReject, t.id) }, 'reject'),
      ]),
      h('div', { class: 'sub', style: 'margin:4px 0 0 6px' }, String(t.findings || 'running the discipline panel…')),
      rv ? h('div', { class: 'sub', style: 'margin:3px 0 0 8px' },
        '🔧 revise: ' + (rv.converged ? '✓ converged' : (String(rv.rounds || 0) + ' round(s) · worst ' + String(rv.worst || '?')))) : null,
      t.code ? h('details', { style: 'margin:5px 0 0 6px' }, [
        h('summary', { class: 'mini', style: 'display:inline-block' }, 'view code'),
        h('pre', { class: 'codeview' }, String(t.code)),
      ]) : null,
    ]);
  };
  // ★ SECTION ORDER — EDIT THIS LINE to reorder the studio (e.g. move 'islands' before 'chrome'). ★
  const SECTION_ORDER = ['pending', 'admitted', 'chrome', 'islands'];
  const SECTIONS = {
    // NEEDS-REVIEW: pinned to the top, NEVER sorted-away or folded — every pending item stays fully visible.
    pending: () => (pending.length ? [sec('🆕 Pending review (' + pending.length + ')'), ...pending.map(pendCard)] : []),
    // the rest: most-recent-first (byRecent), then fold the long tail behind a "show N more" toggle.
    admitted: () => (admitted.length ? [sec('Admitted (' + admitted.length + ')'), ...fold('admitted', byRecent(admitted).map(c => compCard(c, c.kind || 'instance', true)))] : []),
    chrome: () => (chrome.length ? [sec('App chrome (live UI · applies on edit, no rebuild)'), ...fold('chrome', byRecent(chrome).map(c => compCard(c, 'chrome', false)))] : []),
    islands: () => (islands.length ? [sec('Islands (live UI · rebuilt on edit)'), ...fold('islands', byRecent(islands).map(c => compCard(c, 'island', false)))] : []),
  };
  const body = [];
  for (const name of SECTION_ORDER) { const f = SECTIONS[name]; if (f) body.push(...f()); }
  if (!body.length) body.push(h('div', { class: 'pill' }, 'no components yet — ask the agent in chat to build a tool (proposeTool); it shows up here to review + admit'));
  return h('div', { class: 'studio-list' }, body);
}`;

// The per-message CONTROLS row (ISL-2 · chrome-msg-controls) — the ↻ retry / ✎ edit / 🔊 audio + ◀ k/n ▶
// fork-pager rendered INSIDE the user prompt bubble it acts on. Promoted from the vite `message-controls`
// island + its app.js inline twin (userBubbleControls) into the single confined chrome lane (ARCH-1). The
// classes msg-ctrl / mc-btn / mc-nav / mc-count are load-bearing (live CSS + muscle memory target them).
// Host props are the ocap boundary — pure scalars + affordance callbacks; the component holds no cap/DOM.
const MSG_CONTROLS_SOURCE = `// CHROME-MSG-CONTROLS (chrome-msg-controls) — the per-message action row: ↻ retry, ✎ edit, 🔊 audio (if
// any), and a ◀ k/n ▶ fork navigator when the prompt has variants. PURE RENDER: no cap, no DOM, no network.
// props (all render-safe scalars): { hasAudio, varIx, varCount }
//   props.onRetry()  props.onEdit()  props.onPlayAudio()  props.onFork(delta)   — host callbacks (the boundary)
// RIFF FREELY: any (endowments, props) => vnode honoring this contract can replace the row.
(endowments, props) => {
  const h = endowments.h;
  const p = props || {};
  const mk = (label, title, fn) => h('button', {
    class: 'mc-btn', title,
    onClick: () => { if (typeof fn === 'function') fn(); },
  }, label);
  const kids = [
    mk('↻', 'Retry this prompt — clears everything below + forks a new branch from here', p.onRetry),
    mk('✎', 'Edit + retry this prompt (forks from here)', p.onEdit),
  ];
  if (p.hasAudio) kids.push(mk('🔊', 'Play the original audio', p.onPlayAudio));
  const vc = Number(p.varCount) || 1;
  const vi = Number(p.varIx) || 0;
  if (vc > 1) {
    kids.push(h('span', { class: 'mc-nav' }, [
      mk('◀', 'Previous fork of this prompt', () => { if (typeof p.onFork === 'function') p.onFork(-1); }),
      h('span', { class: 'mc-count' }, (vi + 1) + '/' + vc),
      mk('▶', 'Next fork of this prompt', () => { if (typeof p.onFork === 'function') p.onFork(1); }),
    ]));
  }
  return h('div', { class: 'msg-ctrl' }, kids);
}`;

// The OUT-OF-ALLOWANCE card (ISL-3/DEAD-3 · chrome-exhausted) — the prepaid-budget wall: a conversation ran
// out of inference credit. DETERMINISTIC gate (no model produced it). Promoted from the vite `exhausted-card`
// island + its app.js inline twin (renderExhausted) into the confined chrome lane. The AUTHORITY-bearing
// moves — the Stripe /pay/checkout, the /budget/topup comp, and the MetaMask ERC-7715 settlement — stay HOST
// callbacks; this component only renders the card + fires onTopUp/onAbandon/onMetaMask. The host owns all
// view STATE (busy / note / metamask availability) and re-mounts on change: props ARE the boundary. NOTE the
// `.exhausted-card` (host mount) + `.confirm` button classes are load-bearing (a staging test drives them).
const EXHAUSTED_SOURCE = `// CHROME-EXHAUSTED (chrome-exhausted) — the allowance-exhausted top-up / abandon card. PURE RENDER: no cap,
// no DOM, no network; the real payment/top-up calls are HOST callbacks (the props boundary). The host holds
// the view state and re-mounts on change.
// props (render-safe): { isRoot, invited, busy, note, noteBad, showMetaMask, metaMaskLabel, metaMaskBusy }
//   props.onTopUp()  props.onAbandon()  props.onMetaMask()   — host callbacks (do the real fetch/settlement)
// invited = this user's credit came CARRIED ON AN INVITE (a conserved allowance the inviter funded) — say so.
(endowments, props) => {
  const h = endowments.h;
  const p = props || {};
  const isRoot = !!p.isRoot;
  const blurb = isRoot
    ? 'This conversation has used up its budget. Top it up to keep going, or abandon the thread.'
    : p.invited
      ? 'The usage credit that came with your invite is used up. From here you buy your own — top up below and your stalled message resumes automatically.'
      : "You've used up the credit you were given. Add more to keep going — or abandon the thread.";
  const title = isRoot ? 'Out of inference allowance' : 'Allowance exhausted — top up to continue';
  const call = fn => () => { if (typeof fn === 'function') fn(); };
  const btns = [
    h('button', { class: 'confirm', disabled: !!p.busy, onClick: call(p.onTopUp) }, isRoot ? 'Top up $0.50 & continue' : 'Add $5 credit'),
  ];
  if (p.showMetaMask) btns.push(h('button', { class: 'confirm', disabled: !!p.metaMaskBusy, onClick: call(p.onMetaMask) }, p.metaMaskLabel || '⛓️ Subscribe with MetaMask'));
  btns.push(h('button', { class: 'reject', disabled: !!p.busy, onClick: call(p.onAbandon) }, 'Abandon thread'));
  if (p.note) btns.push(h('span', { class: 'pmeta', style: 'font-size:12px;color:' + (p.noteBad ? 'var(--bad)' : 'var(--mut)') }, String(p.note)));
  return h('div', null, [
    h('div', { class: 'ptitle' }, ['🪙 ', h('span', null, title)]),
    h('div', { class: 'pmeta' }, blurb),
    h('div', { class: 'pbtns' }, btns),
  ]);
}`;

// The registry: stable ids (they are ADDRESSES — edit chats, backlogs, and git lineages key off them).
const CHROME = harden([
  { id: 'chrome-msg-toolbar', name: 'Message toolbar', source: MSG_TOOLBAR_SOURCE },
  { id: 'chrome-welcome', name: 'Welcome panel', source: WELCOME_SOURCE },
  { id: 'chrome-trace-view', name: 'Trace view (live)', source: TRACE_VIEW_SOURCE, cells: ['trace:<chatId>'] },
  { id: 'chrome-studio', name: 'Component Studio', source: STUDIO_SOURCE },
  { id: 'chrome-msg-controls', name: 'Message controls', source: MSG_CONTROLS_SOURCE },
  { id: 'chrome-exhausted', name: 'Out-of-allowance card', source: EXHAUSTED_SOURCE },
]);

export const makeChromeComponents = ({ componentGit, componentBacklog }) => {
  const byId = new Map(CHROME.map(c => [c.id, c]));
  const isChrome = id => byId.has(String(id));
  const get = id => byId.get(String(id)) || null;

  // Seed each chrome component's git lineage ONCE (first boot); later boots leave user edits untouched.
  // Seeding = the component's birth as a project-object, so its backlog exists from here too.
  const ensureSeeded = async () => {
    for (const c of CHROME) {
      if (!componentGit.exists(c.id)) {
        const files = {
          'component.js': c.source,
          'manifest.json': JSON.stringify({ name: c.name, kind: 'chrome', renderKind: 'fork', ...(c.cells ? { cells: c.cells } : {}), createdAt: new Date().toISOString() }, null, 2),
        };
        await componentGit.commit(c.id, files, `seed: ${c.name}`);
      }
      componentBacklog.ensure(c.id);
    }
  };

  // The HEAD of every chrome component — what the client mounts. Render-safe pure data (source text +
  // ids), no cap. `version` is the real commit oid so the client can detect a new version after an edit.
  const heads = async () => {
    const out = [];
    for (const c of CHROME) {
      try {
        const snap = await componentGit.readAt(c.id, 'HEAD');
        const [head] = await componentGit.history(c.id);
        const source = (snap && snap.files['component.js']) || c.source;
        out.push({ id: c.id, name: c.name, source, version: (head && head.version) || 'seed' });
      } catch {
        out.push({ id: c.id, name: c.name, source: c.source, version: 'seed' }); // unseeded/broken repo → the built-in seed
      }
    }
    return out;
  };

  return harden({ isChrome, get, ensureSeeded, heads, list: () => CHROME.map(c => ({ id: c.id, name: c.name })) });
};
harden(makeChromeComponents);
