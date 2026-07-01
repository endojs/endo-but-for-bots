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

// The registry: stable ids (they are ADDRESSES — edit chats, backlogs, and git lineages key off them).
const CHROME = harden([
  { id: 'chrome-msg-toolbar', name: 'Message toolbar', source: MSG_TOOLBAR_SOURCE },
  { id: 'chrome-welcome', name: 'Welcome panel', source: WELCOME_SOURCE },
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
          'manifest.json': JSON.stringify({ name: c.name, kind: 'chrome', renderKind: 'fork', createdAt: new Date().toISOString() }, null, 2),
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
