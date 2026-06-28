import { h, Fragment } from 'preact';

// ── HeaderBar island (P4 shell→island migration) — the app's top header. It renders the STRUCTURE (every
// button/select with its stable id, class, title); app.js wires BEHAVIOUR by id after mount (the confined
// renderer keeps `id`, so getElementById still finds them — no refs needed). Editing this island re-flows the
// header (labels, order, which buttons show) without touching app.js's wiring. Stateless + render-safe.
// IMPORTANT: keep every id + class EXACTLY as index.html — app.js depends on them. Renders the children into
// the existing <header> (a Fragment), so the host element + its CSS stay put.
export const HeaderBar = () => h(Fragment, {}, [
  h('button', { class: 'iconbtn', id: 'hamburger', title: 'Chats' }, '☰'),
  h('button', { class: 'iconbtn', id: 'new-chat-top', title: 'New chat (Ctrl/⌘+Shift+O)' }, '✏️'),
  h('button', { class: 'iconbtn', id: 'trash-chat-top', title: 'Throw away this chat' }, '🗑️'),
  h('h1', {}, '🗣️ Agent C'),
  h('span', { class: 'sub', id: 'scope' }, 'connecting…'),
  h('button', { class: 'budget-chip hide', id: 'budget', title: "This conversation's inference allowance — tap to top up" }),
  h('select', { class: 'hdr-sel hide', id: 'agent-sel', title: 'Top-level agent for this chat' }),
  h('select', { class: 'hdr-sel hide', id: 'model-sel', title: 'Model-provider acting as this agent (remembered per agent)' }),
  h('button', { class: 'tab on', id: 'tab-talk' }, 'Talk'),
  h('button', { class: 'tab', id: 'tab-shares' }, 'Powers'),
  h('button', { class: 'tab hide', id: 'tab-components' }, 'Components'),
  h('button', { class: 'iconbtn', id: 'bell-btn', title: 'Needs your attention', style: 'position:relative' }, ['🔔', h('span', { id: 'bell-badge', class: 'badge hide' })]),
  h('button', { class: 'iconbtn', id: 'info-btn', title: "What is this? — Agent C's shipped capabilities" }, 'ⓘ'),
  h('button', { class: 'iconbtn', id: 'projects-btn', title: 'Projects & scheduled agents' }, '🕐'),
  h('button', { class: 'iconbtn', id: 'chatshare-btn', title: 'Share this chat (link / QR)' }, '📤'),
  h('button', { class: 'iconbtn', id: 'hooks-btn', title: 'Hooks — push custom media to your agent' }, '🪝'),
]);
