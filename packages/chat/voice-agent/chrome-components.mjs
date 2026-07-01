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

// The registry: stable ids (they are ADDRESSES — edit chats, backlogs, and git lineages key off them).
const CHROME = harden([
  { id: 'chrome-msg-toolbar', name: 'Message toolbar', source: MSG_TOOLBAR_SOURCE },
  { id: 'chrome-welcome', name: 'Welcome panel', source: WELCOME_SOURCE },
  { id: 'chrome-trace-view', name: 'Trace view (live)', source: TRACE_VIEW_SOURCE, cells: ['trace:<chatId>'] },
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
